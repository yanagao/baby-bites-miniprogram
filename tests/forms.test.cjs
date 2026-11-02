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
  let nextTimer = 0;
  const hooks = {}, timers = new Map();
  const calls = { writes: 0, saves: [], unlinks: [], back: 0, alerts: [], toasts: [], addLog: 0, updateLog: 0, redirects: [], mine: [], timerDelays: [] };
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
    cloud: {callFunction() { throw Error('Saving or prompting must not publish a recipe'); }},
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
      if (name === './recipe-origin') return require('../utils/recipe-origin');
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
        if (dependency === '../../utils/store') return store;
        if (dependency === '../../utils/social') return {getMine: async options => { calls.mine.push(options); return hooks.mine ? hooks.mine(options) : {published: []}; }};
        if (dependency === '../../components/share-prompt/controller') return {createSharePrompt: options =>
          require('../components/share-prompt/controller').createSharePrompt({...options,
            setTimer(fn, delay) { calls.timerDelays.push(delay); timers.set(++nextTimer, fn); return nextTimer; },
            clearTimer(id) { timers.delete(id); }})};
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
    runPromptTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
    pendingTimers: () => timers.size,
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
  assert.equal(app.calls.back, 0);
  assert.equal(page.data.sharePromptVisible, true);
  page.keepRecipeForSelf();
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
  assert.equal(app.calls.back, 0);
  assert.equal(page.data.sharePromptVisible, true);
  page.keepRecipeForSelf();
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

function ownRecipe(app, overrides = {}) {
  return app.store.saveRecipe({...copy(seed[0]), id: undefined, isExample: false, ...overrides});
}
const SHARED_SOURCE = {profileId: 'c'.repeat(32), recipeId: 'd'.repeat(64), authorName: '其他家长'};

test('saving an own recipe offers an unselected share choice only after the local save succeeds', async () => {
  const app = setup(), page = app.open('editor');
  fillRecipe(page);
  assert.equal(page.data.sharePromptVisible, false);
  await page.save();
  const saved = newRecipe(app), writes = app.calls.writes;
  assert.equal(page.data.sharePromptVisible, true);
  assert.equal(page.data.sharePromptMessage, '已收进你的食谱，也分享给其他家长吧');
  assert.equal(page.data.savedComplete, true);
  assert.equal(page.data.sharePromptBusy, false);
  assert.equal(app.returnWarning(), false);
  assert.equal(app.calls.back, 0);
  assert.deepEqual(app.calls.redirects, []);
  await page.save();
  input(page, 'name', '不应重新保存');
  assert.equal(app.calls.writes, writes);
  assert.equal(page.data.form.name, saved.name);
  assert.equal(app.store.getRecipe(saved.id).name, saved.name);
});

test('keep for myself and the back button dismiss the saved prompt without another discard warning or write', async () => {
  for (const method of ['keepRecipeForSelf', 'cancel']) {
    const app = setup(), page = app.open('editor'); fillRecipe(page); await page.save();
    const before = copy(app.store.getState()), writes = app.calls.writes;
    page[method]();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(page.data.discardVisible, false);
    assert.equal(app.calls.back, 1);
    assert.equal(app.calls.writes, writes);
    assert.deepEqual(copy(app.store.getState()), before);
    assert.deepEqual(app.calls.redirects, []);
  }
});

test('public share opens a preview without publishing, and repeated taps open it once', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page); await page.save();
  const id = newRecipe(app).id, writes = app.calls.writes;
  page.previewSavedRecipe(); page.previewSavedRecipe(); page.keepRecipeForSelf();
  assert.equal(app.calls.redirects.length, 1);
  assert.equal(app.calls.redirects[0].url, '/pages/share-preview/index?id=' + encodeURIComponent(id));
  assert.equal(page.data.sharePromptBusy, true);
  assert.equal(app.calls.writes, writes);
  assert.equal(app.calls.back, 0);
});

test('preview navigation failure leaves the saved recipe and both choices available for retry', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page); await page.save();
  const before = copy(app.store.getState());
  page.previewSavedRecipe(); app.calls.redirects[0].fail(Error('offline'));
  assert.equal(page.data.sharePromptVisible, true);
  assert.equal(page.data.sharePromptBusy, false);
  assert.match(page.data.sharePromptError, /菜谱已保存/);
  assert.equal(app.returnWarning(), false);
  assert.deepEqual(copy(app.store.getState()), before);
  page.previewSavedRecipe(); assert.equal(app.calls.redirects.length, 2);
  page.onUnload(); const data = copy(page.data); app.calls.redirects[1].fail(Error('late response'));
  assert.deepEqual(copy(page.data), data);
});

test('built-in edits and attributed copies do not show a prompt to publish someone else’s recipe', async () => {
  for (const kind of ['builtin', 'copy']) {
    const app = setup();
    const id = kind === 'builtin' ? firstRecipeId(app) : ownRecipe(app, {source: SHARED_SOURCE});
    const page = app.open('editor', {id}); input(page, 'name', '我调整的做法'); await page.save();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 1);
    assert.deepEqual(app.calls.redirects, []);
  }
});

test('a new recipe with an initial very-liked meal shows one save prompt rather than two prompts', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  page.toggleRecordMeal(valueEvent(true)); page.rate(valueEvent(3)); await page.save();
  assert.equal(page.data.sharePromptMessage, '已收进你的食谱，也分享给其他家长吧');
  assert.equal(page.data.sharePromptVisible, true);
  assert.equal(app.store.getState().logs.length, 1);
  assert.equal(app.calls.toasts.filter(value => value === '菜谱已保存').length, 1);
});

test('recording an own recipe as very liked shows the requested prompt after the meal is saved', async () => {
  const app = setup(), id = ownRecipe(app), page = app.open('record-editor', {id});
  page.rate(valueEvent(3)); await page.save();
  assert.equal(page.data.sharePromptVisible, true);
  assert.equal(page.data.sharePromptMessage, '宝宝喜欢这道菜，把做法分享出去吧');
  assert.equal(app.store.getState().logs[0].rating, 3);
  assert.equal(app.returnWarning(), false);
  assert.equal(app.calls.back, 0);
  const writes = app.calls.writes; page.save(); page.rate(valueEvent(2));
  assert.equal(app.calls.writes, writes); assert.equal(page.data.rating, 3);
  page.back(); assert.equal(app.calls.back, 1); assert.equal(page.data.discardVisible, false);
});

test('only transitioning an existing own meal to very liked prompts, not editing its note or lowering its rating', async () => {
  for (const [before, after, prompt] of [[2, 3, true], [3, 3, false], [3, 2, false], [1, 2, false]]) {
    const app = setup(), id = ownRecipe(app);
    const logId = app.store.addLog({recipeId: id, rating: before, date: '2020-01-01'});
    const page = app.open('record-editor', {logId}); page.rate(valueEvent(after)); page.note(valueEvent('补充记录')); await page.save();
    assert.equal(page.data.sharePromptVisible, prompt, before + ' to ' + after);
    assert.equal(app.store.getLog(logId).rating, after);
    assert.equal(app.store.getState().logs.length, 1);
    assert.equal(app.calls.back, prompt ? 0 : 1);
  }
});

test('other ratings, built-in recipes and saved copies never trigger the very-liked share prompt', () => {
  for (const kind of ['ordinary-rating', 'builtin', 'copy']) {
    const app = setup();
    const id = kind === 'builtin' ? firstRecipeId(app) : ownRecipe(app, kind === 'copy' ? {source: SHARED_SOURCE} : {});
    const page = app.open('record-editor', {id}); page.rate(valueEvent(kind === 'ordinary-rating' ? 2 : 3)); page.save();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 1);
    assert.deepEqual(app.calls.redirects, []);
  }
});

test('failed local saves never prompt or navigate, and successful retries prompt exactly once', async () => {
  for (const kind of ['editor', 'record-editor']) {
    const app = setup(), id = kind === 'record-editor' ? ownRecipe(app) : null;
    const page = app.open(kind, id ? {id} : {});
    if (kind === 'editor') fillRecipe(page); else page.rate(valueEvent(3));
    app.failWrites(); await page.save();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(page.data.savedComplete, false);
    assert.equal(app.calls.back, 0);
    assert.deepEqual(app.calls.redirects, []);
    app.allowWrites(); await page.save();
    assert.equal(page.data.sharePromptVisible, true);
    const writes = app.calls.writes; await page.save(); assert.equal(app.calls.writes, writes);
  }
});

test('switching accounts invalidates a saved prompt permanently, including A to B to A', async () => {
  const app = setup(), owner = 'a'.repeat(64), other = 'b'.repeat(64);
  app.store.bindAccount(owner);
  const page = app.open('editor'); fillRecipe(page); await page.save();
  const id = newRecipe(app).id;
  app.store.bindAccount(other); app.store.bindAccount(owner);
  assert.equal(page.data.sharePromptVisible, false);
  page.previewSavedRecipe(); page.keepRecipeForSelf();
  assert.deepEqual(app.calls.redirects, []);
  assert.equal(app.calls.back, 0);
  assert.ok(app.store.getRecipe(id));
});

test('a saved recipe removed on another device cannot be opened through a stale prompt', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page); await page.save();
  app.store.deleteRecipe(newRecipe(app).id);
  page.previewSavedRecipe();
  assert.deepEqual(app.calls.redirects, []);
  assert.equal(page.data.sharePromptVisible, false);
  assert.equal(app.calls.back, 1);
});

test('closing the editor during photo persistence prevents the save and removes its orphaned staged photo', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page); page.choosePhoto();
  let finish;
  app.wx.getFileSystemManager = () => ({saveFile(options) { finish = options.success; }, unlink(options) { app.calls.unlinks.push(options.filePath); }});
  const save = page.save(); page.onUnload(); finish({savedFilePath: 'wxfile://usr/late-photo.jpg'}); await save;
  assert.equal(app.calls.writes, 0);
  assert.deepEqual(app.calls.unlinks, ['wxfile://usr/late-photo.jpg']);
  assert.equal(page.data.sharePromptVisible, false);
  assert.deepEqual(app.calls.redirects, []);
});

test('the prompt renders both requested neutral actions without a radio selection or direct sharing capability', () => {
  const template = fs.readFileSync(path.join(root, 'components/share-prompt/index.wxml'), 'utf8');
  assert.match(template, />公开分享<\/button>/);
  assert.match(template, />先留给自己<\/button>/);
  assert.doesNotMatch(template, /open-type=|checked=|selected|radio/);
  assert.equal((template.match(/class="share-prompt-action"/g) || []).length, 2);
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferredResult() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return {promise, resolve, reject};
}
function existingOwnSave(app, name) {
  const id = ownRecipe(app);
  const page = app.open(name, {id});
  if (name === 'editor') input(page, 'name', '修改后的菜谱');
  else page.rate(valueEvent(3));
  return {id, page};
}

test('new recipe invitations do not wait for remote sharing status', async () => {
  const app = setup(), page = app.open('editor'); fillRecipe(page);
  app.hooks.mine = () => new Promise(() => {});
  await page.save();
  assert.equal(page.data.sharePromptVisible, true);
  assert.deepEqual(app.calls.mine, []);
  assert.deepEqual(app.calls.timerDelays, []);
});

test('already shared recipes skip the first-publication invitation after either save moment', async () => {
  for (const name of ['editor', 'record-editor']) {
    const app = setup(), {id, page} = existingOwnSave(app, name);
    app.hooks.mine = () => ({published: [{sourceRecipeId: id}]});
    await page.save();
    assert.equal(page.data.savedComplete, true);
    assert.equal(page.data.sharePromptVisible, false);
    assert.deepEqual(app.calls.mine, [{force: true}]);
    assert.equal(app.calls.back, 1);
    assert.equal(app.pendingTimers(), 0);
    assert.equal(page.data.error, '');
    if (name === 'editor') assert.equal(app.store.getRecipe(id).name, '修改后的菜谱');
    else assert.equal(app.store.getState().logs[0].rating, 3);
  }
});

test('existing unshared own recipes receive the invitation after a fresh successful status check', async () => {
  const app = setup(), {page} = existingOwnSave(app, 'editor');
  app.hooks.mine = () => ({published: [{sourceRecipeId: 'some-other-recipe'}]});
  await page.save();
  assert.equal(page.data.sharePromptVisible, true);
  assert.equal(page.data.sharePromptMessage, '已收进你的食谱，也分享给其他家长吧');
  assert.deepEqual(app.calls.mine, [{force: true}]);
  assert.equal(app.calls.back, 0);
  assert.equal(app.pendingTimers(), 0);
});

test('offline, failed or malformed optional status checks never turn a successful save into an error or invitation', async () => {
  for (const response of [undefined, null, {}, {published: null}, {published: [{}]}, {published: [{sourceRecipeId: ''}]}]) {
    const app = setup(), {id, page} = existingOwnSave(app, 'editor');
    app.hooks.mine = () => { if (response === undefined) throw Error('network offline'); return response; };
    await page.save();
    assert.equal(app.store.getRecipe(id).name, '修改后的菜谱');
    assert.equal(page.data.savedComplete, true);
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(page.data.error, '');
    assert.equal(app.calls.back, 1);
    assert.equal(app.returnWarning(), false);
    assert.equal(app.pendingTimers(), 0);
  }
});

test('sharing-status timeout leaves after 1200 ms and ignores a late unshared response', async () => {
  for (const name of ['editor', 'record-editor']) {
    const app = setup(), {id, page} = existingOwnSave(app, name), gate = deferredResult();
    app.hooks.mine = () => gate.promise;
    const save = page.save(); await nextTurn();
    assert.equal(page.data.savedComplete, true);
    assert.equal(page.data.saving, false);
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 0);
    assert.deepEqual(app.calls.timerDelays, [1200]);
    const writes = app.calls.writes; await page.save(); assert.equal(app.calls.writes, writes);
    app.runPromptTimers(); await save;
    assert.equal(app.calls.back, 1);
    assert.equal(app.pendingTimers(), 0);
    gate.resolve({published: []}); await nextTurn();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 1);
    assert.deepEqual(app.calls.redirects, []);
    assert.ok(app.store.getRecipe(id));
  }
});

test('a late failed status response after timeout is ignored without losing a saved meal', async () => {
  const app = setup(), {page} = existingOwnSave(app, 'record-editor'), gate = deferredResult();
  app.hooks.mine = () => gate.promise;
  const save = page.save(); await nextTurn(); app.runPromptTimers(); await save;
  gate.reject(Error('late network failure')); await nextTurn();
  assert.equal(page.data.error, '');
  assert.equal(page.data.sharePromptVisible, false);
  assert.equal(app.store.getState().logs[0].rating, 3);
  assert.equal(app.calls.back, 1);
});

test('account changes and page unload cancel the optional check without late prompts or navigation', async () => {
  for (const mode of ['account', 'unload']) {
    const app = setup(), owner = 'a'.repeat(64), other = 'b'.repeat(64), gate = deferredResult();
    app.store.bindAccount(owner);
    const {id, page} = existingOwnSave(app, 'editor');
    app.hooks.mine = () => gate.promise;
    const save = page.save(); await nextTurn();
    if (mode === 'account') { app.store.bindAccount(other); app.store.bindAccount(owner); }
    else page.onUnload();
    await save;
    assert.equal(app.pendingTimers(), 0);
    gate.resolve({published: []}); await nextTurn();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 0);
    assert.deepEqual(app.calls.redirects, []);
    assert.equal(app.store.getRecipe(id).name, '修改后的菜谱');
  }
});

test('back while optional sharing status is pending cancels it before the native unload event', async () => {
  for (const name of ['editor', 'record-editor']) {
    const app = setup(), {page} = existingOwnSave(app, name), gate = deferredResult();
    app.hooks.mine = () => gate.promise;
    const save = page.save(); await nextTurn();
    if (name === 'editor') page.cancel(); else page.back();
    await save;
    assert.equal(app.calls.back, 1);
    assert.equal(app.pendingTimers(), 0);
    assert.equal(page.data.discardVisible, false);
    gate.resolve({published: []}); await nextTurn();
    assert.equal(page.data.sharePromptVisible, false);
    assert.equal(app.calls.back, 1);
  }
});
