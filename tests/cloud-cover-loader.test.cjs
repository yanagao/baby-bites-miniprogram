'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const actualCatalog = require('../data/recipe-cover-catalog');
const source = fs.readFileSync(path.join(root, 'utils/cover-loader.js'), 'utf8');
const userRoot = 'wxfile://usr';
const cachePath = item => userRoot + '/recipe-covers-v1/' + item.sha256 + '.jpg';
const info = item => ({size: item.bytes, digest: item.md5});
const url = item => 'https://unit.tcb.qcloud.la/' + item.filename + '?token=signed';
async function flush() { for (let i = 0; i < 160; i++) await Promise.resolve(); }

function fixture(options = {}) {
  const catalog = {version: actualCatalog.version, files: options.entries || actualCatalog.files};
  const files = options.files || new Map();
  const timers = new Map(), heldDownloads = [], heldCloud = [];
  const calls = {cloud: [], downloads: [], info: [], copies: [], mkdir: [], aborts: 0, maxDownloads: 0};
  const hooks = {...options};
  let nextTimer = 0, activeDownloads = 0, now = 1793318400000, tempID = 0;
  const response = () => ({version: catalog.version, expiresAt: now + 60 * 60 * 1000,
    files: catalog.files.map(item => ({...item, url: url(item)}))});
  const manager = {
    getFileInfo(args) {
      calls.info.push(args.filePath);
      assert.equal(args.digestAlgorithm, 'md5');
      if (hooks.getInfo) return hooks.getInfo(args);
      if (files.has(args.filePath)) args.success({...files.get(args.filePath)}); else args.fail({errMsg: 'not found'});
    },
    mkdir(args) { calls.mkdir.push(args.dirPath); args.success({}); },
    copyFile(args) {
      calls.copies.push({srcPath: args.srcPath, destPath: args.destPath});
      assert.ok(args.destPath.startsWith(userRoot + '/recipe-covers-v1/'));
      assert.ok(catalog.files.some(item => cachePath(item) === args.destPath));
      if (hooks.copy) return hooks.copy(args);
      files.set(args.destPath, {...files.get(args.srcPath)}); args.success({});
    }
  };
  const wx = {
    env: {USER_DATA_PATH: userRoot}, getFileSystemManager: () => manager,
    cloud: {callFunction(args) {
      calls.cloud.push(args);
      assert.equal(args.name, 'babyBitesAssets');
      assert.equal(args.config.env, 'mock-cloud');
      assert.equal(args.data.action, 'catalog');
      if (hooks.cloud) return hooks.cloud(args, response());
      if (hooks.holdCloud) { heldCloud.push(args); return; }
      args.success({result: response()});
    }},
    downloadFile(args) {
      calls.downloads.push(args.url);
      assert.equal(args.timeout, 10000);
      activeDownloads++; calls.maxDownloads = Math.max(calls.maxDownloads, activeDownloads);
      let finished = false;
      const complete = (override = {}) => {
        if (!finished) { activeDownloads--; finished = true; }
        const item = catalog.files.find(value => args.url.includes('/' + value.filename));
        const tempFilePath = '/tmp/recipe-download-' + (++tempID) + '.jpg';
        if (item) files.set(tempFilePath, info(item));
        if (override.fail) args.fail({errMsg: 'offline'});
        else args.success({statusCode: 200, tempFilePath, ...override});
      };
      if (hooks.download) hooks.download(args, complete);
      else if (hooks.holdDownloads) heldDownloads.push({args, complete});
      else complete();
      return {abort() { calls.aborts++; if (!finished) { activeDownloads--; finished = true; } }};
    }
  };
  if (options.noFS) delete wx.getFileSystemManager;
  if (options.noCloud) delete wx.cloud;
  const module = {exports: {}};
  const context = {module, Promise, Date: class extends Date {static now() { return now; }},
    require(name) {
      if (name === '../data/recipe-cover-catalog') return catalog;
      if (name === '../config/cloud') return {env: 'mock-cloud'};
      throw Error('Unexpected dependency ' + name);
    },
    setTimeout(callback, delay) { assert.equal(delay, 10000); const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  if (!options.noWx) context.wx = wx;
  vm.runInNewContext(source, context, {filename: 'utils/cover-loader.js'});
  return {loader: module.exports, files, calls, hooks, timers, heldDownloads, heldCloud, response, wx,
    advance(ms) { now += ms; },
    timeout() { const callback = timers.values().next().value; assert.ok(callback); callback(); }
  };
}

const first = actualCatalog.files[0];

test('Node without wx exposes no pretend package paths or readiness', async () => {
  const h = fixture({noWx: true});
  assert.equal(h.loader.isReady(), false);
  assert.equal(h.loader.getSource(first.key), '');
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.calls.cloud.length, 0);
  assert.equal(h.timers.size, 0);
});

test('all valid offline cached images are discovered without any cloud or download request', async () => {
  const files = new Map(actualCatalog.files.map(item => [cachePath(item), info(item)]));
  files.set(userRoot + '/personal-photo.jpg', {size: 42, digest: 'private'});
  const before = JSON.stringify([...files]);
  const h = fixture({files, noCloud: true});
  assert.equal(await h.loader.prepare(), true);
  assert.equal(h.loader.isReady(), true);
  for (const item of actualCatalog.files) assert.equal(h.loader.getSource(item.key), cachePath(item));
  assert.equal(await h.loader.prepare(), true);
  assert.equal(h.calls.cloud.length, 0);
  assert.equal(h.calls.downloads.length, 0);
  assert.equal(h.calls.copies.length, 0);
  assert.equal(JSON.stringify([...files]), before);
  assert.equal(h.loader.getSource('dish:unknown'), '');
});

test('one shared prepare downloads at most three images concurrently and publishes partial sources immediately', async () => {
  const h = fixture({holdDownloads: true});
  const changes = [];
  h.loader.subscribe(change => changes.push(change));
  const pending = h.loader.prepare();
  assert.equal(h.loader.prepare(), pending);
  await flush();
  assert.equal(h.calls.cloud.length, 1);
  assert.equal(h.calls.downloads.length, 3);
  assert.equal(h.loader.isReady(), false);
  assert.equal(h.loader.getSource(first.key), '');
  h.heldDownloads[0].complete();
  await flush();
  assert.equal(h.loader.getSource(first.key), cachePath(first));
  assert.equal(h.calls.downloads.length, 4);
  assert.equal(h.loader.isReady(), false);
  for (let i = 1; i < actualCatalog.files.length; i++) { h.heldDownloads[i].complete(); await flush(); }
  assert.equal(await pending, true);
  assert.equal(h.calls.maxDownloads, 3);
  assert.equal(h.timers.size, 0);
  assert.ok(changes.some(item => item.key === first.key && item.source === url(first)));
  assert.ok(changes.some(item => item.key === first.key && item.source === cachePath(first)));
  await h.loader.prepare();
  assert.equal(h.calls.cloud.length, 1);
});

test('a failed image does not discard other images and the next attempt downloads only its missing cache', async () => {
  let failFirst = true;
  const h = fixture({download(args, complete) { complete({fail: failFirst && args.url === url(first)}); }});
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.loader.getSource(first.key), '');
  assert.equal(h.loader.getSource(actualCatalog.files[1].key), cachePath(actualCatalog.files[1]));
  failFirst = false;
  assert.equal(await h.loader.prepare(), true);
  assert.equal(h.calls.downloads.length, actualCatalog.files.length + 1);
  assert.equal(h.calls.downloads.at(-1), url(first));
  assert.equal(h.calls.cloud.length, 2);
});

test('a cache removed or corrupted after success is rechecked and replaced only inside the static cache', async () => {
  const h = fixture();
  assert.equal(await h.loader.prepare(), true);
  const second = actualCatalog.files[1];
  h.files.delete(cachePath(first));
  h.files.set(cachePath(second), {size: second.bytes, digest: '0'.repeat(32)});
  const privateFile = userRoot + '/shared-user-photo.jpg';
  h.files.set(privateFile, {size: 17, digest: 'unchanged'});
  assert.equal(await h.loader.prepare(), true);
  assert.equal(h.calls.downloads.length, actualCatalog.files.length + 2);
  assert.deepEqual(h.files.get(privateFile), {size: 17, digest: 'unchanged'});
  assert.ok(h.calls.copies.every(item => item.destPath.startsWith(userRoot + '/recipe-covers-v1/')));
});

test('download payload size or MD5 mismatch is never persisted or kept as a remote fallback', async () => {
  for (const bad of [{size: first.bytes + 1, digest: first.md5}, {size: first.bytes, digest: 'f'.repeat(32)}]) {
    const h = fixture({entries: [first]});
    h.hooks.getInfo = args => {
      if (args.filePath.startsWith('/tmp/')) args.success(bad); else args.fail({});
    };
    assert.equal(await h.loader.prepare(), false);
    assert.equal(h.loader.getSource(first.key), '');
    assert.equal(h.calls.copies.length, 0);
  }
});

test('a valid remote fallback remains available when disk persistence fails and expires without invented paths', async () => {
  for (const options of [{copy(args) { args.fail({errMsg: 'quota exceeded'}); }}]) {
    const h = fixture({entries: [first], ...options});
    assert.equal(await h.loader.prepare(), false);
    assert.equal(h.loader.getSource(first.key), url(first));
    assert.equal(h.loader.isReady(), false);
    h.advance(60 * 60 * 1000);
    assert.equal(h.loader.getSource(first.key), '');
    if (!options.noFS) {
      delete h.hooks.copy;
      assert.equal(await h.loader.prepare(), true);
      assert.equal(h.loader.getSource(first.key), cachePath(first));
    }
  }
});

test('catalog version, expiry, key and each fixed content metadata field are enforced independently', async () => {
  const variants = [value => { value.version = 'other'; }, value => { value.expiresAt = 1; },
    value => { value.expiresAt += 25 * 60 * 60 * 1000; }, value => { value.files[0].key = 'dish:unknown'; },
    value => { value.files[0].bytes++; }, value => { value.files[0].sha256 = 'f'.repeat(64); },
    value => { value.files[0].md5 = 'f'.repeat(32); }, value => { delete value.files[0].md5; }];
  for (const change of variants) {
    const h = fixture({entries: [first], cloud(args, value) { change(value); args.success({result: value}); }});
    assert.equal(await h.loader.prepare(), false);
    assert.equal(h.loader.getSource(first.key), '');
    assert.equal(h.calls.downloads.length, 0);
  }
});

test('expired remote fallbacks notify read views to clear their old URL when offline', async () => {
  const h = fixture({entries: [first], copy(args) { args.fail({}); }});
  const changes = [];
  h.loader.subscribe(value => changes.push(value));
  await h.loader.prepare();
  assert.equal(changes.at(-1).source, url(first));
  h.advance(60 * 60 * 1000);
  h.hooks.cloud = args => args.fail({errMsg: 'offline'});
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.loader.getSource(first.key), '');
  assert.equal(changes.at(-1).source, '');
});

test('only HTTPS Tencent storage URLs without userinfo or non-443 ports are accepted', async () => {
  const valid = ['https://bucket.tcb.qcloud.la/a.jpg?token=x', 'https://bucket.tcb.qcloud.la:443/a.jpg',
    'https://bucket-123.cos.ap-shanghai.myqcloud.com/a.jpg', 'https://bucket.file.myqcloud.com/a.jpg',
    'https://bucket.tencentcdn.cn/a.jpg'];
  const invalid = ['http://bucket.tcb.qcloud.la/a.jpg', 'https://evil.example/a.jpg',
    'https://bucket.tcb.qcloud.la.evil.example/a.jpg', 'https://user@bucket.tcb.qcloud.la/a.jpg',
    'https://bucket.tcb.qcloud.la:444/a.jpg', 'https://bucket.tcb.qcloud.la:443@evil.example/a.jpg',
    'https://bucket.tcb.qcloud.la\\@evil.example/a.jpg', 'https://bucket..tcb.qcloud.la/a.jpg',
    'https://bucket.tcb.qcloud.la/a.jpg\n', 'https://bucket.tcb.qcloud.la/a.jpg#fragment'];
  for (const address of [...valid, ...invalid]) {
    const h = fixture({entries: [first], cloud(args, value) {
      value.files[0].url = address; args.success({result: value});
    }});
    await h.loader.prepare();
    assert.equal(h.calls.downloads.length, valid.includes(address) ? 1 : 0, address);
    if (valid.includes(address)) assert.equal(h.calls.downloads[0], address);
  }
});

test('a partial cloud catalog publishes known files without claiming that all files are cached', async () => {
  const h = fixture({cloud(args, value) { value.files = value.files.slice(0, 2); args.success({result: value}); }});
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.calls.downloads.length, 2);
  assert.equal(h.loader.getSource(first.key), cachePath(first));
  assert.equal(h.loader.getSource(actualCatalog.files[2].key), '');
  delete h.hooks.cloud;
  assert.equal(await h.loader.prepare(), true);
  assert.equal(h.calls.downloads.length, actualCatalog.files.length);
});

test('a timed-out cloud call can be retried and its late result cannot publish sources', async () => {
  const h = fixture({entries: [first], holdCloud: true});
  const firstAttempt = h.loader.prepare();
  await flush(); h.timeout();
  assert.equal(await firstAttempt, false);
  const next = h.loader.prepare();
  await flush();
  h.heldCloud[0].success({result: h.response()});
  await flush();
  assert.equal(h.loader.getSource(first.key), '');
  assert.equal(h.loader.prepare(), next);
  h.heldCloud[1].success({result: h.response()});
  assert.equal(await next, true);
  assert.equal(h.timers.size, 0);
});

test('timed-out downloads abort and late completion cannot overwrite a later attempt', async () => {
  const h = fixture({entries: [first], holdDownloads: true});
  const firstAttempt = h.loader.prepare();
  await flush(); h.timeout();
  assert.equal(await firstAttempt, false);
  assert.equal(h.calls.aborts, 1);
  const next = h.loader.prepare();
  await flush();
  h.heldDownloads[0].complete();
  await flush();
  assert.equal(h.calls.copies.length, 0);
  assert.equal(h.loader.prepare(), next);
  h.heldDownloads[1].complete();
  assert.equal(await next, true);
  assert.equal(h.calls.copies.length, 1);
});

test('a stalled file operation cannot leave prepare pending forever or publish a late cache result', async () => {
  let held;
  const h = fixture({entries: [first], noCloud: true, getInfo(args) { held = args; }});
  const pending = h.loader.prepare();
  await flush(); h.timeout();
  assert.equal(await pending, false);
  held.success(info(first));
  await flush();
  assert.equal(h.loader.getSource(first.key), '');
  delete h.hooks.getInfo;
  h.files.set(cachePath(first), info(first));
  assert.equal(await h.loader.prepare(), true);
});

test('cloud synchronous errors and rejected promises settle safely and permit retry', async () => {
  for (const cloud of [() => { throw Error('sync failure'); }, () => Promise.reject(Error('offline'))]) {
    const h = fixture({entries: [first], cloud});
    assert.equal(await h.loader.prepare(), false);
    assert.equal(h.timers.size, 0);
    delete h.hooks.cloud;
    assert.equal(await h.loader.prepare(), true);
  }
  const promiseOnly = fixture({entries: [first], cloud(args, value) { return Promise.resolve({result: value}); }});
  assert.equal(await promiseOnly.loader.prepare(), true);
  assert.equal(promiseOnly.loader.getSource(first.key), cachePath(first));
});

test('download results pointing to user-owned files are rejected before file reads or copies', async () => {
  const privatePath = userRoot + '/user-photo.jpg';
  const h = fixture({entries: [first], download(args, complete) { complete({tempFilePath: privatePath}); }});
  h.files.set(privatePath, info(first));
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.calls.info.includes(privatePath), false);
  assert.equal(h.calls.copies.length, 0);
  assert.deepEqual(h.files.get(privatePath), info(first));
});

test('subscribers receive per-file changes independently and unsubscribe stops later notifications', async () => {
  const h = fixture({entries: [first]});
  const changes = [];
  h.loader.subscribe(() => { throw Error('view disposed'); });
  const unsubscribe = h.loader.subscribe(value => changes.push(value));
  assert.equal(await h.loader.prepare(), true);
  assert.equal(changes.length, 2);
  unsubscribe();
  h.files.delete(cachePath(first));
  assert.equal(await h.loader.prepare(), true);
  assert.equal(changes.length, 2);
  h.loader.subscribe(null)();
});


test('missing filesystem support retains artwork placeholders instead of unverified remote URLs', async () => {
  const h = fixture({entries: [first], noFS: true});
  assert.equal(await h.loader.prepare(), false);
  assert.equal(h.loader.getSource(first.key), '');
  assert.equal(h.calls.downloads.length, 0);
});
