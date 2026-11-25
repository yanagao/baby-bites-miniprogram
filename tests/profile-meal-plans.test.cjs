'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {evaluatePage} = require('./page-runtime.cjs');
const {build, mealPlanDays} = require('../utils/profile-content');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const PROFILE = 'a'.repeat(32), OTHER_PROFILE = 'b'.repeat(32);
const tap = value => ({currentTarget: {dataset: {value}}});
const dayTap = date => ({currentTarget: {dataset: {date}}});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject}; };
const day = (date = '2026-11-24') => ({date, meals: [
  {meal: 'breakfast', label: '早餐', recipe: {id: 'recipe', name: '南瓜小米粥', kind: 'public'}},
  {meal: 'lunch', label: '午餐', recipe: null}
]});

function setup(options = {}) {
  let owner = 'owner-a', scope = 'owner-a', definition, readVersion = 0, now = Date.now();
  class ClockDate extends Date {static now() {return now;}}
  const state = {recipes: [], logs: [], mealPlans: [{date: '2026-11-30', meal: 'dinner', recipeId: 'private'}]};
  const calls = {plans: [], profiles: [], routes: [], tabs: [], updates: 0, errors: []};
  const listeners = new Set();
  const store = {getState: () => state, getSyncInfo: () => ({owner, scopeKey: scope}),
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const wx = {showShareMenu() {}, hideShareMenu() {}, showToast() {},
    navigateTo({url}) {calls.routes.push(url);}, switchTab({url}) {calls.tabs.push(url);}};
  const mine = options.mine === true;
  const profile = {id: PROFILE, name: '小厨房', exists: true, ...options.profile};
  const social = {
    getReadVersion: () => readVersion, getMineReadVersion: () => 0,
    getMine: async () => ({profile, published: []}),
    getProfile: async (id, offset, readOptions) => {
      calls.profiles.push({id, offset, options: readOptions});
      return options.getProfile ? options.getProfile(id, offset, readOptions) : {profile: {...profile, id}, isSelf: false, recipes: [{id: 'public-recipe'}], nextOffset: null};
    },
    getProfileMealPlans: async (id, offset, readOptions) => {
      calls.plans.push({id, offset, options: clone(readOptions)});
      return options.getPlans ? options.getPlans(id, offset, readOptions) : {days: [day()], nextOffset: null};
    }
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    module: accountModule, wx, require: () => store
  });
  evaluatePage(mine ? 'mine' : 'profile', {wx, Date: ClockDate, Page(value) {definition = value;},
    socialEnabled: options.socialEnabled, require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-poster')) return {remove() {}};
      if (dep.endsWith('/ui')) return {error(error) {calls.errors.push(error.message);}, back() {}};
      throw Error(dep);
    }});
  const page = {...definition, data: clone(definition.data), setData(value) {calls.updates++; Object.assign(this.data, clone(value));}};
  page.onLoad(mine ? {} : {id: PROFILE});
  return {page, calls, state, profile,
    changeReadVersion() {readVersion++;}, advance(milliseconds) {now += milliseconds;},
    changeOwner(value) {owner = value; listeners.forEach(fn => fn());},
    changeScope(value) {scope = value; listeners.forEach(fn => fn());}};
}

test('mine and visitor pages load synced meal plans only when their tab is selected', async () => {
  for (const mine of [false, true]) {
    const app = setup({mine}); await app.page.load();
    assert.equal(app.calls.plans.length, 0);
    await app.page.changeContentTab(tap('mealPlans'));
    assert.equal(app.calls.plans.length, 1);
    assert.deepEqual(app.calls.plans[0], {id: PROFILE, offset: 0, options: undefined});
    assert.deepEqual(app.page.data.mealPlanDays, [{date: '2026-11-24', dateLabel: '2026年11月24日',
      meals: [{meal: 'breakfast', label: '早餐', name: '南瓜小米粥'}, {meal: 'lunch', label: '午餐', name: '菜谱暂不可查看'}]}]);
    assert.equal(app.page.data.mealPlansLoading, false);
    assert.equal(app.page.data.mealPlansNextOffset, null);
    assert.ok(!JSON.stringify(app.page.data.mealPlanDays).includes('private'));
    app.page.openMealPlan(dayTap('2026-11-24'));
    assert.deepEqual(app.calls.routes, ['/pages/public-meal-plan/index?profileId=' + PROFILE + '&date=2026-11-24']);
    app.page.changeContentTab(tap('recipes'));
    app.page.openMealPlan(dayTap('2026-11-24'));
    assert.equal(app.calls.routes.length, 1);
  }
});

test('missing, uncreated and disabled own profiles show an empty meal tab without invalid API requests', async () => {
  for (const options of [{profile: {id: undefined}}, {profile: {exists: false}}, {socialEnabled: false}]) {
    const app = setup({mine: true, ...options}); await app.page.load();
    await app.page.changeContentTab(tap('mealPlans'));
    assert.equal(app.calls.plans.length, 0); assert.deepEqual(app.page.data.mealPlanDays, []);
    assert.equal(app.page.data.mealPlansError, '');
    app.page.openRecords(); assert.deepEqual(app.calls.tabs, ['/pages/records/index']);
  }
});

test('meal plans paginate independently and repeated boundary dates are not duplicated', async () => {
  const gate = deferred();
  const app = setup({getPlans: (id, offset) => offset ? gate.promise : {days: [day()], nextOffset: 1}});
  await app.page.load(); await app.page.changeContentTab(tap('mealPlans'));
  const more = app.page.onReachBottom();
  assert.equal(app.page.data.mealPlansLoadingMore, true);
  await app.page.loadMore(); assert.equal(app.calls.plans.length, 2);
  gate.resolve({days: [day(), day('2026-11-25')], nextOffset: null}); await more;
  assert.deepEqual(app.page.data.mealPlanDays.map(item => item.date), ['2026-11-24', '2026-11-25']);
  assert.equal(app.page.data.mealPlansLoadingMore, false);
  await app.page.loadMore(); assert.equal(app.calls.plans.length, 2);
  assert.deepEqual(app.page.data.recipes, [{id: 'public-recipe'}]);
});

test('failed initial and later meal pages retry their own offset while preserving loaded cards', async () => {
  for (const more of [false, true]) {
    let fail = true;
    const app = setup({getPlans: (id, offset) => {
      if ((more ? offset === 1 : offset === 0) && fail) throw Error('餐单读取失败');
      return {days: [day(offset ? '2026-11-25' : '2026-11-24')], nextOffset: offset ? null : 1};
    }});
    await app.page.load(); await app.page.changeContentTab(tap('mealPlans'));
    if (more) await app.page.loadMore();
    assert.equal(app.page.data.mealPlansError, '餐单读取失败');
    assert.equal(app.page.data.mealPlanDays.length, more ? 1 : 0);
    fail = false; await app.page.retryMealPlans();
    assert.equal(app.page.data.mealPlansError, '');
    assert.equal(app.calls.plans.at(-1).offset, more ? 1 : 0);
    assert.deepEqual(app.calls.plans.at(-1).options, {force: true});
    assert.equal(app.page.data.mealPlanDays.length, more ? 2 : 1);
  }
});

test('visitor reload keeps the meal tab and reloads its first page with the force option', async () => {
  const app = setup(); await app.page.load(); await app.page.changeContentTab(tap('mealPlans'));
  await app.page.reload();
  assert.equal(app.page.data.contentTab, 'mealPlans');
  assert.equal(app.calls.plans.length, 2); assert.deepEqual(app.calls.plans[1].options, {force: true});
  app.page.changeContentTab(tap('favorites')); assert.equal(app.page.data.contentTab, 'mealPlans');
  app.page.changeContentTab(tap('records')); assert.equal(app.page.data.contentTab, 'mealPlans');
});

test('an earlier meal request cannot replace a newer result after switching tabs away and back', async () => {
  for (const failure of [false, true]) {
    const old = deferred(); let reads = 0;
    const app = setup({getPlans: () => ++reads === 1 ? old.promise : {days: [day('2026-11-25')], nextOffset: null}});
    await app.page.load(); const pending = app.page.changeContentTab(tap('mealPlans'));
    app.page.changeContentTab(tap('recipes')); await app.page.changeContentTab(tap('mealPlans'));
    const updates = app.calls.updates;
    if (failure) old.reject(Error('旧请求失败')); else old.resolve({days: [day()], nextOffset: 99});
    await pending;
    assert.equal(app.calls.updates, updates);
    assert.deepEqual(app.page.data.mealPlanDays.map(item => item.date), ['2026-11-25']);
    assert.equal(app.page.data.mealPlansError, '');
  }
});

test('account changes, family ABA changes and unloading discard pending meal results', async () => {
  for (const change of ['owner', 'family', 'unload']) {
    const gate = deferred(), app = setup({getPlans: () => gate.promise});
    await app.page.load(); const pending = app.page.changeContentTab(tap('mealPlans'));
    if (change === 'owner') app.changeOwner('owner-b');
    else if (change === 'family') {app.changeScope('family-a'); app.changeScope('owner-a');}
    else app.page.onUnload();
    const updates = app.calls.updates;
    gate.resolve({days: [day()], nextOffset: null}); await pending;
    assert.equal(app.calls.updates, updates); assert.deepEqual(app.page.data.mealPlanDays, []);
    assert.equal(app.page.data.mealPlansLoading, false);
    app.page.openMealPlan(dayTap('2026-11-24')); assert.deepEqual(app.calls.routes, []);
  }
});

test('profile switches clear old cards immediately and reject late meal results', async () => {
  const old = deferred();
  const app = setup({getPlans: id => id === PROFILE ? old.promise : {days: [day('2026-11-25')], nextOffset: null}});
  await app.page.load(); const pending = app.page.changeContentTab(tap('mealPlans'));
  app.page.profileId = OTHER_PROFILE; await app.page.load();
  assert.equal(app.page.data.contentTab, 'mealPlans'); assert.equal(app.page.data.profile.id, OTHER_PROFILE);
  const updates = app.calls.updates; old.resolve({days: [day()], nextOffset: 2}); await pending;
  assert.equal(app.calls.updates, updates); assert.deepEqual(app.page.data.mealPlanDays.map(item => item.date), ['2026-11-25']);
});

test('an old recipe pagination response cannot populate a later tab session', async () => {
  const gate = deferred();
  const app = setup({getProfile: (id, offset) => offset ? gate.promise : {profile: {id, name: '厨房', exists: true}, isSelf: false,
    recipes: [{id: 'one'}], nextOffset: 1}});
  await app.page.load(); const more = app.page.loadMore();
  app.page.changeContentTab(tap('recipes'));
  assert.equal(app.page.data.loadingMore, true, 'reselecting the active tab cannot unlock a second pagination request');
  await app.page.changeContentTab(tap('mealPlans')); app.page.changeContentTab(tap('recipes'));
  gate.resolve({recipes: [{id: 'late'}], nextOffset: null}); await more;
  assert.deepEqual(app.page.data.recipes, [{id: 'one'}]); assert.equal(app.page.data.loadingMore, false);
});

test('meal plan summaries expose only day, meal and recipe names and never mutate server data', () => {
  const data = [day()], before = clone(data);
  data[0].meals[0].recipe.note = 'PRIVATE'; before[0].meals[0].recipe.note = 'PRIVATE';
  assert.ok(!JSON.stringify(mealPlanDays(data)).includes('PRIVATE')); assert.deepEqual(data, before);
  const result = build({recipes: [], logs: []}, {tab: 'mealPlans'});
  assert.deepEqual(result, {recipes: [], logs: [], recipeCount: 0, favoriteCount: 0, logCount: 0});
});


test('own meal lists refresh after a synced revision changes without reloading the unchanged profile', async () => {
  let date = '2026-11-24';
  const app = setup({mine: true, getPlans: () => ({days: [day(date)], nextOffset: null})});
  await app.page.onShow(); await app.page.changeContentTab(tap('mealPlans'));
  date = '2026-11-25'; app.changeReadVersion();
  await app.page.onShow();
  assert.equal(app.calls.plans.length, 2);
  assert.deepEqual(app.page.data.mealPlanDays.map(item => item.date), [date]);
  await app.page.onShow(); assert.equal(app.calls.plans.length, 2);
  app.page.changeContentTab(tap('recipes'));
  date = '2026-11-26'; app.changeReadVersion();
  await app.page.changeContentTab(tap('mealPlans'));
  assert.equal(app.calls.plans.length, 3);
  assert.deepEqual(app.page.data.mealPlanDays.map(item => item.date), [date]);
});

test('meal lists expire independently of the mine profile and refresh at the first page before more pages', async () => {
  const app = setup({mine: true, getPlans: (id, offset) => ({days: [day()], nextOffset: offset + 1})});
  await app.page.onShow(); await app.page.changeContentTab(tap('mealPlans'));
  app.advance(30000); await app.page.onShow();
  assert.deepEqual(app.calls.plans.map(call => call.offset), [0, 0]);
  app.changeReadVersion(); await app.page.loadMore();
  assert.deepEqual(app.calls.plans.map(call => call.offset), [0, 0, 0]);
});

test('failed automatic meal refreshes wait for an explicit retry, new version or expiry', async () => {
  const app = setup({mine: true, getPlans: () => {throw Error('网络暂不可用');}});
  await app.page.onShow(); await app.page.changeContentTab(tap('mealPlans'));
  await app.page.onShow(); await app.page.onReachBottom();
  app.page.changeContentTab(tap('recipes')); await app.page.changeContentTab(tap('mealPlans'));
  assert.equal(app.calls.plans.length, 1);
  app.changeReadVersion(); await app.page.onShow(); assert.equal(app.calls.plans.length, 2);
  await app.page.onShow(); assert.equal(app.calls.plans.length, 2);
  await app.page.retryMealPlans(); assert.equal(app.calls.plans.length, 3);
  app.advance(30000); await app.page.onShow(); assert.equal(app.calls.plans.length, 4);
});
