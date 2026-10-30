'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {evaluatePage} = require('./page-runtime.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return {promise, resolve, reject};
};
const profile = {id: 'a'.repeat(32), name: '公开昵称', bio: '', exists: false};
const friendId = 'b'.repeat(32);

function setup(overrides = {}) {
  let owner = 'owner-a', saved = false;
  const listeners = new Set();
  const calls = {mine: 0, profiles: [], saves: [], events: [], backs: [], order: [], errors: [], toasts: [], updates: 0, publishes: 0};
  const store = {getSyncInfo: () => ({owner}), getState: () => ({recipes: [], logs: []}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {
    showShareMenu() {}, hideShareMenu() {}, showToast(value) { calls.toasts.push(value.title); },
    navigateBack(value) { calls.backs.push(value.delta); calls.order.push('back'); }
  };
  const social = {
    async getMine() { calls.mine++; return {profile: {...profile, exists: saved}, published: []}; },
    async getProfile(id) {
      calls.profiles.push(id);
      if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(Error('主页地址不正确'), {code: 'INVALID_INPUT'});
      return {profile: {...profile, id, exists: true}, isSelf: id === profile.id, recipes: [], nextOffset: null};
    },
    async saveProfile(value) {
      calls.saves.push(clone(value));
      if (overrides.save) await overrides.save(value);
      saved = true;
      return {profile: {...profile, ...value, exists: true}};
    },
    async publishRecipe() { calls.publishes++; throw Error('A nickname save must never publish a recipe'); }
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require: () => store
  });
  let definition, pages = [];
  evaluatePage(overrides.pageName || 'profile', {
    wx, getCurrentPages: () => pages, Page(value) { definition = value; },
    require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-poster')) return {remove() {}};
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, route: 'pages/' + (overrides.pageName || 'profile') + '/index',
    data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); },
    getOpenerEventChannel: () => ({emit(...args) { calls.events.push(args); calls.order.push('event'); }})};
  pages = [{route: 'pages/detail/index'}, page];
  page.onLoad({...{edit: '1', returnToRecipe: '1'}, ...overrides.query});
  return {page, calls, listeners,
    setPages(value) { pages = value; },
    changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('saving the setup nickname emits once before returning and never publishes or reloads the profile', async () => {
  const {page, calls} = setup();
  await page.onShow();
  assert.equal(page.data.editing, true);
  page.changeName({detail: {value: ' 新昵称 '}});
  page.changeBio({detail: {value: ' 只分享做法 '}});
  await page.save();
  assert.deepEqual(calls.saves, [{name: '新昵称', bio: '只分享做法'}]);
  assert.deepEqual(calls.events, [['profileSaved']]);
  assert.deepEqual(calls.backs, [1]);
  assert.deepEqual(calls.order, ['event', 'back']);
  assert.equal(calls.mine, 1, 'the detail page performs the fresh public-state check after returning');
  assert.equal(calls.publishes, 0);
  assert.equal(page.data.saving, false);
  assert.equal(page.returnAfterSave, false);
  assert.equal(page.returnToRecipe(true), false);
  page.cancelEdit();
  assert.equal(calls.events.length, 1); assert.equal(calls.backs.length, 1);
});

test('cancel and popup dismissal return without a saved event or mutation', async t => {
  for (const method of ['cancel', 'dismiss']) await t.test(method, async () => {
    const {page, calls} = setup(); await page.onShow();
    page.changeName({detail: {value: '尚未保存'}});
    if (method === 'cancel') page.cancelEdit();
    else page.editVisibilityChange({detail: {visible: false}});
    assert.equal(page.data.editing, false);
    assert.deepEqual(calls.backs, [1]);
    assert.deepEqual(calls.events, []); assert.deepEqual(calls.saves, []);
    assert.equal(calls.publishes, 0); assert.equal(page.returnAfterSave, false);
    page.editVisibilityChange({detail: {visible: false}});
    assert.equal(calls.backs.length, 1);
  });
});

test('empty nickname and failed save stay in the setup form and a later explicit retry can return', async () => {
  let attempts = 0;
  const {page, calls} = setup({save: async () => { if (++attempts === 1) throw Error('暂时离线'); }});
  await page.onShow();
  page.changeName({detail: {value: '   '}}); await page.save();
  assert.deepEqual(calls.saves, []); assert.equal(page.data.editing, true);
  page.changeName({detail: {value: '有效昵称'}}); await page.save();
  assert.equal(page.data.editing, true); assert.equal(page.data.saving, false);
  assert.equal(page.returnAfterSave, true);
  assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
  assert.deepEqual(calls.errors, ['请填写公开昵称', '暂时离线']);
  await page.save();
  assert.deepEqual(calls.events, [['profileSaved']]); assert.deepEqual(calls.backs, [1]);
  assert.equal(calls.publishes, 0);
});

test('a pending save blocks repeated save and cancellation until completion', async () => {
  const pending = deferred();
  const {page, calls} = setup({save: () => pending.promise}); await page.onShow();
  const saving = page.save();
  await page.save(); page.cancelEdit(); page.editVisibilityChange({detail: {visible: false}});
  assert.equal(calls.saves.length, 1); assert.equal(page.data.editing, true);
  assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
  pending.resolve(); await saving;
  assert.deepEqual(calls.events, [['profileSaved']]); assert.deepEqual(calls.backs, [1]);
});

test('late saves after account switch, explicit reload or unload cannot signal or navigate', async t => {
  for (const mode of ['switch', 'unnotified-switch', 'reload', 'unload']) {
    for (const fails of [false, true]) await t.test(mode + (fails ? ' rejection' : ' success'), async () => {
      const pending = deferred();
      const fixture = setup({save: () => pending.promise});
      const {page, calls} = fixture;
      await page.onShow(); const saving = page.save();
      if (mode === 'unload') page.onUnload();
      else {
        fixture.changeOwner('owner-b', mode !== 'unnotified-switch');
        if (mode === 'reload') await page.reload();
      }
      const updates = calls.updates;
      if (fails) pending.reject(Object.assign(Error('旧账号返回'), {code: 'ACCOUNT_CHANGED'}));
      else pending.resolve();
      await saving;
      assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
      assert.deepEqual(calls.toasts, []); assert.deepEqual(calls.errors, []);
      assert.equal(calls.publishes, 0);
      if (mode !== 'unnotified-switch') assert.equal(calls.updates, updates);
      if (mode === 'reload') assert.equal(page.accountSession.changed, false);
      else if (mode !== 'unload') assert.equal(page.returnAfterSave, false);
    });
  }
});

test('backend account mismatch without a local notification clears the return intent', async () => {
  const {page, calls} = setup({save: async () => { throw Object.assign(Error('身份已变化'), {code: 'ACCOUNT_CHANGED'}); }});
  await page.onShow(); await page.save();
  assert.equal(page.accountSession.changed, true); assert.equal(page.returnAfterSave, false);
  assert.equal(page.data.profile, null);
  assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
});

test('missing or unrelated previous pages do not receive a setup event or unexpected back navigation', async t => {
  for (const route of [null, 'pages/recipes/index', 'pages/public-recipe/index']) await t.test(route || 'no previous page', async () => {
    const fixture = setup(); await fixture.page.onShow();
    fixture.setPages(route ? [{route}, fixture.page] : [fixture.page]);
    await fixture.page.save();
    assert.deepEqual(fixture.calls.events, []); assert.deepEqual(fixture.calls.backs, []);
    assert.equal(fixture.calls.mine, 2, 'normal profile refresh remains usable');
    assert.equal(fixture.page.data.profile.exists, true);
    assert.equal(fixture.calls.publishes, 0);
  });
});

test('visitor IDs, QR scenes and the mine tab cannot opt into the recipe-return flow', async t => {
  for (const query of [{id: friendId}, {scene: '%62'.repeat(32)}, {id: 'invalid-id'}, {scene: '%'}]) {
    await t.test(JSON.stringify(query), async () => {
      const {page, calls} = setup({query}); await page.onShow();
      assert.equal(page.returnAfterSave, false);
      assert.equal(page.returnToRecipe(true), false);
      page.cancelEdit();
      assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
      assert.deepEqual(calls.saves, []); assert.equal(calls.mine, 0);
    });
  }
  const {page, calls} = setup({pageName: 'mine'}); await page.onShow();
  assert.equal(page.returnAfterSave, false);
  await page.save();
  assert.deepEqual(calls.events, []); assert.deepEqual(calls.backs, []);
  assert.equal(calls.mine, 2);
});

test('a hidden profile cannot pop a different current page when its save resolves', async () => {
  const pending=deferred(); const f=setup({save:()=>pending.promise}); await f.page.onShow();
  const saving=f.page.save(); f.setPages([{route:'pages/detail/index'},{route:'pages/profile/index'}]);
  pending.resolve(); await saving;
  assert.deepEqual(f.calls.events,[]); assert.deepEqual(f.calls.backs,[]); assert.equal(f.calls.publishes,0);
});
