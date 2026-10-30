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

function setup() {
  const storage = new Map();
  let failWrites = false;
  let returnWarning = false;
  let duringDelete;
  const calls = { deletes: 0, backs: 0, writes: 0, errors: [], toasts: [] };
  const wx = {
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) {
      if (failWrites) throw new Error('Quota exceeded');
      storage.set(key, copy(value)); calls.writes += 1;
    },
    setNavigationBarTitle() {},
    enableAlertBeforeUnload() { returnWarning = true; },
    disableAlertBeforeUnload(options) { returnWarning = false; if (options.complete) options.complete(); },
    showToast(options) { calls.toasts.push(options.title); }
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
  const deleteLog = store.deleteLog;
  store.deleteLog = id => {
    calls.deletes += 1;
    if (duringDelete) duringDelete();
    return deleteLog(id);
  };
  const recipeId = store.getState().recipes[0].id;
  const logId = store.addLog({ recipeId, rating: 2, date: '2020-01-01', portion: '光盘啦', note: '原备注' });
  const otherLogId = store.addLog({ recipeId, rating: 3, date: '2020-01-02', note: '' });
  function open(options = { logId }) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/record-editor/index.js'), 'utf8'), {
      wx, Page(value) { definition = value; },
      require(name) {
        if (name === '../../utils/store') return store;
        if (name === '../../utils/selectors') return selectors;
        if (name === '../../utils/ui') return {
          back() { assert.equal(returnWarning, false); calls.backs += 1; },
          error(error) { calls.errors.push(error.message); }
        };
        throw new Error('Unexpected page dependency: ' + name);
      }
    });
    const page = { ...definition, data: copy(definition.data), setData(changes) { Object.assign(this.data, copy(changes)); } };
    page.onLoad(options);
    return page;
  }
  return {
    store, calls, recipeId, logId, otherLogId, open,
    returnWarning: () => returnWarning,
    failWrites() { failWrites = true; }, allowWrites() { failWrites = false; },
    onDelete(callback) { duringDelete = callback; }
  };
}

const valueEvent = value => ({ detail: { value } });

test('new and missing meal forms cannot request or confirm deletion', () => {
  const app = setup();
  for (const options of [{ id: app.recipeId }, { logId: 'missing' }]) {
    const page = app.open(options);
    page.deleteLog();
    page.confirmDelete();
    assert.equal(page.data.deleteVisible, false);
  }
  assert.equal(app.calls.deletes, 0);
  assert.equal(app.calls.backs, 0);
  assert.equal(app.store.getState().logs.length, 2);
});

test('canceling deletion preserves unsaved fields and the existing return warning', () => {
  const app = setup();
  const page = app.open();
  page.note(valueEvent('尚未保存的备注'));
  page.changeDate(valueEvent('2020-01-03'));
  const draft = page.draftSnapshot();
  page.deleteLog();
  assert.equal(page.data.deleteVisible, true);
  assert.match(page.data.deleteContent, /2020-01-01/);
  assert.match(page.data.deleteContent, /未保存的修改也会丢弃/);
  page.cancelDelete();
  page.confirmDelete();
  assert.equal(page.data.deleteVisible, false);
  assert.equal(page.draftSnapshot(), draft);
  assert.equal(app.returnWarning(), true);
  assert.equal(app.calls.deletes, 0);
  assert.equal(app.calls.backs, 0);
  assert.equal(app.store.getLog(app.logId).note, '原备注');
});

test('confirmed deletion removes only the saved meal and leaves with no second discard prompt', () => {
  const app = setup();
  const recipes = copy(app.store.getState().recipes);
  const page = app.open();
  page.note(valueEvent('将被丢弃的草稿'));
  page.deleteLog();
  page.confirmDelete();
  page.confirmDelete();
  page.save();
  page.back();
  assert.equal(app.calls.deletes, 1);
  assert.equal(app.store.getLog(app.logId), null);
  assert.equal(app.store.getLog(app.otherLogId).id, app.otherLogId);
  assert.deepEqual(copy(app.store.getState().recipes), recipes);
  assert.equal(app.returnWarning(), false);
  assert.equal(page.data.discardVisible, false);
  assert.equal(app.calls.backs, 1);
  assert.deepEqual(app.calls.toasts, ['记录已删除']);
});

test('storage failure keeps the saved meal, editable draft, and return warning, and permits retry', () => {
  const app = setup();
  const page = app.open();
  page.note(valueEvent('失败后仍保留'));
  const before = copy(app.store.getState());
  app.failWrites();
  page.deleteLog();
  page.confirmDelete();
  assert.equal(page.data.deleting, false);
  assert.equal(page.data.deleteVisible, false);
  assert.equal(page.data.note, '失败后仍保留');
  assert.equal(app.returnWarning(), true);
  assert.equal(app.calls.backs, 0);
  assert.equal(app.calls.errors.length, 1);
  assert.deepEqual(copy(app.store.getState()), before);
  page.note(valueEvent('继续编辑'));
  app.allowWrites();
  page.deleteLog();
  page.confirmDelete();
  assert.equal(app.store.getLog(app.logId), null);
  assert.equal(app.calls.backs, 1);
});

test('save, edits, navigation, and repeated deletion are blocked during confirmation and deletion', () => {
  const app = setup();
  const page = app.open();
  page.deleteLog();
  const draft = page.draftSnapshot();
  page.save(); page.back(); page.note(valueEvent('不能修改')); page.rate(valueEvent(1));
  assert.equal(page.draftSnapshot(), draft);
  assert.equal(app.calls.backs, 0);
  app.onDelete(() => {
    assert.equal(page.data.deleting, true);
    page.deleteLog(); page.confirmDelete(); page.cancelDelete();
    page.save(); page.back(); page.discard(); page.portion(valueEvent(1)); page.openDate();
    assert.equal(page.draftSnapshot(), draft);
    assert.equal(page.data.dateVisible, false);
    assert.equal(app.calls.backs, 0);
  });
  page.confirmDelete();
  assert.equal(app.calls.deletes, 1);
  assert.equal(app.calls.backs, 1);
});

test('saving or a pending discard confirmation cannot open a competing deletion dialog', () => {
  const app = setup();
  const page = app.open();
  page.setData({ saving: true });
  page.deleteLog();
  assert.equal(page.data.deleteVisible, false);
  page.setData({ saving: false });
  page.note(valueEvent('需要确认放弃'));
  page.back();
  assert.equal(page.data.discardVisible, true);
  page.deleteLog();
  assert.equal(page.data.deleteVisible, false);
  assert.equal(app.calls.deletes, 0);
});
