'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const MESSAGE = '本机修改已保存，菜谱暂未同步完成，请联网后重试。';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const result = (updated = 0, removed = 0, hasMore = false) => ({updated, removed, hasMore});
function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
function setup(options = {}) {
  let owner = OWNER, current = true, dirty = false, invalidations = 0;
  const calls = [], hooks = {};
  const state = {recipes: [{id: 'one', name: '用户菜谱', note: '私人心得', photo: 'wxfile://private-photo'},
    {id: 'pumpkin-millet', isExample: true}], logs: [{note: '私人用餐记录'}], nickname: '宝宝私人称呼'};
  const store = {getSyncInfo: () => ({owner, dirty}), getState: () => copy(state)};
  const wx = {cloud: {callFunction(args) {
    calls.push({name: args.name, config: copy(args.config), data: copy(args.data)});
    Promise.resolve().then(() => hooks.request ? hooks.request(args.data) : result()).then(value => args.success({result: value}), args.fail);
  }}};
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/publication-sync.js'), 'utf8'), {
    module, exports: module.exports, wx,
    require(name) {
      if (name === './store') return store;
      if (name === '../config/cloud') return {env: 'cloud1-publication-test', socialEnabled: options.enabled !== false};
      throw Error('Unexpected dependency: ' + name);
    }
  });
  return {calls, hooks, state,
    run: () => module.exports.syncPublished({owner: OWNER, isCurrent: () => current, onUpdated: () => invalidations++}),
    setOwner(value) { owner = value; }, setCurrent(value) { current = value; }, setDirty(value) { dirty = value; },
    invalidations: () => invalidations};
}

function publicationFailure(error) {
  assert.equal(error.userMessage, MESSAGE);
  assert.equal(error.message, MESSAGE);
  assert.equal(error.publicationPending, true);
  return true;
}
function accountFailure(error) {
  assert.equal(error.code, 'ACCOUNT_CHANGED');
  assert.equal(error.publicationPending, false);
  return true;
}

test('disabled sharing does not invoke cloud APIs or change local data', async () => {
  const app = setup({enabled: false}), before = copy(app.state);
  assert.deepEqual(copy(await app.run()), {updated: 0, removed: 0});
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.state, before);
});

test('reconciliation uses only the authenticated committed snapshot, never local recipe or baby content', async () => {
  const app = setup(), before = copy(app.state);
  app.hooks.request = () => result(2, 1);
  assert.deepEqual(copy(await app.run()), {updated: 2, removed: 1});
  assert.deepEqual(app.calls, [{name: 'babyBitesSocial', config: {env: 'cloud1-publication-test'},
    data: {action: 'syncPublications', expectedOwner: OWNER}}]);
  assert.doesNotMatch(JSON.stringify(app.calls), /用户菜谱|私人心得|private-photo|私人用餐|宝宝私人|pumpkin-millet/);
  assert.deepEqual(app.state, before);
  assert.equal(app.invalidations(), 1);
});

test('empty or unchanged snapshots complete without invalidating read caches', async () => {
  const app = setup();
  assert.deepEqual(copy(await app.run()), {updated: 0, removed: 0});
  assert.equal(app.calls.length, 1);
  assert.equal(app.invalidations(), 0);
});

test('bounded batches run sequentially and include completed deletions', async () => {
  const app = setup(), gate = pending();
  app.hooks.request = () => app.calls.length === 1 ? gate.promise : result(1, 2);
  const work = app.run(); await turn();
  assert.equal(app.calls.length, 1);
  gate.resolve(result(8, 0, true));
  assert.deepEqual(copy(await work), {updated: 9, removed: 2});
  assert.equal(app.calls.length, 2);
  assert.equal(app.invalidations(), 2);
});

test('local edits pause further batches so their snapshot can be committed first', async () => {
  const app = setup(), gate = pending();
  app.hooks.request = () => gate.promise;
  const work = app.run(); await turn();
  app.setDirty(true); gate.resolve(result(2, 0, true));
  assert.deepEqual(copy(await work), {updated: 2, removed: 0});
  assert.equal(app.calls.length, 1);
  app.calls.length = 0;
  assert.deepEqual(copy(await app.run()), {updated: 0, removed: 0});
  assert.deepEqual(app.calls, []);
});

test('partial server failure invalidates completed changes and retries without altering local data', async () => {
  const app = setup(), before = copy(app.state);
  app.hooks.request = () => ({...result(1, 1), error: {code: 'STORAGE_FAILED', message: 'private diagnostics'}});
  await assert.rejects(app.run(), error => {
    publicationFailure(error); assert.equal(error.code, 'STORAGE_FAILED');
    assert.doesNotMatch(error.message, /private diagnostics/); return true;
  });
  assert.equal(app.invalidations(), 1);
  assert.deepEqual(app.state, before);
  app.hooks.request = () => result(1);
  assert.deepEqual(copy(await app.run()), {updated: 1, removed: 0});
  assert.equal(app.calls.length, 2);
});

test('lost responses invalidate caches because the server may have completed a write', async () => {
  const app = setup(); app.hooks.request = () => { throw Error('network timeout'); };
  await assert.rejects(app.run(), error => publicationFailure(error) && error.code === 'NETWORK');
  assert.equal(app.calls.length, 1);
  assert.equal(app.invalidations(), 1);
});

test('malformed counts and continuation responses cannot signal successful synchronization', async () => {
  for (const value of [null, [], {}, {updated: true}, result(-1), result(1.5), result(9), result(1, -1),
    {updated: 0, removed: 0}, {...result(), hasMore: 'yes'}, result(0, 0, true)]) {
    const app = setup(); app.hooks.request = () => value;
    await assert.rejects(app.run(), publicationFailure);
    assert.equal(app.calls.length, 1);
  }
});

test('continuous remote changes are bounded and leave remaining work retryable', async () => {
  const app = setup(); app.hooks.request = () => result(1, 0, true);
  await assert.rejects(app.run(), publicationFailure);
  assert.equal(app.calls.length, 250);
  assert.equal(app.invalidations(), 250);
});

test('invalidated sessions and different owners cannot begin reconciliation', async () => {
  for (const mode of ['owner', 'session']) {
    const app = setup();
    if (mode === 'owner') app.setOwner(OTHER); else app.setCurrent(false);
    await assert.rejects(app.run(), accountFailure);
    assert.deepEqual(app.calls, []);
  }
});

test('account changes during a request discard its response and never invalidate the next account cache', async () => {
  for (const aba of [false, true]) {
    const app = setup(), gate = pending(); app.hooks.request = () => gate.promise;
    const work = app.run(); await turn();
    app.setOwner(OTHER);
    if (aba) { app.setCurrent(false); app.setOwner(OWNER); }
    gate.resolve(result(1, 0, true));
    await assert.rejects(work, accountFailure);
    assert.equal(app.calls.length, 1);
    assert.equal(app.invalidations(), 0);
  }
});

test('server account mismatch is preserved instead of reduced to a retryable sync error', async () => {
  const app = setup(); app.hooks.request = () => ({error: {code: 'ACCOUNT_CHANGED'}});
  await assert.rejects(app.run(), accountFailure);
  assert.equal(app.invalidations(), 0);
});
