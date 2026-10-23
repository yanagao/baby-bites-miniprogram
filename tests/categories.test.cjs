'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {categories, recipeCategories, normalizeCategory} = require('../utils/categories');
const selectors = require('../utils/selectors');
const seed = require('../data/recipes');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function setup(initial) {
  const storage = new Map([['baby-bites-v1', clone(initial)]]);
  let writes = 0;
  const files = new Map();
  global.wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, value) { writes += 1; storage.set(key, clone(value)); },
    getFileSystemManager() {
      return {
        writeFile({filePath, data, encoding, success}) {
          files.set(filePath, Buffer.from(data, encoding)); success({});
        },
        unlink({filePath, success}) { files.delete(filePath); success({}); }
      };
    }
  };
  delete require.cache[require.resolve('../utils/store')];
  delete require.cache[require.resolve('../utils/backup')];
  return {store: require('../utils/store'), backup: require('../utils/backup'), files,
    saved: () => clone(storage.get('baby-bites-v1')), writes: () => writes};
}

function legacyState() {
  const examples = [seed[0], seed[2], seed[5]];
  return {
    version: 1, nickname: '小豆', profileUpdatedAt: 91,
    recipes: examples.map((recipe, index) => Object.assign(clone(recipe), {
      id: 'personal-' + index, category: ['粥与面', '蔬菜泥', '小点心'][index],
      favorite: index === 1, photo: index === 0 ? 'wxfile://usr/own-meal.jpg' : '',
      isExample: false, createdAt: 101 + index, updatedAt: 201 + index
    })),
    logs: [{id: 'own-log', recipeId: 'personal-1', rating: 3, date: '2024-04-02',
      note: '喜欢自己拿着吃', portion: '吃了一些', createdAt: 501, updatedAt: 601}]
  };
}

function normalizedState() {
  const data = legacyState();
  data.recipes.forEach((recipe, index) => {
    recipe.category = ['粥饭主食', '蔬菜手抓', '早餐饼'][index];
  });
  return data;
}

test('the seven recipe categories have the requested names and order, with All only in filters', () => {
  const expected = ['早餐饼', '肉饼肉丸', '面包糕点', '粥饭主食',
    '蔬菜手抓', '蒸蛋豆腐', '汤羹炖菜'];
  assert.deepEqual(recipeCategories, expected);
  assert.deepEqual(categories, ['全部'].concat(expected));
  assert.deepEqual(selectors.categories, categories);
  assert.equal(normalizeCategory('全部', '南瓜粥'), null);
});

test('legacy category inference uses dish type and never reclassifies explicit current choices', () => {
  for (const [category, name, expected] of [
    ['粥与面', '番茄牛肉软面', '粥饭主食'],
    ['蔬菜泥', '山药红枣泥', '蔬菜手抓'],
    ['小点心', '菠菜鸡蛋小饼', '早餐饼'],
    ['小点心', '香蕉蒸糕', '面包糕点'],
    ['小点心', '鸡肉丸', '肉饼肉丸'],
    ['小点心', '牛肉饼', '肉饼肉丸'],
    ['小点心', '南瓜蒸蛋', '蒸蛋豆腐'],
    ['蔬菜泥', '菠菜豆腐', '蒸蛋豆腐'],
    ['粥与面', '番茄肉丸汤', '汤羹炖菜'],
    ['小点心', '蔬菜炖菜', '汤羹炖菜'],
    ['粥与面', '鸡蛋羹', '蒸蛋豆腐'],
    ['粥与面', '菠菜豆腐粥', '粥饭主食']
  ]) assert.equal(normalizeCategory(category, name), expected, name);
  recipeCategories.forEach(category => assert.equal(normalizeCategory(category, '肉丸豆腐汤'), category));
  for (const category of ['其他', 'constructor', '全部', '', null, undefined, {}, 1]) {
    assert.equal(normalizeCategory(category, '鸡肉丸'), null);
  }
});

test('existing object and JSON-string storage is migrated only in memory without losing personal data', () => {
  for (const initial of [legacyState(), JSON.stringify(legacyState())]) {
    const app = setup(initial);
    assert.deepEqual(app.store.init(), normalizedState());
    assert.equal(app.store.getWarning(), '', 'legacy labels must not trigger example-data fallback');
    assert.deepEqual(app.store.getState().logs, legacyState().logs);
    assert.ok(app.store.getState().recipes.every(recipe => !recipe.isExample));
    assert.equal(app.store.getRecipe('personal-0').photo, 'wxfile://usr/own-meal.jpg');
    assert.equal(app.store.getRecipe('personal-1').favorite, true);
    assert.deepEqual(JSON.parse(app.store.exportBackup()), normalizedState());
    assert.equal(app.writes(), 0);
    assert.deepEqual(app.saved(), initial, 'reading or exporting must not rewrite stored bytes');
  }
});

test('legacy JSON backup imports keep IDs, dates, photos, favorites and feedback without duplicates', () => {
  const local = {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []};
  const app = setup(local);
  const result = app.store.importBackup(JSON.stringify(legacyState()));
  assert.deepEqual(result, {addedRecipes: 3, updatedRecipes: 0, addedLogs: 1});
  assert.deepEqual(app.store.getState(), normalizedState());
  assert.deepEqual(app.store.validateData(app.saved()), normalizedState());
  assert.deepEqual(app.store.importBackup(JSON.stringify(legacyState())),
    {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.store.getState(), normalizedState());
  const reloaded = setup(app.saved());
  assert.deepEqual(reloaded.store.getState(), normalizedState());
  assert.equal(reloaded.writes(), 0);
});

test('portable legacy backups still restore photos while keeping all non-photo recipe and log fields', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZS0AAAAASUVORK5CYII=', 'base64');
  const incoming = legacyState();
  incoming.recipes[0].photo = 'data:image/png;base64,' + png.toString('base64');
  const app = setup({version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []});
  await app.backup.importText(JSON.stringify(incoming));
  const actual = app.store.getState();
  const expected = normalizedState();
  assert.match(actual.recipes[0].photo, /^wxfile:\/\/usr\/import-.*\.png$/);
  assert.deepEqual(app.files.get(actual.recipes[0].photo), png);
  expected.recipes[0].photo = actual.recipes[0].photo;
  assert.deepEqual(actual, expected);
});

test('unknown categories remain invalid and failed imports leave existing data untouched', () => {
  const app = setup(normalizedState());
  const before = app.store.getState();
  for (const category of ['其他', '全部', '', null, 'constructor']) {
    const incoming = legacyState();
    incoming.recipes[0].category = category;
    assert.throws(() => app.store.importBackup(JSON.stringify(incoming)), /菜谱信息/);
    assert.deepEqual(app.store.getState(), before);
    assert.deepEqual(app.saved(), before);
  }
  assert.equal(app.writes(), 0);
});

test('the first intentional edit persists migrated categories without altering unrelated metadata', () => {
  const app = setup(legacyState());
  app.store.setNickname('小豆豆');
  const actual = app.saved();
  assert.deepEqual(actual.recipes, normalizedState().recipes);
  assert.deepEqual(actual.logs, legacyState().logs);
  assert.equal(actual.nickname, '小豆豆');
  assert.ok(actual.profileUpdatedAt > legacyState().profileUpdatedAt);
  assert.equal(app.writes(), 1);
});

test('new categories remain user-selected through save, reload, category filtering and random selection', () => {
  const app = setup({version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []});
  recipeCategories.forEach((category, index) => {
    app.store.saveRecipe(Object.assign(clone(seed[0]), {id: undefined, name: '自选分类菜谱' + index, category}));
  });
  const reloaded = setup(app.saved());
  recipeCategories.forEach(category => {
    const filtered = selectors.listRecipes(reloaded.store.getState(), {category});
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].category, category);
    assert.equal(selectors.randomRecipe(reloaded.store.getState(), {category}, () => 0).id, filtered[0].id);
  });
});

test('built-in recipes use new categories without changing their food texture', () => {
  const app = setup();
  const recipes = app.store.getState().recipes;
  assert.equal(recipes.filter(recipe => recipe.category === '粥饭主食').length, 4);
  assert.equal(recipes.filter(recipe => recipe.category === '早餐饼').length, 2);
  const purees = recipes.filter(recipe => ['broccoli-potato', 'yam-red-date'].includes(recipe.id));
  assert.equal(purees.length, 2);
  assert.ok(purees.every(recipe => recipe.category === '蔬菜手抓' && recipe.texture === '细腻泥糊'));
  assert.ok(recipes.every(recipe => recipeCategories.includes(recipe.category)));
  assert.equal(app.writes(), 0);
});

test('the seven former category labels with 类 migrate without writes or changing explicit choices', () => {
  const currentNames = ['早餐饼', '肉饼肉丸', '面包糕点', '粥饭主食', '蔬菜手抓', '蒸蛋豆腐', '汤羹炖菜'];
  const original = legacyState();
  const template = original.recipes[0];
  original.recipes = currentNames.concat(currentNames).map((category, index) => Object.assign(clone(template), {
    id: 'category-choice-' + index,
    // Deliberately conflict with most labels: renaming must preserve the saved choice.
    name: '肉丸豆腐汤', category: category + (index < currentNames.length ? '类' : ''),
    favorite: index % 2 === 0, photo: 'wxfile://usr/meal-' + index + '.jpg',
    createdAt: 101 + index, updatedAt: 201 + index
  }));
  original.logs = original.recipes.map((recipe, index) => ({
    id: 'category-log-' + index, recipeId: recipe.id, rating: index % 3 + 1,
    date: '2024-04-02', note: '保留原来的喜好记录', portion: '吃了一些',
    createdAt: 501 + index, updatedAt: 601 + index
  }));
  const expected = clone(original);
  expected.recipes.forEach((recipe, index) => { recipe.category = currentNames[index % currentNames.length]; });

  for (const initial of [original, JSON.stringify(original)]) {
    const app = setup(initial);
    assert.deepEqual(app.store.init(), expected);
    assert.equal(app.store.getWarning(), '');
    assert.deepEqual(JSON.parse(app.store.exportBackup()), expected);
    assert.equal(app.writes(), 0, 'reading and exporting renamed categories must not write storage');
    assert.deepEqual(app.saved(), initial);
  }

  const app = setup({version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []});
  assert.deepEqual(app.store.importBackup(JSON.stringify(original)),
    {addedRecipes: 14, updatedRecipes: 0, addedLogs: 14});
  assert.deepEqual(app.store.getState(), expected);
  assert.deepEqual(app.store.validateData(app.saved()), expected);
  assert.deepEqual(app.store.importBackup(JSON.stringify(original)),
    {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0});
  assert.deepEqual(app.store.getState(), expected);
  const reloaded = setup(app.saved());
  assert.deepEqual(reloaded.store.getState(), expected);
  assert.equal(reloaded.writes(), 0);
});
