'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fakeEnvironment, ownerFor, fileFor, ENV, GRANTS} = require('./helpers/analysis-cloud.cjs');
const decode = response => JSON.parse(response.body);

test('analysis management derives owner from trusted WeChat context and refuses mismatched scope', async () => {
  const app = fakeEnvironment(); app.seed('bob');
  assert.equal((await app.internal('status', {expectedOwner: ownerFor('bob')})).error.code, 'ACCOUNT_CHANGED');
  assert.equal((await app.internal('status', {expectedScope: {kind: 'personal', id: ownerFor('bob')}})).error.code, 'FAMILY_CHANGED');
  app.context({ENV});
  assert.equal((await app.internal('createGrant')).error.code, 'UNAUTHENTICATED');
  assert.equal(app.writes, 0); assert.equal(app.downloads.length, 0);
});

test('status provides only grant metadata and an old in-app analysis request is rejected before reading records', async () => {
  const app = fakeEnvironment();
  assert.deepEqual(await app.internal('status'), {
    owner: ownerFor(), scope: app.scopeFor(), apiBaseUrl: 'https://analysis.example.test/baby-bites-ai', grant: null
  });
  const result = await app.internal('analyze', {query: {days: 7}});
  assert.equal(result.error.code, 'INVALID_REQUEST');
  assert.equal(app.downloads.length, 0);
  assert.equal(app.writes, 0);
});

test('external grant is random, expires in seven days, stores only a hash, and status never retrieves its secret', async () => {
  const app = fakeEnvironment(); const created = await app.internal('createGrant');
  assert.match(created.token, /^bbai_[a-f0-9]{32}\.[a-f0-9]{64}$/);
  assert.equal(created.expiresAt - app.time, 7 * 86400000);
  const stored = app.grantRecord();
  assert.equal(stored.tokenHash, crypto.createHash('sha256').update(created.token).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(created.token), false);
  const status = await app.internal('status');
  assert.deepEqual(status.grant, {active: true, expiresAt: created.expiresAt});
  assert.equal(Object.hasOwn(status, 'token'), false); assert.equal(JSON.stringify(status).includes(stored.tokenHash), false);
});

test('external bearer reads a minimized cloud snapshot without a WeChat user identity', async () => {
  const app = fakeEnvironment(); const {token} = await app.internal('createGrant'); app.context({ENV});
  const response = await app.http(token, {queryStringParameters: {days: '7'}});
  assert.equal(response.statusCode, 200, response.body);
  const result = decode(response);
  assert.equal(result.summary.recordCount, 1); assert.equal(result.records[0].rating, 0);
  assert.equal(result.baby.ageMonths, 10); assert.equal(result.source.revision, 1);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  for (const privateValue of ['PRIVATE BABY NAME', 'PRIVATE FAMILY', 'PRIVATE RECIPE NOTE', ownerFor(), fileFor(), '2026-01-27', 'private-recipe-id', 'private-log-id']) {
    assert.equal(response.body.includes(privateValue), false, privateValue);
  }
});

test('a gateway mounted on the full route can forward its root with or without a slash', async () => {
  const app = fakeEnvironment();
  const {token} = await app.internal('createGrant');
  for (const path of ['/', '']) {
    const anonymous = await app.http(null, {path, headers: {}});
    assert.equal(anonymous.statusCode, 401);
    assert.equal(decode(anonymous).error.code, 'INVALID_TOKEN');
    assert.equal((await app.http(token, {path, httpMethod: 'POST'})).statusCode, 405);
    const authorized = await app.http(token, {path});
    assert.equal(authorized.statusCode, 200);
    assert.equal(decode(authorized).summary.recordCount, 1);
  }
  for (const path of ['/extra', '/baby-bites-ai/v1/feeding-context/extra', undefined, null, false]) {
    const response = await app.http(token, {path});
    assert.equal(response.statusCode, 404);
    assert.equal(decode(response).error.code, 'NOT_FOUND');
  }
  assert.equal(app.downloads.length, 2);
});

test('HTTP can resolve its environment without WeChat context, but management still requires trusted WeChat identity', async () => {
  for (const env of [{TCB_ENV: ENV}, {SCF_NAMESPACE: ENV}]) {
    const app = fakeEnvironment({env});
    const {token} = await app.internal('createGrant');
    app.context({});
    assert.equal((await app.http(token)).statusCode, 200);
    const result = await app.internal('createGrant', {OPENID: 'alice', APPID: 'wx-analysis-test'});
    assert.equal(result.error.code, 'UNAUTHENTICATED');
  }

  const app = fakeEnvironment();
  const {token} = await app.internal('createGrant');
  app.context({});
  const result = await app.http(token, {requestContext: {ENV}, headers: {Authorization: 'Bearer ' + token, 'x-env': ENV}});
  assert.equal(decode(result).error.code, 'INVALID_ENV');
});

test('HTTP cannot invoke management or analysis even if it embeds trusted-looking event values', async () => {
  const app = fakeEnvironment(); const {token} = await app.internal('createGrant'); const before = app.grantRecord();
  for (const action of ['createGrant', 'revokeGrant', 'analyze']) {
    const response = await app.http(token, {httpMethod: 'POST', action, expectedOwner: ownerFor(), expectedScope: app.scopeFor(),
      body: JSON.stringify({action, protocolVersion: 2, expectedOwner: ownerFor()})});
    assert.equal(response.statusCode, 405); assert.equal(decode(response).error.code, 'METHOD_NOT_ALLOWED');
  }
  assert.deepEqual(app.grantRecord(), before);
});

test('bearer accepts exactly one authorization header and never URL, body, account or file selectors', async () => {
  const app = fakeEnvironment(); const {token} = await app.internal('createGrant');
  const cases = [
    {headers: {}}, {headers: {Authorization: 'Bearer bad'}}, {headers: {Authorization: ['Bearer ' + token]}},
    {headers: {Authorization: 'Bearer ' + token, authorization: 'Bearer ' + token}},
    {queryStringParameters: {token}}, {queryStringParameters: {owner: ownerFor()}},
    {queryStringParameters: {fileID: fileFor()}}, {headers: {}, body: JSON.stringify({token})}
  ];
  for (const input of cases) { const response = await app.http(token, input); assert.ok([400, 401].includes(response.statusCode), response.body); }
  assert.equal(app.downloads.length, 0);
  const response = await app.http(token, {headers: {authorization: 'Bearer ' + token}});
  assert.equal(response.statusCode, 200, response.body);
});

test('rotation, revocation and expiry reject old authorization before reading private snapshots', async () => {
  const app = fakeEnvironment(); const first = await app.internal('createGrant');
  app.tick(5000); const second = await app.internal('createGrant'); assert.notEqual(first.token, second.token);
  assert.equal((await app.http(first.token)).statusCode, 401);
  assert.equal((await app.http(second.token)).statusCode, 200);
  const reads = app.downloads.length;
  assert.equal((await app.internal('revokeGrant')).revoked, true);
  assert.equal((await app.http(second.token)).statusCode, 401); assert.equal(app.downloads.length, reads);
  const third = await app.internal('createGrant'); app.tick(7 * 86400000);
  assert.equal((await app.http(third.token)).statusCode, 401); assert.equal(app.downloads.length, reads);
});

test('joining or leaving a family and a new membership invalidate an existing grant', async () => {
  const app = fakeEnvironment(); const personal = await app.internal('createGrant');
  app.joinFamily(); assert.equal((await app.http(personal.token)).statusCode, 401);
  app.tick(5000); const family = await app.internal('createGrant');
  assert.equal((await app.http(family.token)).statusCode, 200);
  app.joinFamily({membershipId: 'c'.repeat(32)});
  assert.equal((await app.http(family.token)).statusCode, 401);
  app.set('baby_bites_family_memberships', ownerFor(), {active: false, previousFamilyId: 'f'.repeat(64), updatedAt: app.time});
  assert.equal((await app.http(family.token)).statusCode, 401);
  assert.equal((await app.http(personal.token)).statusCode, 401, 'returning to personal data cannot revive its old grant');
});

test('an in-flight external read cannot return data after revocation or token rotation', async () => {
  for (const action of ['revokeGrant', 'createGrant']) {
    const app = fakeEnvironment(); const first = await app.internal('createGrant'); app.tick(5000);
    app.onDownload(async () => { const result = await app.internal(action); assert.equal(!!result.error, false); });
    const response = await app.http(first.token);
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(Object.hasOwn(decode(response), 'records'), false);
  }
});

test('an in-flight external read cannot return another revision or a removed family snapshot', async () => {
  const app = fakeEnvironment(); const {token} = await app.internal('createGrant');
  app.onDownload(() => { const account = app.get('baby_bites_accounts', ownerFor()); app.set('baby_bites_accounts', ownerFor(), {...account, revision: 2}); });
  assert.equal((await app.http(token)).statusCode, 409);
  const familyApp = fakeEnvironment(); familyApp.joinFamily(); const family = await familyApp.internal('createGrant');
  familyApp.onDownload(() => familyApp.set('baby_bites_family_memberships', ownerFor(), {active: false, updatedAt: familyApp.time}));
  const response = await familyApp.http(family.token);
  assert.equal(response.statusCode, 401); assert.equal(decode(response).error.code, 'INVALID_TOKEN');
  assert.equal(Object.hasOwn(decode(response), 'records'), false);
});

test('external minute and day quotas are consumed atomically before reading snapshots', async () => {
  const app = fakeEnvironment(); const {token} = await app.internal('createGrant');
  app.grantRecordSet({...app.grantRecord(), minute: Math.floor(app.time / 60000), minuteCount: 59});
  const results = await Promise.all([app.http(token), app.http(token)]);
  assert.deepEqual(results.map(item => item.statusCode).sort(), [200, 429]);
  assert.equal(app.downloads.length, 1);
  app.tick(60000); app.grantRecordSet({...app.grantRecord(), day: Math.floor(app.time / 86400000), dayCount: 1000});
  assert.equal((await app.http(token)).statusCode, 429); assert.equal(app.downloads.length, 1);
});

test('external read errors never echo private storage diagnostics', async () => {
  const app = fakeEnvironment();
  const {token} = await app.internal('createGrant');
  app.files.delete(fileFor());
  const result = await app.http(token);
  assert.equal(result.statusCode, 503);
  assert.equal(decode(result).error.code, 'ANALYSIS_FAILED');
  assert.equal(result.body.includes('sensitive storage detail'), false);
});

test('an unconfigured external URL cannot issue an unusable grant', async () => {
  const app = fakeEnvironment({env: {ANALYSIS_API_BASE_URL: ''}});
  assert.equal((await app.internal('createGrant')).error.code, 'API_NOT_CONFIGURED');
  assert.equal(app.writes, 0); assert.equal(app.records.has(GRANTS + ':' + ownerFor()), false);
});

test('real analysis client accepts the real backend status, grant and revocation contracts', async () => {
  const backend = fakeEnvironment();
  const module = {exports: {}};
  const store = {getSyncInfo: () => ({owner: ownerFor(), scope: backend.scopeFor(), blocked: false}), subscribe() { return () => {}; }};
  class FixedDate extends Date { static now() { return backend.time; } }
  const requests = [];
  const wx = {cloud: {callFunction(options) {
    requests.push(options.data);
    assert.equal(options.name, 'babyBitesAnalysis');
    backend.handler(options.data).then(result => options.success({result}), options.fail);
  }}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/ai-analysis.js'), 'utf8'), {
    module, wx, Date: FixedDate,
    require(name) {
      if (name === './store') return store;
      if (name === '../config/cloud') return {env: ENV};
      throw Error('Unexpected client dependency ' + name);
    }
  });
  const client = module.exports;
  assert.equal((await client.status()).grant, null);
  const grant = await client.createGrant();
  assert.equal(grant.apiBaseUrl, 'https://analysis.example.test/baby-bites-ai');
  assert.equal((await backend.http(grant.token, {queryStringParameters: {days: '30'}})).statusCode, 200);
  assert.equal((await client.revokeGrant()).revoked, true);
  assert.equal((await backend.http(grant.token)).statusCode, 401);
  assert.deepEqual(requests.map(item => item.action), ['status', 'createGrant', 'revokeGrant']);
  assert.equal(JSON.stringify(requests).includes('PRIVATE BABY NAME'), false);
});
