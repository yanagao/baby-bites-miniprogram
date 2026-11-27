'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const {MEALS, planId} = require('../utils/meal-plans');
const {getBuiltInRecipe} = require('../utils/recipe-origin');
const {today} = require('../utils/selectors');
const {shiftDate} = require('../utils/calendar');
const A = 'a'.repeat(64), B = 'b'.repeat(64), PROFILE = 'c'.repeat(32);
const PUBLIC = 'd'.repeat(64), SECOND = 'e'.repeat(64);
const DATE = today(), TOMORROW = shiftDate(DATE, 1);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const publicId = (creator, id) => crypto.createHash('sha256').update('public-recipe:' + creator + ':' + id).digest('hex');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const publicRecipe = (id = PUBLIC) => ({id, kind: 'public', name: id === PUBLIC ? '南瓜饭' : '番茄面',
  minutes: 20, texture: '软烂颗粒', imageKey: 'pumpkin', photoURL: ''});
const builtinRecipe = (id = 'pumpkin-millet') => {
  const recipe = getBuiltInRecipe(id);
  return {id, kind: 'builtin', name: recipe.name, minutes: recipe.minutes, texture: recipe.texture,
    imageKey: 'dish:' + id, photoURL: ''};
};
function rows(recipes = [publicRecipe(), undefined, undefined]) {
  return MEALS.map(({value: meal, label}, index) => ({meal, label, planned: recipes[index] !== undefined,
    recipe: recipes[index] === undefined ? null : recipes[index]}));
}
const recipeInput = (name = '自己的菜') => ({name, category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
  ingredients: [{name: '南瓜', amount: '20 克'}], steps: ['蒸熟。'], note: '', photo: ''});

function setup(meals = rows()) {
  const storage = new Map(), calls = [], writes = [], hooks = {}, subscriptions = new Set();
  let active = true, rejectPlanWrite = false, sourceReads = 0;
  const storeFile = path.resolve(__dirname, '../utils/store.js'), storeModule = {exports: {}};
  const wx = {
    getStorageSync: key => copy(storage.get(key)), getStorageInfoSync: () => ({keys: [...storage.keys()]}),
    setStorageSync(key, data) {
      if (rejectPlanWrite && data.data && (data.data.mealPlans || []).some(plan => plan.date === DATE)) throw Error('quota');
      writes.push({key, data: copy(data)}); storage.set(key, copy(data));
    }
  };
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {module: storeModule, require: createRequire(storeFile), wx});
  const store = storeModule.exports;
  store.bindAccount(A);
  const subscribe = store.subscribe;
  store.subscribe = listener => {
    subscriptions.add(listener); const dispose = subscribe(listener);
    return () => { subscriptions.delete(listener); dispose(); };
  };
  const app = {store, calls, writes, hooks, storage, subscriptions, meals: copy(meals),
    remote: {author: {id: PROFILE, name: '分享的小厨房', exists: true}, date: DATE,
      meals: meals.filter(row => row.planned).map(({meal, label, recipe}) => ({meal, label, recipe: copy(recipe)}))},
    cancel() { active = false; }, failPlans() { rejectPlanWrite = true; },
    input(overrides = {}) {
      const mode = overrides.mode || 'keep', targetDate = overrides.targetDate || DATE;
      return {profileId: PROFILE, sourceDate: DATE, targetDate, mode, meals: copy(app.meals),
        expected: app.copy.preview(app.meals, targetDate, mode).expected, isCurrent: () => active, ...overrides};
    },
    addOwn(meal, date = DATE, name = '自己的菜') {
      const id = store.saveRecipe(recipeInput(name));
      if (meal) store.saveMealPlans([{date, meal, recipeId: id}]);
      return id;
    }
  };
  const social = {
    async getMealPlan(profileId, date, options) {
      calls.push({action: 'read', profileId, date, options: copy(options)});
      sourceReads++;
      if (hooks.read) { const result = await hooks.read(sourceReads); if (result !== undefined) return result; }
      return copy(app.remote);
    },
    async addToCookbook(id) {
      calls.push({action: 'import', id});
      if (hooks.beforeImport) await hooks.beforeImport(id);
      const existing = store.findPublicRecipe(id);
      const result = existing ? {recipeId: existing.id, added: false} : store.addPublicRecipe({
        ...recipeInput(), ...publicRecipe(id), profileId: PROFILE, authorName: '分享的小厨房', photo: ''
      }, store.getSyncInfo().owner);
      if (hooks.afterImport) await hooks.afterImport(id, result);
      return result;
    }
  };
  const module = {exports: {}}, file = path.resolve(__dirname, '../utils/meal-plan-copy.js'), ownRequire = createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {module, require(name) {
    if (name === './store') return store;
    if (name === './social') return social;
    return ownRequire(name);
  }});
  app.copy = module.exports;
  return app;
}

test('preview of an empty day reports additions, unavailable recipes and empty slots without writes', () => {
  const app = setup(rows([publicRecipe(), null, undefined])), before = app.writes.length;
  const result = copy(app.copy.preview(app.meals, DATE));
  assert.deepEqual(result, {rows: [
    {meal: 'breakfast', label: '早餐', name: '南瓜饭', existingName: '', conflict: false, locked: false, action: 'add'},
    {meal: 'lunch', label: '午餐', name: '', existingName: '', conflict: false, locked: false, action: 'unavailable'},
    {meal: 'dinner', label: '晚餐', name: '', existingName: '', conflict: false, locked: false, action: 'empty'}
  ], expected: [], saveCount: 1, conflictCount: 0, unavailableCount: 1});
  assert.equal(app.writes.length, before); assert.deepEqual(copy(app.store.getState().recipes), []);
});

test('copying a public and builtin recipe commits the target day once and retains no private source feedback', async () => {
  const app = setup(rows([publicRecipe(), builtinRecipe(), null]));
  const before = app.writes.length, result = await app.copy.save(app.input());
  assert.deepEqual(copy(result), {date: DATE, savedCount: 2, keptCount: 0, unavailableCount: 1, scopeKey: app.store.getScopeKey()});
  const state = app.store.getState();
  assert.equal(state.recipes.length, 2); assert.equal(state.logs.length, 0);
  assert.deepEqual(copy(state.mealPlans.map(plan => [plan.meal, plan.recipeId])),
    [['breakfast', 'shared-' + PUBLIC], ['lunch', 'pumpkin-millet']]);
  const commits = app.writes.slice(before).filter(write => write.data.data && write.data.data.mealPlans);
  assert.equal(commits.length, 1); assert.equal(commits[0].data.data.mealPlans.length, 2);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.calls.map(call => call.action), ['read', 'import', 'read']);
  assert.ok(app.calls.filter(call => call.action === 'read').every(call => call.options.force === true));
  assert.equal(app.subscriptions.size, 0);
});

test('keep and replace modes preserve unrelated dates and only change conflicts when selected', async () => {
  for (const mode of ['keep', 'replace']) {
    const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
    const old = app.addOwn('breakfast'), otherDate = app.addOwn('dinner', TOMORROW, '明天的菜');
    const preview = app.copy.preview(app.meals, DATE, mode);
    assert.equal(preview.rows[0].action, mode === 'keep' ? 'keep' : 'replace');
    assert.equal(preview.conflictCount, 1); assert.equal(preview.saveCount, mode === 'keep' ? 1 : 2);
    const result = await app.copy.save(app.input({mode}));
    assert.equal(result.savedCount, mode === 'keep' ? 1 : 2); assert.equal(result.keptCount, mode === 'keep' ? 1 : 0);
    const plans = app.store.getState().mealPlans;
    assert.equal(plans.find(plan => plan.date === DATE && plan.meal === 'breakfast').recipeId, mode === 'keep' ? old : 'shared-' + PUBLIC);
    assert.equal(plans.find(plan => plan.date === TOMORROW).recipeId, otherDate);
  }
});

test('completed target slots are locked even when their record has no matching current plan', async () => {
  const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
  const breakfast = app.addOwn('breakfast'), lunch = app.addOwn();
  app.store.completeMeal({planId: planId(DATE, 'breakfast')});
  app.store.addLog({recipeId: lunch, date: DATE, meal: 'lunch', rating: 0});
  const preview = app.copy.preview(app.meals, DATE, 'replace');
  assert.deepEqual(copy(preview.rows.slice(0, 2).map(row => [row.locked, row.action])), [[true, 'locked'], [true, 'locked']]);
  const result = await app.copy.save(app.input({mode: 'replace'}));
  assert.equal(result.savedCount, 0); assert.equal(result.keptCount, 2);
  assert.equal(app.store.getState().mealPlans.length, 1); assert.equal(app.store.getState().mealPlans[0].recipeId, breakfast);
  assert.equal(app.calls.some(call => call.action === 'import'), false);
});

test('a meal completed while an import is pending is kept and other slots can still be saved', async () => {
  const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
  app.addOwn('breakfast');
  app.hooks.afterImport = id => { if (id === PUBLIC) app.store.completeMeal({planId: planId(DATE, 'breakfast')}); };
  const result = await app.copy.save(app.input({mode: 'replace'}));
  assert.equal(result.savedCount, 1); assert.equal(result.keptCount, 1);
  assert.equal(app.store.getState().logs.length, 1);
  assert.equal(app.store.getState().mealPlans.find(plan => plan.meal === 'lunch').recipeId, 'shared-' + SECOND);
});

test('removing a completed meal during any await cannot expand the confirmed writable slots', async () => {
  for (const phase of ['read', 'import', 'final-read']) {
    for (const hadPlan of [false, true]) {
      for (const sameDish of [false, true]) {
        const app = setup(rows([publicRecipe(), publicRecipe(sameDish ? PUBLIC : SECOND), undefined]));
        const own = app.addOwn(hadPlan ? 'breakfast' : undefined);
        const logId = app.store.addLog({recipeId: own, date: DATE, meal: 'breakfast', rating: 0});
        const input = app.input({mode: 'replace'}), beforePlans = copy(app.store.getState().mealPlans);
        assert.equal(app.copy.preview(app.meals, DATE, 'replace').rows[0].action, 'locked');
        const unlock = () => app.store.deleteLog(logId);
        if (phase === 'import') app.hooks.afterImport = unlock;
        else app.hooks.read = count => { if (count === (phase === 'read' ? 1 : 2)) unlock(); };
        await assert.rejects(app.copy.save(input), error => error.code === 'TARGET_CHANGED',
          phase + ':plan=' + hadPlan + ':same=' + sameDish);
        assert.deepEqual(copy(app.store.getState().mealPlans), beforePlans);
        assert.equal(app.store.getState().logs.length, 0);
        assert.equal(app.subscriptions.size, 0);
      }
    }
  }
});

test('duplicate dishes import once and a repeated confirmed save is a no-op', async () => {
  const app = setup(rows([publicRecipe(), publicRecipe(), publicRecipe()]));
  const first = await app.copy.save(app.input()); assert.equal(first.savedCount, 3);
  assert.equal(app.calls.filter(call => call.action === 'import').length, 1);
  assert.equal(app.store.getState().recipes.length, 1); assert.equal(app.store.getState().mealPlans.length, 3);
  const before = app.writes.length;
  const repeated = await app.copy.save(app.input({mode: 'replace'}));
  assert.equal(repeated.savedCount, 0); assert.equal(repeated.keptCount, 3);
  assert.equal(app.writes.length, before); assert.equal(app.calls.filter(call => call.action === 'import').length, 1);
});

test('existing public copies are reused but still require a fresh available source day', async () => {
  const app = setup();
  app.store.addPublicRecipe({...recipeInput('原保存'), id: PUBLIC, profileId: PROFILE, authorName: '原作者', imageKey: ''}, A);
  app.store.saveRecipe({...app.store.getRecipe('shared-' + PUBLIC), name: '我调整后的做法'});
  const result = await app.copy.save(app.input());
  assert.equal(result.savedCount, 1); assert.equal(app.store.getState().recipes.length, 1);
  assert.equal(app.store.getRecipe('shared-' + PUBLIC).name, '我调整后的做法');
  assert.equal(app.calls.filter(call => call.action === 'read').length, 2);
  assert.equal(app.calls.filter(call => call.action === 'import').length, 1);
});

test('saving personal or family originals reuses their local IDs across repeated dishes and target dates', async () => {
  for (const family of [false, true]) {
    const app = setup();
    if (family) app.store.bindScope(A, {kind: 'family', id: 'f'.repeat(64), membershipId: '1'.repeat(32)});
    const id = app.addOwn();
    app.store.saveRecipe({...app.store.getRecipe(id), name: '我修改后的做法', note: '私人心得',
      favorite: true, photo: 'wxfile://usr/edited-photo.jpg', ...(family ? {createdBy: B} : {})});
    const shared = {...publicRecipe(publicId(family ? B : A, id)), name: '原来的公开菜名'};
    app.meals = rows([shared, shared, shared]);
    app.remote.meals = app.meals.map(({meal, label, recipe}) => ({meal, label, recipe: copy(recipe)}));
    const before = copy(app.store.getState().recipes);
    const first = await app.copy.save(app.input());
    assert.equal(first.savedCount, 3);
    assert.deepEqual(copy(app.store.getState().recipes), before);
    assert.deepEqual(copy(app.store.getState().mealPlans.map(plan => plan.recipeId)), [id, id, id]);
    const preview = app.copy.preview(app.meals, DATE, 'replace');
    assert.equal(preview.saveCount, 0); assert.equal(preview.conflictCount, 0);
    assert.deepEqual(copy(preview.rows.map(row => row.action)), ['same', 'same', 'same']);
    const writes = app.writes.length;
    assert.equal((await app.copy.save(app.input({mode: 'replace'}))).savedCount, 0);
    assert.equal(app.writes.length, writes);
    assert.equal((await app.copy.save(app.input({targetDate: TOMORROW}))).savedCount, 3);
    assert.deepEqual(copy(app.store.getState().recipes), before);
    assert.ok(app.store.getState().mealPlans.every(plan => plan.recipeId === id));
    assert.equal(app.calls.filter(call => call.action === 'import').length, 2);
  }
});

test('a historical source copy with a different local ID is reused without replacing its edits', async () => {
  const app = setup();
  const id = app.store.saveRecipe({...recipeInput('我调整的副本'), note: '保留这份心得', favorite: true,
    source: {recipeId: PUBLIC, profileId: PROFILE, authorName: '原作者'}});
  const before = copy(app.store.getState().recipes);
  assert.equal((await app.copy.save(app.input())).savedCount, 1);
  assert.equal(app.store.getState().mealPlans[0].recipeId, id);
  assert.deepEqual(copy(app.store.getState().recipes), before);
});

test('same-named recipes with different origins remain separate', async () => {
  const app = setup(), existing = app.addOwn(undefined, DATE, publicRecipe().name);
  await app.copy.save(app.input());
  assert.equal(app.store.getState().recipes.length, 2);
  assert.equal(app.store.getState().mealPlans[0].recipeId, 'shared-' + PUBLIC);
  assert.ok(app.store.getRecipe(existing));
});

test('different recipes import concurrently and the day is committed once after every import and source check', async () => {
  const third = '9'.repeat(64), ids = [PUBLIC, SECOND, third];
  const app = setup(rows(ids.map(id => publicRecipe(id)))), gates = new Map(ids.map(id => [id, deferred()]));
  app.hooks.beforeImport = id => gates.get(id).promise;
  const work = app.copy.save(app.input()); await turn();
  assert.deepEqual(app.calls.filter(call => call.action === 'import').map(call => call.id), ids);
  assert.equal(app.store.getState().mealPlans, undefined);
  gates.get(SECOND).resolve(); gates.get(third).resolve(); await turn();
  assert.equal(app.store.getState().recipes.length, 2); assert.equal(app.store.getState().mealPlans, undefined);
  assert.equal(app.calls.filter(call => call.action === 'read').length, 1);
  gates.get(PUBLIC).resolve();
  assert.equal((await work).savedCount, 3);
  assert.equal(app.calls.filter(call => call.action === 'read').length, 2);
  assert.equal(app.writes.filter(write => write.data.data && write.data.data.mealPlans).length, 1);
});

test('a failed concurrent import waits for the other imports before releasing saving state', async () => {
  const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
  const first = deferred(), second = deferred();
  app.hooks.beforeImport = id => id === PUBLIC ? first.promise : second.promise;
  let settled = false;
  const work = app.copy.save(app.input()).finally(() => { settled = true; });
  const failed = assert.rejects(work, /network failure/);
  await turn(); first.reject(Error('network failure')); await turn();
  assert.equal(settled, false); assert.equal(app.store.getState().mealPlans, undefined);
  second.resolve(); await failed;
  assert.equal(settled, true); assert.equal(app.store.getState().mealPlans, undefined);
  assert.equal(app.store.getState().recipes.length, 1); assert.equal(app.subscriptions.size, 0);
  const writes = app.writes.length; await turn(); assert.equal(app.writes.length, writes);
});

test('concurrent import completion rechecks cancellation, family identity and target changes before network failures', async () => {
  for (const mode of ['cancel', 'family', 'target']) {
    const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
    const first = deferred(), second = deferred(), own = app.addOwn();
    app.hooks.beforeImport = id => id === PUBLIC ? first.promise : second.promise;
    const work = app.copy.save(app.input());
    const failed = assert.rejects(work, error => error.code ===
      ({cancel: 'CANCELLED', family: 'ACCOUNT_CHANGED', target: 'TARGET_CHANGED'})[mode]);
    await turn(); first.reject(Error('old network error')); await turn();
    if (mode === 'cancel') app.cancel();
    if (mode === 'family') app.store.bindScope(A, {kind: 'family', id: 'f'.repeat(64), membershipId: '1'.repeat(32)});
    if (mode === 'target') app.store.saveMealPlans([{date: DATE, meal: 'dinner', recipeId: own}]);
    second.resolve(); await failed;
    assert.equal((app.store.getState().mealPlans || []).length, mode === 'target' ? 1 : 0);
    assert.equal(app.subscriptions.size, 0);
  }
});

test('source changes or withdrawal before importing never write a plan or import a recipe', async () => {
  for (const change of [app => { app.remote.meals[0].recipe = null; }, app => { app.remote.meals[0].recipe = publicRecipe(SECOND); },
    app => { app.remote.meals[0].recipe.name = '更新后的名字'; }, app => { app.remote.meals[0].meal = 'lunch'; },
    app => { app.hooks.read = () => { const error = Error('withdrawn'); error.code = 'NOT_FOUND'; throw error; }; }]) {
    const app = setup(), input = app.input(), before = app.writes.length; change(app);
    await assert.rejects(app.copy.save(input), error => error.code === 'SOURCE_CHANGED');
    assert.equal(app.writes.length, before); assert.equal(app.calls.some(call => call.action === 'import'), false);
    assert.equal(app.subscriptions.size, 0);
  }
});

test('withdrawal during imports aborts the day while already imported recipes may remain', async () => {
  const app = setup(rows([publicRecipe(), builtinRecipe(), undefined]));
  app.hooks.afterImport = () => { app.remote.meals[0].recipe = null; };
  await assert.rejects(app.copy.save(app.input()), error => error.code === 'SOURCE_CHANGED');
  assert.equal(app.store.getState().recipes.length, 2); assert.equal(app.store.getState().mealPlans, undefined);
  assert.equal(app.subscriptions.size, 0);
});

test('explicit withdrawal errors from first or later recipe imports request a source refresh without scheduling', async () => {
  for (const code of ['NOT_PUBLIC', 'RECIPE_NOT_FOUND', 'NOT_FOUND', 'PROFILE_NOT_FOUND']) {
    for (const revokedId of [PUBLIC, SECOND]) {
      const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
      app.hooks.beforeImport = id => {
        if (id === revokedId) { const error = Error('withdrawn during import'); error.code = code; throw error; }
      };
      await assert.rejects(app.copy.save(app.input()), error => error.code === 'SOURCE_CHANGED', code + ':' + revokedId);
      assert.equal(app.store.getState().mealPlans, undefined);
      // Independent imports settle before the failure is reported. The other
      // successful recipe stays available for a retry, but no meals are saved.
      assert.equal(app.store.getState().recipes.length, 1);
      assert.equal(app.subscriptions.size, 0);
    }
  }
});

test('renewed photo signatures and display caches do not masquerade as a source change', async () => {
  const meals = rows([publicRecipe(), undefined, undefined]);
  meals[0].recipe.photoURL = 'https://images.test/photo.jpg?signature=old'; meals[0].recipe.displayPhoto = 'wxfile://usr/old';
  const app = setup(meals);
  app.hooks.read = index => {
    app.remote.meals[0].recipe.photoURL = 'https://images.test/photo.jpg?signature=new-' + index;
    app.remote.meals[0].recipe.displayPhoto = 'wxfile://usr/new-' + index;
  };
  assert.equal((await app.copy.save(app.input())).savedCount, 1);
});

test('changes to any target slot during awaits are rejected without partially saving the remaining slots', async () => {
  for (const phase of ['before', 'read', 'import', 'final-read']) {
    const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
    const own = app.addOwn(), input = app.input();
    const change = () => app.store.saveMealPlans([{date: DATE, meal: 'dinner', recipeId: own}]);
    if (phase === 'before') change();
    if (phase === 'read') app.hooks.read = count => { if (count === 1) change(); };
    if (phase === 'import') app.hooks.afterImport = id => { if (id === PUBLIC) change(); };
    if (phase === 'final-read') app.hooks.read = count => { if (count === 2) change(); };
    await assert.rejects(app.copy.save(input), error => error.code === 'TARGET_CHANGED', phase);
    assert.deepEqual(copy(app.store.getState().mealPlans.map(plan => plan.meal)), ['dinner']);
    assert.equal(app.subscriptions.size, 0);
  }
});

test('unrelated recipe and other-day changes do not cancel the atomic selected-day save', async () => {
  const app = setup(); app.hooks.afterImport = () => { app.addOwn('dinner', TOMORROW); };
  assert.equal((await app.copy.save(app.input())).savedCount, 1);
  assert.equal(app.store.getState().mealPlans.length, 2);
});

test('account, family and ABA changes invalidate in-flight copies after every asynchronous phase', async () => {
  const family = {kind: 'family', id: 'f'.repeat(64), membershipId: '1'.repeat(32)};
  for (const mode of ['account', 'account-aba', 'family', 'family-aba', 'membership']) {
    for (const phase of ['read', 'import', 'final-read']) {
      const app = setup();
      if (mode === 'membership') app.store.bindScope(A, family);
      const input = app.input(), switchScope = () => {
        if (mode.startsWith('account')) { app.store.bindAccount(B); if (mode === 'account-aba') app.store.bindAccount(A); }
        else if (mode === 'membership') app.store.bindScope(A, {...family, membershipId: '2'.repeat(32)});
        else { app.store.bindScope(A, family); if (mode === 'family-aba') app.store.bindScope(A, {kind: 'personal', id: A}); }
      };
      if (phase === 'import') app.hooks.afterImport = switchScope;
      else app.hooks.read = count => { if (count === (phase === 'read' ? 1 : 2)) switchScope(); };
      await assert.rejects(app.copy.save(input), error => error.code === 'ACCOUNT_CHANGED', mode + ':' + phase);
      for (const value of app.storage.values()) assert.equal((value.data && value.data.mealPlans || []).length, 0);
      assert.equal(app.subscriptions.size, 0);
    }
  }
});

test('closing the page prevents scheduling before reads, after imports and after the final read', async () => {
  for (const phase of ['before', 'read', 'import', 'final-read']) {
    const app = setup(), input = app.input();
    if (phase === 'before') app.cancel();
    if (phase === 'read') app.hooks.read = count => { if (count === 1) app.cancel(); };
    if (phase === 'import') app.hooks.afterImport = () => app.cancel();
    if (phase === 'final-read') app.hooks.read = count => { if (count === 2) app.cancel(); };
    await assert.rejects(app.copy.save(input), error => error.code === 'CANCELLED', phase);
    assert.equal(app.store.getState().mealPlans, undefined); assert.equal(app.subscriptions.size, 0);
  }
});

test('recipe-import and final storage failures never leave a partially scheduled day', async () => {
  for (const phase of ['first-import', 'second-import', 'final-read', 'plan-write']) {
    const app = setup(rows([publicRecipe(), publicRecipe(SECOND), undefined]));
    if (phase.includes('import')) app.hooks.beforeImport = id => { if (id === (phase === 'first-import' ? PUBLIC : SECOND)) throw Error('network import failure'); };
    if (phase === 'final-read') app.hooks.read = count => { if (count === 2) throw Error('network final read failure'); };
    if (phase === 'plan-write') app.failPlans();
    await assert.rejects(app.copy.save(app.input()));
    assert.equal(app.store.getState().mealPlans, undefined, phase);
    assert.equal(app.subscriptions.size, 0);
  }
});

test('invalid dates, modes, rows, expected slots and callbacks fail before network or writes', async () => {
  const app = setup(), input = app.input(), before = app.writes.length;
  for (const changes of [{targetDate: shiftDate(DATE, -1)}, {targetDate: '2026-02-30'}, {mode: 'overwrite'},
    {profileId: 'bad'}, {sourceDate: 'bad'}, {isCurrent: undefined}, {expected: undefined},
    {expected: [planId(DATE, 'breakfast')]}, {meals: []}, {meals: [app.meals[0], app.meals[0], app.meals[2]]},
    {meals: rows([{...publicRecipe(), id: 'bad'}, undefined, undefined])},
    {meals: rows([{...builtinRecipe(), id: '__proto__'}, undefined, undefined])},
    {meals: rows([{...publicRecipe(), minutes: 0}, undefined, undefined])},
    {meals: rows([{...publicRecipe(), photoURL: 'http://unsafe.test/image'}, undefined, undefined])}]) {
    await assert.rejects(app.copy.save({...input, ...changes}), error => error.code === 'INVALID_INPUT');
  }
  assert.equal(app.calls.length, 0); assert.equal(app.writes.length, before); assert.equal(app.subscriptions.size, 0);
});

test('explicit builtin imports add one stable original, preserve edits, and survive retirement or a deliberate re-add', () => {
  const app = setup();
  const first = app.store.addBuiltInRecipe('pumpkin-millet', A);
  assert.deepEqual(copy(first), {recipeId: 'pumpkin-millet', added: true});
  assert.equal(app.store.getState().recipes.length, 1); assert.ok(app.store.getRecipe(first.recipeId).updatedAt > 0);
  app.store.saveRecipe({...app.store.getRecipe(first.recipeId), name: '我改过的原版', photo: 'wxfile://usr/mine.jpg'});
  const edited = copy(app.store.getRecipe(first.recipeId)), before = app.writes.length;
  assert.equal(app.store.addBuiltInRecipe(first.recipeId, A).added, false);
  assert.deepEqual(copy(app.store.getRecipe(first.recipeId)), edited); assert.equal(app.writes.length, before);
  const {removeUnusedStarterRecipes} = require('../utils/retired-starter-recipes');
  assert.equal(removeUnusedStarterRecipes(app.store.getState()).recipes.length, 1);
  app.store.deleteRecipe(first.recipeId);
  const tombstone = app.store.getSyncSnapshot().deleted.recipes.find(item => item.id === first.recipeId);
  app.store.addBuiltInRecipe(first.recipeId, A);
  assert.equal(app.store.getState().recipes.length, 1);
  assert.ok(app.store.getRecipe(first.recipeId).updatedAt > tombstone.updatedAt);
  assert.equal(app.store.getRecipe(first.recipeId).name, getBuiltInRecipe(first.recipeId).name);
  const count = app.writes.length;
  assert.throws(() => app.store.addBuiltInRecipe('missing', A));
  assert.throws(() => app.store.addBuiltInRecipe(first.recipeId, B)); assert.equal(app.writes.length, count);
});

test('copying a builtin reuses an edited existing original without replacing its name or photo', async () => {
  const app = setup(rows([builtinRecipe(), undefined, undefined]));
  app.store.addBuiltInRecipe('pumpkin-millet', A);
  app.store.saveRecipe({...app.store.getRecipe('pumpkin-millet'), name: '更适合我们家的版本', photo: 'wxfile://usr/family.jpg'});
  const before = copy(app.store.getRecipe('pumpkin-millet'));
  assert.equal((await app.copy.save(app.input())).savedCount, 1);
  assert.deepEqual(copy(app.store.getRecipe('pumpkin-millet')), before); assert.equal(app.store.getState().recipes.length, 1);
});
