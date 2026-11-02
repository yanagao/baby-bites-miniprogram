'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeAllergies, findRecipeAllergens} = require('../utils/allergies');
const selectors = require('../utils/selectors');
const seed = require('../data/recipes');
const recipe = (id, names, fields = {}) => ({id, name: id, category: '粥饭主食', minutes: 20,
  texture: '细腻泥糊', ingredients: names.map(name => ({name, amount: '适量'})), steps: ['蒸熟'],
  createdAt: 1, updatedAt: 1, ...fields});

test('allergy settings preserve absent legacy values and explicit clearing, trim and deduplicate without mutation', () => {
  assert.equal(normalizeAllergies(undefined), undefined);
  assert.deepEqual(normalizeAllergies([]), []);
  const input = [' 鸡蛋 ', '牛奶', '鸡蛋'];
  assert.deepEqual(normalizeAllergies(input), ['鸡蛋', '牛奶']);
  assert.deepEqual(input, [' 鸡蛋 ', '牛奶', '鸡蛋']);
  assert.deepEqual(normalizeAllergies(['a'.repeat(40)]), ['a'.repeat(40)]);
  assert.equal(normalizeAllergies(Array.from({length: 50}, (_, n) => '食物' + n)).length, 50);
  for (const invalid of [null, '', {}, 1, [null], [''], ['  '], ['a'.repeat(41)], ['蛋\n'], ['蛋\u007f'],
    ['蛋\u0085'], new Array(1), Array(51).fill('鸡蛋')]) assert.throws(() => normalizeAllergies(invalid), /过敏食物/);
});

test('common recorded foods match named ingredients and familiar ingredient forms', () => {
  const cases = [
    ['鸡蛋', ['鸡蛋', '蛋', '蛋白', '蛋白液', '熟蛋黄', '蛋清', '全蛋液', '鸡蛋液（打散）']],
    ['牛奶', ['牛奶', '奶', '配方奶', '酸奶', '奶酪', '芝士', '无盐黄油', '乳清蛋白']],
    ['大豆', ['黄豆', '熟黄豆', '嫩豆腐', '豆浆', '豆皮', '腐竹', '酱油']],
    ['小麦', ['小麦粉', '低筋面粉', '普通面条', '挂面', '面包', '馒头', '酱油']],
    ['花生', ['花生米', '花生酱', '碎花生']],
    ['坚果', ['核桃仁', '腰果', '杏仁粉', '榛子', '松子', '巴旦木']],
    ['鱼', ['三文鱼', '鳕鱼', '鱼肉']],
    ['虾', ['虾仁', '虾皮', '鲜虾']],
    ['芝麻', ['黑芝麻', '芝麻酱', '麻酱', '香油']]
  ];
  for (const [allergen, ingredients] of cases) for (const ingredient of ingredients) {
    assert.deepEqual(findRecipeAllergens(recipe('test', [ingredient]), [allergen]), [allergen], ingredient);
  }
});

test('custom foods and ingredient aliases match qualified names but not private notes or recipe titles', () => {
  assert.deepEqual(findRecipeAllergens(recipe('番茄鸡蛋', ['去皮西红柿', '蒸马铃薯', '猕猴桃泥']),
    ['番茄', '土豆', '猕猴桃']), ['番茄', '土豆', '猕猴桃']);
  assert.deepEqual(findRecipeAllergens(recipe('鱼虾鸡蛋', ['南瓜'], {note: '牛奶', steps: ['鸡蛋']}),
    ['鸡蛋', '鱼', '虾', '牛奶']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['egg white', 'eggplant', 'kiwi puree']), ['egg', 'kiwi']), ['egg', 'kiwi']);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['eggplant']), ['egg']), []);
});

test('recorded groups do not equate unrelated foods or specific fish with all fish', () => {
  assert.deepEqual(findRecipeAllergens(recipe('test', ['大豆蛋白', '乳清蛋白', '蛋白质粉']), ['鸡蛋']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['豆奶', '椰奶', '燕麦奶']), ['牛奶']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['红豆', '绿豆', '豌豆']), ['大豆']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['大米', '米粉', '玉米面粉', '荞麦面粉']), ['小麦']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['玉米面粉（含小麦）']), ['小麦']), ['小麦']);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['鳕鱼']), ['三文鱼']), []);
  assert.deepEqual(findRecipeAllergens(recipe('test', ['花生']), ['坚果']), []);
});

test('matching returns only recorded labels and does not mutate recipes or settings', () => {
  const dish = recipe('test', ['鸡蛋', '蛋黄', '豆腐']);
  const allergies = ['鸡蛋', '大豆', '花生'];
  const before = JSON.stringify({dish, allergies});
  assert.deepEqual(findRecipeAllergens(dish, allergies), ['鸡蛋', '大豆']);
  assert.equal(JSON.stringify({dish, allergies}), before);
  for (const empty of [undefined, []]) assert.deepEqual(findRecipeAllergens(dish, empty), []);
});

test('random and ingredient recommendations always exclude matching recipes even when dislikes are allowed', () => {
  const state = {allergies: ['鸡蛋'], recipes: [recipe('egg', ['南瓜', '蛋黄']), recipe('pumpkin', ['南瓜'])], logs: []};
  assert.deepEqual(selectors.randomCandidates(state, {skipDisliked: false}).map(item => item.id), ['pumpkin']);
  assert.equal(selectors.randomRecipe(state, {skipDisliked: false}, () => 0).id, 'pumpkin');
  assert.deepEqual(selectors.matchRecipes(state, ['南瓜'], false).map(item => item.id), ['pumpkin']);
  assert.deepEqual(selectors.matchRecipes(state, ['南瓜', '蛋黄'], true).map(item => item.id), ['pumpkin']);
  state.allergies.push('南瓜');
  assert.deepEqual(selectors.randomCandidates(state, {}), []);
  assert.equal(selectors.randomRecipe(state, {}, () => 0), null);
  assert.deepEqual(selectors.matchRecipes(state, ['南瓜'], false), []);
  state.allergies = [];
  assert.equal(selectors.randomCandidates(state, {}).length, 2);
});

test('allergy exclusions compose with age and category filters without removing management or history entries', () => {
  const state = {allergies: ['鸡蛋'], recipes: [
    recipe('egg', ['鸡蛋'], {favorite: true}),
    recipe('young', ['南瓜'], {ageGroups: ['6-8'], category: '蔬菜手抓'}),
    recipe('older', ['土豆'], {ageGroups: ['18+'], category: '蔬菜手抓'})
  ], logs: [{id: 'history', recipeId: 'egg', rating: 3, date: '2026-11-01', createdAt: 2}]};
  assert.deepEqual(selectors.randomCandidates(state, {categories: ['蔬菜手抓'], ageGroups: ['6-8']}).map(item => item.id), ['young']);
  assert.equal(selectors.listRecipes(state).length, 3);
  assert.equal(selectors.listRecipes(state, {onlyFavorites: true})[0].id, 'egg');
  assert.equal(selectors.listRecipes(state, {excludeAllergies: true}).length, 2);
  assert.equal(selectors.listLogs(state)[0].recipeId, 'egg');
  assert.deepEqual(selectors.enrichRecipe(state, state.recipes[0]).allergyMatches, ['鸡蛋']);
  assert.match(selectors.enrichRecipe(state, state.recipes[0]).allergyWarning, /鸡蛋/);
  assert.equal(selectors.enrichRecipe(state, state.recipes[1]).allergyWarning, '');
});

test('starter recipes use existing ingredient names for eggs, wheat, soy and fish without rewriting the catalog', () => {
  const before = JSON.stringify(seed);
  const state = {allergies: ['鸡蛋', '小麦', '大豆', '鱼'], recipes: seed, logs: []};
  const candidates = selectors.randomCandidates(state, {skipDisliked: false});
  assert.ok(candidates.length > 0 && candidates.length < seed.length);
  assert.ok(candidates.some(item => item.id === 'pumpkin-millet'));
  assert.ok(!candidates.some(item => ['tomato-beef-noodle', 'salmon-rice', 'banana-oat-pancake'].includes(item.id)));
  assert.ok(candidates.every(item => !findRecipeAllergens(item, state.allergies).length));
  assert.equal(JSON.stringify(seed), before);
});
