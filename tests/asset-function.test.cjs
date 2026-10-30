'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createHandler} = require('../cloudfunctions/babyBitesAssets');
const recipes = require('../data/recipes');
const ENV = 'cloud1-5gxmasdl05652531';
const APPID = 'wxc6c61fbebebe3340';
const NOW = Date.parse('2026-10-30T02:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
const digest = (algorithm, text) => crypto.createHash(algorithm).update(text).digest('hex');

function manifest() {
  assert.equal(recipes.length, 21);
  return {version: 'recipe-covers-v1', env: ENV, files: recipes.map(recipe => {
    const sha256 = digest('sha256', recipe.id);
    return {key: 'dish:' + recipe.id, sha256, md5: digest('md5', recipe.id), bytes: 12345,
      fileID: `cloud://${ENV}.test-bucket/public/recipe-covers/v1/${recipe.id}-${sha256.slice(0, 16)}.jpg`};
  })};
}

function signed(options) {
  return {fileList: options.fileList.map(file => ({fileID: file.fileID, status: 0, maxAge: 3600,
    tempFileURL: 'https://test-bucket.tcb.qcloud.la/' + file.fileID.split('/').slice(3).join('/') + '?sign=test'}))};
}

function harness(options = {}) {
  let context = {OPENID: 'caller-a', APPID, ENV};
  let time = NOW;
  let signer = options.signer || (async args => signed(args));
  const calls = [];
  const forbidden = [];
  const cloud = {getWXContext() { return context; }, async getTempFileURL(args) {
    calls.push(clone(args));
    return signer(args);
  }};
  for (const method of ['database', 'uploadFile', 'downloadFile', 'deleteFile', 'callFunction', 'openapi']) {
    Object.defineProperty(cloud, method, {get() { forbidden.push(method); throw Error('Unexpected privileged operation'); }});
  }
  const catalog = options.manifest === undefined ? manifest() : options.manifest;
  return {handler: createHandler({cloud, manifest: catalog, now: () => time}), calls, forbidden, catalog,
    setContext(value) { context = value; }, setTime(value) { time = value; },
    setSigner(value) { signer = value; }};
}

test('catalog signs exactly the 21 fixed assets and exposes only presentation metadata', async () => {
  const h = harness();
  const result = await h.handler({action: 'catalog'});
  assert.equal(result.version, 'recipe-covers-v1');
  assert.equal(result.expiresAt, NOW + 55 * 60 * 1000);
  assert.equal(result.files.length, 21);
  assert.deepEqual(h.calls, [{fileList: h.catalog.files.map(file => ({fileID: file.fileID, maxAge: 3600}))}]);
  for (const [index, file] of result.files.entries()) {
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'key', 'md5', 'sha256', 'url']);
    assert.equal(file.key, h.catalog.files[index].key);
    assert.equal(file.sha256, h.catalog.files[index].sha256);
    assert.equal(file.md5, h.catalog.files[index].md5);
    assert.equal(file.bytes, h.catalog.files[index].bytes);
  }
  assert.doesNotMatch(JSON.stringify(result), /cloud:\/\/|caller-a|OPENID|APPID/);
  assert.deepEqual(h.forbidden, []);
});

test('SDK results may arrive in a different order but remain paired by exact fileID', async () => {
  const h = harness({signer: async args => ({fileList: signed(args).fileList.reverse()})});
  const result = await h.handler({action: 'catalog'});
  assert.deepEqual(result.files.map(file => file.key), h.catalog.files.map(file => file.key));
  result.files.forEach(file => assert.ok(file.url.includes(file.key.slice(5) + '-' + file.sha256.slice(0, 16))));
});

test('trusted WeChat identity and exact environment are required before signing or cache access', async () => {
  const h = harness();
  await h.handler({action: 'catalog'});
  for (const context of [null, {}, {OPENID: '', APPID, ENV}, {OPENID: ' ', APPID, ENV},
    {OPENID: 1, APPID, ENV}, {OPENID: 'caller', APPID: 'other', ENV}]) {
    h.setContext(context);
    assert.equal((await h.handler({action: 'catalog'})).error.code, 'UNAUTHENTICATED');
  }
  for (const env of [undefined, '', 'other-env']) {
    h.setContext({OPENID: 'caller', APPID, ENV: env});
    assert.equal((await h.handler({action: 'catalog'})).error.code, 'INVALID_ENV');
  }
  assert.equal(h.calls.length, 1);
});

test('only catalog is accepted; arbitrary file IDs, paths, identities and initialization actions are rejected', async () => {
  const h = harness();
  const requests = [undefined, null, [], {}, Object.create({action: 'catalog'}), {action: 'seed'}, {action: 'upload'}, {action: 'delete'},
    {action: 'catalog', fileID: `cloud://${ENV}.test-bucket/users/private/photo.jpg`},
    {action: 'catalog', files: []}, {action: 'catalog', path: '../users'}, {action: 'catalog', env: ENV},
    {action: 'catalog', OPENID: 'caller-a'}, {action: 'catalog', maxAge: 86400}];
  for (const request of requests) assert.equal((await h.handler(request)).error.code, 'INVALID_REQUEST');
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.forbidden, []);
});

test('platform userInfo and tcbContext are ignored and cannot replace trusted caller context', async () => {
  const h = harness();
  const expected = await h.handler({action: 'catalog'});
  for (const untrusted of [null, 'untrusted', [], {OPENID: 'forged', APPID: 'forged', ENV: 'forged'},
    {openId: 'forged', appId: 'forged', fileID: 'cloud://private/photo.jpg'}]) {
    assert.deepEqual(await h.handler({action: 'catalog', userInfo: untrusted}), expected);
    assert.deepEqual(await h.handler({action: 'catalog', tcbContext: untrusted}), expected);
    assert.deepEqual(await h.handler({action: 'catalog', userInfo: untrusted, tcbContext: untrusted}), expected);
  }
  assert.equal(h.calls.length, 1);
  const userInfo = {OPENID: 'caller-a', APPID, ENV, openId: 'caller-a', appId: APPID};
  const tcbContext = {OPENID: 'caller-a', APPID, ENV, envId: ENV};
  for (const context of [null, {}, {OPENID: '', APPID, ENV}, {OPENID: 'caller', APPID: 'other', ENV}]) {
    h.setContext(context);
    assert.equal((await h.handler({action: 'catalog', userInfo, tcbContext})).error.code, 'UNAUTHENTICATED');
  }
  h.setContext({OPENID: 'caller-a', APPID, ENV: 'other-env'});
  assert.equal((await h.handler({action: 'catalog', userInfo, tcbContext})).error.code, 'INVALID_ENV');
  h.setContext({OPENID: 'caller-a', APPID, ENV});
  for (const extra of [{fileID: 'cloud://private/photo.jpg'}, {path: 'users/private/photo.jpg'}, {env: ENV}, {__context: {}}]) {
    const result = await h.handler({action: 'catalog', userInfo, tcbContext, ...extra});
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message']);
  }
  assert.equal((await h.handler({userInfo, tcbContext})).error.code, 'INVALID_REQUEST');
  assert.equal(h.calls.length, 1);
});

test('malformed deployment manifests fail closed without requesting any URL', async t => {
  const changes = {
    'missing manifest': () => null,
    'wrong version': value => { value.version = 'unreviewed-v2'; },
    'wrong environment': value => { value.env = 'other-env'; },
    'missing file': value => { value.files.pop(); },
    'more than 21 files': value => { value.files.push(clone(value.files[0])); },
    'duplicate key': value => { value.files[1] = clone(value.files[0]); },
    'unknown recipe': value => { value.files[0].key = 'dish:user-private-id'; },
    'bad sha256': value => { value.files[0].sha256 = 'not-a-hash'; },
    'bad md5': value => { value.files[0].md5 = 'not-a-hash'; },
    'zero bytes': value => { value.files[0].bytes = 0; },
    'oversized image': value => { value.files[0].bytes = 204801; },
    'fractional bytes': value => { value.files[0].bytes = 2.5; },
    'missing uploaded ID': value => { value.files[0].fileID = ''; },
    'other environment file': value => { value.files[0].fileID = value.files[0].fileID.replace(ENV, 'other'); },
    'private user path': value => { value.files[0].fileID = `cloud://${ENV}.test-bucket/users/private/photo.jpg`; },
    'hash path mismatch': value => { value.files[0].fileID = value.files[0].fileID.replace(/-[a-f0-9]{16}\.jpg$/, '-0000000000000000.jpg'); },
    'traversal path': value => { value.files[0].fileID = value.files[0].fileID.replace('/v1/', '/v1/../v1/'); }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const source = manifest();
    const changed = change(source);
    const h = harness({manifest: changed === null ? null : source});
    assert.equal((await h.handler({action: 'catalog'})).error.code, 'ASSETS_UNAVAILABLE');
    assert.equal(h.calls.length, 0);
  });
});

test('manifest is copied so later caller mutation cannot redirect signing', async () => {
  const h = harness();
  const expected = h.catalog.files[0].fileID;
  h.catalog.files[0].fileID = `cloud://${ENV}.test-bucket/users/private/photo.jpg`;
  h.catalog.files[0].key = 'dish:private';
  const result = await h.handler({action: 'catalog'});
  assert.equal(h.calls[0].fileList[0].fileID, expected);
  assert.equal(result.files[0].key, 'dish:' + recipes[0].id);
});

test('incomplete, failed, duplicated or mismatched SDK responses never expose a partial catalog', async t => {
  const changes = {
    'no response': () => null,
    'missing array': () => ({}),
    'missing one file': value => { value.fileList.pop(); },
    'extra file': value => { value.fileList.push(clone(value.fileList[0])); },
    'duplicate result': value => { value.fileList[1] = clone(value.fileList[0]); },
    'wrong fileID': value => { value.fileList[0].fileID = `cloud://${ENV}.test-bucket/users/private/photo.jpg`; },
    'failed item': value => { value.fileList[0].status = -1; value.fileList[0].errMsg = 'SECRET underlying error'; },
    'missing status': value => { delete value.fileList[0].status; },
    'too short URL TTL': value => { value.fileList[0].maxAge = 300; }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const h = harness({signer: async args => {
      const response = signed(args), changed = change(response);
      return changed === null || changed && typeof changed === 'object' ? changed : response;
    }});
    const result = await h.handler({action: 'catalog'});
    assert.equal(result.error.code, 'ASSETS_UNAVAILABLE');
    assert.deepEqual(Object.keys(result), ['error']);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|cloud:\/\/|users\/private/);
    h.setSigner(async args => signed(args));
    assert.equal((await h.handler({action: 'catalog'})).files.length, 21);
    assert.equal(h.calls.length, 2);
  });
});

test('URL validation permits HTTPS TCB and COS only and requires the exact static asset path', async t => {
  const changes = {
    'plain http': url => url.replace('https:', 'http:'),
    'lookalike host': url => url.replace('.tcb.qcloud.la', '.tcb.qcloud.la.evil.test'),
    'unrelated host': url => url.replace('test-bucket.tcb.qcloud.la', 'example.com'),
    'userinfo': url => url.replace('https://', 'https://admin:password@'),
    'alternate port': url => url.replace('.qcloud.la/', '.qcloud.la:8443/'),
    'fragment': url => url + '#private',
    'private path on allowed host': () => 'https://test-bucket.tcb.qcloud.la/users/private/photo.jpg',
    'path for another static image': url => url.replace(recipes[0].id, recipes[1].id),
    'embedded newline': url => url + '\n'
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const h = harness({signer: async args => {
      const response = signed(args); response.fileList[0].tempFileURL = change(response.fileList[0].tempFileURL); return response;
    }});
    assert.equal((await h.handler({action: 'catalog'})).error.code, 'ASSETS_UNAVAILABLE');
  });
  const cos = harness({signer: async args => {
    const response = signed(args);
    response.fileList.forEach(file => { file.tempFileURL = file.tempFileURL.replace('test-bucket.tcb.qcloud.la', 'bucket-123.cos.ap-shanghai.myqcloud.com'); });
    return response;
  }});
  assert.equal((await cos.handler({action: 'catalog'})).files.length, 21);
});

test('successful cache lasts 50 minutes without sliding the 55 minute result expiry', async () => {
  const h = harness();
  const first = await h.handler({action: 'catalog'});
  h.setTime(NOW + 49 * 60 * 1000);
  h.setContext({OPENID: 'caller-b', APPID, ENV});
  assert.deepEqual(await h.handler({action: 'catalog'}), first);
  assert.equal(h.calls.length, 1);
  first.files[0].url = 'https://evil.test/';
  first.files.pop();
  const safe = await h.handler({action: 'catalog'});
  assert.equal(safe.files.length, 21);
  assert.match(safe.files[0].url, /^https:\/\/test-bucket\.tcb\.qcloud\.la\//);
  h.setTime(NOW + 50 * 60 * 1000);
  const refreshed = await h.handler({action: 'catalog'});
  assert.equal(h.calls.length, 2);
  assert.equal(refreshed.expiresAt, NOW + 105 * 60 * 1000);
});

test('concurrent callers share one signing operation, including after a rejected operation', async () => {
  let resolve;
  const h = harness({signer: args => new Promise(done => { resolve = () => done(signed(args)); })});
  const a = h.handler({action: 'catalog'}), b = h.handler({action: 'catalog'});
  assert.equal(h.calls.length, 1);
  resolve();
  assert.deepEqual(await a, await b);

  h.setTime(NOW + 50 * 60 * 1000);
  let reject;
  h.setSigner(() => new Promise((_, fail) => { reject = fail; }));
  const c = h.handler({action: 'catalog'}), d = h.handler({action: 'catalog'});
  assert.equal(h.calls.length, 2);
  reject(Error('SECRET storage failure'));
  assert.equal((await c).error.code, 'ASSETS_UNAVAILABLE');
  assert.equal((await d).error.code, 'ASSETS_UNAVAILABLE');
  h.setSigner(async args => signed(args));
  assert.equal((await h.handler({action: 'catalog'})).files.length, 21);
  assert.equal(h.calls.length, 3);
});
