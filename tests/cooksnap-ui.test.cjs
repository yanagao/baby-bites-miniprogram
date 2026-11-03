'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const pending = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const ID = 'b'.repeat(64), ACTOR = 'c'.repeat(32), AUTHOR = 'a'.repeat(32);
const recipe = {id: ID, profileId: AUTHOR, name: '南瓜粥', ingredients: [{name: '南瓜'}], steps: ['煮熟']};
const author = {id: AUTHOR, name: '作者的小厨房'};
const snap = {id: 'd'.repeat(64), recipeId: ID, author: {id: ACTOR, name: '跟做家长'}, photoURL: 'https://example.test/dish.jpg', text: '南瓜多放了一点，很好吃。', createdAt: 1700000000000, isSelf: true};
function setup(name = 'cooksnap-editor', overrides = {}) {
  const calls = {submits: [], recipes: [], profiles: [], feedback: [], deletes: [], imports: [], routes: [], errors: [], toasts: [], previews: [], alerts: [], shares: [], updates: 0};
  let owner = 'owner-a', imported = null;
  const listeners = new Set();
  const hooks = {};
  const store = {getSyncInfo: () => ({owner}), getState: () => ({allergies: []}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showToast(value) { calls.toasts.push(value.title); },
    showShareMenu() { calls.shares.push('show'); }, hideShareMenu() { calls.shares.push('hide'); },
    navigateTo(value) { calls.routes.push(value.url); if (hooks.navigation) hooks.navigation(value); else if (value.complete) value.complete(); },
    redirectTo(value) { calls.routes.push(value.url); if (hooks.navigation) hooks.navigation(value); else if (value.complete) value.complete(); },
    previewImage(value) { calls.previews.push(value.current); },
    chooseMedia(value) { calls.photoOptions = value; },
    showModal(value) { calls.modal = value; },
    enableAlertBeforeUnload(value) { calls.alerts.push('enable'); }, disableAlertBeforeUnload(value) { calls.alerts.push('disable'); },
  };
  const social = {
    async getRecipe(id, options) { calls.recipes.push({id, options}); return hooks.recipe ? hooks.recipe() : {recipe, author}; },
    async getProfileSummary(id, options) { calls.profiles.push({id, options}); return hooks.profile ? hooks.profile() : {isSelf: false}; },
    findImportedRecipe() { return imported; },
    async addToCookbook(id) { calls.imports.push(id); if (hooks.import) return hooks.import(); imported = {id: 'local-copy'}; return {recipeId: imported.id, added: true}; },
    async addCooksnap(id, draft) { calls.submits.push({id, ...clone(draft)}); return hooks.submit ? hooks.submit(id, draft) : {cooksnap: snap}; },
    async getRecipeFeedback(id, offset, options) { calls.feedback.push({id, offset, options}); return hooks.feedback ? hooks.feedback(id, offset, options) : {saveCount: 3, cooksnapCount: 1, cooksnaps: [snap], nextOffset: null}; },
    async deleteCooksnap(id) { calls.deletes.push(id); return hooks.delete ? hooks.delete(id) : {deleted: true}; }, ...overrides
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require() { return store; }});
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx,
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/allergies')) return require('../utils/allergies');
      if (dep.endsWith('/profile-avatar')) return require('../utils/profile-avatar');
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() { calls.routes.push('back'); }};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); }};
  page.onLoad({id: ID});
  return {page, calls, hooks, setImported(value) { imported = value; }, changeOwner(value) { owner = value; listeners.forEach(fn => fn()); },
    async open() { await page.onShow(); return page; },
    fill() { page.setData({photo: 'wxfile://tmp/dish.jpg'}); page.changeText({detail: {value: '南瓜多放了一点，很好吃。'}}); }};
}

test('cooksnap opens read-only, does not require a completed public profile and hides forwarding', async () => {
  const app = setup(), page = await app.open();
  assert.equal(page.data.recipe.id, ID); assert.equal(page.data.isSelf, false);
  assert.deepEqual(app.calls.submits, []); assert.deepEqual(app.calls.imports, []);
  assert.equal(app.calls.shares.at(-1), 'hide');
  assert.equal(typeof page.onShareAppMessage, 'undefined');
  await page.onShow(); assert.equal(app.calls.recipes.length, 1);
});

test('both a photo and feedback sentence are required and clicking submit is the only write', async () => {
  const app = setup(), page = await app.open();
  await page.submit(); assert.match(page.data.photoError, /成品照/); assert.match(page.data.textError, /反馈/);
  page.changeText({detail: {value: '   '}}); page.setData({photo: 'wxfile://tmp/dish.jpg'});
  await page.submit(); assert.equal(app.calls.submits.length, 0);
  app.fill(); await page.submit();
  assert.equal(app.calls.submits.length, 1); assert.equal(page.data.submitted, true);
  assert.equal(app.calls.submits[0].id, ID); assert.equal(app.calls.submits[0].photoPath, 'wxfile://tmp/dish.jpg');
  assert.match(app.calls.submits[0].requestId, /^[A-Za-z0-9_-]{16,80}$/);
  assert.equal(app.calls.imports.length, 0); assert.equal(app.calls.alerts.at(-1), 'disable');
});

test('uncertain submit retry keeps the same request ID and complete draft without duplicating concurrent requests', async () => {
  const app = setup(), page = await app.open(), gate = pending(); app.fill();
  app.hooks.submit = () => gate.promise;
  const work = page.submit(); await page.submit(); page.back(); page.choosePhoto(); page.changeText({detail: {value: '不能覆盖'}});
  assert.equal(app.calls.submits.length, 1); assert.equal(page.data.text, snap.text); assert.deepEqual(app.calls.routes, []);
  gate.reject(Error('网络中断')); await work;
  assert.equal(page.data.photo, 'wxfile://tmp/dish.jpg'); assert.equal(page.data.text, snap.text);
  assert.equal(page.data.submitted, false); assert.equal(page.data.saving, false);
  app.hooks.submit = null; await page.submit();
  assert.equal(app.calls.submits[0].requestId, app.calls.submits[1].requestId);
  await page.submit(); assert.equal(app.calls.submits.length, 2);
});

test('a changed draft uses a fresh idempotency key instead of overwriting a possibly posted version', async () => {
  const app = setup(), page = await app.open(); app.fill(); app.hooks.submit = () => { throw Error('网络中断'); };
  await page.submit(); page.changeText({detail: {value: '新的反馈'}}); await page.submit();
  assert.notEqual(app.calls.submits[0].requestId, app.calls.submits[1].requestId);
});

test('own original recipe cannot submit even when a direct editor URL is opened', async () => {
  const app = setup(); app.hooks.profile = () => ({isSelf: true}); const page = await app.open();
  assert.match(page.data.error, /自己的菜谱/); app.fill(); await page.submit(); page.choosePhoto();
  assert.deepEqual(app.calls.submits, []); assert.equal(app.calls.photoOptions, undefined);
});

test('owner change clears draft and late submit results, including switch-away-and-back', async () => {
  const app = setup(), page = await app.open(), gate = pending(); app.fill(); app.hooks.submit = () => gate.promise;
  const work = page.submit(); app.changeOwner('owner-b'); app.changeOwner('owner-a');
  assert.equal(page.data.photo, ''); assert.equal(page.data.text, ''); assert.equal(page.data.recipe, null);
  const updates = app.calls.updates;
  gate.resolve({cooksnap: snap}); await work;
  assert.equal(app.calls.updates, updates); assert.equal(page.data.submitted, false);
  assert.equal(app.calls.toasts.length, 0);
});

test('unloaded editor ignores late recipe, picker and submission results', async () => {
  const app = setup(), gate = pending(); app.hooks.recipe = () => gate.promise;
  const work = app.open(); app.page.onUnload(); const updates = app.calls.updates;
  gate.resolve({recipe, author}); await work; assert.equal(app.calls.updates, updates);
  const selected = setup(), page = await selected.open(); page.choosePhoto(); page.onUnload(); const count = selected.calls.updates;
  selected.calls.photoOptions.success({tempFiles: [{tempFilePath: 'wxfile://tmp/a.jpg', size: 200}]});
  selected.calls.photoOptions.complete(); assert.equal(selected.calls.updates, count);
});

test('picker accepts compressed photos for client validation and preserves old photo on size failure', async () => {
  const app = setup(), page = await app.open(); page.choosePhoto();
  const picker = app.calls.photoOptions; assert.deepEqual(clone(picker.sizeType), ['compressed']); assert.equal(picker.count, 1);
  picker.success({tempFiles: [{tempFilePath: 'wxfile://tmp/large.jpg', size: 2 * 1024 * 1024}]}); picker.complete();
  assert.equal(page.data.photo, 'wxfile://tmp/large.jpg');
  page.choosePhoto(); app.calls.photoOptions.success({tempFiles: [{tempFilePath: 'wxfile://tmp/huge.jpg', size: 11 * 1024 * 1024}]}); app.calls.photoOptions.complete();
  assert.equal(page.data.photo, 'wxfile://tmp/large.jpg'); assert.match(page.data.photoError, /10 MB/);
  page.previewPhoto(); assert.deepEqual(app.calls.previews, ['wxfile://tmp/large.jpg']);
});

test('leaving a draft offers discard while successful submit can return directly', async () => {
  const app = setup(), page = await app.open(); app.fill(); page.back();
  assert.equal(page.data.discardVisible, true); assert.deepEqual(app.calls.routes, []);
  page.continueEditing(); assert.equal(page.data.discardVisible, false);
  await page.submit(); page.back(); assert.deepEqual(app.calls.routes, ['back']);
});

test('organizing a personal variation is optional and explicitly saves an attributed copy first', async () => {
  const app = setup(), page = await app.open(); app.fill(); await page.submit();
  assert.deepEqual(app.calls.imports, []); assert.deepEqual(app.calls.routes, []);
  await page.arrangeRecipe();
  assert.deepEqual(app.calls.imports, [ID]); assert.deepEqual(app.calls.routes, ['/pages/editor/index?id=local-copy']);
  assert.equal(page.data.photo, 'wxfile://tmp/dish.jpg', 'follow-along photo is not copied into recipe');
});

test('organizing an existing saved copy reuses it and navigation failure remains retryable', async () => {
  const app = setup(); app.setImported({id: 'existing-copy'}); const page = await app.open(); app.fill(); await page.submit();
  app.hooks.navigation = options => options.fail();
  await page.arrangeRecipe(); assert.deepEqual(app.calls.imports, []); assert.equal(page.data.arranging, false);
  assert.equal(app.calls.routes.at(-1), '/pages/editor/index?id=existing-copy');
  assert.match(page.data.submitError, /编辑页/);
});

test('editor markup clearly states public sharing, has two required inputs and does not force a recipe rewrite', () => {
  const markup = fs.readFileSync(path.join(root, 'pages/cooksnap-editor/index.wxml'), 'utf8');
  for (const copy of ['我的成品照', '留一句做后的反馈', '分享跟做', '本菜谱和作者收到的反馈里', '无需完善资料', '完成，返回菜谱']) assert.ok(markup.includes(copy), copy);
  assert.match(markup, /maxlength="120"/); assert.doesNotMatch(markup, /open-type="share"/);
});

test('public recipe displays server feedback counts and opens follow-along only for another confirmed author', async () => {
  const app = setup('public-recipe'), page = await app.open();
  assert.equal(page.data.saveCount, 3); assert.equal(page.data.cooksnapCount, 1); assert.equal(page.data.cooksnaps[0].text, snap.text);
  page.openCooksnap(); assert.equal(app.calls.routes.at(-1), '/pages/cooksnap-editor/index?id=' + ID);
  page.setData({authorIsSelf: true}); page.openCooksnap(); assert.equal(app.calls.routes.length, 1);
  page.setData({authorIsSelf: false, authorKnown: false}); page.openCooksnap(); assert.equal(app.calls.routes.length, 1);
});

test('public feedback failures preserve recipe and do not invent counts', async () => {
  const app = setup('public-recipe'); app.hooks.feedback = () => { throw Error('反馈暂时不可用'); };
  const page = await app.open();
  assert.equal(page.data.recipe.id, ID); assert.equal(page.data.error, ''); assert.equal(page.data.feedbackReady, false);
  assert.match(page.data.feedbackError, /反馈/); assert.equal(page.data.saveCount, 0);
  app.hooks.feedback = null; await page.retryFeedback(); assert.equal(page.data.feedbackReady, true);
  assert.equal(app.calls.feedback.at(-1).options.force, true);
});

test('public feedback pagination deduplicates rows and keeps totals from the server', async () => {
  const app = setup('public-recipe');
  app.hooks.feedback = (id, offset) => ({saveCount: 4, cooksnapCount: 2,
    cooksnaps: offset ? [snap, {...snap, id: 'e'.repeat(64), isSelf: false}] : [snap], nextOffset: offset ? null : 20});
  const page = await app.open(); await page.moreFeedback();
  assert.equal(page.data.cooksnaps.length, 2); assert.equal(page.data.cooksnapCount, 2);
  assert.equal(app.calls.feedback.at(-1).offset, 20); await page.moreFeedback(); assert.equal(app.calls.feedback.length, 2);
});

test('only a caller-owned cooksnap may be removed, with cancellation and refresh after deletion', async () => {
  const app = setup('public-recipe'), page = await app.open();
  page.deleteCooksnap({currentTarget: {dataset: {id: snap.id}}});
  assert.equal(app.calls.deletes.length, 0); await app.calls.modal.success({confirm: false});
  assert.equal(page.data.deletingCooksnap, '');
  page.deleteCooksnap({currentTarget: {dataset: {id: snap.id}}});
  app.hooks.feedback = () => ({saveCount: 3, cooksnapCount: 0, cooksnaps: [], nextOffset: null});
  await app.calls.modal.success({confirm: true});
  assert.deepEqual(app.calls.deletes, [snap.id]); assert.equal(page.data.cooksnapCount, 0);
  page.setData({cooksnaps: [{...snap, isSelf: false}]}); page.deleteCooksnap({currentTarget: {dataset: {id: snap.id}}});
  assert.deepEqual(app.calls.deletes, [snap.id]);
});

test('owner switching clears feedback and prevents a pending delete confirmation from operating', async () => {
  const app = setup('public-recipe'), page = await app.open(); page.deleteCooksnap({currentTarget: {dataset: {id: snap.id}}});
  app.changeOwner('owner-b'); await app.calls.modal.success({confirm: true});
  assert.equal(page.data.cooksnaps.length, 0); assert.equal(page.data.feedbackReady, false); assert.equal(page.data.saveCount, 0);
  assert.deepEqual(app.calls.deletes, []);
});

test('a late public feedback response cannot repopulate an unloaded page', async () => {
  const app = setup('public-recipe'), gate = pending(); app.hooks.feedback = () => gate.promise;
  const work = app.open(); await new Promise(resolve => setImmediate(resolve)); app.page.onUnload(); const updates = app.calls.updates;
  gate.resolve({saveCount: 100, cooksnapCount: 1, cooksnaps: [snap], nextOffset: null}); await work;
  assert.equal(app.calls.updates, updates); assert.equal(app.page.data.feedbackReady, false);
});

test('deleting cancels older feedback pagination so a late page cannot restore a removed cooksnap', async () => {
  const app = setup('public-recipe'); app.hooks.feedback = () => ({saveCount: 3, cooksnapCount: 1, cooksnaps: [snap], nextOffset: 20});
  const page = await app.open(), oldPage = pending();
  app.hooks.feedback = (id, offset) => offset === 20 ? oldPage.promise : {saveCount: 3, cooksnapCount: 0, cooksnaps: [], nextOffset: null};
  const more = page.moreFeedback();
  page.deleteCooksnap({currentTarget: {dataset: {id: snap.id}}});
  await app.calls.modal.success({confirm: true});
  oldPage.resolve({saveCount: 3, cooksnapCount: 1, cooksnaps: [snap], nextOffset: null}); await more;
  assert.deepEqual(clone(page.data.cooksnaps), []); assert.equal(page.data.cooksnapCount, 0);
  assert.equal(page.data.feedbackReady, true); assert.equal(page.data.feedbackMore, false);
});

test('feedback text normalizes pasted line breaks to one sentence and stays within the server limit', async () => {
  const app = setup(), page = await app.open();
  page.changeText({detail: {value: '南瓜多放了一点\r\n煮得软软的\t很好吃'}});
  assert.equal(page.data.text, '南瓜多放了一点 煮得软软的 很好吃');
  page.changeText({detail: {value: '好'.repeat(121)}}); assert.equal(page.data.text.length, 120);
});
