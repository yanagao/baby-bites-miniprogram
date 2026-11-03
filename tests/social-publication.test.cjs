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

test('offline deletion returns immediately and leaves the tombstone pending without a late toast', async () => {
  for (const status of ['pending', 'error', 'unconfigured']) {
    const app = setup({published: true}); const page = await app.open(); app.hooks.sync = () => ({state: status});
    page.remove(); page.confirmDelete();
    assert.equal(app.calls.backs, 1);
    await turn();
    assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.store.getSyncInfo().dirty, true);
    assert.deepEqual(app.calls.toasts, []); assert.equal(app.calls.backs, 1);
  }
});

test('a failed local deletion does not start cloud sync or remove the existing recipe', async () => {
  const app = setup({published: true}); const page = await app.open();
  app.hooks.storage = () => { throw Error('Storage full'); };
  page.remove(); await page.confirmDelete();
  assert.ok(app.store.getRecipe(LOCAL_ID)); assert.equal(app.calls.sync, 0); assert.equal(app.calls.backs, 0);
  assert.ok(app.calls.errors.length); assert.equal(page.data.deleting, false);
  assert.ok(page.data.recipe); assert.equal(page.data.deleteVisible, false);
  delete app.hooks.storage;
  page.remove(); await page.confirmDelete();
  assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.calls.backs, 1);
});

test('an unexpected sync rejection cannot roll back a committed local deletion', async () => {
  const app = setup({published: true}); const page = await app.open();
  app.hooks.sync = () => { throw Error('Network unavailable'); };
  page.remove(); await page.confirmDelete(); await turn();
  assert.equal(app.store.getRecipe(LOCAL_ID), null); assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.calls.toasts, []); assert.equal(app.calls.backs, 1);
  assert.deepEqual(app.calls.errors, []);
});

test('a failed local deletion during share preparation leaves sharing retryable', async () => {
  const app = setup(), page = await app.open(), gate = pending();
  const oldLink = {recipe: {id: 'c'.repeat(64), name: '旧分享'}, localVersion: JSON.stringify(app.store.getRecipe(LOCAL_ID))};
  app.hooks.link = () => gate.promise;
  const oldRequest = page.refreshPublication();
  assert.equal(page.data.publicLoading, true);
  app.hooks.storage = () => { throw Error('Storage full'); };
  page.remove(); page.confirmDelete();
  assert.ok(app.store.getRecipe(LOCAL_ID)); assert.equal(page.data.publicLoading, false);
  assert.equal(page.data.deleting, false); assert.equal(app.calls.backs, 0);
  delete app.hooks.link; delete app.hooks.storage;
  await page.requestShare(); assert.equal(page.data.shareReady, true);
  const updates = app.calls.updates;
  gate.resolve(oldLink); await oldRequest;
  assert.equal(app.calls.updates, updates);
  assert.doesNotMatch(page.onShareAppMessage().title, /旧分享/);
});

test('deletion returns before slow sync and never renders the missing-recipe view', async () => {
  const app = setup({published: true}); const page = await app.open(); const gate = pending();
  const renders = [], setData = page.setData;
  page.setData = function(update) { setData.call(this, update); renders.push(clone(this.data)); };
  app.hooks.sync = () => gate.promise; page.remove(); page.confirmDelete();
  assert.equal(app.calls.backs, 1, 'local deletion navigates back before awaiting any network work');
  assert.equal(app.store.getRecipe(LOCAL_ID), null);
  assert.equal(app.store.getState().logs.length, 0);
  await page.confirmDelete(); page.favorite(); page.edit(); await page.requestShare();
  page.refresh(); app.emitSync();
  assert.equal(app.calls.sync, 1); assert.equal(app.calls.backs, 1); assert.deepEqual(app.calls.navigation, []);
  assertUnshareable(page);
  assert.equal(renders.some(data => data.recipe === null), false, 'including the synchronous store notification');
  const updates = app.calls.updates;
  gate.resolve({state: 'synced'}); await turn();
  assert.equal(app.calls.updates, updates); assert.equal(app.calls.backs, 1);
  assert.equal(page.data.deleting, true, 'keep the exit guard until the page unloads');
});

test('delete completion cannot navigate or alter a switched account or unloaded page', async () => {
  for (const mode of ['switch', 'unload']) {
    const app = setup({published: true}); const page = await app.open(); const gate = pending();
    app.hooks.sync = () => gate.promise; page.remove(); page.confirmDelete();
    assert.equal(app.calls.backs, 1);
    if (mode === 'switch') app.store.bindAccount(OTHER); else page.onUnload();
    const updates = app.calls.updates; gate.resolve({state: 'pending'}); await turn();
    assert.equal(app.calls.updates, updates); assert.equal(app.calls.backs, 1); assert.deepEqual(app.calls.toasts, []);
  }
});

test('switching account or family while delete confirmation is open cancels deletion', async () => {
  for (const kind of ['account', 'family']) {
    const app = setup(), page = await app.open();
    page.remove();
    if (kind === 'account') { app.store.bindAccount(OTHER); app.store.bindAccount(OWNER); }
    else { app.store.bindScope(OWNER, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)}); app.store.bindScope(OWNER, {kind: 'personal', id: OWNER}); }
    page.confirmDelete(); await turn();
    assert.ok(app.store.getRecipe(LOCAL_ID)); assert.equal(app.calls.backs, 0); assert.equal(app.calls.sync, 0);
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
