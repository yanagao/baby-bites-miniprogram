'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const PERSONAL = {kind: 'personal', id: OWNER}, FAMILY = {kind: 'family', id: 'c'.repeat(64), membershipId: 'd'.repeat(32)};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {resolve, promise};};
function setup() {
  let owner = OWNER, scope = PERSONAL, serverScope = PERSONAL, locks = 0, dirty = false, sequence = 1;
  const listeners = new Set(), calls = [], syncCalls = [], hooks = {};
  const key = () => owner + ':' + scope.kind + ':' + scope.id + (scope.membershipId ? ':' + scope.membershipId : '');
  const getInfo = () => ({owner, scope: clone(scope), scopeKey: key(), revision: 3, sequence, dirty, blocked: false});
  const notify = () => listeners.forEach(fn => fn(getInfo()));
  const setScope = value => {scope = clone(value); notify();};
  const store = {getSyncInfo: getInfo, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    beginScopeChange() {if (hooks.beforeLock) hooks.beforeLock(); locks++; return () => {locks--;};}};
  const familyView = () => scope.kind === 'family' ? {id: scope.id, name: '小米家', isManager: true, members: [], memberCount: 1} : null;
  const cloudSync = {async syncNow(options) {
    syncCalls.push(options); if (hooks.sync) {const result = await hooks.sync(options); if (result) return result;}
    if (JSON.stringify(scope) !== JSON.stringify(serverScope)) setScope(serverScope);
    return {state: 'synced', owner};
  }};
  const wx = {cloud: {callFunction(options) {
    calls.push(clone(options.data));
    Promise.resolve().then(async () => {
      if (hooks.request) return hooks.request(options.data);
      if (options.data.action === 'familyCreate' || options.data.action === 'familyJoin') serverScope = FAMILY;
      if (options.data.action === 'familyLeave') serverScope = PERSONAL;
      return {owner, scope: serverScope, family: familyView()};
    }).then(result => options.success({result}), options.fail);
  }}};
  const mod = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/family.js'), 'utf8'), {module: mod, wx,
    require(name) {if (name === './store') return store; if (name === './cloud-sync') return cloudSync; if (name === '../config/cloud') return {env: 'test', functionName: 'babyBitesSync'}; throw Error(name);}});
  return {api: mod.exports, calls, syncCalls, hooks, setScope, getInfo, locks: () => locks,
    setDirty(value = true) {dirty = value; sequence++; notify();},
    setServerScope(value) {serverScope = clone(value);}, setOwner(value) {owner = value; scope = {kind: 'personal', id: value}; serverScope = scope; notify();}};
}
test('family info caches for the same scope and force reload bypasses the cache', async () => {
  const app = setup(); await app.api.info(); await app.api.info(); assert.equal(app.calls.length, 1);
  await app.api.info({force: true}); assert.equal(app.calls.length, 2);
  app.setServerScope(FAMILY); await app.api.info(); assert.equal(app.calls.length, 3);
  assert.deepEqual(app.calls[2].expectedScope, FAMILY);
});
test('a publication-only failure does not block authenticated family reads or invitations', async () => {
  const app = setup(); app.setScope(FAMILY); app.setServerScope(FAMILY);
  app.hooks.sync = () => ({state: 'synced', owner: OWNER, publicationPending: true,
    publicationErrorCode: 'INVALID_REQUEST', publicationMessage: '记录已同步，公开菜谱服务需要更新，请稍后重试。'});
  const result = await app.api.info();
  assert.equal(result.family.id, FAMILY.id);
  assert.equal(app.calls[0].action, 'familyState');
  assert.deepEqual(app.calls[0].expectedScope, FAMILY);
  await app.api.invite();
  assert.equal(app.calls[1].action, 'familyInvite');
  assert.deepEqual(app.calls[1].expectedScope, FAMILY);
  assert.equal(app.calls[1].expectedOwner, OWNER);
  assert.equal(app.locks(), 0);
});
test('public retry state cannot bypass private pending data or dirty checks, even with a cached family', async () => {
  for (const condition of ['pending', 'error', 'dirty']) {
    const app = setup(); app.setScope(FAMILY); app.setServerScope(FAMILY);
    await app.api.info();
    app.hooks.sync = () => ({state: condition === 'dirty' ? 'synced' : condition,
      owner: OWNER, publicationPending: true, message: '当前数据尚未同步'});
    if (condition === 'dirty') app.setDirty();
    await assert.rejects(app.api.info(), error => error.code === 'SYNC_REQUIRED');
    await assert.rejects(app.api.invite(), error => error.code === 'SYNC_REQUIRED');
    assert.equal(app.calls.length, 1, 'only the original clean family read reaches the backend');
    assert.equal(app.locks(), 0);
  }
});
test('create synchronizes first, stamps protocol and expected scope, then verifies the resulting scope before unlocking', async () => {
  const app = setup(); const result = await app.api.create({name: '小米家', label: '妈妈'});
  assert.equal(app.calls[0].action, 'familyCreate'); assert.equal(app.calls[0].roleLabel, '妈妈');
  assert.equal(app.calls[0].protocolVersion, 2); assert.equal(app.calls[0].expectedOwner, OWNER);
  assert.deepEqual(app.calls[0].expectedScope, PERSONAL); assert.equal(app.calls[0].baseRevision, 3);
  assert.match(app.calls[0].requestId, /^[A-Za-z0-9_-]{8,100}$/);
  assert.equal(result.scope.kind, 'family'); assert.equal(app.getInfo().scope.kind, 'family');
  assert.equal(app.syncCalls.length, 2); assert.equal(app.locks(), 0);
});
test('a lost create response retries the exact request and original scope even after server membership changed', async () => {
  const app = setup(); let attempts = 0;
  app.hooks.request = data => {
    if (data.action === 'familyCreate') {app.setServerScope(FAMILY); if (++attempts === 1) throw Error('response lost');}
    return {owner: OWNER, scope: FAMILY, family: {id: FAMILY.id}};
  };
  await assert.rejects(app.api.create({name: '小米家', label: '妈妈'}), error => error.code === 'NETWORK');
  await app.api.create({name: '小米家', label: '妈妈'});
  assert.equal(app.calls[0].requestId, app.calls[1].requestId); assert.deepEqual(app.calls[1].expectedScope, PERSONAL);
});
test('a management result performs a fresh check when it first joins a pre-transition foreground sync', async () => {
  const app = setup(); let reads = 0;
  app.hooks.sync = () => {if (++reads === 2) return {state: 'synced', owner: OWNER};};
  const result = await app.api.create({name: '小米家', label: '妈妈'});
  assert.equal(result.scope.kind, 'family'); assert.equal(app.getInfo().scope.kind, 'family');
  assert.equal(app.syncCalls.length, 3); assert.equal(app.locks(), 0);
});
test('failed pre-transition sync prevents mutation and never acquires a write lock', async () => {
  const app = setup(); app.hooks.sync = () => ({state: 'pending', owner: OWNER, message: '先完成同步'});
  await assert.rejects(app.api.join({token: 'invite', label: '爸爸'}), /先完成同步/);
  assert.equal(app.calls.length, 0); assert.equal(app.locks(), 0);
});
test('an edit after synced preflight but before the write lock prevents leaving or inviting', async () => {
  for (const action of ['leave', 'invite']) {
    for (const dirty of [true, false]) {
      const app = setup(); app.setScope(FAMILY); app.setServerScope(FAMILY);
      app.hooks.beforeLock = () => app.setDirty(dirty);
      await assert.rejects(app.api[action](), error => error.code === 'SYNC_REQUIRED');
      assert.equal(app.calls.length, 0); assert.equal(app.locks(), 0);
      assert.deepEqual(app.getInfo().scope, FAMILY);
    }
  }
});
test('a family change during sync cannot retarget an old leave or invite action', async () => {
  for (const action of ['leave', 'invite']) {
    const app = setup(); app.setScope(FAMILY); app.setServerScope(FAMILY);
    app.hooks.sync = () => {app.setScope(PERSONAL); app.setServerScope(PERSONAL); return {state: 'synced', owner: OWNER};};
    await assert.rejects(app.api[action](), error => ['FAMILY_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code));
    assert.equal(app.calls.length, 0); assert.equal(app.locks(), 0);
  }
});
test('membership ABA during preflight cannot submit a stale manager action', async () => {
  const app = setup(); app.setScope(FAMILY); app.setServerScope(FAMILY);
  app.hooks.sync = () => {app.setScope(PERSONAL); app.setScope(FAMILY); return {state: 'synced', owner: OWNER};};
  await assert.rejects(app.api.remove('e'.repeat(32)), error => error.code === 'FAMILY_CHANGED'); assert.equal(app.calls.length, 0);
});
test('duplicate actions share work and a different concurrent action is rejected', async () => {
  const app = setup(), gate = deferred(); app.hooks.request = async () => {await gate.promise; app.setServerScope(FAMILY); return {owner: OWNER, scope: FAMILY, family: {id: FAMILY.id}};};
  const first = app.api.create({name: '小米家', label: '妈妈'}), duplicate = app.api.create({name: '小米家', label: '妈妈'});
  await assert.rejects(app.api.join({token: 'different', label: '爸爸'}), error => error.code === 'FAMILY_BUSY');
  gate.resolve(); await Promise.all([first, duplicate]); assert.equal(app.calls.length, 1); assert.equal(app.locks(), 0);
});
test('late family responses from an account switch are rejected and locks are released', async () => {
  const app = setup(), gate = deferred(); app.hooks.request = async () => {await gate.promise; return {owner: OWNER, scope: FAMILY, family: {id: FAMILY.id}};};
  const work = app.api.create({name: '小米家', label: '妈妈'});
  while (!app.calls.length) await new Promise(resolve => setImmediate(resolve));
  app.setOwner(OTHER); gate.resolve(); await assert.rejects(work, error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(app.locks(), 0);
});
test('preview reads the invitation without joining or creating a family', async () => {
  const app = setup(); app.hooks.request = () => ({owner: OWNER, scope: PERSONAL, name: '小米家', nickname: '小米', memberCount: 3, expiresAt: 123});
  const result = await app.api.preview('opaque-token');
  assert.equal(result.memberCount, 3); assert.equal(app.calls.length, 1); assert.equal(app.calls[0].action, 'familyPreview');
  assert.equal(app.getInfo().scope.kind, 'personal');
});
