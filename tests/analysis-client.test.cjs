'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const PERSONAL = {kind: 'personal', id: OWNER};
const FAMILY = {kind: 'family', id: 'c'.repeat(64), membershipId: 'd'.repeat(32)};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {resolve, promise};};

function setup() {
  let info = {owner: OWNER, scope: PERSONAL, dirty: false, blocked: false};
  const listeners = new Set(), calls = [], hooks = {};
  const store = {getSyncInfo: () => clone(info), subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const setInfo = patch => {info = {...info, ...patch}; listeners.forEach(fn => fn(store.getSyncInfo()));};
  const good = () => ({owner: info.owner, scope: info.scope, apiBaseUrl: '', grant: null});
  const wx = {cloud: {callFunction(options) {
    calls.push(clone(options));
    Promise.resolve().then(() => hooks.request ? hooks.request(options.data) : good()).then(result => options.success({result}), options.fail);
  }}};
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/ai-analysis.js'), 'utf8'), {module, wx, Date,
    require(name) {if (name === './store') return store; if (name === '../config/cloud') return {env: 'test-env'}; throw Error('Unexpected dependency ' + name);}});
  return {api: module.exports, calls, hooks, setInfo, good};
}

test('analysis status is a read-only scoped call without synchronizing or sending private data', async () => {
  const app = setup();
  const result = await app.api.status();
  assert.equal(result.grant, null);
  assert.deepEqual(app.calls, [{name: 'babyBitesAnalysis', config: {env: 'test-env'}, data: {
    action: 'status', protocolVersion: 2, expectedOwner: OWNER, expectedScope: PERSONAL
  }}]);
});

test('late responses are rejected after account switches, family changes and same-scope ABA', async () => {
  for (const change of ['account', 'family', 'aba', 'membership']) {
    const app = setup(), wait = deferred();
    if (change === 'membership') app.setInfo({scope: FAMILY});
    const before = app.good(); app.hooks.request = () => wait.promise;
    const pending = app.api.status();
    if (change === 'account') app.setInfo({owner: OTHER, scope: {kind: 'personal', id: OTHER}});
    if (change === 'family' || change === 'aba') app.setInfo({scope: FAMILY});
    if (change === 'aba') app.setInfo({scope: PERSONAL});
    if (change === 'membership') app.setInfo({scope: {...FAMILY, membershipId: 'e'.repeat(32)}});
    wait.resolve(before);
    await assert.rejects(pending, error => error.code === 'ACCOUNT_CHANGED');
  }
});

test('wrong response owner or membership is never accepted', async () => {
  const app = setup();
  app.hooks.request = () => ({...app.good(), owner: OTHER});
  await assert.rejects(app.api.status(), error => error.code === 'ACCOUNT_CHANGED');
  app.setInfo({scope: FAMILY});
  app.hooks.request = () => ({...app.good(), scope: {...FAMILY, membershipId: 'e'.repeat(32)}});
  await assert.rejects(app.api.status(), error => error.code === 'FAMILY_CHANGED');
});

test('authorization service failures produce bounded user-facing messages', async () => {
  const app = setup();
  app.hooks.request = () => ({error: {code: 'API_NOT_CONFIGURED'}});
  await assert.rejects(app.api.createGrant(), error => error.code === 'API_NOT_CONFIGURED' && /尚未配置/.test(error.message));
  app.hooks.request = () => ({error: {code: 'UPSTREAM', message: 'secret upstream diagnostic'}});
  await assert.rejects(app.api.createGrant(), error => !/secret/.test(error.message));
  app.hooks.request = () => {throw Error('secret transport diagnostic');};
  await assert.rejects(app.api.createGrant(), error => error.code === 'NETWORK' && !/secret/.test(error.message));
});

test('grant secrets must be valid, current and paired with a safe HTTPS API base', async () => {
  const app = setup(), expiresAt = Date.now() + 100000;
  app.hooks.request = () => ({...app.good(), token: 'bbai_' + 'x'.repeat(64), expiresAt, apiBaseUrl: 'https://api.example.test/ai/'});
  const grant = await app.api.createGrant();
  assert.equal(grant.apiBaseUrl, 'https://api.example.test/ai');
  for (const apiBaseUrl of ['http://api.example.test', 'https://user:password@api.example.test', 'https://api.example.test?token=secret', 'javascript:alert(1)', '']) {
    app.hooks.request = () => ({...app.good(), token: 'bbai_' + 'x'.repeat(64), expiresAt, apiBaseUrl});
    await assert.rejects(app.api.createGrant());
  }
  app.hooks.request = () => ({...app.good(), token: 'bbai_' + 'x'.repeat(64), expiresAt: 1, apiBaseUrl: 'https://api.example.test'});
  await assert.rejects(app.api.createGrant());
});

test('unconfirmed revocation is rejected', async () => {
  const app = setup();
  app.hooks.request = () => ({...app.good(), revoked: false});
  await assert.rejects(app.api.revokeGrant(), /撤销未确认/);
  app.hooks.request = () => ({...app.good(), revoked: true});
  assert.equal((await app.api.revokeGrant()).revoked, true);
});

test('missing identity and blocked scopes cannot reach analysis service', async () => {
  const app = setup(); app.setInfo({owner: '', scope: null});
  await assert.rejects(app.api.status(), error => error.code === 'UNAUTHENTICATED');
  app.setInfo({owner: OWNER, scope: PERSONAL, blocked: true});
  await assert.rejects(app.api.createGrant(), error => error.code === 'SYNC_REQUIRED');
  assert.equal(app.calls.length, 0);
});
