'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const recipeAges = require('../utils/recipe-ages');
const babyAge = require('../utils/baby-age');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const CN_TODAY = babyAge.todayString(Date.parse('2026-10-28T16:00:00.000Z'));
const tapAge = ageGroup => ({currentTarget: {dataset: {ageGroup}}});
const tapCategory = category => ({currentTarget: {dataset: {category}}});
const response = (birthday, extra = {}) => ({profile: {id: 'a'.repeat(32), name: '公开厨房', exists: true, ...extra, ...(birthday === undefined ? {} : {babyBirthDate: birthday})}, published: []});
function dish(id, category, ages) {
  return {id, name: id, category, minutes: 20, texture: '软烂颗粒', ingredients: [{name: '南瓜', amount: '30克'}],
    steps: ['煮至软烂'], createdAt: 1, updatedAt: 1, favorite: false, ...(ages === undefined ? {} : {ageGroups: ages})};
}
const RECIPES = [
  dish('six', '早餐饼', ['6-8']), dish('nine', '粥饭主食', ['9-11']),
  dish('twelve', '蒸蛋豆腐', ['12-17']), dish('eighteen', '早餐饼', ['18+']),
  dish('unrestricted', '粥饭主食'), dish('multi', '粥饭主食', ['6-8', '9-11'])
];

function setup(options = {}) {
  let owner = options.owner === undefined ? OWNER : options.owner, day = CN_TODAY, definition;
  const listeners = new Set();
  const state = {nickname: '私人称呼', recipes: clone(options.recipes || RECIPES), logs: clone(options.logs || [])};
  const calls = {mine: 0, errors: [], toasts: [], writes: 0, updates: 0, routes: []};
  const store = {
    getState: () => clone(state), getSyncInfo: () => ({owner}),
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    toggleFavorite() { calls.writes++; throw Error('Default-age initialization must not save a favorite'); },
    setNickname() { calls.writes++; throw Error('Default-age initialization must not save private data'); }
  };
  const social = {
    getMine() { calls.mine++; return options.getMine ? options.getMine(calls.mine) : Promise.resolve(response('2026-02-28')); },
    saveProfile() { calls.writes++; throw Error('Default-age initialization must not save a public profile'); }
  };
  // Keep all date validation and calendar arithmetic real while fixing the China calendar day.
  const fixedAge = {
    ...babyAge, todayString: () => day,
    isValidBirthDate: (value, today = day) => babyAge.isValidBirthDate(value, today),
    ageInMonths: (value, today = day) => babyAge.ageInMonths(value, today)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/random/index.js'), 'utf8'), {
    Page(value) { definition = value; },
    require(dep) {
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/selectors')) return selectors;
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/recipe-ages')) return recipeAges;
      if (dep.endsWith('/baby-age')) return fixedAge;
      if (dep.endsWith('/cloud')) return {socialEnabled: options.socialEnabled !== false};
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error('Unexpected random dependency: ' + dep);
    },
    wx: {showToast(value) { calls.toasts.push(value.title); }, navigateTo(value) { calls.routes.push(value.url); }}
  });
  const page = {...definition, data: clone(definition.data), setData(update) { calls.updates++; Object.assign(this.data, clone(update)); }};
  page.onLoad();
  return {page, state, calls, listeners,
    setToday(value) { day = value; },
    switchOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(callback => callback({owner})); }};
}
const selected = page => Array.from(page.data.selectedAgeGroups);

function assertCurrentPool(fixture) {
  const {page, state} = fixture;
  const pool = selectors.randomCandidates(state, {
    categories: page.data.selectedCategories, ageGroups: page.data.selectedAgeGroups, skipDisliked: page.data.skipDisliked
  });
  assert.equal(page.data.candidateCount, pool.length);
  if (pool.length) assert.ok(pool.some(recipe => recipe.id === page.data.result.id));
  else assert.equal(page.data.result, null);
}

test('random shows an immediate local result before the birthday resolves, then applies one read-only default', async () => {
  const pending = deferred(), f = setup({getMine: () => pending.promise}), before = clone(f.state);
  const loading = f.page.onShow();
  assert.ok(f.page.data.result); assert.equal(f.page.data.candidateCount, RECIPES.length);
  assert.deepEqual(selected(f.page), []); assert.equal(f.calls.mine, 1);
  pending.resolve(response('2026-02-28', {babyAgeMonths: 99})); await loading;
  assert.equal(CN_TODAY, '2026-10-29'); assert.deepEqual(selected(f.page), ['6-8']);
  assert.equal(f.page.data.candidateCount, 3); assertCurrentPool(f);
  assert.deepEqual(f.state, before); assert.equal(f.calls.writes, 0); assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
});

test('birthday defaults use real China calendar arithmetic at every age-group boundary', async t => {
  const cases = [
    ['2026-04-29', '6-8'], ['2026-02-28', '6-8'], ['2026-01-29', '9-11'],
    ['2025-11-29', '9-11'], ['2025-10-29', '12-17'], ['2025-05-29', '12-17'],
    ['2025-04-29', '18+'], ['1900-01-01', '18+']
  ];
  for (const [birthday, expected] of cases) await t.test(birthday, async () => {
    const f = setup({getMine: async () => response(birthday)}); await f.page.onShow();
    assert.deepEqual(selected(f.page), [expected]); assertCurrentPool(f); assert.equal(f.calls.writes, 0);
  });
});

test('missing, invalid and under-six-month birthdays stay unrestricted and never fall back to legacy age', async t => {
  const cases = [undefined, null, '', 'not-a-date', '2026-02-30', '2026-10-30', '1899-12-31', '2026-4-29', 0, '2026-04-30', CN_TODAY];
  for (const birthday of cases) await t.test(String(birthday), async () => {
    const f = setup({getMine: async () => response(birthday, {babyAgeMonths: 10})});
    await f.page.onShow(); assert.deepEqual(selected(f.page), []); assert.equal(f.page.data.candidateCount, RECIPES.length);
    const result = f.page.data.result.id; await f.page.onShow();
    assert.equal(f.calls.mine, 1); assert.equal(f.page.data.result.id, result);
    assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
  });
});

test('returning from a recipe retains the chosen dish and age filter without re-reading the birthday', async () => {
  const f = setup(); await f.page.onShow();
  const id = f.page.data.result.id; f.page.detail();
  assert.equal(f.calls.routes[0], '/pages/detail/index?id=' + encodeURIComponent(id));
  f.state.recipes.find(recipe => recipe.id === id).name = '在详情页更新的菜名'; f.setToday('2027-10-29');
  await f.page.onShow(); await f.page.loadDefaultAge();
  assert.equal(f.calls.mine, 1); assert.deepEqual(selected(f.page), ['6-8']);
  assert.equal(f.page.data.result.id, id); assert.equal(f.page.data.result.name, '在详情页更新的菜名');
});

test('repeated onShow and loadDefaultAge during one pending read do not duplicate the request', async () => {
  const pending = deferred(), f = setup({getMine: () => pending.promise});
  const first = f.page.onShow(), second = f.page.onShow(), third = f.page.loadDefaultAge();
  assert.equal(f.calls.mine, 1);
  pending.resolve(response('2026-01-29')); await Promise.all([first, second, third]);
  assert.equal(f.calls.mine, 1); assert.deepEqual(selected(f.page), ['9-11']); assertCurrentPool(f);
});

test('every intentional age action beats a slow default, including unrestricted and removing the last chip', async t => {
  for (const action of ['select', 'all', 'remove-last', 'reset']) await t.test(action, async () => {
    const pending = deferred(), f = setup({getMine: () => pending.promise}); const loading = f.page.onShow();
    if (action === 'select') f.page.toggleAgeGroup(tapAge('18+'));
    if (action === 'all') f.page.toggleAgeGroup(tapAge('全部'));
    if (action === 'remove-last') { f.page.toggleAgeGroup(tapAge('9-11')); f.page.toggleAgeGroup(tapAge('9-11')); }
    if (action === 'reset') { f.page.toggleCategory(tapCategory('早餐饼')); f.page.resetFilters(); }
    pending.resolve(response('2026-02-28')); await loading; await f.page.onShow();
    assert.deepEqual(selected(f.page), action === 'select' ? ['18+'] : []);
    assertCurrentPool(f); assert.equal(f.calls.mine, 1); assert.equal(f.calls.writes, 0);
  });
});

test('category and dislike changes compose with the arriving default instead of suppressing it', async () => {
  const logs = [{id: 'latest', recipeId: 'multi', date: CN_TODAY, rating: 1, createdAt: 1}];
  const pending = deferred(), f = setup({logs, getMine: () => pending.promise}); const loading = f.page.onShow();
  f.page.toggleCategory(tapCategory('粥饭主食')); f.page.skip({detail: {value: true}});
  pending.resolve(response('2026-02-28')); await loading;
  assert.deepEqual(selected(f.page), ['6-8']); assert.deepEqual(Array.from(f.page.data.selectedCategories), ['粥饭主食']);
  assert.equal(f.page.data.skipDisliked, true); assert.equal(f.page.data.candidateCount, 1);
  assert.equal(f.page.data.result.id, 'unrestricted'); assertCurrentPool(f);
});

test('an invalid age tap does not cancel a pending birthday default', async () => {
  const pending = deferred(), f = setup({getMine: () => pending.promise}); const loading = f.page.onShow();
  f.page.toggleAgeGroup(tapAge('not-a-group')); pending.resolve(response('2026-01-29')); await loading;
  assert.deepEqual(selected(f.page), ['9-11']); assertCurrentPool(f);
});

test('ordinary read failure stays quiet and unrestricted, and the next onShow may retry successfully', async () => {
  const f = setup({getMine: async attempt => { if (attempt === 1) throw Error('暂时离线'); return response('2025-10-29'); }});
  await f.page.onShow(); assert.deepEqual(selected(f.page), []); assert.ok(f.page.data.result);
  assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
  await f.page.onShow(); assert.equal(f.calls.mine, 2); assert.deepEqual(selected(f.page), ['12-17']);
  await f.page.onShow(); assert.equal(f.calls.mine, 2); assertCurrentPool(f);
});

test('manual age selection remains authoritative after a failed default read', async () => {
  const f = setup({getMine: async () => { throw Error('暂时离线'); }}); await f.page.onShow();
  f.page.toggleAgeGroup(tapAge('18+')); await f.page.onShow();
  assert.deepEqual(selected(f.page), ['18+']); assert.equal(f.calls.mine, 1);
  assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []); assertCurrentPool(f);
});

test('disabled social features never request a birthday and leave manual filters usable', async () => {
  const f = setup({socialEnabled: false}); await f.page.onShow(); await f.page.loadDefaultAge();
  assert.equal(f.calls.mine, 0); assert.deepEqual(selected(f.page), []);
  f.page.toggleAgeGroup(tapAge('9-11')); await f.page.onShow();
  assert.equal(f.calls.mine, 0); assert.deepEqual(selected(f.page), ['9-11']); assertCurrentPool(f);
});

test('an unbound account does not trigger implicit sync, and its first binding permits a later default read', async () => {
  const f = setup({owner: ''}); await f.page.onShow(); await f.page.loadDefaultAge();
  assert.equal(f.calls.mine, 0); assert.ok(f.page.data.result); assert.deepEqual(selected(f.page), []);
  f.switchOwner(OWNER); await f.page.onShow();
  assert.equal(f.calls.mine, 1); assert.deepEqual(selected(f.page), ['6-8']); assert.equal(f.page.data.accountError, '');
});

test('account changes, including A to B to A, reject the old birthday response and keep results locked', async t => {
  for (const mode of ['notified', 'unnotified', 'A-B-A']) await t.test(mode, async () => {
    const pending = deferred(), f = setup({getMine: () => pending.promise}); const loading = f.page.onShow();
    f.switchOwner(OTHER, mode !== 'unnotified'); if (mode === 'A-B-A') f.switchOwner(OWNER);
    pending.resolve(response('2026-01-29')); await loading; await f.page.onShow();
    assert.deepEqual(selected(f.page), []); assert.equal(f.page.data.result, null); assert.equal(f.page.data.candidateCount, 0);
    assert.match(f.page.data.accountError, /账号已切换/); assert.equal(f.calls.mine, 1); assert.equal(f.calls.writes, 0);
  });
});

test('ACCOUNT_CHANGED from the service locks the page even when the local owner has not changed', async () => {
  const f = setup({getMine: async () => { throw Object.assign(Error('服务识别到账号变化'), {code: 'ACCOUNT_CHANGED'}); }});
  await f.page.onShow(); await f.page.onShow();
  assert.deepEqual(selected(f.page), []); assert.equal(f.page.data.result, null); assert.equal(f.page.data.candidateCount, 0);
  assert.match(f.page.data.accountError, /账号已切换/); assert.equal(f.calls.mine, 1);
  assert.deepEqual(f.calls.toasts, []); assert.equal(f.calls.writes, 0);
});

test('unloading cancels a pending birthday response without later page updates or writes', async () => {
  const pending = deferred(), f = setup({getMine: () => pending.promise}); const loading = f.page.onShow();
  f.page.onUnload(); const updates = f.calls.updates;
  pending.resolve(response('2026-01-29')); await loading; await f.page.onShow(); await f.page.loadDefaultAge();
  assert.equal(f.calls.updates, updates); assert.equal(f.listeners.size, 0); assert.equal(f.calls.mine, 1);
  assert.deepEqual(selected(f.page), []); assert.equal(f.calls.writes, 0); assert.deepEqual(f.calls.toasts, []);
});

test('a nonexistent public profile never supplies a birthday default even when its response contains one', async () => {
  const f = setup({getMine: async () => response('2026-02-28', {exists: false})});
  await f.page.onShow(); await f.page.onShow();
  assert.deepEqual(selected(f.page), []); assert.equal(f.page.data.candidateCount, RECIPES.length); assert.equal(f.calls.mine, 1);
  assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
});

test('malformed profile responses stay quiet and remain eligible for a fresh read', async t => {
  for (const malformed of [{}, {profile: null}, response('2026-02-28', {exists: undefined}), response('2026-02-28', {exists: 'true'})]) {
    await t.test(JSON.stringify(malformed), async () => {
      const f = setup({getMine: async attempt => attempt === 1 ? malformed : response('2026-01-29')});
      await f.page.onShow(); assert.deepEqual(selected(f.page), []); assert.ok(f.page.data.result);
      assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
      await f.page.onShow(); assert.equal(f.calls.mine, 2); assert.deepEqual(selected(f.page), ['9-11']);
    });
  }
});
