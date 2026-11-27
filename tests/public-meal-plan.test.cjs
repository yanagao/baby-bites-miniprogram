'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {getProfileAvatar} = require('../utils/profile-avatar');
const {normalizeMealPlan} = require('../utils/public-meal-plans');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const profileId = 'a'.repeat(32), date = '2026-11-24', publicId = 'b'.repeat(64);
const today = '2026-11-25', tomorrow = '2026-11-26';
const appImage = '/assets/cute/pocket-mascot.png';
const author = {id: profileId, name: '朋友的小厨房', bio: '家常做法', babyAgeMonths: 18, exists: true};
const result = {author, date, meals: [
  {meal: 'dinner', label: '晚餐', recipe: {id: 'pumpkin-millet', kind: 'builtin', name: '南瓜小米粥', minutes: 30, texture: '软烂颗粒', imageKey: 'pumpkin'}},
  {meal: 'breakfast', label: '早餐', recipe: {id: publicId, kind: 'public', name: '家常小饼', minutes: 20, texture: '手指食物', photoURL: 'https://images.example/food.jpg'}}
]};

function setup(query = {profileId, date}) {
  let owner = 'owner-a', scope = 'owner-a:personal', version = 1;
  const listeners = new Set(), hooks = {};
  const calls = {reads: [], routes: [], updates: [], covers: [], backs: 0,
    previews: [], copies: [], tabs: [], toasts: [], selectedDates: [], refreshStops: 0};
  const store = {getState: () => ({recipes: [], logs: [], mealPlans: []}),
    getSyncInfo: () => ({owner, scopeKey: scope, scope: {kind: scope.endsWith(':personal') ? 'personal' : 'family'}}), subscribe(listener) {
    listeners.add(listener); return () => listeners.delete(listener);
  }};
  const wx = {showShareMenu() {}, hideShareMenu() {}, navigateTo(options) { calls.routes.push(options.url); },
    showToast(options) { calls.toasts.push(options.title); }, stopPullDownRefresh() { calls.refreshStops++; },
    switchTab(options) {
      calls.tabs.push(options.url);
      if (hooks.switchTab) return hooks.switchTab(options);
      if (options.success) options.success();
    }};
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {
    wx, module: accountModule, require(name) { if (name === '../../utils/store') return store; throw Error(name); }
  });
  const social = {getReadVersion: () => version, getMealPlan(id, day, options) {
    calls.reads.push({profileId: id, date: day, options: clone(options || {})});
    return hooks.read ? hooks.read(id, day, options) : Promise.resolve(clone(result));
  }};
  const copyHelper = {
    preview(meals, day, mode) {
      calls.previews.push({meals: clone(meals), date: day, mode});
      if (hooks.preview) return hooks.preview(meals, day, mode);
      const rows = meals.filter(meal => meal.planned);
      return {rows, expected: [], saveCount: rows.filter(meal => meal.recipe).length,
        conflictCount: 0, unavailableCount: rows.filter(meal => !meal.recipe).length};
    },
    save(input) {
      calls.copies.push(input);
      if (hooks.copy) return hooks.copy(input);
      return Promise.resolve({date: input.targetDate, savedCount: 2, keptCount: 0,
        unavailableCount: 0, scopeKey: scope});
    }
  };
  const recordsPage = {route: 'pages/records/index', selectConfirmedDate(day, scopeKey) {
    calls.selectedDates.push({date: day, scopeKey});
  }};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/public-meal-plan/index.js'), 'utf8'), {
    wx, getCurrentPages: () => hooks.currentPages || [recordsPage], Page(value) { definition = value; },
    require(name) {
      if (name === '../../utils/social') return social;
      if (name === '../../utils/store') return store;
      if (name === '../../utils/selectors') return {today: () => today};
      if (name === '../../utils/meal-plan-copy') return copyHelper;
      if (name === '../profile/account') return accountModule.exports;
      if (name === '../../utils/meal-plans') return require('../utils/meal-plans');
      if (name === '../../utils/calendar') return require('../utils/calendar');
      if (name === '../../utils/profile-avatar') return {getProfileAvatar};
      if (name === '../../utils/recipe-covers') return {withCover(recipe) {
        calls.covers.push(recipe.id); return {...recipe, displayPhoto: recipe.kind === 'builtin' ? 'wxfile://usr/builtin-cover.jpg' : ''};
      }};
      if (name === '../../utils/ui') return {back() { calls.backs++; }};
      throw Error(name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(fields) {
    calls.updates.push(clone(fields)); Object.assign(this.data, clone(fields));
  }};
  page.onLoad(query);
  return {page, calls, hooks, listeners, changeReadVersion() { version++; },
    changeIdentity(nextOwner, nextScope = scope, notify = true) {
      owner = nextOwner; scope = nextScope; if (notify) listeners.forEach(listener => listener());
    }};
}

const mealEvent = meal => ({currentTarget: {dataset: {meal}}});
const dateEvent = value => ({detail: {value}});
const modeEvent = mode => ({currentTarget: {dataset: {mode}}});

test('loads confirmed meals in breakfast-lunch-dinner order and fills missing slots without editing state', async () => {
  const app = setup();
  await app.page.onShow();
  assert.deepEqual(app.calls.reads, [{profileId, date, options: {}}]);
  assert.equal(app.page.data.loading, false); assert.equal(app.page.data.ready, true);
  assert.equal(app.page.data.dateLabel, '11 月 24 日'); assert.equal(app.page.data.weekdayLabel, '周二');
  assert.deepEqual(app.page.data.meals.map(row => row.meal), ['breakfast', 'lunch', 'dinner']);
  assert.equal(app.page.data.meals[1].planned, false); assert.equal(app.page.data.meals[1].emptyLabel, '未安排');
  assert.equal(app.page.data.meals[0].recipe.displayPhoto, 'https://images.example/food.jpg');
  assert.equal(app.page.data.meals[2].recipe.displayPhoto, 'wxfile://usr/builtin-cover.jpg');
  assert.deepEqual(app.calls.covers, ['pumpkin-millet']);
  assert.equal(app.page.data.author.avatar, getProfileAvatar(profileId));
});

test('public meal-plan normalization preserves only safe avatar URLs and the page falls back on image errors', async () => {
  const app = setup(); let avatarURL = 'https://example.test/author-avatar.png';
  app.hooks.read = (id, day) => normalizeMealPlan({...clone(result), author: {...author, avatarURL}}, id, day);
  const error = url => ({currentTarget: {dataset: {id: author.id, url}}});
  await app.page.load(); assert.equal(app.page.data.author.avatar, avatarURL);
  app.page.authorAvatarError(error(avatarURL)); assert.equal(app.page.data.author.avatar, getProfileAvatar(author.id));
  await app.page.reload(); assert.equal(app.page.data.author.avatar, getProfileAvatar(author.id));
  const previous = avatarURL; avatarURL = 'https://example.test/replaced-avatar.png';
  await app.page.reload(); assert.equal(app.page.data.author.avatar, avatarURL);
  app.page.authorAvatarError(error(previous)); assert.equal(app.page.data.author.avatar, avatarURL);
  for (const unsafe of ['http://example.test/avatar', 'https://user@example.test/avatar', 'cloud://private/avatar']) {
    const normalized = normalizeMealPlan({...clone(result), author: {...author, avatarURL: unsafe}}, profileId, date);
    assert.equal(normalized.author.avatarURL, undefined);
  }
  app.page.authorAvatarError(error(avatarURL)); app.changeIdentity('owner-b'); await app.page.reload();
  assert.equal(app.page.data.author.avatar, avatarURL);
});

test('opens recipes and author using loaded identifiers and ignores missing meals or injected targets', async () => {
  const app = setup(); await app.page.onShow();
  app.page.openRecipe(mealEvent('breakfast')); app.page.openRecipe(mealEvent('dinner'));
  app.page.openRecipe(mealEvent('lunch')); app.page.openRecipe(mealEvent('unknown'));
  app.page.openRecipe({currentTarget: {dataset: {id: 'injected'}}});
  app.page.openAuthor(); app.page.back();
  assert.deepEqual(app.calls.routes, ['/pages/public-recipe/index?id=' + publicId,
    '/pages/builtin-recipe/index?id=pumpkin-millet', '/pages/profile/index?id=' + profileId]);
  assert.equal(app.calls.backs, 1);
});

test('sharing uses the selected date and public author name with a stable mascot image', async () => {
  const app = setup(); await app.page.onShow();
  const share = app.page.onShareAppMessage();
  assert.equal(share.title, date + ' 餐单 · ' + author.name);
  assert.equal(share.path, '/pages/public-meal-plan/index?profileId=' + profileId + '&date=' + date);
  assert.equal(share.imageUrl, appImage);
});

test('real meal-plan normalization delivers a renderable author and preserves recipe and sharing routes', async () => {
  const app = setup();
  app.hooks.read = (id, day) => normalizeMealPlan(clone(result), id, day);
  await app.page.onShow();
  assert.equal(app.page.data.error, ''); assert.equal(app.page.data.ready, true);
  assert.equal(app.page.data.author.id, profileId); assert.equal(app.page.data.author.name, author.name);
  assert.equal(app.page.data.meals[0].recipe.id, publicId);
  assert.equal(app.page.data.meals[1].emptyLabel, '未安排');
  assert.equal(app.page.data.meals[2].recipe.kind, 'builtin');
  app.page.openRecipe(mealEvent('breakfast')); app.page.openRecipe(mealEvent('dinner')); app.page.openAuthor();
  assert.deepEqual(app.calls.routes, ['/pages/public-recipe/index?id=' + publicId,
    '/pages/builtin-recipe/index?id=pumpkin-millet', '/pages/profile/index?id=' + profileId]);
  assert.equal(app.page.onShareAppMessage().path, '/pages/public-meal-plan/index?profileId=' + profileId + '&date=' + date);
  assert.equal(app.page.onShareAppMessage().imageUrl, appImage);
});

test('does not place private feedback, baby names or unknown response fields in page state or sharing', async () => {
  const app = setup();
  app.hooks.read = () => ({...clone(result), babyNickname: '私密宝宝名', logs: [{note: '私密心得'}],
    author: {...author, babyNickname: '私密宝宝名'},
    meals: [{meal: 'breakfast', rating: 3, portion: '私密食量', note: '私密心得',
      recipe: {...result.meals[1].recipe, note: '私密心得', privatePhoto: 'wxfile://usr/private.jpg'}}]});
  await app.page.onShow();
  const serialized = JSON.stringify(app.page.data) + JSON.stringify(app.page.onShareAppMessage());
  assert.doesNotMatch(serialized, /私密|privatePhoto|babyNickname|rating|portion/);
});

test('invalid links never request data or navigate and share the generic app card', async t => {
  for (const query of [{}, {profileId, date: '2026-02-30'}, {profileId, date: '2026-2-01'},
    {profileId, date: '0999-01-01'}, {profileId, date: null}, {profileId: [], date},
    {profileId: profileId.toUpperCase(), date}, {profileId: profileId + '&private=1', date}]) {
    await t.test(JSON.stringify(query), async () => {
      const app = setup(query); await app.page.onShow(); await app.page.reload();
      app.page.openAuthor(); app.page.openRecipe(mealEvent('breakfast'));
      assert.equal(app.calls.reads.length, 0); assert.deepEqual(app.calls.routes, []);
      assert.match(app.page.data.error, /链接|日期/); assert.equal(app.page.data.loading, false);
      assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
    });
  }
});

test('an unavailable recipe is distinct from an unplanned meal and cannot navigate', async () => {
  const app = setup(); app.hooks.read = (id, day) => normalizeMealPlan({author, date, meals: [{meal: 'lunch', recipe: null}]}, id, day);
  await app.page.onShow();
  assert.equal(app.page.data.meals[0].emptyLabel, '未安排');
  assert.equal(app.page.data.meals[1].planned, true);
  assert.equal(app.page.data.meals[1].emptyLabel, '菜谱暂不可查看');
  app.page.openRecipe(mealEvent('lunch')); assert.deepEqual(app.calls.routes, []);
});

test('a day without confirmed plans shows a retryable empty error and can load a later confirmed plan', async () => {
  const app = setup(); app.hooks.read = () => { throw Object.assign(Error('这一天还没有已确认的餐单。'), {code: 'NOT_FOUND'}); };
  await app.page.onShow();
  assert.equal(app.page.data.ready, false); assert.equal(app.page.data.hasPlans, false);
  assert.match(app.page.data.error, /没有已确认/); assert.deepEqual(app.page.data.meals, []);
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  app.hooks.read = (id, day) => normalizeMealPlan(clone(result), id, day); await app.page.reload();
  assert.equal(app.page.data.hasPlans, true); assert.equal(app.calls.reads.length, 2);
});

test('undefined, missing, empty and malformed meals from the real normalizer become retryable errors', async t => {
  for (const [label, response] of [
    ['undefined response', undefined], ['null response', null], ['missing meals', {author, date}],
    ['undefined meals', {author, date, meals: undefined}], ['null meals', {author, date, meals: null}],
    ['empty meals', {author, date, meals: []}], ['missing recipe', {author, date, meals: [{meal: 'lunch'}]}]
  ]) await t.test(label, async () => {
    const app = setup(); app.hooks.read = (id, day) => normalizeMealPlan(response, id, day);
    await app.page.onShow();
    assert.equal(app.page.data.loading, false); assert.equal(app.page.data.ready, false);
    assert.match(app.page.data.error, /餐单/); assert.equal(app.page.data.author, null);
    assert.deepEqual(app.page.data.meals, []); assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
    app.hooks.read = (id, day) => normalizeMealPlan(clone(result), id, day);
    await app.page.reload(); assert.equal(app.page.data.ready, true);
  });
});

test('loading and failed reads clear old meal content, disable navigation and allow a retry', async () => {
  const app = setup(); await app.page.onShow();
  const pending = deferred(); app.hooks.read = () => pending.promise;
  const loading = app.page.reload(); await turn();
  assert.equal(app.page.data.loading, true); assert.equal(app.page.data.author, null);
  assert.deepEqual(app.page.data.meals, []);
  app.page.openAuthor(); app.page.openRecipe(mealEvent('breakfast'));
  assert.deepEqual(app.calls.routes, []); assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  pending.reject(Error('餐单已撤回')); await loading;
  assert.equal(app.page.data.loading, false); assert.match(app.page.data.error, /撤回/);
  assert.equal(app.page.data.ready, false); assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  app.hooks.read = () => clone(result); await app.page.reload();
  assert.equal(app.page.data.error, ''); assert.equal(app.page.data.ready, true);
});

test('concurrent shows share the read, ordinary returns preserve meals, and changed versions refresh withdrawals', async () => {
  const app = setup(), pending = deferred(); app.hooks.read = () => pending.promise;
  const first = app.page.onShow(), second = app.page.onShow(); await turn();
  assert.equal(app.calls.reads.length, 1);
  pending.resolve(clone(result)); await Promise.all([first, second]);
  app.page.photoError(mealEvent('breakfast'));
  const meals = clone(app.page.data.meals), updates = app.calls.updates.length;
  for (let i = 0; i < 3; i++) await app.page.onShow();
  assert.equal(app.calls.reads.length, 1); assert.deepEqual(app.page.data.meals, meals);
  assert.equal(app.calls.updates.length, updates);
  app.changeReadVersion();
  app.hooks.read = () => { throw Error('餐单已撤回'); };
  await app.page.onShow();
  assert.equal(app.calls.reads.length, 2); assert.match(app.page.data.error, /撤回/);
  assert.deepEqual(app.page.data.meals, []);
});

test('meal-plan pull-down refreshes force a read, coalesce while pending, and stop after completion', async () => {
  const app = setup(), pending = deferred(); await app.page.onShow();
  app.hooks.read = () => pending.promise;
  const refresh = app.page.onPullDownRefresh(), repeat = app.page.onPullDownRefresh();
  const revisit = app.page.onShow(); await turn();
  assert.equal(refresh, repeat); assert.equal(app.calls.reads.length, 2);
  assert.equal(app.calls.reads[1].options.force, true);
  pending.resolve({...clone(result), author: {...author, name: '更新的餐单作者'}});
  await Promise.all([refresh, revisit]);
  assert.equal(app.page.data.author.name, '更新的餐单作者'); assert.equal(app.calls.refreshStops, 1);
  app.page.openCopy(); await app.page.onPullDownRefresh();
  assert.equal(app.calls.reads.length, 2); assert.equal(app.calls.refreshStops, 2);
});

test('a superseded read cannot overwrite the newer response or clear its loading state', async () => {
  const app = setup(), first = deferred(), second = deferred();
  app.hooks.read = () => first.promise;
  const oldLoad = app.page.onShow(); await turn();
  app.hooks.read = () => second.promise;
  const newLoad = app.page.reload(); await turn();
  first.resolve(clone(result)); await oldLoad;
  assert.equal(app.page.data.loading, true); assert.deepEqual(app.page.data.meals, []);
  second.resolve({...clone(result), author: {...author, name: '更新后的小厨房'}}); await newLoad;
  assert.equal(app.page.data.author.name, '更新后的小厨房');
});

test('late requests cannot repopulate an unloaded page or an account/family that changed and returned', async t => {
  for (const mode of ['unload', 'account', 'family', 'account-aba', 'family-aba', 'silent-account']) {
    await t.test(mode, async () => {
      const app = setup(), pending = deferred(); app.hooks.read = () => pending.promise;
      const loading = app.page.onShow(); await turn();
      if (mode === 'unload') app.page.onUnload();
      else if (mode.startsWith('family')) {
        app.changeIdentity('owner-a', 'family-b');
        if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
      } else {
        app.changeIdentity('owner-b', 'owner-b:personal', mode !== 'silent-account');
        if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
      }
      const updates = app.calls.updates.length;
      pending.resolve(clone(result)); await loading;
      assert.equal(app.page.data.author, null); assert.deepEqual(app.page.data.meals, []);
      assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
      app.page.openAuthor(); app.page.openRecipe(mealEvent('breakfast')); assert.deepEqual(app.calls.routes, []);
      if (mode !== 'silent-account') assert.equal(app.calls.updates.length, updates);
      if (mode === 'unload') assert.equal(app.listeners.size, 0);
      else {
        app.hooks.read = () => clone(result); await app.page.reload();
        assert.equal(app.page.data.ready, true);
      }
    });
  }
});

test('ACCOUNT_CHANGED errors invalidate the session until explicit retry', async () => {
  const app = setup(); app.hooks.read = () => { throw Object.assign(Error('身份变化'), {code: 'ACCOUNT_CHANGED'}); };
  await app.page.onShow();
  assert.equal(app.page.accountSession.changed, true); assert.equal(app.page.data.loading, false);
  assert.match(app.page.data.error, /账号|家庭/);
  await app.page.onShow(); assert.equal(app.calls.reads.length, 1);
  app.hooks.read = () => clone(result); await app.page.reload(); assert.equal(app.page.data.ready, true);
});

test('rejects mismatched authors, dates and duplicate meal slots without exposing a stale plan', async t => {
  for (const invalid of [
    {...clone(result), date: '2026-11-25'}, {...clone(result), author: {...author, id: 'c'.repeat(32)}},
    {...clone(result), author: {...author, exists: false}}, {...clone(result), author: {...author, name: ''}},
    {...clone(result), meals: [result.meals[0], result.meals[0]]},
    {...clone(result), meals: [{meal: 'snack', recipe: result.meals[0].recipe}]},
    {...clone(result), meals: []}, {...clone(result), meals: [{meal: 'lunch'}]}
  ]) await t.test(JSON.stringify(invalid), async () => {
    const app = setup(); app.hooks.read = () => invalid; await app.page.onShow();
    assert.ok(app.page.data.error); assert.equal(app.page.data.author, null);
    assert.deepEqual(app.page.data.meals, []); assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  });
});

test('invalid recipe destinations render as unavailable and image errors only replace that meal photo', async () => {
  const app = setup(); app.hooks.read = () => ({author, date, meals: [
    ...clone(result.meals), {meal: 'lunch', recipe: {id: '../private?token=secret', kind: 'public', name: '无效菜谱'}}
  ]});
  await app.page.onShow();
  assert.equal(app.page.data.meals[1].recipe, null); app.page.openRecipe(mealEvent('lunch'));
  assert.deepEqual(app.calls.routes, []);
  app.page.photoError(mealEvent('breakfast'));
  assert.equal(app.page.data.meals[0].photoFailed, true); assert.equal(app.page.data.meals[2].photoFailed, false);
  assert.equal(app.page.onShareAppMessage().imageUrl, appImage);
  await app.page.reload(); assert.equal(app.page.data.meals[0].photoFailed, false);
});

test('copying starts with tomorrow and preserves the source until the user confirms', async () => {
  const app = setup();
  app.page.openCopy(); assert.equal(app.page.data.copyVisible, false);
  await app.page.onShow(); app.page.openCopy();
  assert.equal(app.page.data.hasSavableMeals, true);
  assert.equal(app.page.data.copyVisible, true); assert.equal(app.page.data.copySaving, false);
  assert.equal(app.page.data.copyDate, tomorrow); assert.equal(app.page.data.copyMinDate, today);
  assert.equal(app.page.data.copyMode, 'keep'); assert.equal(app.page.data.copySaveCount, 2);
  assert.equal(app.page.data.copyDestination, '保存到我的餐单');
  assert.deepEqual(app.calls.previews[0], {meals: app.page.data.meals, date: tomorrow, mode: 'keep'});
  assert.equal(app.calls.copies.length, 0); assert.deepEqual(app.calls.tabs, []);
  assert.equal(app.page.data.date, date);
  app.page.copyVisibleChange({detail: {visible: false}});
  assert.equal(app.page.data.copyVisible, false); assert.deepEqual(app.page.data.copyRows, []);
});

test('an unavailable source cannot open a copy sheet or submit a save', async () => {
  const app = setup(); app.hooks.read = () => ({author, date, meals: [{meal: 'breakfast', recipe: null}]});
  await app.page.onShow(); app.page.openCopy(); await app.page.confirmCopy();
  assert.equal(app.page.data.hasSavableMeals, false); assert.equal(app.page.data.copyVisible, false);
  assert.equal(app.calls.previews.length, 0); assert.equal(app.calls.copies.length, 0);
});

test('date and conflict mode changes refresh the preview and pass the final snapshot to save', async () => {
  const app = setup(); await app.page.onShow();
  const expected = [{id: 'local-breakfast', meal: 'breakfast', recipeId: 'already-planned'}];
  app.hooks.preview = (meals, targetDate, mode) => ({expected,
    rows: [{meal: 'breakfast', action: mode, existingName: '原有粥'},
      {meal: 'dinner', action: 'add'}, {meal: 'lunch', action: 'unavailable'}],
    saveCount: mode === 'keep' ? 1 : 2, conflictCount: 1, unavailableCount: 1});
  app.page.openCopy();
  assert.equal(app.page.data.copyRows[0].actionLabel, '保留：原有粥');
  assert.equal(app.page.data.copySaveCount, 1); assert.equal(app.page.data.copyConflictCount, 1);
  assert.equal(app.page.data.copyUnavailableCount, 1);
  app.page.changeCopyDate(dateEvent('2026-11-28'));
  app.page.changeCopyMode(modeEvent('replace'));
  assert.equal(app.page.data.copyRows[0].actionLabel, '将替换：原有粥');
  assert.equal(app.page.data.copySaveCount, 2);
  const previews = app.calls.previews.length;
  app.page.changeCopyMode(modeEvent('unknown'));
  app.page.changeCopyDate(dateEvent('2026-02-30')); app.page.changeCopyDate(dateEvent(date));
  assert.equal(app.calls.previews.length, previews); assert.equal(app.page.data.copyDate, '2026-11-28');
  assert.match(app.page.data.copyError, /今天|日期/);
  app.page.changeCopyDate(dateEvent('2026-11-28'));
  await app.page.confirmCopy();
  const input = app.calls.copies[0];
  assert.equal(input.profileId, profileId); assert.equal(input.sourceDate, date);
  assert.equal(input.targetDate, '2026-11-28'); assert.equal(input.mode, 'replace');
  assert.deepEqual(clone(input.expected), expected); assert.deepEqual(clone(input.meals), app.page.data.meals);
  assert.equal(typeof input.isCurrent, 'function'); assert.equal(input.isCurrent(), true);
  assert.equal(app.page.data.copySavedDate, '2026-11-28'); assert.equal(app.page.data.copySaving, false);
});

test('returning to an open copy sheet refreshes local conflicts without dropping its draft', async () => {
  const app = setup(); await app.page.onShow(); app.page.openCopy();
  app.page.changeCopyDate(dateEvent('2026-11-28')); app.page.changeCopyMode(modeEvent('replace'));
  app.hooks.preview = () => ({rows: [{meal: 'breakfast', action: 'locked', existingName: '刚记过的早餐'}],
    expected: [{id: 'completed-plan'}], saveCount: 1, conflictCount: 1, unavailableCount: 0});
  await app.page.onShow();
  assert.equal(app.calls.reads.length, 1); assert.equal(app.page.data.copyVisible, true);
  assert.equal(app.page.data.copyDate, '2026-11-28'); assert.equal(app.page.data.copyMode, 'replace');
  assert.equal(app.page.data.copyRows[0].actionLabel, '已记录用餐，保留：刚记过的早餐');
});

test('saving locks duplicate submits, dismissal, date/mode edits and navigation until completion', async () => {
  const app = setup(), pending = deferred(); await app.page.onShow(); app.page.openCopy();
  app.hooks.copy = () => pending.promise;
  const saving = app.page.confirmCopy();
  assert.equal(app.page.data.copySaving, true); assert.equal(app.calls.copies.length, 1);
  await app.page.confirmCopy(); app.page.changeCopyDate(dateEvent('2026-11-28'));
  app.page.changeCopyMode(modeEvent('replace')); app.page.closeCopy();
  app.page.copyVisibleChange({detail: {visible: false}}); app.page.openCopy();
  app.page.openAuthor(); app.page.openRecipe(mealEvent('breakfast')); app.page.back();
  await app.page.onShow();
  assert.equal(app.calls.copies.length, 1); assert.equal(app.calls.reads.length, 1);
  assert.equal(app.page.data.copyVisible, true); assert.equal(app.page.data.copyDate, tomorrow);
  assert.equal(app.page.data.copyMode, 'keep'); assert.deepEqual(app.calls.routes, []); assert.equal(app.calls.backs, 0);
  pending.resolve({date: tomorrow, savedCount: 1, keptCount: 1, unavailableCount: 1, scopeKey: 'owner-a:personal'});
  await saving;
  assert.equal(app.page.data.copySaving, false); assert.equal(app.page.data.copySavedDate, tomorrow);
  assert.match(app.page.data.copyResultMessage, /已安排 1 餐/);
  assert.match(app.page.data.copyResultMessage, /保留原有 1 餐/);
  assert.match(app.page.data.copyResultMessage, /跳过未公开的 1 餐/);
  app.page.changeCopyDate(dateEvent('2026-11-28')); app.page.changeCopyMode(modeEvent('replace'));
  await app.page.confirmCopy(); await app.page.onShow();
  assert.equal(app.calls.copies.length, 1); assert.equal(app.calls.reads.length, 1);
  assert.equal(app.page.data.copyDate, tomorrow); assert.equal(app.page.data.copyMode, 'keep');
  app.page.viewCopiedPlan();
  assert.deepEqual(app.calls.tabs, ['/pages/records/index']);
  assert.deepEqual(app.calls.selectedDates, [{date: tomorrow, scopeKey: 'owner-a:personal'}]);
});

test('a failed copy keeps date and mode, refreshes conflicts, and supports explicit retry', async () => {
  const app = setup(); await app.page.onShow(); app.page.openCopy();
  app.page.changeCopyDate(dateEvent('2026-11-28')); app.page.changeCopyMode(modeEvent('replace'));
  app.hooks.copy = () => { throw Error('连接暂时中断'); };
  const previews = app.calls.previews.length;
  await app.page.confirmCopy();
  assert.equal(app.page.data.copyVisible, true); assert.equal(app.page.data.copySaving, false);
  assert.equal(app.page.data.copyDate, '2026-11-28'); assert.equal(app.page.data.copyMode, 'replace');
  assert.equal(app.page.data.copySavedDate, ''); assert.match(app.page.data.copyError, /连接暂时中断/);
  assert.equal(app.calls.previews.length, previews + 1); assert.deepEqual(app.calls.tabs, []);
  app.hooks.copy = undefined; await app.page.confirmCopy();
  assert.equal(app.calls.copies.length, 2); assert.equal(app.page.data.copySavedDate, '2026-11-28');
  assert.equal(app.page.data.copyError, '');
});

test('a changed source closes the copy sheet and reloads the public plan before asking to retry', async () => {
  const app = setup(); await app.page.onShow(); app.page.openCopy();
  app.hooks.copy = () => { throw Object.assign(Error('来源已变化'), {code: 'SOURCE_CHANGED'}); };
  app.hooks.read = () => ({...clone(result), meals: [clone(result.meals[0])]});
  await app.page.confirmCopy();
  assert.equal(app.page.data.copyVisible, false); assert.equal(app.page.data.copySaving, false);
  assert.equal(app.page.data.copySavedDate, ''); assert.equal(app.calls.reads.length, 2);
  assert.deepEqual(app.calls.reads[1].options, {force: true});
  assert.equal(app.page.data.meals[0].planned, false); assert.equal(app.page.data.meals[2].planned, true);
  assert.equal(app.calls.toasts.length, 1); assert.match(app.calls.toasts[0], /原餐单有更新/);
  assert.deepEqual(app.calls.tabs, []);
});

test('pending copies cannot update or navigate after unload, identity changes or identity ABA', async t => {
  for (const mode of ['unload', 'account', 'family', 'account-aba', 'family-aba', 'silent-account']) {
    await t.test(mode, async () => {
      const app = setup(), pending = deferred(); await app.page.onShow(); app.page.openCopy();
      app.hooks.copy = () => pending.promise;
      const saving = app.page.confirmCopy(), input = app.calls.copies[0];
      assert.equal(input.isCurrent(), true);
      if (mode === 'unload') app.page.onUnload();
      else if (mode.startsWith('family')) {
        app.changeIdentity('owner-a', 'family-b');
        if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
      } else {
        app.changeIdentity('owner-b', 'owner-b:personal', mode !== 'silent-account');
        if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
      }
      assert.equal(input.isCurrent(), false);
      const updates = app.calls.updates.length;
      pending.resolve({date: tomorrow, savedCount: 2, keptCount: 0, unavailableCount: 0, scopeKey: 'owner-a:personal'});
      await saving;
      assert.equal(app.calls.updates.length, updates); assert.equal(app.page.data.copySavedDate, '');
      app.page.viewCopiedPlan(); assert.deepEqual(app.calls.tabs, []); assert.deepEqual(app.calls.selectedDates, []);
    });
  }
});

test('copy ACCOUNT_CHANGED errors invalidate the sheet and require an explicit reload', async () => {
  const app = setup(); await app.page.onShow(); app.page.openCopy();
  app.hooks.copy = () => { throw Object.assign(Error('身份变化'), {code: 'ACCOUNT_CHANGED'}); };
  await app.page.confirmCopy();
  assert.equal(app.page.accountSession.changed, true); assert.equal(app.page.data.copyVisible, false);
  assert.equal(app.page.data.copySavedDate, ''); assert.match(app.page.data.error, /账号|家庭/);
  await app.page.onShow(); assert.equal(app.calls.reads.length, 1);
  await app.page.reload(); app.page.openCopy(); assert.equal(app.page.data.copyVisible, true);
});

test('viewing a copied family plan selects the saved date after switchTab unloads the source page', async () => {
  const app = setup(); app.changeIdentity('owner-a', 'family-b'); await app.page.reload();
  app.page.openCopy(); assert.equal(app.page.data.copyDestination, '保存到当前家庭餐单');
  await app.page.confirmCopy();
  let navigation; app.hooks.switchTab = options => { navigation = options; };
  app.page.viewCopiedPlan(); assert.deepEqual(app.calls.selectedDates, []);
  app.page.onUnload();
  navigation.success();
  assert.deepEqual(app.calls.selectedDates, [{date: tomorrow, scopeKey: 'family-b'}]);
  assert.equal(app.listeners.size, 0);
});

test('delayed records navigation cannot select a date after an account/family ABA or on another page', async t => {
  for (const mode of ['wrong-page', 'account', 'family', 'account-aba', 'family-aba']) await t.test(mode, async () => {
    const app = setup(); await app.page.onShow(); app.page.openCopy(); await app.page.confirmCopy();
    let navigation; app.hooks.switchTab = options => { navigation = options; };
    app.page.viewCopiedPlan(); assert.equal(app.calls.tabs.length, 1);
    app.page.onUnload();
    if (mode === 'wrong-page') app.hooks.currentPages = [{route: 'pages/home/index', selectConfirmedDate() {
      assert.fail('must not call a method on a different page');
    }}];
    else if (mode.startsWith('family')) {
      app.changeIdentity('owner-a', 'family-b');
      if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
    } else {
      app.changeIdentity('owner-b', 'owner-b:personal');
      if (mode.endsWith('aba')) app.changeIdentity('owner-a', 'owner-a:personal');
    }
    navigation.success();
    assert.deepEqual(app.calls.selectedDates, []);
    assert.equal(app.listeners.size, 0);
  });
});

test('all-conflict previews avoid a no-op save while still allowing the existing date to open', async () => {
  const app = setup(); await app.page.onShow();
  app.hooks.preview = () => ({rows: [{meal: 'breakfast', action: 'keep', existingName: '原有早餐'}],
    expected: [{id: 'existing'}], saveCount: 0, conflictCount: 1, unavailableCount: 0});
  app.page.openCopy(); await app.page.confirmCopy();
  assert.equal(app.calls.copies.length, 0); assert.equal(app.page.data.copyCanView, true);
  app.page.viewCopiedPlan();
  assert.deepEqual(app.calls.selectedDates, [{date: tomorrow, scopeKey: 'owner-a:personal'}]);
});

test('the public template offers viewing, retry and sharing without record or edit controls', () => {
  const template = fs.readFileSync(path.join(__dirname, '../pages/public-meal-plan/index.wxml'), 'utf8');
  assert.match(template, /bindtap="openRecipe"/); assert.match(template, /bindtap="openAuthor"/);
  assert.match(template, /open-type="share"/); assert.match(template, /bind:tap="reload"/);
  assert.match(template, /disabled="\{\{!item\.recipe\}\}"/);
  assert.doesNotMatch(template, /rating|portion|recordedBy|babyNickname|bindtap="(?:save|edit|complete)|<input|<textarea/);
});
