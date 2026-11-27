'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const OWNER = 'a'.repeat(64), PERSONAL = {kind: 'personal', id: OWNER};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {resolve, reject, promise};};
const status = () => ({apiBaseUrl: 'https://api.example.test/ai', grant: null});
function setup() {
  let info = {owner: OWNER, scope: PERSONAL, dirty: false, blocked: false}, page;
  const listeners = new Set(), calls = [], clipboard = [], hooks = {};
  const api = Object.fromEntries(['status', 'createGrant', 'revokeGrant'].map(method => [method, async (...args) => {
    calls.push([method, ...args]);
    if (hooks[method]) return hooks[method](...args);
    if (method === 'status') return status();
    if (method === 'createGrant') return {token: 'secret-value', expiresAt: Date.now() + 86400000, apiBaseUrl: status().apiBaseUrl};
    return {revoked: true};
  }]));
  const store = {getSyncInfo: () => clone(info), subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const wx = {setClipboardData(options) {clipboard.push(options.data); options.success();}, showToast() {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/ai-analysis/index.js'), 'utf8'), {Page(value) {page = value;}, wx, Date,
    require(name) {if (name.endsWith('/store')) return store; if (name.endsWith('/ai-analysis')) return api; throw Error(name);}});
  page.data = clone(page.data); page.setData = value => Object.assign(page.data, clone(value));
  return {page, calls, clipboard, hooks, listeners, setInfo(patch) {info = {...info, ...patch}; listeners.forEach(fn => fn(store.getSyncInfo()));}};
}

test('opening and returning only loads grant status once', async () => {
  const app = setup(); await app.page.onLoad(); app.page.onShow(); app.page.onShow();
  assert.deepEqual(app.calls, [['status']]);
  assert.equal(app.page.data.statusLoaded, true); assert.equal(app.page.data.activeGrant, false);
});

test('a QR cold start waits for the first resolved account and family before loading grant status', async () => {
  const app = setup(), family = {kind: 'family', id: 'f'.repeat(64), membershipId: 'd'.repeat(32)};
  app.setInfo({owner: '', scope: null});
  await app.page.onLoad();
  await app.page.createGrant();
  assert.deepEqual(app.calls, []);
  app.setInfo({owner: OWNER, scope: PERSONAL});
  app.setInfo({scope: family});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.calls, [['status']]);
  assert.equal(app.page.data.statusLoaded, true);
  assert.equal(app.page.data.locked, false);
  app.setInfo({scope: PERSONAL}); app.setInfo({scope: family});
  assert.equal(app.page.data.locked, true);
  await app.page.createGrant();
  assert.deepEqual(app.calls, [['status']]);
});

test('an initial status failure leaves configuration unknown and permits only a status retry', async () => {
  const app = setup(); app.hooks.status = () => {throw Error('网络未连接');};
  await app.page.onLoad();
  assert.equal(app.page.data.statusLoaded, false);
  assert.equal(app.page.data.error, '网络未连接');
  assert.equal(app.page.data.loading, false);
  await app.page.createGrant();
  assert.deepEqual(app.calls, [['status']]);
  const template = fs.readFileSync(path.join(__dirname, '../pages/ai-analysis/index.wxml'), 'utf8');
  assert.match(template, /<block wx:if="\{\{!locked && statusLoaded\}\}">/);
  assert.match(template, /!locked && \(!statusLoaded \|\| error/);
  app.hooks.status = () => ({...status(), apiBaseUrl: ''});
  await app.page.load();
  assert.equal(app.page.data.statusLoaded, true);
  assert.equal(app.page.data.apiBaseUrl, '');
  assert.equal(app.page.data.error, '');
});

test('duplicate taps during generation do not rotate a newly issued grant', async () => {
  const app = setup(); await app.page.onLoad();
  const wait = deferred(); app.hooks.createGrant = () => wait.promise;
  const pending = app.page.createGrant(); await app.page.createGrant();
  assert.deepEqual(app.calls, [['status'], ['createGrant']]);
  wait.resolve({token: 'test-secret', apiBaseUrl: status().apiBaseUrl, expiresAt: Date.now() + 10000});
  await pending;
  assert.equal(app.page._token, 'test-secret'); assert.equal(app.page.data.busy, '');
});

test('missing external API URL disables grant creation', async () => {
  const app = setup(); app.hooks.status = () => ({...status(), apiBaseUrl: ''});
  await app.page.onLoad(); await app.page.createGrant();
  assert.deepEqual(app.calls, [['status']]); assert.equal(app.page.data.activeGrant, false);
});

test('public connector addresses use the configured HTTPS origin without any grant', async () => {
  const app = setup();
  app.hooks.status = () => ({...status(), apiBaseUrl: 'https://tenant.example.test:8443/baby-bites-ai'});
  await app.page.onLoad();
  const address = format => app.page.copyAddress({currentTarget: {dataset: {format}}});
  address('mcp'); address('openapi'); address('other');
  app.page.copyToken();
  assert.deepEqual(app.clipboard, [
    'https://tenant.example.test:8443/baby-bites-tools/mcp',
    'https://tenant.example.test:8443/baby-bites-tools/openapi.json'
  ]);
  assert.deepEqual(app.calls, [['status']]);
});

test('grant lifecycle keeps token in page memory, copies only Authorization header, and revokes it', async () => {
  const app = setup(); await app.page.onLoad(); await app.page.createGrant();
  assert.equal(app.page._token, 'secret-value'); assert.equal(JSON.stringify(app.page.data).includes('secret-value'), false);
  app.page.copyConfiguration();
  const copied = JSON.parse(app.clipboard[0]);
  assert.equal(copied.url, 'https://api.example.test/ai/v1/feeding-context');
  assert.deepEqual(copied.query, {days: 7});
  assert.equal(copied.headers.Authorization, 'Bearer secret-value');
  assert.equal(copied.url.includes('secret'), false);
  app.page.copyToken(); assert.equal(app.clipboard[1], 'secret-value');
  app.page.copyAddress({currentTarget: {dataset: {format: 'mcp'}}});
  assert.equal(app.clipboard[2], 'https://api.example.test/baby-bites-tools/mcp');
  await app.page.revokeGrant();
  assert.equal(app.page._token, ''); assert.equal(app.page.data.activeGrant, false); assert.equal(app.page.data.tokenAvailable, false);
  app.page.copyConfiguration(); app.page.copyToken(); assert.equal(app.clipboard.length, 3);
});

test('expired grants cannot be copied and status-only reads never recover a previous secret', async () => {
  const app = setup(); await app.page.onLoad(); await app.page.createGrant();
  app.page._expiresAt = 1; app.page.copyToken(); app.page.copyConfiguration();
  assert.equal(app.clipboard.length, 0); assert.equal(app.page._token, ''); assert.equal(app.page.data.activeGrant, false);
  await app.page.createGrant();
  app.hooks.status = () => ({...status(), grant: {active: true, expiresAt: Date.now() + 10000}});
  await app.page.load();
  assert.equal(app.page.data.activeGrant, true); assert.equal(app.page.data.tokenAvailable, false); assert.equal(app.page._token, '');
  app.page.copyToken(); assert.equal(app.clipboard.length, 0);
});

test('an uncertain rotation stops offering the old token and an uncertain revocation can be retried', async () => {
  const app = setup(); await app.page.onLoad(); await app.page.createGrant();
  app.hooks.createGrant = () => {throw Error('网络断开');}; await app.page.createGrant();
  assert.equal(app.page._token, ''); assert.equal(app.page.data.tokenAvailable, false);
  assert.equal(app.page.data.activeGrant, true);
  app.hooks.revokeGrant = () => {throw Error('网络断开');}; await app.page.revokeGrant();
  assert.equal(app.page.data.activeGrant, true); assert.equal(app.page.data.busy, '');
  app.hooks.revokeGrant = () => ({revoked: true}); await app.page.revokeGrant();
  assert.equal(app.page.data.activeGrant, false);
});

test('scope changes clear the key and discard late grant responses even if the scope comes back', async () => {
  const app = setup(); await app.page.onLoad(); await app.page.createGrant();
  const wait = deferred(); app.hooks.createGrant = () => wait.promise;
  const pending = app.page.createGrant();
  app.setInfo({scope: {kind: 'family', id: 'c'.repeat(64), membershipId: 'd'.repeat(32)}});
  app.setInfo({scope: PERSONAL});
  wait.resolve({token: 'late-key', apiBaseUrl: status().apiBaseUrl, expiresAt: Date.now() + 86400000}); await pending;
  assert.equal(app.page._token, ''); assert.equal(app.page.data.locked, true);
  assert.equal(app.page.data.busy, '');
  const count = app.calls.length; await app.page.createGrant(); await app.page.load(); assert.equal(app.calls.length, count);
});

test('page unload clears the token and a pending grant cannot restore it', async () => {
  const app = setup(); await app.page.onLoad(); await app.page.createGrant();
  const wait = deferred(); app.hooks.createGrant = () => wait.promise; const pending = app.page.createGrant();
  app.page.onUnload(); wait.resolve({token: 'late-key', apiBaseUrl: status().apiBaseUrl, expiresAt: Date.now() + 86400000}); await pending;
  assert.equal(app.page._token, ''); assert.equal(app.listeners.size, 0);
});
