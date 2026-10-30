'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const selectors = require('../utils/selectors');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ageGroups = [
  {value: '6-8', label: '6–8个月'}, {value: '9-11', label: '9–11个月'},
  {value: '12-17', label: '12–17个月'}, {value: '18+', label: '18个月以上'}
];
const recipeAges = require('../utils/recipe-ages');
const RECIPE = {id: 'personal-recipe', name: '南瓜粥', minutes: 20, category: '粥饭主食', texture: '软烂颗粒',
  ingredients: [{name: '南瓜', amount: '30克'}, {name: '小米', amount: '20克'}], steps: ['煮至软烂'], note: '', photo: ''};
const tap = value => ({currentTarget: {dataset: {value}}});
const input = (field, value) => ({currentTarget: {dataset: {field}}, detail: {value}});

function setup(options = {}) {
  let definition, owner = 'owner-a', failSave = false, saveFile, alert = false;
  const saved = [], listeners = new Set(), source = options.recipe && clone(options.recipe);
  const calls = {saved, alerts: [], errors: [], toasts: [], backs: 0, updates: 0, unlinks: []};
  const store = options.store || {
    getSyncInfo: () => ({owner}), getRecipe: () => clone(source),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    saveRecipe(recipe) { if (failSave) throw Error('保存失败'); saved.push(clone(recipe)); }
  };
  const wx = {
    setNavigationBarTitle() {}, showToast(value) { calls.toasts.push(value.title); },
    enableAlertBeforeUnload(value) { alert = true; calls.alerts.push(value.message); },
    disableAlertBeforeUnload(value) { alert = false; if (value.complete) value.complete(); },
    getFileSystemManager() { return {
      saveFile(value) { saveFile = value; }, unlink(value) { calls.unlinks.push(value.filePath); }
    }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/editor/index.js'), 'utf8'), {
    wx, Page(value) { definition = value; }, require(dep) {
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/selectors')) return selectors;
      if (dep.endsWith('/recipe-ages')) return recipeAges;
      if (dep.endsWith('/ui')) return {back() { calls.backs++; }, error(value) { calls.errors.push(value.message); }};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++;
    for (const [key, value] of Object.entries(update)) {
      const parts = key.split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = clone(value);
    }
  }};
  page.onLoad(options.recipe || options.missing ? {id: options.recipe && options.recipe.id || 'missing'} : {});
  return {page, calls, source, listeners, alert: () => alert,
    fill() { page.input(input('name', '我的南瓜粥')); page.input(input('ingredients', '南瓜 30克\n小米 20克')); page.input(input('steps', '煮至软烂')); },
    changeOwner(value) { owner = value; listeners.forEach(fn => fn({owner})); },
    failSave(value = true) { failSave = value; },
    finishPhoto(fail = false) { if (fail) saveFile.fail(Error('照片未保存')); else saveFile.success({savedFilePath: 'wxfile://usr/saved.jpg'}); }
  };
}

test('editor offers exactly the four age groups and saves multiple selections in stable order only on save', async () => {
  const f = setup(); f.fill();
  assert.deepEqual(f.page.data.ageGroupOptions.map(({value, label}) => ({value, label})), ageGroups);
  assert.deepEqual(f.page.data.ageGroups, []); assert.equal(f.page.data.ageGroupsDirty, false);
  f.page.toggleAgeGroup(tap('18+')); f.page.toggleAgeGroup(tap('6-8'));
  assert.deepEqual(f.page.data.ageGroups, ['6-8', '18+']); assert.equal(f.page.data.ageGroupsDirty, true);
  assert.equal(f.page.data.ageGroupOptions.filter(group => group.selected).length, 2); assert.equal(f.calls.saved.length, 0);
  await f.page.save();
  assert.deepEqual(f.calls.saved[0].ageGroups, ['6-8', '18+']); assert.equal(f.calls.backs, 1); assert.equal(f.alert(), false);
});

test('untouched new and legacy recipes omit the age field rather than writing an empty array', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'legacy' : 'new', async () => {
    const f = setup(existing ? {recipe: RECIPE} : {}); if (!existing) f.fill();
    assert.deepEqual(f.page.data.ageGroups, []); await f.page.save();
    assert.equal(Object.hasOwn(f.calls.saved[0], 'ageGroups'), false);
  });
});

test('existing annotations load as selected chips but remain omitted from an unrelated edit payload', async () => {
  const f = setup({recipe: {...RECIPE, ageGroups: ['9-11', '18+']}});
  assert.deepEqual(f.page.data.ageGroups, ['9-11', '18+']); assert.equal(f.page.data.ageGroupsDirty, false);
  assert.equal(f.alert(), false); f.page.input(input('name', '改名后的菜谱')); await f.page.save();
  assert.equal(Object.hasOwn(f.calls.saved[0], 'ageGroups'), false);
});

test('existing default recipes without annotations stay unmarked regardless of texture or category', async () => {
  const f = setup({recipe: {...RECIPE, id: 'pumpkin-millet', isExample: true}});
  assert.deepEqual(f.page.data.ageGroups, []); assert.equal(f.page.data.ageGroupsDirty, false);
  assert.equal(f.alert(), false); f.page.input(input('note', '仅改备注')); await f.page.save();
  assert.equal(Object.hasOwn(f.calls.saved[0], 'ageGroups'), false);
});

test('deselecting all stored groups explicitly saves an empty array and an existing empty array remains unmarked', async () => {
  const f = setup({recipe: {...RECIPE, ageGroups: ['9-11', '12-17']}});
  f.page.toggleAgeGroup(tap('9-11')); f.page.toggleAgeGroup(tap('12-17'));
  assert.deepEqual(f.page.data.ageGroups, []); assert.equal(f.page.data.ageGroupsDirty, true);
  await f.page.save(); assert.deepEqual(f.calls.saved[0].ageGroups, []);
  const cleared = setup({recipe: {...RECIPE, ageGroups: []}});
  assert.deepEqual(cleared.page.data.ageGroups, []); assert.equal(cleared.page.data.ageGroupsDirty, false);
  await cleared.page.save(); assert.equal(Object.hasOwn(cleared.calls.saved[0], 'ageGroups'), false);
});

test('restoring the original unmarked state clears the unsaved warning and preserves an absent legacy field', async () => {
  const f = setup({recipe: RECIPE});
  f.page.toggleAgeGroup(tap('6-8')); assert.equal(f.alert(), true); assert.equal(f.page.data.ageGroupsDirty, true);
  f.page.toggleAgeGroup(tap('6-8')); assert.equal(f.alert(), false); assert.equal(f.page.data.ageGroupsDirty, false);
  await f.page.save(); assert.equal(Object.hasOwn(f.calls.saved[0], 'ageGroups'), false);
});

test('cancel and continue keep the age draft; confirmed discard does not save it', () => {
  const f = setup({recipe: RECIPE}); f.page.toggleAgeGroup(tap('12-17')); f.page.cancel();
  assert.equal(f.page.data.discardVisible, true); assert.equal(f.calls.backs, 0);
  f.page.continueEditing(); assert.deepEqual(f.page.data.ageGroups, ['12-17']); assert.equal(f.alert(), true);
  f.page.cancel(); f.page.discard(); f.page.onUnload();
  assert.equal(f.calls.backs, 1); assert.deepEqual(f.calls.saved, []); assert.equal(Object.hasOwn(f.source, 'ageGroups'), false);
});

test('invalid taps, missing recipes and saving state cannot change age selections', async () => {
  const f = setup({recipe: RECIPE});
  for (const value of ['未知', '6–8个月', '', undefined, 0]) f.page.toggleAgeGroup(tap(value));
  assert.deepEqual(f.page.data.ageGroups, []); assert.equal(f.alert(), false);
  f.page.setData({saving: true}); f.page.toggleAgeGroup(tap('6-8')); assert.deepEqual(f.page.data.ageGroups, []);
  const missing = setup({missing: true}); missing.page.toggleAgeGroup(tap('6-8')); await missing.page.save();
  assert.deepEqual(missing.page.data.ageGroups, []); assert.deepEqual(missing.calls.saved, []);
});

test('a failed save preserves all age selections and a retry saves the same draft', async () => {
  const f = setup({recipe: RECIPE}); f.page.toggleAgeGroup(tap('9-11')); f.page.toggleAgeGroup(tap('18+'));
  f.failSave(); await f.page.save();
  assert.equal(f.page.data.error, '保存失败'); assert.deepEqual(f.page.data.ageGroups, ['9-11', '18+']);
  assert.equal(f.page.data.ageGroupsDirty, true); assert.equal(f.page.data.saving, false); assert.equal(f.alert(), true);
  f.failSave(false); await f.page.save(); assert.deepEqual(f.calls.saved[0].ageGroups, ['9-11', '18+']);
});

test('changing accounts blocks age toggles and saves, including a photo-save await', async () => {
  const f = setup({recipe: RECIPE}); f.page.toggleAgeGroup(tap('6-8')); f.changeOwner('owner-b');
  f.page.toggleAgeGroup(tap('18+')); await f.page.save();
  assert.deepEqual(f.page.data.ageGroups, ['6-8']); assert.match(f.page.data.error, /账号已切换/); assert.deepEqual(f.calls.saved, []);
  const pending = setup({recipe: RECIPE}); pending.page.toggleAgeGroup(tap('9-11')); pending.page.pendingPhoto = 'wxfile://tmp/photo.jpg';
  const saving = pending.page.save(); pending.page.toggleAgeGroup(tap('18+')); pending.changeOwner('owner-b'); pending.finishPhoto(); await saving;
  assert.deepEqual(pending.page.data.ageGroups, ['9-11']); assert.deepEqual(pending.calls.saved, []); assert.match(pending.page.data.error, /账号已切换/);
});

test('actual store preserves newer age labels unless the editor deliberately changes or clears them', async t => {
  for (const action of ['untouched', 'restored', 'replace', 'clear']) await t.test(action, async () => {
    const initial = {...RECIPE, ageGroups: ['6-8'], createdAt: 1, updatedAt: 1};
    const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝', profileUpdatedAt: 1, recipes: [initial], logs: []}]]);
    const storeFile = path.join(__dirname, '../utils/store.js'), storeModule = {exports: {}};
    vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {
      module: storeModule, require: createRequire(storeFile),
      wx: {getStorageSync: key => clone(storage.get(key)), setStorageSync(key, value) { storage.set(key, clone(value)); }}
    });
    const store = storeModule.exports, originalSave = store.saveRecipe, submitted = [];
    store.saveRecipe = (value, rating) => { submitted.push(clone(value)); return originalSave(value, rating); };
    const f = setup({recipe: initial, store});
    f.page.input(input('note', '只在本机修改备注'));
    if (action === 'restored') { f.page.toggleAgeGroup(tap('18+')); f.page.toggleAgeGroup(tap('18+')); }
    if (action === 'replace' || action === 'clear') f.page.toggleAgeGroup(tap('6-8'));
    if (action === 'replace') f.page.toggleAgeGroup(tap('18+'));
    // Another update reaches the real store while the editor still holds its original snapshot.
    originalSave({...store.getRecipe(initial.id), ageGroups: ['12-17']});
    assert.deepEqual(clone(store.getRecipe(initial.id).ageGroups), ['12-17']);
    await f.page.save();
    assert.equal(submitted.length, 1); assert.equal(store.getRecipe(initial.id).note, '只在本机修改备注');
    const expected = action === 'replace' ? ['18+'] : action === 'clear' ? [] : ['12-17'];
    assert.deepEqual(clone(store.getRecipe(initial.id).ageGroups), expected);
    if (action === 'untouched' || action === 'restored') assert.equal(Object.hasOwn(submitted[0], 'ageGroups'), false);
    else assert.deepEqual(submitted[0].ageGroups, expected);
    assert.deepEqual(storage.get('baby-bites-v1').recipes[0].ageGroups, expected);
  });
});
