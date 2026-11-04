'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');
const seed = require('../data/recipes');
const root = path.resolve(__dirname, '..');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Run the actual pages and store with an isolated WeChat device for every test.
// Storage and file failures are observable at the same API boundary as on-device.
function setup() {
  const storage = new Map();
  let failWrites = false;
  let returnWarning = false;
  const hooks = {};
  const calls = { writes: 0, saves: [], unlinks: [], back: 0, alerts: [], toasts: [], addLog: 0, updateLog: 0, redirects: [], mine: [], timerDelays: [], photoPreparations: [], photoCleanups: [], photoChoices: 0 };
  const wx = {
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) {
      if (failWrites) throw new Error('Quota exceeded');
      storage.set(key, copy(value));
      calls.writes += 1;
    },
    enableAlertBeforeUnload(options) { returnWarning = true; calls.alerts.push(options.message); },
    disableAlertBeforeUnload(options) { returnWarning = false; if (options.complete) options.complete(); },
    setNavigationBarTitle() {},
    showToast(options) { calls.toasts.push(options.title); },
    redirectTo(options) { calls.redirects.push(options); },
    cloud: {callFunction() { throw Error('Forms must save locally before background publication'); }},
    chooseMedia(options) {
      calls.photoChoices++;
      if (hooks.chooseMedia) return hooks.chooseMedia(options);
      options.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp/selected-photo.jpg', size: 4096 }] });
    },
    getFileSystemManager() {
      return {
        saveFile(options) {
          const savedFilePath = 'wxfile://usr/photo-' + (calls.saves.length + 1) + '.jpg';
          calls.saves.push({ tempFilePath: options.tempFilePath, savedFilePath });
          options.success({ savedFilePath });
        },
        unlink(options) { calls.unlinks.push(options.filePath); }
      };
    }
  };
  const storeModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8'), {
    wx, module: storeModule,
    require(name) {
      if (name === '../data/recipes') return seed;
      if (name === './selectors') return selectors;
      if (name === './categories') return require('../utils/categories');
      if (name === './sync-merge') return require('../utils/sync-merge');
      if (name === './recipe-ages') return require('../utils/recipe-ages');
      if (name === './recipe-origin') return require('../utils/recipe-origin');
      if (name === './baby-age') return require('../utils/baby-age');
      if (name === './allergies') return require('../utils/allergies');
      throw new Error('Unexpected store dependency: ' + name);
    }
  });
  const store = storeModule.exports;
  for (const name of ['addLog', 'updateLog']) {
    const original = store[name];
    store[name] = (...args) => { calls[name] += 1; return original(...args); };
  }
  function open(name, options = {}) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
      wx, Page(value) { definition = value; },
      require(dependency) {
        if (dependency === '../../utils/family-photos') return {photoURL: value => value || ''};
        if (dependency === '../../utils/recipe-photo') return {async prepareRecipePhoto(filePath, options) {
          calls.photoPreparations.push(filePath);
          if (hooks.prepareRecipePhoto) return hooks.prepareRecipePhoto(filePath, options);
          options.assertCurrent();
          return {filePath, async cleanup() {}};
        }};
        if (dependency === '../../utils/store') return store;
        if (dependency === '../../utils/social') return {getMine: async options => { calls.mine.push(options); return hooks.mine ? hooks.mine(options) : {published: []}; }};
        if (dependency === '../../components/form-session/controller') return require('../components/form-session/controller');
        if (dependency === '../../utils/selectors') return selectors;
        if (dependency === '../../utils/recipe-origin') return require('../utils/recipe-origin');
        if (dependency === '../../utils/recipe-ages') return require('../utils/recipe-ages');
        if (dependency === '../../utils/ui') return {
          back() {
            assert.equal(returnWarning, false, 'successful or confirmed navigation must disable the return warning');
            calls.back += 1;
          },
          error(error) { calls.toasts.push(error.message); }
        };
        throw new Error('Unexpected page dependency: ' + dependency);
      }
    });
    const page = {
      ...definition, data: copy(definition.data),
      setData(changes) {
        for (const [key, value] of Object.entries(changes)) {
          const parts = key.split('.');
          let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part];
          target[parts[parts.length - 1]] = copy(value);
        }
      }
    };
    page.onLoad(options);
    return page;
  }
  return {
    store, calls, open, wx, hooks,
    returnWarning: () => returnWarning,
    failWrites() { failWrites = true; }, allowWrites() { failWrites = false; }
  };
}

const valueEvent = value => ({ detail: { value } });

test('meal date arrows cross leap days, stop at date bounds and keep changes unsaved', () => {
  const app = setup();
  const page = app.open('record-editor', {id: firstRecipeId(app), date: '2024-03-01'});
  const move = delta => page.moveDate({currentTarget: {dataset: {delta}}});
  move(-1); assert.equal(page.data.date, '2024-02-29');
  move(-1); assert.equal(page.data.date, '2024-02-28');
  move(1); assert.equal(page.data.date, '2024-02-29');
  assert.equal(app.calls.addLog, 0);
  assert.equal(app.returnWarning(), true);
  page.setData({date: selectors.today()}); move(1); assert.equal(page.data.date, selectors.today());
  page.setData({date: page.data.minDate}); move(-1); assert.equal(page.data.date, page.data.minDate);
  page.setData({date: '2024-02-28', saving: true}); move(1); assert.equal(page.data.date, '2024-02-28');
});

test('quick meal preference and portion choices do not persist until save is explicitly tapped', () => {
  const app = setup();
  const page = app.open('record-editor', {id: firstRecipeId(app)});
  page.tapRating({currentTarget: {dataset: {value: 3}}});
  page.tapPortion({currentTarget: {dataset: {value: 2}}});
  assert.equal(page.data.rating, 3); assert.equal(page.data.portionIndex, 2);
  assert.equal(app.calls.addLog, 0);
  page.save();
  assert.equal(app.calls.addLog, 1);
  assert.equal(app.store.getState().logs[0].portion, '吃了约一半');
});
const fieldEvent = field => ({ currentTarget: { dataset: { field } } });
function input(page, field, value) { page.input({ ...fieldEvent(field), ...valueEvent(value) }); }
function fillRecipe(page) {
  input(page, 'name', '南瓜小米粥');
  input(page, 'minutes', '25');
  input(page, 'ingredients', '南瓜 50克\n小米 20克');
  input(page, 'steps', '南瓜切小块\n与小米一起煮熟');
  input(page, 'note', '下次切得更细');
}
function newRecipe(app) { return app.store.getState().recipes.find(recipe => !recipe.isExample); }
function firstRecipeId(app) { return app.store.getState().recipes[0].id; }

test('simultaneous meal recording requires a selected preference before either recipe or meal is saved', async () => {
  const app = setup();
  const page = app.open('editor');
  const before = copy(app.store.getState());
  fillRecipe(page);
  page.toggleRecordMeal(valueEvent(true));
  await page.save();
  assert.ok(page.data.ratingError);
  assert.equal(app.calls.writes, 0);
  assert.deepEqual(copy(app.store.getState()), before);
  assert.equal(app.calls.back, 0);

  page.rate(valueEvent(3));
  await page.save();
  const recipe = newRecipe(app);
  const logs = app.store.getState().logs;
  assert.equal(recipe.name, '南瓜小米粥');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].recipeId, recipe.id);
  assert.equal(logs[0].rating, 3);
  assert.equal(app.calls.writes, 1, 'recipe and initial meal are saved together');
});

test('turning simultaneous recording off saves only the recipe even after choosing a preference', async () => {
  const app = setup();
  const page = app.open('editor');
  fillRecipe(page);
  page.toggleRecordMeal(valueEvent(true));
  page.rate(valueEvent(2));
  page.toggleRecordMeal(valueEvent(false));
  await page.save();
  assert.equal(newRecipe(app).name, '南瓜小米粥');
  assert.equal(app.store.getState().logs.length, 0);
  assert.equal(app.calls.writes, 1);
});

test('canceling a recipe picker keeps the current value; confirmation changes the saved category', async () => {
  const app = setup();
  const page = app.open('editor');
  const initialCategory = page.data.categoryIndex;
  page.openPicker(fieldEvent('categoryIndex'));
  page.closePicker();
  assert.equal(page.data.categoryIndex, initialCategory);
  assert.equal(app.returnWarning(), false);
  assert.equal(app.calls.writes, 0);

  page.openPicker(fieldEvent('categoryIndex'));
  page.pick(valueEvent([3]));
  assert.equal(page.data.categoryIndex, 3);
  assert.equal(page.data.categories[page.data.categoryIndex], '粥饭主食');
  assert.equal(page.data.pickerVisible, false);
  assert.equal(app.returnWarning(), true);
  fillRecipe(page);
  await page.save();
  assert.equal(newRecipe(app).category, '粥饭主食');
});

test('canceling the date picker preserves the date; confirming saves the chosen date', () => {
  const app = setup();
  const page = app.open('record-editor', { id: firstRecipeId(app) });
  const originalDate = page.data.date;
  page.openDate();
  page.closeDate();
  assert.equal(page.data.date, originalDate);
  assert.equal(app.returnWarning(), false);
  page.openDate();
  page.changeDate(valueEvent('2020-01-02'));
  assert.equal(page.data.dateVisible, false);
  page.rate(valueEvent(2));
  page.save();
  assert.equal(app.store.getState().logs[0].date, '2020-01-02');
});

test('calendar date query is preserved for a new meal, validated, and never overrides an existing record date', () => {
  const app = setup();
  const now = selectors.today();
  const year = Number(now.slice(0, 4));
  const selectedDate = (year - 1) + '-12-01';
  const recipeId = firstRecipeId(app);
  const page = app.open('record-editor', {id: recipeId, date: selectedDate});
  assert.equal(page.data.date, selectedDate);
  assert.equal(page.data.editing, false);
  assert.equal(app.calls.writes, 0, 'opening the form does not create a record');
  assert.equal(app.returnWarning(), false, 'the selected date is part of the initial draft');
  page.rate(valueEvent(2));
  page.save();
  const savedLog = app.store.getState().logs[0];
  assert.equal(savedLog.date, selectedDate, 'saving keeps the date selected in the records calendar');

  const invalidDates = [(year + 1) + '-01-01', (year - 1) + '-02-30',
    (year - 1) + '-2-01', 'not-a-date', '', null, 123, (year - 11) + '-12-01'];
  invalidDates.forEach(date => {
    const newMeal = app.open('record-editor', {id: recipeId, date});
    assert.equal(newMeal.data.date, now, 'invalid or unavailable date falls back to today: ' + date);
  });
  assert.equal(app.calls.addLog, 1);
  const editing = app.open('record-editor', {logId: savedLog.id, date: now});
  assert.equal(editing.data.editing, true);
  assert.equal(editing.data.date, selectedDate, 'an existing record owns its date even when a date query is supplied');
  editing.note(valueEvent('保留原用餐日期'));
  editing.save();
  assert.equal(app.store.getLog(savedLog.id).date, selectedDate);
  assert.equal(app.calls.updateLog, 1);
  assert.equal(app.store.getState().logs.length, 1);
});

test('recipe return warning is enabled only while the form differs from its original values', () => {
  const app = setup();
  const page = app.open('editor');
  assert.equal(app.returnWarning(), false);
  input(page, 'name', '临时名称');
  assert.equal(app.returnWarning(), true);
  input(page, 'name', '');
  assert.equal(app.returnWarning(), false);
  assert.equal(app.calls.writes, 0);
});

test('meal return warning is cleared when edited text is restored to its original value', () => {
  const app = setup();
  const page = app.open('record-editor', { id: firstRecipeId(app) });
  assert.equal(app.returnWarning(), false);
  page.note(valueEvent('临时备注'));
  assert.equal(app.returnWarning(), true);
  page.note(valueEvent(''));
  assert.equal(app.returnWarning(), false);
  assert.equal(app.calls.writes, 0);
});

test('canceling a changed recipe and choosing to continue keeps all edits without navigating or writing', async () => {
  const app = setup();
  const page = app.open('editor');
  fillRecipe(page);
  page.cancel();
  assert.equal(page.data.discardVisible, true);
  page.continueEditing();
  assert.equal(page.data.discardVisible, false);
  assert.equal(app.calls.back, 0);
  assert.equal(app.calls.writes, 0);
  assert.equal(app.returnWarning(), true);
  await page.save();
  assert.equal(newRecipe(app).note, '下次切得更细');
  assert.equal(page.data.savedComplete, true);
  assert.equal(app.calls.back, 1);
  assert.equal(app.returnWarning(), false);
});

test('canceling a meal and continuing retains the preference and note', () => {
  const app = setup();
  const page = app.open('record-editor', { id: firstRecipeId(app) });
  page.rate(valueEvent(1));
  page.note(valueEvent('今天没有吃太多'));
  page.back();
  assert.equal(page.data.discardVisible, true);
  page.continueEditing();
  assert.equal(app.calls.back, 0);
  assert.equal(app.calls.writes, 0);
  assert.equal(page.data.rating, 1);
  assert.equal(page.data.note, '今天没有吃太多');
  assert.equal(app.returnWarning(), true);
});

test('failed storage keeps the full photo draft and retries without saving the photo twice', async () => {
  const app = setup();
  const page = app.open('editor');
  const before = copy(app.store.getState());
  fillRecipe(page);
  const form = copy(page.data.form);
  page.toggleRecordMeal(valueEvent(true));
  page.rate(valueEvent(3));
  await page.choosePhoto();
  app.failWrites();
  await page.save();
  assert.ok(page.data.error);
  assert.equal(page.data.saving, false);
  assert.deepEqual(copy(page.data.form), form);
  assert.equal(page.data.recordMeal, true);
  assert.equal(page.data.rating, 3);
  assert.equal(page.data.photo, app.calls.saves[0].savedFilePath);
  assert.equal(app.calls.saves.length, 1);
  assert.deepEqual(app.calls.unlinks, []);
  assert.deepEqual(copy(app.store.getState()), before);
  assert.equal(app.calls.writes, 0);
  assert.equal(app.calls.back, 0);
  assert.equal(app.returnWarning(), true);

  app.allowWrites();
  await page.save();
  const recipe = newRecipe(app);
  assert.equal(app.calls.saves.length, 1);
  assert.equal(recipe.photo, app.calls.saves[0].savedFilePath);
  assert.equal(recipe.note, form.note);
  assert.deepEqual(copy(recipe.ingredients), [{ name: '南瓜', amount: '50克' }, { name: '小米', amount: '20克' }]);
  assert.deepEqual(copy(recipe.steps), ['南瓜切小块', '与小米一起煮熟']);
  assert.equal(app.store.getState().logs[0].rating, 3);
  assert.equal(app.calls.writes, 1);
  assert.equal(page.data.savedComplete, true);
  assert.equal(app.calls.back, 1);
  page.onUnload();
  assert.deepEqual(app.calls.unlinks, [], 'the photo referenced by the saved recipe must survive page unload');
});

test('discarding a failed photo draft removes the staged file and leaves stored recipes unchanged', async () => {
  const app = setup();
  const page = app.open('editor');
  const before = copy(app.store.getState());
  fillRecipe(page);
  await page.choosePhoto();
  app.failWrites();
  await page.save();
  page.cancel();
  page.discard();
  page.onUnload();
  assert.deepEqual(app.calls.unlinks, [app.calls.saves[0].savedFilePath]);
  assert.deepEqual(copy(app.store.getState()), before);
  assert.equal(app.calls.back, 1);
});

test('editing by logId updates the existing meal without adding a log or rewriting its unchanged legacy portion', () => {
  const app = setup();
  const recipeId = firstRecipeId(app);
  const logId = app.store.addLog({ recipeId, rating: 2, date: '2020-01-01', portion: '光盘啦', note: '原备注' });
  const addsBeforeEditing = app.calls.addLog;
  const page = app.open('record-editor', { logId });
  assert.equal(page.data.editing, true);
  assert.equal(page.data.portions[page.data.portionIndex], '全部吃完');
  page.rate(valueEvent(3));
  page.note(valueEvent('补充备注'));
  page.save();
  const logs = app.store.getState().logs;
  assert.equal(app.calls.updateLog, 1);
  assert.equal(app.calls.addLog, addsBeforeEditing);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, logId);
  assert.equal(logs[0].recipeId, recipeId);
  assert.equal(logs[0].rating, 3);
  assert.equal(logs[0].note, '补充备注');
  assert.equal(logs[0].portion, '光盘啦');
  assert.equal(app.calls.back, 1);
});

test('missing meal or recipe opens an explicit empty state and cannot write a new record', () => {
  const app = setup();
  const missingLog = app.open('record-editor', { logId: 'deleted-log' });
  assert.equal(missingLog.data.recipe, null);
  assert.match(missingLog.data.missingMessage, /没有找到.*记录/);
  missingLog.save();
  const missingRecipe = app.open('record-editor', { id: 'deleted-recipe' });
  assert.equal(missingRecipe.data.recipe, null);
  assert.match(missingRecipe.data.missingMessage, /没有找到.*菜谱/);
  missingRecipe.save();
  assert.equal(app.calls.writes, 0);
  assert.equal(app.calls.addLog, 0);
  assert.equal(app.calls.updateLog, 0);
});

function ownRecipe(app, overrides = {}) {
  return app.store.saveRecipe({...copy(seed[0]), id: undefined, isExample: false, ...overrides});
}
const SHARED_SOURCE = {profileId: 'c'.repeat(32), recipeId: 'd'.repeat(64), authorName: '其他家长'};

test('saving a new recipe returns immediately without a sharing choice or remote status request', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  await page.save();
  const saved = newRecipe(app), writes = app.calls.writes;
  assert.equal(page.data.savedComplete, true); assert.equal(app.calls.back, 1);
  assert.equal(app.returnWarning(), false); assert.deepEqual(app.calls.redirects, []); assert.deepEqual(app.calls.mine, []);
  await page.save(); input(page, 'name', '不应再次保存');
  assert.equal(app.calls.writes, writes); assert.equal(app.store.getRecipe(saved.id).name, saved.name);
});

test('editing own, built-in and attributed recipes returns without publishing from the form', async () => {
  for (const kind of ['own', 'builtin', 'copy']) {
    const app = setup(), id = kind === 'builtin' ? firstRecipeId(app) : ownRecipe(app, kind === 'copy' ? {source: SHARED_SOURCE} : {});
    const page = app.open('editor', {id}); input(page, 'name', '调整后的做法'); await page.save();
    assert.equal(app.calls.back, 1); assert.deepEqual(app.calls.redirects, []); assert.deepEqual(app.calls.mine, []);
    assert.equal(app.store.getRecipe(id).name, '调整后的做法');
    if (kind === 'copy') assert.deepEqual(copy(app.store.getRecipe(id).source), SHARED_SOURCE);
  }
});

test('a text-only draft keeps the family photo synced while the editor was open', async () => {
  const app = setup(), owner = 'a'.repeat(64), familyId = 'f'.repeat(64);
  app.store.bindAccount(owner);
  app.store.bindScope(owner, {kind: 'family', id: familyId, membershipId: 'e'.repeat(32)});
  const id = ownRecipe(app, {photo: ''}), editor = app.open('editor', {id});
  const snapshot = app.store.getSyncSnapshot(), {sequence} = app.store.getSyncInfo();
  const photo = 'cloud://test.bucket/families/' + familyId + '/photos/first.jpg';
  snapshot.data.recipes.find(recipe => recipe.id === id).photo = photo;
  app.store.applySyncedSnapshot(snapshot, {owner, revision: 1, sequence});
  input(editor, 'name', '新菜名');
  await editor.save();
  assert.equal(app.store.getRecipe(id).photo, photo);
  assert.equal(app.store.getRecipe(id).name, '新菜名');

  const next = app.open('editor', {id});
  next.clearPhoto();
  await next.save();
  assert.equal(app.store.getRecipe(id).photo, '');
});

test('a new recipe with a very-liked meal saves both once and returns', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  page.toggleRecordMeal(valueEvent(true)); page.rate(valueEvent(3)); await page.save();
  assert.equal(app.store.getState().logs.length, 1); assert.equal(app.store.getState().logs[0].rating, 3);
  assert.equal(app.calls.back, 1); assert.deepEqual(app.calls.redirects, []);
  await page.save(); assert.equal(app.store.getState().logs.length, 1);
});

test('all meal ratings return after saving without a share prompt or remote request', async () => {
  for (const rating of [1, 2, 3]) {
    const app = setup(), id = ownRecipe(app), page = app.open('record-editor', {id});
    page.rate(valueEvent(rating)); await page.save();
    assert.equal(app.store.getState().logs[0].rating, rating); assert.equal(app.calls.back, 1);
    assert.equal(page.data.savedComplete, true); assert.deepEqual(app.calls.mine, []); assert.deepEqual(app.calls.redirects, []);
    const writes = app.calls.writes; page.save(); page.rate(valueEvent(1)); assert.equal(app.calls.writes, writes);
  }
});

test('updating a meal to very liked edits the existing log and immediately returns', async () => {
  const app = setup(), id = ownRecipe(app), logId = app.store.addLog({recipeId: id, rating: 2, date: '2020-01-01'});
  const page = app.open('record-editor', {logId}); page.rate(valueEvent(3)); page.note(valueEvent('喜欢南瓜')); await page.save();
  assert.equal(app.store.getState().logs.length, 1); assert.equal(app.store.getLog(logId).rating, 3);
  assert.equal(app.calls.back, 1); assert.deepEqual(app.calls.redirects, []); assert.deepEqual(app.calls.mine, []);
});

test('failed saves retain the draft and successful retries return exactly once', async () => {
  for (const name of ['editor', 'record-editor']) {
    const app = setup(), id = name === 'record-editor' ? ownRecipe(app) : null, page = app.open(name, id ? {id} : {});
    if (id) page.rate(valueEvent(3)); else fillRecipe(page);
    app.failWrites(); await page.save();
    assert.equal(page.data.savedComplete, false); assert.equal(app.calls.back, 0);
    app.allowWrites(); await page.save();
    assert.equal(page.data.savedComplete, true); assert.equal(app.calls.back, 1);
    const writes = app.calls.writes; await page.save(); assert.equal(app.calls.writes, writes);
  }
});

test('recipe and record forms have no publication-choice UI or preview route', () => {
  for (const name of ['editor', 'record-editor']) {
    const page = fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8');
    const template = fs.readFileSync(path.join(root, 'pages', name, 'index.wxml'), 'utf8');
    assert.doesNotMatch(page + template, /share-prompt|share-preview|先留给自己|确认预览|previewPublication|publishRecipe/);
  }
});

test('closing the editor during photo persistence prevents the save and removes its orphaned staged photo', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page); await page.choosePhoto();
  let finish;
  app.wx.getFileSystemManager = () => ({saveFile(options) { finish = options.success; }, unlink(options) { app.calls.unlinks.push(options.filePath); }});
  const save = page.save(); page.onUnload(); finish({savedFilePath: 'wxfile://usr/late-photo.jpg'}); await save;
  assert.equal(app.calls.writes, 0);
  assert.deepEqual(app.calls.unlinks, ['wxfile://usr/late-photo.jpg']);
  assert.equal(page.data.savedComplete, false);
  assert.deepEqual(app.calls.redirects, []);
});

test('same-account family changes clear editor drafts and an ABA return cannot save them', async () => {
  for (const name of ['editor', 'record-editor']) {
    const app = setup(), owner = 'a'.repeat(64);
    app.store.bindAccount(owner);
    const id = ownRecipe(app), page = app.open(name, {id});
    if (name === 'editor') input(page, 'name', '待保存修改'); else page.rate(valueEvent(3));
    app.store.bindScope(owner, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)});
    if (name === 'editor') assert.equal(page.data.form.name, '');
    app.store.bindScope(owner, {kind: 'personal', id: owner});
    const before = copy(app.store.getState());
    await page.save();
    assert.deepEqual(copy(app.store.getState()), before);
    assert.match(page.data.error, /家庭|账号/);
    assert.equal(app.calls.back, 0);
  }
});

test('editing another family member recipe preserves creator and returns without changing its creator', async () => {
  const app = setup(), owner = 'a'.repeat(64), creator = 'b'.repeat(64);
  app.store.bindAccount(owner);
  app.store.bindScope(owner, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)});
  const id = app.store.saveRecipe({...seed[0], id: undefined, isExample: false, createdBy: creator});
  const recipe = app.store.getRecipe(id);
  const page = app.open('editor', {id: recipe.id});
  input(page, 'name', '爸爸调整后的南瓜饭');
  await page.save();
  assert.equal(app.store.getRecipe(recipe.id).createdBy, creator);
  assert.equal(app.store.getRecipe(recipe.id).name, '爸爸调整后的南瓜饭');
  assert.equal(app.calls.mine.length, 0);
});

const photoTurn = () => new Promise(resolve => setImmediate(resolve));
function pendingPhotoPreparation() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function preparedPhoto(app, filePath = 'wxfile://tmp/compressed-photo.jpg') {
  let cleaned = false;
  return {filePath, async cleanup() {
    if (cleaned) return;
    cleaned = true; app.calls.photoCleanups.push(filePath);
  }};
}

test('large selected photos are prepared before preview and only the compressed result is persisted', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  const source = 'wxfile://tmp/large-camera-photo.jpg', output = 'wxfile://tmp/compressed-camera-photo.jpg';
  app.hooks.chooseMedia = options => options.success({tempFiles: [{tempFilePath: source, size: 8 * 1024 * 1024}]});
  app.hooks.prepareRecipePhoto = (filePath, options) => {
    options.assertCurrent(); assert.equal(filePath, source); return preparedPhoto(app, output);
  };
  await page.choosePhoto();
  assert.deepEqual(app.calls.photoPreparations, [source]);
  assert.equal(page.data.photo, output); assert.equal(page.data.photoDisplay, output);
  assert.equal(page.pendingPhoto, output); assert.equal(page.data.choosingPhoto, false);
  assert.equal(app.calls.saves.length, 0); assert.equal(app.calls.writes, 0);
  await page.save();
  assert.equal(app.calls.saves[0].tempFilePath, output);
  assert.equal(newRecipe(app).photo, app.calls.saves[0].savedFilePath);
  assert.deepEqual(app.calls.photoCleanups, [output]);
  page.onUnload();
  assert.deepEqual(app.calls.photoCleanups, [output]);
  assert.deepEqual(app.calls.unlinks, []);
});

test('photo preparation keeps the prior preview and blocks duplicate choices, removal and premature saving', async () => {
  const app = setup(), oldPhoto = 'wxfile://usr/existing-photo.jpg';
  const id = ownRecipe(app, {photo: oldPhoto}), page = app.open('editor', {id});
  const gate = pendingPhotoPreparation(), output = preparedPhoto(app);
  let guard;
  app.hooks.prepareRecipePhoto = (_, options) => { guard = options.assertCurrent; return gate.promise; };
  const work = page.choosePhoto(); await photoTurn();
  const writes = app.calls.writes;
  assert.equal(page.data.choosingPhoto, true); assert.equal(page.data.photo, oldPhoto);
  assert.equal(typeof guard, 'function'); guard();
  await page.choosePhoto(); page.clearPhoto(); await page.save();
  assert.equal(app.calls.photoChoices, 1); assert.equal(app.calls.photoPreparations.length, 1);
  assert.equal(page.data.photo, oldPhoto); assert.equal(app.calls.writes, writes);
  assert.equal(app.calls.saves.length, 0); assert.deepEqual(app.calls.unlinks, []);
  gate.resolve(output); await work;
  assert.equal(page.data.photo, output.filePath); assert.equal(page.data.choosingPhoto, false);
  assert.equal(app.store.getRecipe(id).photo, oldPhoto);
});

test('picker cancellation, empty results and compression failures retain the complete previous photo draft', async t => {
  for (const mode of ['cancel', 'permission', 'empty', 'compression']) await t.test(mode, async () => {
    const app = setup(), oldPhoto = 'wxfile://usr/existing-photo.jpg';
    const id = ownRecipe(app, {photo: oldPhoto}), page = app.open('editor', {id});
    const before = copy(app.store.getState());
    if (mode === 'cancel' || mode === 'permission') app.hooks.chooseMedia = options => options.fail({errMsg: 'chooseMedia:fail ' + (mode === 'cancel' ? 'cancel' : 'auth deny')});
    else if (mode === 'empty') app.hooks.chooseMedia = options => options.success({tempFiles: []});
    else app.hooks.prepareRecipePhoto = () => { throw Error('照片压缩失败'); };
    await page.choosePhoto();
    assert.equal(page.data.photo, oldPhoto); assert.equal(page.data.photoDisplay, oldPhoto);
    assert.equal(page.data.choosingPhoto, false); assert.equal(app.returnWarning(), false);
    assert.deepEqual(copy(app.store.getState()), before);
    assert.deepEqual(app.calls.unlinks, []); assert.deepEqual(app.calls.photoCleanups, []);
    assert.equal(app.calls.toasts.length, mode === 'cancel' || mode === 'empty' ? 0 : 1);
  });
});

test('late prepared photos cannot repopulate closed or changed-account and family drafts', async t => {
  for (const mode of ['unload', 'account', 'family-aba']) await t.test(mode, async () => {
    const app = setup(), owner = 'a'.repeat(64), other = 'b'.repeat(64);
    app.store.bindAccount(owner);
    const oldPhoto = 'wxfile://usr/existing-photo.jpg', id = ownRecipe(app, {photo: oldPhoto});
    const page = app.open('editor', {id}), gate = pendingPhotoPreparation(), output = preparedPhoto(app);
    let guard;
    app.hooks.prepareRecipePhoto = (_, options) => { guard = options.assertCurrent; return gate.promise; };
    const work = page.choosePhoto(); await photoTurn();
    if (mode === 'unload') page.onUnload();
    else if (mode === 'account') app.store.bindAccount(other);
    else {
      app.store.bindScope(owner, {kind: 'family', id: 'f'.repeat(64), membershipId: 'e'.repeat(32)});
      app.store.bindScope(owner, {kind: 'personal', id: owner});
    }
    assert.throws(guard, /页面已关闭|账号|家庭/);
    const view = copy(page.data), stored = copy(app.store.getState()), writes = app.calls.writes;
    gate.resolve(output); await work;
    assert.deepEqual(page.data, view); assert.deepEqual(copy(app.store.getState()), stored);
    assert.equal(app.calls.writes, writes); assert.equal(app.calls.saves.length, 0);
    assert.deepEqual(app.calls.photoCleanups, [output.filePath]);
    assert.deepEqual(app.calls.unlinks, []); assert.equal(app.calls.toasts.length, 0);
  });
});

test('replacing or clearing prepared photos cleans only temporary outputs and never the original saved photo', async () => {
  const app = setup(), oldPhoto = 'wxfile://usr/existing-photo.jpg';
  const id = ownRecipe(app, {photo: oldPhoto}), page = app.open('editor', {id});
  const first = preparedPhoto(app, 'wxfile://tmp/compressed-first.jpg');
  app.hooks.prepareRecipePhoto = () => first; await page.choosePhoto();
  app.hooks.prepareRecipePhoto = () => { throw Error('压缩未完成'); }; await page.choosePhoto();
  assert.equal(page.data.photo, first.filePath); assert.deepEqual(app.calls.photoCleanups, []);
  const second = preparedPhoto(app, 'wxfile://tmp/compressed-second.jpg');
  app.hooks.prepareRecipePhoto = () => second; await page.choosePhoto();
  assert.deepEqual(app.calls.photoCleanups, [first.filePath]);
  page.clearPhoto(); page.onUnload();
  assert.deepEqual(app.calls.photoCleanups, [first.filePath, second.filePath]);
  assert.equal(page.data.photo, ''); assert.equal(app.store.getRecipe(id).photo, oldPhoto);
  assert.deepEqual(app.calls.unlinks, []);
});

test('a failed recipe write retries the persisted compressed photo without choosing, compressing or saving the file twice', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  const output = preparedPhoto(app);
  app.hooks.prepareRecipePhoto = () => output;
  await page.choosePhoto(); app.failWrites(); await page.save();
  assert.equal(app.calls.photoPreparations.length, 1); assert.equal(app.calls.saves.length, 1);
  assert.deepEqual(app.calls.photoCleanups, [output.filePath]);
  assert.equal(page.data.photo, app.calls.saves[0].savedFilePath);
  assert.equal(page.data.savedComplete, false);
  app.allowWrites(); await page.save(); page.onUnload();
  assert.equal(app.calls.photoPreparations.length, 1); assert.equal(app.calls.saves.length, 1);
  assert.equal(newRecipe(app).photo, app.calls.saves[0].savedFilePath);
  assert.deepEqual(app.calls.photoCleanups, [output.filePath]); assert.deepEqual(app.calls.unlinks, []);
});

test('closing an unsaved compressed photo draft cleans its generated output once', async () => {
  const app = setup(), page = app.open('editor'), output = preparedPhoto(app);
  app.hooks.prepareRecipePhoto = () => output;
  await page.choosePhoto(); page.onUnload(); page.onUnload();
  assert.deepEqual(app.calls.photoCleanups, [output.filePath]);
  assert.equal(app.calls.writes, 0); assert.equal(app.calls.saves.length, 0);
  assert.deepEqual(app.calls.unlinks, []);
});
