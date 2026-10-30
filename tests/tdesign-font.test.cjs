'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'utils/tdesign-font.js'), 'utf8');
const fontPath = '../recipe-media/fonts/tdesign-icons-0.4.5.js';
const remote = 'url("https://tdesign.gtimg.com/icon/0.4.5/fonts/t.woff")';
const fontModule = {exports: {}};
vm.runInNewContext(fs.readFileSync(path.join(root, 'utils', fontPath), 'utf8'), {module: fontModule});
const font = fontModule.exports;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function flush() {
  for (let count = 0; count < 12; count++) await Promise.resolve();
}

function harness(options = {}) {
  const module = {exports: {}};
  const fonts = [], packages = [], timers = new Map();
  let timerID = 0;
  const localRequire = () => { throw Error('No synchronous font import is allowed'); };
  if (!options.noAsync) localRequire.async = name => {
    assert.equal(name, fontPath);
    packages.push(name);
    return options.packageLoad ? options.packageLoad() : Promise.resolve(font);
  };
  const wx = {
    getAppBaseInfo: () => ({SDKVersion: options.version || '3.7.12'}),
    loadFontFace(value) { fonts.push(value); if (options.fontLoad) return options.fontLoad(value); value.success(); }
  };
  if (options.noFontAPI) delete wx.loadFontFace;
  if (options.systemInfo) {
    delete wx.getAppBaseInfo;
    wx.getSystemInfoSync = options.systemInfo;
  }
  const context = {module, require: localRequire, Promise,
    setTimeout(callback, delay) {
      assert.equal(delay, 10000);
      const id = ++timerID;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  if (!options.noWx) context.wx = wx;
  vm.runInNewContext(source, context, {filename: 'utils/tdesign-font.js'});
  return {...module.exports, fonts, packages, timers, wx,
    timeout() { const callback = timers.values().next().value; assert.ok(callback, 'expected a pending timeout'); callback(); }
  };
}

test('the moved official WOFF and retained license preserve their original bytes', () => {
  const bytes = Buffer.from(font.base64, 'base64');
  assert.equal(bytes.subarray(0, 4).toString(), 'wOFF');
  assert.equal(font.family, 't');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), font.sha256);
  assert.equal(font.sha256, '377024275d01176d32461000713af752fbefb0d2520c49b0aeda82a3a3150b54');
  assert.equal(fs.existsSync(path.join(root, 'assets/fonts/tdesign-icons-0.4.5.js')), false);
  assert.ok(fs.readFileSync(path.join(root, 'recipe-media/fonts/LICENSE'))
    .equals(fs.readFileSync(path.join(root, 'assets/fonts/LICENSE'))));
});

test('supported runtimes deduplicate concurrent requests and cache successful offline loading', async () => {
  const work = deferred();
  const h = harness({packageLoad: () => work.promise, fontLoad() {}});
  const first = h.loadTDesignIcons();
  assert.equal(h.loadTDesignIcons(), first);
  await flush();
  assert.deepEqual(h.packages, [fontPath]);
  assert.equal(h.fonts.length, 0);
  work.resolve(font);
  await flush();
  assert.equal(h.loadTDesignIcons(), first);
  assert.equal(h.fonts.length, 1);
  assert.equal(h.fonts[0].family, 't');
  assert.equal(h.fonts[0].global, true);
  assert.deepEqual(Array.from(h.fonts[0].scopes), ['webview']);
  assert.equal(h.fonts[0].source, 'url("data:font/woff;base64,' + font.base64 + '")');
  h.fonts[0].success();
  assert.equal(await first, 'offline');
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(h.packages.length, 1);
  assert.equal(h.fonts.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.supportsDataURL('3.7.8'), false);
  assert.equal(h.supportsDataURL('3.7.9'), true);
});

test('older SDKs and runtimes without async require use the official network font directly', async () => {
  for (const options of [{version: '2.32.3'}, {version: '3.7.8'}, {noAsync: true},
    {systemInfo: () => ({SDKVersion: '3.7.8'})}, {systemInfo() { throw Error('unavailable'); }}]) {
    const h = harness(options);
    assert.equal(await h.loadTDesignIcons(), 'network');
    assert.equal(await h.loadTDesignIcons(), 'network');
    assert.equal(h.packages.length, 0);
    assert.equal(h.fonts.length, 1);
    assert.equal(h.fonts[0].source, remote);
    assert.equal(h.timers.size, 0);
  }
});

test('package rejection, synchronous throws and malformed exports fall back to the network font', async () => {
  for (const packageLoad of [() => Promise.reject(Error('offline')), () => { throw Error('runtime error'); },
    () => Promise.resolve(null), () => Promise.resolve({family: 'wrong', base64: font.base64}),
    () => Promise.resolve({family: 't', base64: ''})]) {
    const h = harness({packageLoad});
    assert.equal(await h.loadTDesignIcons(), 'network');
    assert.equal(h.packages.length, 1);
    assert.equal(h.fonts.length, 1);
    assert.equal(h.fonts[0].source, remote);
    assert.equal(h.timers.size, 0);
  }
});

test('a rejected or synchronously thrown local font load falls back once to the network font', async () => {
  for (const throwing of [false, true]) {
    const h = harness({fontLoad(value) {
      if (value.source === remote) value.success();
      else if (throwing) throw Error('data URLs unsupported');
      else value.fail();
    }});
    assert.equal(await h.loadTDesignIcons(), 'network');
    assert.equal(await h.loadTDesignIcons(), 'network');
    assert.equal(h.fonts.length, 2);
    assert.equal(h.fonts[1].source, remote);
    assert.equal(h.timers.size, 0);
  }
});

test('complete failures are retryable rather than cached as permanently unavailable', async () => {
  let fail = true;
  const h = harness({fontLoad(value) { if (fail) value.fail(); else value.success(); }});
  assert.equal(await h.loadTDesignIcons(), 'unavailable');
  assert.equal(h.fonts.length, 2);
  assert.equal(h.timers.size, 0);
  fail = false;
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(h.packages.length, 2);
  assert.equal(h.fonts.length, 3);
});

test('a stalled package times out and late resolution cannot replace the successful network fallback', async () => {
  const work = deferred();
  const h = harness({packageLoad: () => work.promise});
  const first = h.loadTDesignIcons();
  await flush();
  h.timeout();
  assert.equal(await first, 'network');
  work.resolve(font);
  await flush();
  assert.equal(await h.loadTDesignIcons(), 'network');
  assert.equal(h.fonts.length, 1);
  assert.equal(h.fonts[0].source, remote);
  assert.equal(h.timers.size, 0);
});

test('package rejection arriving after timeout is handled without an unhandled rejection', async () => {
  const work = deferred();
  const h = harness({packageLoad: () => work.promise});
  const first = h.loadTDesignIcons();
  await flush();
  h.timeout();
  assert.equal(await first, 'network');
  work.reject(Error('late package rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fonts.length, 1);
  assert.equal(await h.loadTDesignIcons(), 'network');
});

test('a stalled local font falls back after timeout and ignores both late callbacks', async () => {
  const h = harness({fontLoad() {}});
  const first = h.loadTDesignIcons();
  await flush();
  const local = h.fonts[0];
  h.timeout();
  await flush();
  assert.equal(h.fonts.length, 2);
  local.success(); local.fail();
  await flush();
  assert.equal(h.loadTDesignIcons(), first);
  assert.equal(h.timers.size, 1);
  h.fonts[1].success();
  assert.equal(await first, 'network');
  assert.equal(h.fonts.length, 2);
  assert.equal(h.timers.size, 0);
});

test('a stalled network font settles unavailable and stale callbacks cannot settle a retry', async () => {
  const h = harness({noAsync: true, fontLoad() {}});
  const first = h.loadTDesignIcons();
  await flush();
  const stale = h.fonts[0];
  h.timeout();
  assert.equal(await first, 'unavailable');
  const second = h.loadTDesignIcons();
  assert.notEqual(second, first);
  await flush();
  stale.success(); stale.fail();
  await flush();
  assert.equal(h.loadTDesignIcons(), second);
  assert.equal(h.fonts.length, 2);
  assert.equal(h.timers.size, 1);
  h.fonts[1].success();
  assert.equal(await second, 'network');
  assert.equal(h.timers.size, 0);
});

test('a synchronous network API throw resolves unavailable and permits a later retry', async () => {
  let throwing = true;
  const h = harness({noAsync: true, fontLoad(value) { if (throwing) throw Error('font API error'); value.success(); }});
  assert.equal(await h.loadTDesignIcons(), 'unavailable');
  assert.equal(h.timers.size, 0);
  throwing = false;
  assert.equal(await h.loadTDesignIcons(), 'network');
  assert.equal(h.fonts.length, 2);
});

test('missing runtimes or font APIs resolve unavailable without loading resources and can recover', async () => {
  const missingRuntime = harness({noWx: true});
  assert.equal(await missingRuntime.loadTDesignIcons(), 'unavailable');
  assert.equal(missingRuntime.timers.size, 0);
  const h = harness({noFontAPI: true});
  assert.equal(await h.loadTDesignIcons(), 'unavailable');
  assert.equal(h.packages.length, 0);
  assert.equal(h.timers.size, 0);
  h.wx.loadFontFace = value => value.success();
  assert.equal(await h.loadTDesignIcons(), 'offline');
  assert.equal(h.packages.length, 1);
});

function appHarness(loadIcons) {
  let app, syncState = 'ready';
  const work = [];
  const calls = {icons: 0, init: 0, subscriptions: 0, starts: 0, syncs: 0, covers: 0, warnings: []};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App(value) { app = value; }, Promise, getCurrentPages: () => [],
    console: {warn(value) { calls.warnings.push(value); }},
    require(name) {
      if (name === './utils/store') return {init() { calls.init++; }, subscribe() { calls.subscriptions++; }};
      if (name === './utils/cloud-sync') return {
        start() { calls.starts++; }, getStatus: () => ({state: syncState}), syncNow() { calls.syncs++; }
      };
      if (name === './utils/tdesign-font') return {loadTDesignIcons() {
        calls.icons++;
        if (loadIcons) return loadIcons(calls.icons);
        const item = deferred(); work.push(item); return item.promise;
      }};
      if (name === './utils/cover-loader') return {
        isReady: () => false, subscribe: () => () => {}, prepare() { calls.covers++; return Promise.resolve(false); }
      };
      if (name === './utils/recipe-covers') return {withCover: value => value};
      throw Error('Unexpected app dependency: ' + name);
    }
  });
  return {app, calls, work, syncing(value) { syncState = value ? 'syncing' : 'ready'; }};
}

test('app foreground retries unavailable icons once while preserving cover and sync lifecycle', async () => {
  const h = appHarness();
  h.app.globalData.pantry = ['南瓜'];
  h.app.onLaunch();
  const first = h.app._iconFontPromise;
  assert.equal(h.app.prepareIcons(), first);
  h.app.onShow(); h.app.onShow();
  await flush();
  assert.equal(h.calls.icons, 1);
  assert.equal(h.calls.init, 1);
  assert.equal(h.calls.subscriptions, 1);
  assert.equal(h.calls.starts, 1);
  assert.equal(h.calls.covers, 1);
  assert.equal(h.calls.syncs, 2);
  h.work[0].resolve('unavailable');
  assert.equal(await first, 'unavailable');
  assert.equal(h.app.globalData.iconFontState, 'unavailable');
  assert.equal(h.calls.warnings.length, 1);
  h.app.onShow();
  const second = h.app._iconFontPromise;
  assert.equal(h.app.globalData.iconFontState, 'loading');
  h.app.onShow();
  await flush();
  assert.equal(h.calls.icons, 2);
  assert.equal(h.calls.covers, 2);
  assert.equal(h.calls.syncs, 4);
  h.work[1].resolve('network');
  assert.equal(await second, 'network');
  h.app.onShow();
  assert.equal(h.calls.syncs, 5);
  h.syncing(true);
  h.app.onShow();
  await flush();
  assert.equal(h.calls.icons, 2);
  assert.equal(h.calls.covers, 3);
  assert.equal(h.calls.syncs, 5, 'an ongoing cloud sync remains protected');
  assert.deepEqual(h.app.globalData.pantry, ['南瓜']);
});

test('app foreground and explicit preparation do not reload offline or network successes', async () => {
  for (const state of ['offline', 'network']) {
    const h = appHarness(() => Promise.resolve(state));
    h.app.onLaunch();
    assert.equal(await h.app._iconFontPromise, state);
    h.app.onShow(); h.app.onShow();
    assert.equal(await h.app.prepareIcons(), state);
    assert.equal(h.app.globalData.iconFontState, state);
    assert.equal(h.calls.icons, 1);
    assert.equal(h.calls.warnings.length, 0);
  }
});

test('app converts a thrown or rejected icon loader into retryable foreground failure', async () => {
  for (const throwing of [false, true]) {
    const h = appHarness(attempt => {
      if (attempt > 1) return Promise.resolve('offline');
      if (throwing) throw Error('unexpected font loader failure');
      return Promise.reject(Error('unexpected font loader rejection'));
    });
    h.app.onLaunch();
    assert.equal(await h.app._iconFontPromise, 'unavailable');
    assert.equal(h.app._iconFontPromise, null);
    h.app.onShow();
    assert.equal(await h.app._iconFontPromise, 'offline');
    assert.equal(h.calls.icons, 2);
    assert.equal(h.calls.warnings.length, 1);
  }
});
