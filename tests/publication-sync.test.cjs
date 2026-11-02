'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PROFILE_ID = 'c'.repeat(32);
const PUBLIC_ID = 'd'.repeat(64);
const SECOND_PUBLIC_ID = 'e'.repeat(64);
const MESSAGE = '菜谱已保存，公开内容暂未同步，请联网后重试。';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function pending() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
const publication = (sourceRecipeId = 'one', sourceUpdatedAt = 1, id = PUBLIC_ID) => ({id, sourceRecipeId, sourceUpdatedAt});

function setup(options = {}) {
  let owner = options.owner === undefined ? OWNER : options.owner;
  let current = true;
  const calls = [];
  const hooks = {};
  const state = {recipes: copy(options.recipes || [
    {id: 'one', name: '我的新菜名', updatedAt: 2, createdAt: 1, note: '私人心得', photo: 'wxfile://private-photo'},
    {id: 'private', name: '未公开菜谱', updatedAt: 10, createdAt: 1}
  ]), logs: [{id: 'meal', recipeId: 'one', note: '私人用餐记录'}], nickname: '宝宝私人称呼'};
  const mine = {profile: {id: PROFILE_ID, exists: true}, published: copy(options.published || [publication()])};
  const store = {getSyncInfo: () => ({owner}), getState: () => copy(state)};
  const wx = {cloud: {callFunction(args) {
    calls.push({name: args.name, config: copy(args.config), data: copy(args.data)});
    Promise.resolve().then(() => {
      if (hooks.request) return hooks.request(args.data, args);
      return args.data.action === 'mine' ? copy(mine) : {updated: true};
    }).then(result => args.success({result}), args.fail);
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
  return {calls, hooks, state, mine,
    run: () => module.exports.syncPublished({owner: OWNER, isCurrent: () => current}),
    setOwner(value) { owner = value; }, setCurrent(value) { current = value; }};
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

test('publication sync is disabled without invoking social APIs or changing local data', async () => {
  const app = setup({enabled: false});
  const before = copy(app.state);
  assert.deepEqual(copy(await app.run()), {updated: 0});
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.state, before);
});

test('private recipes and missing local recipes are never published by reconciliation', async () => {
  for (const published of [[], [publication('deleted')]]) {
    const app = setup({published});
    if (!published.length) app.mine.profile.exists = false;
    const before = copy(app.state);
    assert.deepEqual(copy(await app.run()), {updated: 0});
    assert.deepEqual(app.calls.map(call => call.data.action), ['mine']);
    assert.deepEqual(app.state, before);
  }
});

test('reconciliation only updates changed published IDs, deduplicates them, and sends no private content', async () => {
  const app = setup({recipes: [
    {id: 'one', updatedAt: 2, createdAt: 1, name: '新标题', note: '私人心得', photo: 'wxfile://private-photo'},
    {id: 'unchanged', updatedAt: 5, createdAt: 1},
    {id: 'legacy', createdAt: 7},
    {id: 'private', updatedAt: 10, name: '未公开菜谱'}
  ], published: [publication(), publication(), publication('unchanged', 5, SECOND_PUBLIC_ID),
    publication('legacy', 7, 'f'.repeat(64)), publication('deleted', 1, '1'.repeat(64))]});
  const before = copy(app.state);
  assert.deepEqual(copy(await app.run()), {updated: 1});
  assert.deepEqual(app.calls.map(call => call.data), [
    {action: 'mine', expectedOwner: OWNER},
    {action: 'updatePublished', sourceRecipeId: 'one', expectedOwner: OWNER}
  ]);
  for (const call of app.calls) {
    assert.equal(call.name, 'babyBitesSocial');
    assert.deepEqual(call.config, {env: 'cloud1-publication-test'});
  }
  assert.doesNotMatch(JSON.stringify(app.calls), /新标题|私人心得|private-photo|未公开菜谱|私人用餐|宝宝私人/);
  assert.deepEqual(app.state, before);
});

test('unknown or malformed publication lists fail before any update request', async () => {
  const invalid = [null, {}, {profile: {exists: true}}, {profile: null, published: []},
    {profile: {}, published: []}, {profile: {exists: true}, published: null},
    {profile: {exists: true}, published: [null]},
    {profile: {exists: true}, published: [publication(), {...publication(), sourceRecipeId: ''}]},
    {profile: {exists: true}, published: [publication('one', 1, 'invalid-public-id')]},
    {profile: {exists: true}, published: [publication('one', 'unknown')]}
  ];
  for (const result of invalid) {
    const app = setup(); app.hooks.request = () => result;
    await assert.rejects(app.run(), publicationFailure);
    assert.deepEqual(app.calls.map(call => call.data.action), ['mine']);
  }
});

test('updates run sequentially and a server-side withdrawal is a successful skip', async () => {
  const app = setup({recipes: [{id: 'one', updatedAt: 2}, {id: 'two', updatedAt: 2}],
    published: [publication(), publication('two', 1, SECOND_PUBLIC_ID)]});
  const gate = pending();
  app.hooks.request = data => data.action === 'mine' ? copy(app.mine)
    : data.sourceRecipeId === 'one' ? gate.promise : {updated: true};
  const work = app.run(); await turn();
  assert.deepEqual(app.calls.map(call => call.data.action), ['mine', 'updatePublished']);
  gate.resolve({updated: false});
  assert.deepEqual(copy(await work), {updated: 1});
  assert.deepEqual(app.calls.filter(call => call.data.action === 'updatePublished').map(call => call.data.sourceRecipeId), ['one', 'two']);
});

test('each queued update checks the latest local recipe state before issuing a request', async () => {
  const app = setup({recipes: [{id: 'one', updatedAt: 2}, {id: 'two', updatedAt: 2}],
    published: [publication(), publication('two', 1, SECOND_PUBLIC_ID)]});
  const gate = pending();
  app.hooks.request = data => data.action === 'mine' ? copy(app.mine) : gate.promise;
  const work = app.run(); await turn();
  app.state.recipes.find(recipe => recipe.id === 'two').updatedAt = 1;
  gate.resolve({updated: true});
  assert.deepEqual(copy(await work), {updated: 1});
  assert.deepEqual(app.calls.filter(call => call.data.action === 'updatePublished').map(call => call.data.sourceRecipeId), ['one']);
});

test('network or server update errors preserve a retryable public sync failure after private save', async () => {
  for (const mode of ['network', 'server']) {
    const app = setup(); let fail = true;
    app.hooks.request = data => {
      if (data.action === 'mine') return copy(app.mine);
      if (fail && mode === 'network') throw Error('network timeout');
      if (fail) return {error: {code: 'STORAGE_FAILED', message: 'private storage diagnostics'}};
      return {updated: true};
    };
    const before = copy(app.state);
    await assert.rejects(app.run(), error => {
      publicationFailure(error);
      if (mode === 'server') assert.equal(error.code, 'STORAGE_FAILED');
      assert.doesNotMatch(error.message, /private storage/);
      return true;
    });
    assert.deepEqual(app.state, before);
    fail = false;
    assert.deepEqual(copy(await app.run()), {updated: 1});
    assert.deepEqual(app.calls.map(call => call.data.action), ['mine', 'updatePublished', 'mine', 'updatePublished']);
  }
});

test('malformed update responses are not mistaken for a completed public sync', async () => {
  for (const result of [null, {}, {updated: 'yes'}, {updated: 1}]) {
    const app = setup();
    app.hooks.request = data => data.action === 'mine' ? copy(app.mine) : result;
    await assert.rejects(app.run(), publicationFailure);
  }
});

test('an invalidated session or different current owner cannot begin reconciliation', async () => {
  for (const mode of ['owner', 'session']) {
    const app = setup();
    if (mode === 'owner') app.setOwner(OTHER); else app.setCurrent(false);
    await assert.rejects(app.run(), accountFailure);
    assert.deepEqual(app.calls, []);
  }
});

test('owner changes while reading publication status cannot enqueue an update', async () => {
  const app = setup(), gate = pending(); app.hooks.request = () => gate.promise;
  const work = app.run(); await turn(); app.setOwner(OTHER);
  gate.resolve(copy(app.mine));
  await assert.rejects(work, accountFailure);
  assert.deepEqual(app.calls.map(call => call.data.action), ['mine']);
});

test('a session invalidated during an update stops the remaining batch even after A to B to A', async () => {
  const app = setup({recipes: [{id: 'one', updatedAt: 2}, {id: 'two', updatedAt: 2}],
    published: [publication(), publication('two', 1, SECOND_PUBLIC_ID)]});
  const gate = pending();
  app.hooks.request = data => data.action === 'mine' ? copy(app.mine) : gate.promise;
  const work = app.run(); await turn();
  app.setOwner(OTHER); app.setCurrent(false); app.setOwner(OWNER);
  gate.resolve({updated: true});
  await assert.rejects(work, accountFailure);
  assert.equal(app.calls.filter(call => call.data.action === 'updatePublished').length, 1);
});

test('server account mismatch is preserved instead of being reduced to a generic sync error', async () => {
  for (const action of ['mine', 'updatePublished']) {
    const app = setup();
    app.hooks.request = data => data.action === action ? {error: {code: 'ACCOUNT_CHANGED'}} : copy(app.mine);
    await assert.rejects(app.run(), accountFailure);
  }
});
