'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {publicRecipeId, matchesPublicRecipe} = require('../utils/recipe-identity');
const {getBuiltInRecipe} = require('../utils/recipe-origin');
const A = 'a'.repeat(64), B = 'b'.repeat(64), FAMILY = 'f'.repeat(64);
const personal = {owner: A, scope: {kind: 'personal', id: A}};
const family = {owner: A, scope: {kind: 'family', id: FAMILY, membershipId: 'e'.repeat(32)}};
const expected = (creator, id) => crypto.createHash('sha256').update('public-recipe:' + creator + ':' + id).digest('hex');

test('public recipe IDs match server SHA-256 across padding boundaries and the full local ID length range', () => {
  for (const creator of [A, B, '0123456789abcdef'.repeat(4)]) {
    for (let length = 1; length <= 100; length++) {
      const id = 'r'.repeat(length);
      assert.equal(publicRecipeId(creator, id), expected(creator, id), creator + ':' + length);
    }
  }
});

test('public IDs preserve UTF-8, astral characters, isolated surrogates and exact local ID spacing', () => {
  const ids = ['南瓜粥', '食谱🥣🍓', 'é食谱', 'e\u0301食谱', '\ud800', '\udfff', '\ud800x\udfff',
    '\ud800\ud800\udc00', '\udc00\ud800', '菜'.repeat(100), '🥣'.repeat(50), ' dish ', 'a:b', '\ufffd'];
  for (const id of ids) assert.equal(publicRecipeId(A, id), expected(A, id), JSON.stringify(id));
  assert.notEqual(publicRecipeId(A, ' dish '), publicRecipeId(A, 'dish'));
  assert.notEqual(publicRecipeId(A, 'é食谱'), publicRecipeId(A, 'e\u0301食谱'));
});

test('identity hashing works without Node, Buffer, TextEncoder, Web Crypto or global wx', () => {
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/recipe-identity.js'), 'utf8'), {
    module, require(name) { assert.equal(name, './recipe-origin'); return require('../utils/recipe-origin'); }
  });
  assert.equal(module.exports.publicRecipeId(A, '南瓜🥣\ud800'), expected(A, '南瓜🥣\ud800'));
});

test('invalid creator IDs and invalid or oversized local IDs have no public identity', () => {
  for (const creator of ['', null, undefined, 12, {}, A.toUpperCase(), 'a'.repeat(63), 'g'.repeat(64)]) {
    assert.equal(publicRecipeId(creator, 'dish'), '');
  }
  for (const id of ['', ' ', null, undefined, 12, {}, [], 'r'.repeat(101), '🥣'.repeat(51), 'a\u0000b', 'a\nb', 'a\u007fb']) {
    assert.equal(publicRecipeId(A, id), '');
  }
});

test('personal originals match the current owner and keep identity across all content edits', () => {
  const recipe = {id: 'own-dish', name: '南瓜粥', createdBy: B};
  const id = expected(A, recipe.id);
  assert.equal(matchesPublicRecipe(recipe, id, personal), true);
  assert.equal(matchesPublicRecipe({...recipe, name: '我调整后的菜', photo: 'wxfile://usr/mine.jpg',
    note: '私人心得', favorite: true, ingredients: [], updatedAt: 999}, id, personal), true);
  assert.equal(matchesPublicRecipe(recipe, expected(B, recipe.id), personal), false);
  assert.equal(matchesPublicRecipe(recipe, id, {owner: B, scope: {kind: 'personal', id: B}}), false);
  assert.equal(matchesPublicRecipe(recipe, id, {owner: A}), true);
});

test('family originals match the synchronized creator independently of the viewing member', () => {
  const recipe = {id: 'family-dish', createdBy: B}, id = expected(B, recipe.id);
  assert.equal(matchesPublicRecipe(recipe, id, family), true);
  assert.equal(matchesPublicRecipe(recipe, id, {...family, owner: B}), true);
  assert.equal(matchesPublicRecipe(recipe, expected(A, recipe.id), family), false);
  assert.equal(matchesPublicRecipe({id: recipe.id}, expected(A, recipe.id), family), false);
  assert.equal(matchesPublicRecipe({...recipe, createdBy: ''}, id, family), false);
  assert.equal(matchesPublicRecipe({...recipe, createdBy: 'invalid'}, id, family), false);
});

test('imported recipes match source identity with stable or historical IDs without becoming original publications', () => {
  const publicId = expected(B, 'original');
  for (const id of ['shared-' + publicId, 'restored-copy', '旧备份副本']) {
    const recipe = {id, source: {recipeId: publicId, profileId: 'c'.repeat(32), authorName: '原作者'},
      name: '我调整后的做法', createdBy: A, note: '已编辑'};
    assert.equal(matchesPublicRecipe(recipe, publicId, personal), true);
    assert.equal(matchesPublicRecipe(recipe, publicId, family), true);
    assert.equal(matchesPublicRecipe(recipe, expected(A, id), personal), false);
    assert.equal(matchesPublicRecipe(recipe, expected(A, id), family), false);
    assert.equal(matchesPublicRecipe(recipe, expected(B, 'unrelated'), personal), false);
  }
});

test('source identity takes precedence even when malformed and cannot fall back to a new publication', () => {
  for (const source of [{}, {recipeId: ''}, {recipeId: 'invalid'}, false, [], 'invalid']) {
    assert.equal(matchesPublicRecipe({id: 'dish', source}, expected(A, 'dish'), personal), false);
  }
  assert.equal(matchesPublicRecipe({id: 'dish', source: null}, expected(A, 'dish'), personal), true);
});

test('built-in origins never match a public identity, including edited or imported examples', () => {
  const recipe = getBuiltInRecipe('pumpkin-millet');
  for (const isExample of [true, false, undefined]) {
    assert.equal(matchesPublicRecipe({...recipe, isExample}, expected(A, recipe.id), personal), false);
  }
  const id = expected(B, 'another');
  assert.equal(matchesPublicRecipe({id: 'marked-example', isExample: true}, expected(A, 'marked-example'), personal), false);
  assert.equal(matchesPublicRecipe({id: 'copy', isExample: true, source: {recipeId: id}}, id, personal), false);
  assert.equal(matchesPublicRecipe({id: 'my-dish', imageKey: 'dish:pumpkin-millet'}, expected(A, 'my-dish'), personal), true);
});

test('matching rejects malformed recipes, public IDs and unknown original ownership scopes', () => {
  const recipe = {id: 'dish'}, id = expected(A, recipe.id);
  for (const value of [null, undefined, [], false, {}, {id: ''}, {id: 'r'.repeat(101)}]) {
    assert.equal(matchesPublicRecipe(value, id, personal), false);
  }
  for (const value of [null, undefined, '', id.toUpperCase(), 'a'.repeat(63)]) {
    assert.equal(matchesPublicRecipe(recipe, value, personal), false);
  }
  for (const info of [null, undefined, {}, {owner: 'invalid'}, {owner: A, scope: false},
    {owner: A, scope: {kind: 'unknown'}}, {owner: A, scope: {kind: 'personal', id: B}}]) {
    assert.equal(matchesPublicRecipe(recipe, id, info), false);
  }
});
