'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../data/recipes');
const {removeUnusedStarterRecipes} = require('../utils/retired-starter-recipes');
const copy = value => JSON.parse(JSON.stringify(value));

function starter(index = 0, overrides = {}) {
  const recipe = copy(catalog[index]);
  return {...recipe, note: recipe.note || '', imageKey: recipe.imageKey || '',
    isExample: true, favorite: false, photo: '', createdAt: 1700000000000 + index,
    updatedAt: 0, ...overrides};
}

function snapshot(recipes, overrides = {}) {
  return {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes, logs: [], ...overrides};
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('removes all 21 untouched defaults without mutating data or adding deletion metadata', () => {
  const data = freeze(snapshot(catalog.map((_, index) => starter(index)), {
    babyBirthDate: null, babyBirthDateUpdatedAt: 12, allergies: ['鸡蛋'], allergiesUpdatedAt: 34,
    mealPlans: []
  }));
  const before = copy(data);
  const result = removeUnusedStarterRecipes(data);
  assert.notEqual(result, data);
  assert.deepEqual(result, {...before, recipes: []});
  assert.deepEqual(data, before);
  assert.equal(result.logs, data.logs);
  assert.equal(result.mealPlans, data.mealPlans);
  assert.equal(result.allergies, data.allergies);
  assert.equal(Object.hasOwn(result, 'deleted'), false);
});

test('keeps same-name personal recipes, saved public copies and noncatalog imported examples', () => {
  const recipes = [
    starter(0, {id: 'recipe-own', isExample: false}),
    starter(0, {id: 'shared-' + 'a'.repeat(64), isExample: false,
      source: {profileId: 'b'.repeat(32), recipeId: 'a'.repeat(64), authorName: '小厨房'}}),
    starter(0, {id: 'imported-example'})
  ];
  const data = freeze(snapshot(recipes));
  assert.equal(removeUnusedStarterRecipes(data), data);
});

for (const [label, overrides] of [
  ['an edit timestamp', {updatedAt: 1}],
  ['a favorite', {favorite: true}],
  ['a local photo', {photo: 'wxfile://usr/my-food.jpg'}],
  ['a cloud photo', {photo: 'cloud://example.bucket/users/owner/photos/my-food.jpg'}],
  ['a source', {source: {profileId: 'a'.repeat(32), recipeId: 'b'.repeat(64), authorName: '原作者'}}],
  ['selected ages', {ageGroups: ['9-11']}],
  ['explicitly cleared ages', {ageGroups: []}],
  ['a cleared example marker', {isExample: false}],
  ['a legacy missing example marker', {isExample: undefined}]
]) {
  test('preserves a catalog recipe with ' + label, () => {
    const recipe = starter(0, overrides);
    const data = freeze(snapshot([starter(1), recipe]));
    const result = removeUnusedStarterRecipes(data);
    assert.deepEqual(result.recipes, [recipe]);
    assert.equal(result.recipes[0], recipe);
  });
}

for (const [label, change] of [
  ['name', recipe => { recipe.name = '我改过的菜名'; }],
  ['category', recipe => { recipe.category = '汤羹炖菜'; }],
  ['time', recipe => { recipe.minutes += 1; }],
  ['texture', recipe => { recipe.texture = '细腻泥糊'; }],
  ['note', recipe => { recipe.note = ''; }],
  ['artwork', recipe => { recipe.imageKey = 'dish:' + recipe.id; }],
  ['ingredient name', recipe => { recipe.ingredients[0].name = '土豆'; }],
  ['ingredient amount', recipe => { recipe.ingredients[0].amount = '60 克'; }],
  ['ingredient count', recipe => { recipe.ingredients.push({name: '水', amount: '100 毫升'}); }],
  ['ingredient order', recipe => { recipe.ingredients.reverse(); }],
  ['step text', recipe => { recipe.steps[0] += '这是自己的做法。'; }],
  ['step count', recipe => { recipe.steps.pop(); }],
  ['step order', recipe => { recipe.steps.reverse(); }]
]) {
  test('preserves changed ' + label + ' even when an old import has no edit timestamp', () => {
    const recipe = starter();
    change(recipe);
    const data = freeze(snapshot([recipe]));
    assert.equal(removeUnusedStarterRecipes(data), data);
  });
}

test('preserves recipes referenced by meal history or a plan and leaves those records intact', () => {
  const logged = starter(0), planned = starter(1), unused = starter(2);
  const logs = [{id: 'log-1', recipeId: logged.id, rating: 3, date: '2024-04-01',
    portion: '', note: '', createdAt: 1711929600000, updatedAt: 0}];
  const mealPlans = [{id: '2024-04-02-lunch', recipeId: planned.id,
    date: '2024-04-02', meal: 'lunch', createdAt: 1711929600000, updatedAt: 0}];
  const data = freeze(snapshot([logged, planned, unused], {logs, mealPlans}));
  const result = removeUnusedStarterRecipes(data);
  assert.deepEqual(result.recipes, [logged, planned]);
  assert.equal(result.logs, logs);
  assert.equal(result.mealPlans, mealPlans);
});

test('a remote copy with user history survives after the unused local copy was retired', () => {
  const local = removeUnusedStarterRecipes(snapshot([starter()]));
  const remote = snapshot([starter()], {logs: [{id: 'meal-history', recipeId: catalog[0].id}]});
  const normalizedRemote = removeUnusedStarterRecipes(remote);
  assert.deepEqual(local.recipes, []);
  assert.equal(normalizedRemote, remote);
  assert.equal(normalizedRemote.recipes[0].id, catalog[0].id);
});

test('returns unchanged objects when no defaults remain and is idempotent', () => {
  const custom = starter(0, {id: 'my-recipe', isExample: false});
  const data = freeze(snapshot([starter(1), custom, starter(2)]));
  const result = removeUnusedStarterRecipes(data);
  assert.deepEqual(result.recipes, [custom]);
  assert.equal(removeUnusedStarterRecipes(result), result);
  const empty = freeze(snapshot([]));
  assert.equal(removeUnusedStarterRecipes(empty), empty);
});

test('automatic family creator attribution does not count as a user edit', () => {
  const data = snapshot(catalog.map((_, index) => starter(index, {createdBy: 'a'.repeat(64)})));
  assert.deepEqual(removeUnusedStarterRecipes(data).recipes, []);
});
