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
  const calls = { writes: 0, saves: [], unlinks: [], back: 0, alerts: [], toasts: [], addLog: 0, updateLog: 0 };
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
    chooseMedia(options) {
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
        if (dependency === '../../utils/store') return store;
        if (dependency === '../../utils/selectors') return selectors;
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
    store, calls, open,
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
  page.choosePhoto();
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
  assert.equal(app.calls.back, 1);
  page.onUnload();
  assert.deepEqual(app.calls.unlinks, [], 'the photo referenced by the saved recipe must survive page unload');
});

test('discarding a failed photo draft removes the staged file and leaves stored recipes unchanged', async () => {
  const app = setup();
  const page = app.open('editor');
  const before = copy(app.store.getState());
  fillRecipe(page);
  page.choosePhoto();
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
