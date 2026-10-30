'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const seed = require('../data/recipes');
const catalog = require('../data/recipe-cover-catalog');
const cloudManifest = require('../cloudfunctions/babyBitesAssets/manifest.json');
const {getImageKey} = require('../cloudfunctions/babyBitesSocial/recipe-covers');
const root = path.resolve(__dirname, '..');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function views(sources = new Map()) {
  const calls = [], loader = {getSource(key) { calls.push(key); return sources.get(key) || ''; },
    isReady() { throw Error('A global readiness gate must not hide ready covers'); }};
  const coverModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/recipe-covers.js'), 'utf8'), {module: coverModule, require(dep) {
    if (dep === './cover-loader') return loader;
    if (dep === '../data/recipe-cover-catalog') return catalog;
    throw Error(dep);
  }});
  const selectorModule = {exports: {}}, requireSelector = createRequire(path.join(root, 'utils/selectors.js'));
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/selectors.js'), 'utf8'), {module: selectorModule, require(dep) {
    if (dep === './recipe-covers') return coverModule.exports;
    if (dep === './cover-loader') return loader;
    return requireSelector(dep);
  }});
  return {...coverModule.exports, selectors: selectorModule.exports, sources, calls};
}
function cachedSources() {
  return new Map(catalog.files.map(file => [file.key, 'wxfile://usr/recipe-cover-cache/' + file.sha256 + '.jpg']));
}

test('every starter cover key has matching client/cloud source metadata without requiring packaged JPEGs', () => {
  const f = views(cachedSources()), keys = seed.map(f.getCoverKey);
  assert.equal(new Set(keys).size, seed.length); assert.equal(catalog.files.length, seed.length);
  assert.equal(catalog.version, cloudManifest.version);
  assert.equal(new Set(cloudManifest.files.map(file => file.key)).size, seed.length);
  for (const recipe of seed) {
    const key = f.getCoverKey(recipe), file = catalog.files.find(item => item.key === key), remote = cloudManifest.files.find(item => item.key === key);
    assert.equal(key, 'dish:' + recipe.id); assert.ok(remote); assert.match(file.filename, /^[a-z-]+\.jpg$/);
    assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.match(file.md5, /^[a-f0-9]{32}$/);
    assert.ok(Number.isInteger(file.bytes) && file.bytes > 1000 && file.bytes < 200 * 1024);
    assert.deepEqual({sha256: remote.sha256, md5: remote.md5, bytes: remote.bytes}, {sha256: file.sha256, md5: file.md5, bytes: file.bytes});
    const publicKey = getImageKey(recipe.id, recipe.imageKey);
    assert.equal(publicKey, key); assert.ok(publicKey.length <= 40);
    assert.equal(f.getCover({id: 'public-id', imageKey: key}), f.sources.get(key));
    assert.equal(f.getCover({id: 'shared-public-id', imageKey: key}), f.getCover(recipe));
  }
});

test('legacy and edited starter dishes use available individual sources without changing stored recipes', () => {
  const f = views(cachedSources());
  for (const recipe of seed) for (const isExample of [true, false]) {
    const stored = {...recipe, isExample, photo: '', favorite: true}, before = clone(stored);
    const state = {recipes: [stored], logs: [{id: 'meal', recipeId: stored.id, date: '2026-10-29', rating: 3}]};
    const expected = f.sources.get(f.getCoverKey(recipe));
    assert.equal(f.selectors.listRecipes(state)[0].displayPhoto, expected);
    assert.equal(f.selectors.enrichRecipe(state, stored).displayPhoto, expected);
    assert.equal(f.selectors.listLogs(state)[0].displayPhoto, expected);
    assert.equal(f.selectors.randomRecipe(state).displayPhoto, expected);
    assert.deepEqual(stored, before); assert.equal(stored.photo, ''); assert.equal(stored.displayPhoto, undefined);
  }
});

test('partial readiness shows only available covers and absent or expired sources retain ingredient fallback data', () => {
  const f = views(new Map([['dish:pumpkin-millet', 'https://storage.example/current-signed-cover']]));
  const state = {recipes: [clone(seed[0]), clone(seed[1])], logs: []}, before = clone(state);
  const shown = f.selectors.listRecipes(state);
  assert.equal(shown[0].displayPhoto, 'https://storage.example/current-signed-cover');
  assert.equal(shown[1].displayPhoto, ''); assert.deepEqual(clone(shown[1].ingredients), seed[1].ingredients);
  assert.equal(shown[1].placeholderIcon, 'noodle');
  assert.equal(f.getCover(seed[1]), ''); assert.equal(f.withCover(seed[1]), seed[1]);
  const old = f.withCover({...seed[0], photo: ''}); f.sources.clear();
  assert.equal(f.getCover(seed[0]), ''); assert.equal(f.withCover(old).displayPhoto, '');
  assert.equal(f.selectors.listRecipes(state)[0].displayPhoto, '');
  f.sources.set('dish:pumpkin-millet', 'wxfile://usr/recipe-cover-cache/refreshed.jpg');
  assert.equal(f.withCover(old).displayPhoto, 'wxfile://usr/recipe-cover-cache/refreshed.jpg');
  assert.deepEqual(state, before);
});

test('user photos and public photo URLs override ready covers, including previously decorated cards', () => {
  const f = views(cachedSources());
  const recipe = {...seed[0], photo: 'wxfile://usr/my-photo.jpg'};
  assert.equal(f.selectors.enrichRecipe({logs: []}, recipe).displayPhoto, recipe.photo);
  const shared = {...seed[0], id: 'public-id', imageKey: 'dish:pumpkin-millet', photoURL: 'https://example.test/real-photo'};
  assert.equal(f.withCover(shared), shared);
  assert.equal(f.selectors.enrichRecipe({logs: []}, shared).displayPhoto, shared.photoURL);
  assert.equal(f.withCover({...shared, displayPhoto: 'https://example.test/expired-cover'}).displayPhoto, shared.photoURL);
  assert.equal(f.withCover({...recipe, displayPhoto: 'wxfile://usr/recipe-cover-cache/old.jpg'}).displayPhoto, recipe.photo);
  assert.deepEqual(f.calls, [], 'user photos should not even query stock sources');
});

test('names, ingredient icons and unknown dish keys never guess a cover or call the cache', () => {
  const f = views(cachedSources());
  for (const id of ['mine', '__proto__', 'constructor', '../pumpkin-millet']) {
    for (const imageKey of ['pumpkin', 'chicken', 'yam', 'dish:__proto__', 'dish:../pumpkin-millet']) {
      const recipe = {id, imageKey, name: seed[0].name, isExample: true};
      assert.equal(f.getCoverKey(recipe), ''); assert.equal(f.getCover(recipe), ''); assert.equal(f.withCover(recipe), recipe);
    }
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.getCoverKey({id: seed[0].id, imageKey: 'dish:' + seed[1].id}), 'dish:' + seed[0].id, 'exact original catalog ID retains precedence');
});

test('available public covers remain presentation-only, and saving an enriched recipe strips display URLs from private persistence', () => {
  const f = views(cachedSources());
  const publicRecipe = {id: 'public-id', imageKey: 'dish:carrot-chicken', photoURL: '', name: '胡萝卜鸡肉粥'};
  const shown = f.withCover(publicRecipe);
  assert.equal(shown.displayPhoto, f.sources.get('dish:carrot-chicken'));
  assert.equal(shown.photoURL, ''); assert.equal(shown.photo, undefined); assert.equal(publicRecipe.displayPhoto, undefined);
  const original = {...seed[0], photo: '', createdAt: 1, updatedAt: 1};
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝', profileUpdatedAt: 1, recipes: [original], logs: []}]]);
  const module = {exports: {}}, storeFile = path.join(root, 'utils/store.js');
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {module, require: createRequire(storeFile), wx: {
    getStorageSync: key => clone(storage.get(key)), setStorageSync(key, value) { storage.set(key, clone(value)); }
  }});
  const store = module.exports, stored = store.getRecipe(original.id);
  const enriched = f.selectors.enrichRecipe({logs: []}, stored);
  store.saveRecipe({...enriched, name: '编辑后的菜名'});
  assert.equal(store.getRecipe(original.id).photo, ''); assert.equal(store.getRecipe(original.id).displayPhoto, undefined);
  assert.doesNotMatch(store.exportBackup(), /recipe-cover-cache|displayPhoto|current-signed-cover/);
});
