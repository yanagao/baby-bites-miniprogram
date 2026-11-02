'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup, pending, turn, clone, assertUnshareable, OWNER, OTHER, LOCAL_ID} = require('./detail-runtime.cjs');

test('deletion first persists the local tombstone then syncs it without an unpublish request', async () => {
  const app = setup({published: true}); const page = await app.open();
  app.hooks.sync = () => {
    assert.equal(app.store.getRecipe(LOCAL_ID), null);
    assert.equal(app.store.getState().logs.length, 0);
    assert.ok(app.store.getSyncSnapshot().deleted.recipes.some(item => item.id === LOCAL_ID));
    return {state: 'synced'};
  };
  page.remove(); assert.match(page.data.deleteContent, /同步后/); assertUnshareable(page);
  await page.confirmDelete();
  assert.equal(app.calls.sync, 1); assert.deepEqual(app.calls.unpublish, []); assert.equal(app.calls.backs, 1);
  assert.equal(app.store.getRecipe(LOCAL_ID), null); assertUnshareable(page);
});

test('canceling delete preserves the cookbook and avoids cloud writes', async () => {
  const app = setup({published: true}); const page = await app.open(); const before = clone(app.store.getState());
  page.remove(); page.cancelDelete(); await page.confirmDelete();
  assert.deepEqual(clone(app.store.getState()), before); assert.equal(app.calls.sync, 0);
  assert.equal(page.shareAvailable(), true);
});

test('offline deletion remains saved and pending for the next network connection', async () => {
  for (const status of ['pending', 'error', 'unconfigured']) {
    const app = setup({published: true}); const page = await app.open(); app.hooks.sync = () => ({state: status});
    page.remove(); await page.confirmDelete();
    assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.store.getSyncInfo().dirty, true);
    assert.deepEqual(app.calls.toasts, ['已删除，联网后同步']); assert.equal(app.calls.backs, 1);
  }
});

test('a failed local deletion does not start cloud sync or remove the existing recipe', async () => {
  const app = setup({published: true}); const page = await app.open();
  app.hooks.storage = () => { throw Error('Storage full'); };
  page.remove(); await page.confirmDelete();
  assert.ok(app.store.getRecipe(LOCAL_ID)); assert.equal(app.calls.sync, 0); assert.equal(app.calls.backs, 0);
  assert.ok(app.calls.errors.length); assert.equal(page.data.deleting, false);
});

test('an unexpected sync rejection cannot roll back a committed local deletion', async () => {
  const app = setup({published: true}); const page = await app.open();
  app.hooks.sync = () => { throw Error('Network unavailable'); };
  page.remove(); await page.confirmDelete();
  assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.calls.toasts, ['已删除，联网后同步']); assert.equal(app.calls.backs, 1);
  assert.deepEqual(app.calls.errors, []);
});

test('duplicate deletion taps cannot retry or navigate while one sync is pending', async () => {
  const app = setup({published: true}); const page = await app.open(); const gate = pending();
  app.hooks.sync = () => gate.promise; page.remove(); const work = page.confirmDelete();
  await page.confirmDelete(); page.favorite(); page.edit(); await page.requestShare();
  assert.equal(app.calls.sync, 1); assert.equal(app.calls.backs, 0); assert.deepEqual(app.calls.navigation, []);
  assertUnshareable(page); gate.resolve({state: 'synced'}); await work;
  assert.equal(app.calls.backs, 1); assert.equal(page.data.deleting, false);
});

test('delete completion cannot navigate or alter a switched account or unloaded page', async () => {
  for (const mode of ['switch', 'unload']) {
    const app = setup({published: true}); const page = await app.open(); const gate = pending();
    app.hooks.sync = () => gate.promise; page.remove(); const work = page.confirmDelete();
    if (mode === 'switch') app.store.bindAccount(OTHER); else page.onUnload();
    const updates = app.calls.updates; gate.resolve({state: 'pending'}); await work;
    assert.equal(app.calls.updates, updates); assert.equal(app.calls.backs, 0); assert.deepEqual(app.calls.toasts, []);
  }
});

test('deletion is still available locally when the social feature is disabled', async () => {
  const app = setup({enabled: false}); const page = await app.open();
  page.remove(); await page.confirmDelete();
  assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.calls.sync, 0); assert.equal(app.calls.mine, 0);
  assert.equal(app.calls.backs, 1);
});

test('store-only refreshes do not issue repeated server status reads', async () => {
  const app = setup({published: true}); const page = await app.open(); const reads = app.calls.mine;
  app.store.toggleFavorite(LOCAL_ID); page.refresh(); await turn();
  assert.equal(app.calls.mine, reads); assert.equal(page.data.publicChanged, true);
});
