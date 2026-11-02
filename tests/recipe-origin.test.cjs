'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/recipes');
const {isBuiltInRecipe} = require('../utils/recipe-origin');

test('every historical built-in ID remains built-in after an older client cleared its example marker', () => {
  for (const recipe of seed) {
    for (const isExample of [undefined, false, true]) {
      assert.equal(isBuiltInRecipe({...recipe, isExample, name: '用户修改后的名称'}), true, recipe.id);
    }
  }
});

test('example markers protect imported examples but recipe names and artwork do not mark user recipes built-in', () => {
  assert.equal(isBuiltInRecipe({id: 'imported-example', isExample: true}), true);
  assert.equal(isBuiltInRecipe({id: 'my-recipe', name: seed[0].name, imageKey: 'dish:' + seed[0].id}), false);
  assert.equal(isBuiltInRecipe({id: 'shared-user-recipe', isExample: false}), false);
  assert.equal(isBuiltInRecipe(null), false);
});
