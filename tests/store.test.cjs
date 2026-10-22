'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const selectors = require('../utils/selectors');
const storePath = path.resolve(__dirname, '../utils/store.js');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setup(initial, readError) {
  let saved = copy(initial);
  let failWrite = false;
  let writes = 0;
  global.wx = {
    getStorageSync() { if (readError) throw Error('Storage unavailable'); return copy(saved); },
    setStorageSync(key, value) { if (failWrite) throw Error('Quota exceeded'); writes += 1; saved = copy(value); }
  };
  delete require.cache[storePath];
  const store = require(storePath);
  return {store, saved: () => copy(saved), writes: () => writes, failWrites: () => { failWrite = true; },
    allowWrites: () => { failWrite = false; }};
}

function recipe(overrides) {
  return Object.assign({name: '西红柿土豆泥', category: '蔬菜泥', minutes: 20, texture: '细腻泥糊',
    ingredients: [{name: '西红柿', amount: '50 克'}, {name: '土豆', amount: '60 克'}],
    steps: ['把两种食材洗净、切块。', '蒸熟后压泥。'], note: ''}, overrides || {});
}

function withLog(state, id, recipeId, rating, date, createdAt) {
  state.logs.push({id, recipeId, rating, date, createdAt, portion: '', note: ''});
}

test('first read exposes eight examples, no fabricated feedback, and no implicit write', () => {
  const app = setup();
  assert.equal(app.store.init().recipes.length, 8);
  assert.deepEqual(app.store.getState().logs, []);
  assert.equal(app.store.getWarning(), '');
  assert.equal(app.writes(), 0);
  assert.ok(app.store.getState().recipes.every(item => item.isExample && !item.favorite));
  const snapshot = app.store.getState();
  snapshot.recipes[0].name = '修改副本';
  snapshot.recipes[0].ingredients[0].name = '修改副本食材';
  assert.notEqual(app.store.getState().recipes[0].name, '修改副本');
  assert.notEqual(app.store.getState().recipes[0].ingredients[0].name, '修改副本食材');
  const one = app.store.getRecipe(snapshot.recipes[0].id);
  one.steps.push('只修改副本');
  assert.notDeepEqual(app.store.getRecipe(one.id).steps, one.steps);
  assert.equal(app.store.getRecipe('missing'), null);
});

test('create, update, favorite, record, and cascade deletion retain valid state', () => {
  const {store} = setup();
  const id = store.saveRecipe(recipe({photo: 'wxfile://usr/food-1.jpg'}), 3);
  assert.equal(store.getRecipe(id).ingredients[0].name, '番茄');
  assert.equal(store.getRecipe(id).isExample, false);
  assert.equal(store.getState().logs.length, 1);
  assert.equal(selectors.ratingOf(store.getState(), id), 3);
  assert.equal(store.toggleFavorite(id), true);
  const old = store.getRecipe(id);
  store.saveRecipe(Object.assign({}, old, {name: '更细腻的土豆泥'}));
  assert.equal(store.getRecipe(id).favorite, true);
  assert.equal(store.getRecipe(id).photo, 'wxfile://usr/food-1.jpg');
  assert.equal(store.getRecipe(id).createdAt, old.createdAt);
  assert.ok(store.getRecipe(id).updatedAt > old.updatedAt);
  assert.equal(store.getState().logs.length, 1);
  const logId = store.addLog({recipeId: id, rating: 2, date: '2024-02-29', note: '更喜欢细腻一点', portion: '尝了几口'});
  store.deleteLog(logId);
  assert.equal(store.getState().logs.length, 1);
  store.deleteRecipe(id);
  assert.equal(store.getRecipe(id), null);
  assert.equal(store.getState().logs.length, 0);
  assert.throws(() => store.addLog({recipeId: id, rating: 3}), /不存在/);
  assert.throws(() => store.saveRecipe(Object.assign({}, old, {name: '过期编辑'})), /移除/);
});

test('invalid inputs are rejected without changing existing state', () => {
  const app = setup();
  const before = app.store.getState();
  for (const input of [recipe({name: ' '}), recipe({minutes: 0}), recipe({minutes: 481}),
    recipe({minutes: ''}), recipe({ingredients: []}), recipe({steps: [' ']}),
    recipe({category: '无效分类'}), recipe({texture: '无效口感'}), recipe({note: '字'.repeat(2001)})]) {
    assert.throws(() => app.store.saveRecipe(input), /菜谱信息/);
  }
  assert.throws(() => app.store.saveRecipe(recipe(), 4), /喜好程度/);
  assert.throws(() => app.store.setNickname('字'.repeat(21)), /1–20/);
  assert.throws(() => app.store.setNickname(' '), /1–20/);
  assert.deepEqual(app.store.getState(), before);
  assert.equal(app.writes(), 0);
});

test('saving an edited example preserves creation time and becomes a personal recipe', () => {
  const {store} = setup();
  const original = store.getState().recipes[0];
  assert.equal(original.isExample, true);
  const edited = Object.assign({}, original, {name: '我的南瓜小米粥', photo: undefined});
  store.saveRecipe(edited);
  const saved = store.getRecipe(original.id);
  assert.equal(saved.createdAt, original.createdAt);
  assert.ok(saved.updatedAt > original.updatedAt);
  assert.equal(saved.isExample, false);
  assert.equal(saved.photo, '');
});

test('feedback rejects impossible/future dates and invalid ratings', () => {
  const app = setup();
  const recipeId = app.store.getState().recipes[0].id;
  for (const date of ['2024-02-30', '2023-02-29', '2024-13-01', '9999-12-31']) {
    assert.throws(() => app.store.addLog({recipeId, rating: 3, date}), /喜好记录/);
  }
  assert.throws(() => app.store.addLog({recipeId, rating: 0}), /喜好记录/);
  assert.throws(() => app.store.addLog({recipeId, rating: 3, note: '字'.repeat(501)}), /喜好记录/);
  assert.equal(app.store.getState().logs.length, 0);
  app.store.addLog({recipeId, rating: 2, date: '2024-02-29'});
  assert.equal(app.store.getState().logs.length, 1);
});

test('only persistent local image paths are stored', () => {
  const {store} = setup();
  for (const photo of ['', 'wxfile://usr/a.jpg', 'wxfile://store_123.png', 'http://usr/test.webp']) {
    const id = store.saveRecipe(recipe({photo}));
    assert.equal(store.getRecipe(id).photo, photo);
  }
  for (const photo of ['wxfile://tmp_123.jpg', 'https://example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    assert.throws(() => store.saveRecipe(recipe({photo})), /本机/);
  }
});

test('failed storage writes roll back memory for creation, edits, deletes, and profile changes', () => {
  const app = setup();
  const id = app.store.saveRecipe(recipe(), 2);
  const before = app.store.getState();
  const savedBefore = app.saved();
  app.failWrites();
  for (const operation of [
    () => app.store.saveRecipe(recipe()),
    () => app.store.toggleFavorite(id),
    () => app.store.deleteRecipe(id),
    () => app.store.deleteLog(before.logs[0].id),
    () => app.store.addLog({recipeId: id, rating: 1}),
    () => app.store.setNickname('小豆')
  ]) {
    assert.throws(operation, /保存失败/);
    assert.deepEqual(app.store.getState(), before);
    assert.deepEqual(app.saved(), savedBefore);
  }
  app.allowWrites();
  assert.equal(app.store.toggleFavorite(id), true);
  assert.equal(app.saved().recipes.find(item => item.id === id).favorite, true);
});

test('corrupt stored content is not overwritten by initialization or ordinary mutations', () => {
  const original = '{this is not json';
  const app = setup(original);
  assert.equal(app.store.getState().recipes.length, 8);
  assert.match(app.store.getWarning(), /原数据未被覆盖/);
  assert.equal(app.saved(), original);
  assert.throws(() => app.store.saveRecipe(recipe()), /导入有效备份/);
  assert.throws(() => app.store.exportBackup(), /不能将示例菜谱/);
  assert.equal(app.saved(), original);
  assert.equal(app.writes(), 0);
  const recovery = app.store.getState();
  recovery.nickname = '恢复的小豆';
  recovery.profileUpdatedAt = 10;
  app.store.importBackup(JSON.stringify(recovery));
  assert.equal(app.store.getWarning(), '');
  assert.equal(app.store.getState().nickname, '恢复的小豆');
  assert.doesNotThrow(() => app.store.saveRecipe(recipe()));
});

test('storage read errors do not trigger a destructive default-data write', () => {
  const app = setup(undefined, true);
  app.store.init();
  assert.match(app.store.getWarning(), /未能读取/);
  assert.throws(() => app.store.setNickname('小豆'), /未能读取/);
  assert.equal(app.writes(), 0);
});

test('backup merge restores newer same-ID edits and nickname, skips duplicates and stale edits', () => {
  const app = setup();
  const backup = app.store.getState();
  const id = backup.recipes[0].id;
  backup.recipes[0].name = '调整过的南瓜粥';
  backup.recipes[0].updatedAt = 200;
  backup.nickname = '小豆';
  backup.profileUpdatedAt = 200;
  withLog(backup, 'import-log', id, 3, '2024-04-01', 100);
  const summary = app.store.importBackup(JSON.stringify(backup));
  assert.equal(summary.updatedRecipes, 1);
  assert.equal(summary.addedLogs, 1);
  assert.equal(app.store.getRecipe(id).name, '调整过的南瓜粥');
  assert.equal(app.store.getState().nickname, '小豆');
  assert.deepEqual(app.store.importBackup(JSON.stringify(backup)), {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  backup.recipes[0].name = '旧版本';
  backup.recipes[0].updatedAt = 100;
  backup.nickname = '旧称呼';
  backup.profileUpdatedAt = 100;
  app.store.importBackup(JSON.stringify(backup));
  assert.equal(app.store.getRecipe(id).name, '调整过的南瓜粥');
  assert.equal(app.store.getState().nickname, '小豆');
  const exported = app.store.exportBackup();
  assert.deepEqual(JSON.parse(exported), app.store.getState());
  const reloaded = setup(JSON.parse(exported));
  assert.deepEqual(reloaded.store.getState(), JSON.parse(exported));
});

test('an intentional newer default nickname is not overwritten by an older backup', () => {
  const app = setup();
  const backup = app.store.getState();
  backup.nickname = '旧称呼';
  backup.profileUpdatedAt = 1;
  app.store.setNickname('宝宝');
  app.store.importBackup(JSON.stringify(backup));
  assert.equal(app.store.getState().nickname, '宝宝');
});

test('invalid and oversized backup merges are atomic and leave re-loadable data', () => {
  const baseline = setup().store.getState();
  const many = prefix => Object.assign(copy(baseline), {
    recipes: Array.from({length: 600}, (_, index) => Object.assign(copy(baseline.recipes[0]), {id: `${prefix}-${index}`}))
  });
  const initial = many('local');
  const app = setup(initial);
  const before = app.store.getState();
  assert.throws(() => app.store.importBackup(JSON.stringify(many('new'))), /1000/);
  assert.deepEqual(app.store.getState(), before);
  assert.deepEqual(app.saved(), initial);
  assert.throws(() => app.store.importBackup('{bad'), /JSON/);
  const orphan = copy(baseline);
  withLog(orphan, 'bad-log', 'missing-recipe', 3, '2024-04-01', 1);
  assert.throws(() => app.store.importBackup(JSON.stringify(orphan)), /喜好记录/);
  const duplicate = copy(baseline);
  duplicate.recipes.push(copy(duplicate.recipes[0]));
  assert.throws(() => app.store.importBackup(JSON.stringify(duplicate)), /菜谱信息/);
  assert.deepEqual(app.store.getState(), before);
  const restored = setup(app.saved());
  assert.equal(restored.store.getState().recipes.length, 600);
});

test('backup write failure preserves current recipes and feedback', () => {
  const app = setup();
  app.store.setNickname('保留的称呼');
  const before = app.store.getState();
  const incoming = copy(before);
  incoming.recipes[0].name = '不能写入的修改';
  incoming.recipes[0].updatedAt = Date.now() + 1;
  app.failWrites();
  assert.throws(() => app.store.importBackup(JSON.stringify(incoming)), /保存失败/);
  assert.deepEqual(app.store.getState(), before);
  assert.deepEqual(app.saved(), before);
});

test('latest preference uses meal date, then creation time on the same day', () => {
  const state = setup().store.getState();
  const id = state.recipes[0].id;
  withLog(state, 'older-entered-later', id, 3, '2024-04-01', 500);
  withLog(state, 'newer', id, 1, '2024-04-02', 100);
  assert.equal(selectors.ratingOf(state, id), 1);
  withLog(state, 'same-day-later', id, 2, '2024-04-02', 200);
  assert.equal(selectors.ratingOf(state, id), 2);
  const enriched = selectors.enrichRecipe(state, state.recipes[0]);
  assert.equal(enriched.ratingName, '还不错');
  assert.equal(enriched.photoSrc, '');
  assert.equal(enriched.placeholderIcon, 'pumpkin');
  assert.equal(enriched.ingredientText, '南瓜 · 小米');
  assert.equal(selectors.listLogs(state)[0].id, 'same-day-later');
  assert.equal(selectors.listLogs(state)[0].recipeName, state.recipes[0].name);
  assert.equal(selectors.listLogs(state, '3').length, 1);
  assert.deepEqual(selectors.stats(state), {recipeCount: 8, likedCount: 0, logCount: 3, triedCount: 1});
});

test('recipe search, sort, favorites, and texture filters compose without mutating input', () => {
  const state = setup().store.getState();
  const before = copy(state);
  assert.equal(selectors.listRecipes(state, {search: '西红柿'})[0].id, 'tomato-beef-noodle');
  assert.equal(selectors.listRecipes(state, {search: '  南瓜  '}).length, 1);
  assert.equal(selectors.listRecipes(state, {search: '不存在的食材'}).length, 0);
  const quick = selectors.listRecipes(state, {sort: 'quick'});
  assert.ok(quick.every((item, index) => index === 0 || item.minutes >= quick[index - 1].minutes));
  assert.deepEqual(state, before);
  state.recipes[2].favorite = true;
  assert.deepEqual(selectors.listRecipes(state, {onlyFavorites: true}).map(item => item.id), ['broccoli-potato']);
  assert.equal(selectors.listRecipes(state, {onlyFavorites: true, category: '小点心'}).length, 0);
  assert.ok(selectors.listRecipes(state, {texture: '手指食物'}).every(item => item.category === '小点心'));
  withLog(state, 'favorite-rating', state.recipes[2].id, 3, '2024-04-01', 1);
  assert.equal(selectors.listRecipes(state, {sort: 'liked'})[0].id, 'broccoli-potato');
});

test('pantry matching reports missing ingredients and normalizes aliases', () => {
  const state = setup().store.getState();
  const matches = selectors.matchRecipes(state, ['南瓜', '小米', '马铃薯']);
  assert.equal(matches[0].id, 'pumpkin-millet');
  assert.equal(matches[0].complete, true);
  assert.equal(matches[0].missingText, '');
  assert.equal(matches[0].foundCount, 2);
  const partial = matches.find(item => item.id === 'broccoli-potato');
  assert.equal(partial.foundCount, 1);
  assert.equal(partial.totalCount, 2);
  assert.equal(partial.missingText, '西兰花');
  assert.equal(partial.complete, false);
  assert.equal(selectors.matchRecipes(state, ['南瓜', '小米'], true).length, 1);
  assert.equal(selectors.matchRecipes(state, ['冬瓜']).length, 0);
  assert.deepEqual(selectors.matchRecipes(state, []), []);
  assert.equal(selectors.normalizeIngredient('constructor'), 'constructor');
});

test('random selection respects category/latest dislikes, avoids repetition, and handles empty pools', () => {
  const state = setup().store.getState();
  const first = selectors.randomRecipe(state, {category: '蔬菜泥'}, () => 0);
  const next = selectors.randomRecipe(state, {category: '蔬菜泥', lastId: first.id}, () => 0);
  assert.notEqual(first.id, next.id);
  assert.equal(next.category, '蔬菜泥');
  state.recipes.filter(item => item.category === '蔬菜泥').forEach((item, index) => {
    withLog(state, `disliked-${index}`, item.id, 1, '2024-04-01', index);
  });
  assert.equal(selectors.randomRecipe(state, {category: '蔬菜泥'}, () => 0), null);
  assert.ok(selectors.randomRecipe(state, {category: '蔬菜泥', skipDisliked: false}, () => 0));
  withLog(state, 'now-liked', first.id, 3, '2024-04-02', 5);
  assert.equal(selectors.randomRecipe(state, {category: '蔬菜泥', lastId: first.id}, () => 0).id, first.id);
  assert.equal(selectors.randomRecipe({recipes: [], logs: []}, {}, () => 0), null);
});
