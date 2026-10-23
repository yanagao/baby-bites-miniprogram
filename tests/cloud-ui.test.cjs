'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(__dirname, '..');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const requireStore = createRequire(path.join(root, 'utils/store.js'));
const selectors = require('../utils/selectors');
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function recipe(id, overrides = {}) {
  return Object.assign({id, name: '南瓜小米粥', category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
    ingredients: [{name: '南瓜', amount: '50 克'}], steps: ['蒸熟后煮粥。'], note: '', photo: '', imageKey: '',
    favorite: false, isExample: false, createdAt: 1, updatedAt: 1}, overrides);
}
function setup(options = {}) {
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '宝宝', profileUpdatedAt: 1,
    recipes: [recipe('one'), recipe('two', {name: '土豆泥', category: '蔬菜手抓'})], logs: []}]]);
  const calls = {start: 0, sync: 0, toasts: [], errors: [], updates: [], previews: []};
  const syncListeners = new Set();
  let syncStatus = {state: 'unconfigured', message: '云同步尚未配置', lastSyncedAt: 0, owner: ''};
  let currentPages = [];
  const wx = {
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, copy(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    showToast(options) { calls.toasts.push(options.title); },
    setNavigationBarTitle() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
    previewImage(options) { calls.previews.push(copy(options)); }
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/store.js'), 'utf8'), {
    module: storeModule, require: requireStore, wx
  });
  const store = storeModule.exports;
  if (!options.unbound) store.bindAccount(OWNER);
  const backup = {removeFile: () => Promise.resolve(), importText: async (text, guard) => {
    if (guard) guard();
    return store.importBackup(text);
  }};
  const cloudSync = {
    subscribe(callback) { syncListeners.add(callback); return () => syncListeners.delete(callback); },
    getStatus() { return copy(syncStatus); },
    start() { calls.start += 1; return Promise.resolve(copy(syncStatus)); },
    syncNow() { calls.sync += 1; return Promise.resolve(copy(syncStatus)); }
  };
  let app;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
    App(value) { app = value; }, wx, console, getCurrentPages() { return currentPages; },
    require(name) {
      if (name === './utils/store') return store;
      if (name === './utils/cloud-sync') return cloudSync;
      if (name === './assets/fonts/pocket-brush') return {};
      if (name === './utils/tdesign-font') return {loadTDesignIcons: () => Promise.resolve('available')};
      throw Error('Unexpected app require: ' + name);
    }
  });
  app.onLaunch();
  function open(name, options = {}) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
      Page(value) { definition = value; }, wx, getApp() { return app; },
      require(dependency) {
        if (dependency === '../../utils/store') return store;
        if (dependency === '../../utils/cloud-sync') return cloudSync;
        if (dependency === '../../config/cloud') return {socialEnabled: true};
        if (dependency === '../../utils/social') return {getMine: async () => ({profile: {exists: false}, published: []})};
        if (dependency === '../../utils/selectors') return selectors;
        if (dependency === '../../utils/tab-bar') return {syncTabBar() {}};
        if (dependency === '../../utils/backup') return backup;
        if (dependency === '../../utils/ui') return {error(error) { calls.errors.push(error.message); }, back() {}};
        throw Error('Unexpected page require: ' + dependency);
      }
    });
    const page = Object.assign({}, definition, {route: 'pages/' + name + '/index', data: copy(definition.data),
      setData(changes) {
        calls.updates.push({page: name, changes: copy(changes)});
        for (const [key, value] of Object.entries(changes)) {
          const parts = key.split('.');
          let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part];
          target[parts[parts.length - 1]] = copy(value);
        }
      }});
    currentPages = [page];
    if (page.onLoad) page.onLoad(options);
    if (page.onShow) page.onShow();
    return page;
  }
  function remoteUpdate(change) {
    const info = store.getSyncInfo();
    const incoming = store.getSyncSnapshot();
    change(incoming.data, incoming.deleted);
    store.applySyncedSnapshot(incoming, {owner: OWNER, sequence: info.sequence, revision: info.revision + 1});
  }
  function publish(status) {
    syncStatus = Object.assign({}, syncStatus, status);
    syncListeners.forEach(listener => listener(copy(syncStatus)));
  }
  return {app, store, open, calls, remoteUpdate, publish, syncListeners, wx, backup,
    show(page) { currentPages = page ? [page] : []; }};
}

test('background sync preserves the unsaved nickname while refreshing settings counts and status', () => {
  const fixture = setup();
  const page = fixture.open('settings');
  page.nickname({detail: {value: '正在输入的称呼'}});
  fixture.remoteUpdate(data => {
    data.nickname = '另一台设备的称呼'; data.profileUpdatedAt = 10;
    data.recipes.push(recipe('remote'));
  });
  fixture.publish({state: 'synced', message: '已同步当前微信账号', lastSyncedAt: 1000});
  assert.equal(page.data.nickname, '正在输入的称呼');
  assert.equal(fixture.store.getState().nickname, '另一台设备的称呼');
  assert.equal(page.data.counts.recipeCount, 3);
  assert.equal(page.data.syncTitle, '已同步');
  page.onShow();
  assert.equal(page.data.nickname, '正在输入的称呼');
  page.saveNickname();
  assert.equal(fixture.store.getState().nickname, '正在输入的称呼');
  assert.equal(page._nicknameDirty, false);
});

test('settings without a nickname draft follows cloud profile updates and unsubscribes on unload', () => {
  const fixture = setup();
  const page = fixture.open('settings');
  fixture.remoteUpdate(data => { data.nickname = '云端称呼'; data.profileUpdatedAt = 5; });
  assert.equal(page.data.nickname, '云端称呼');
  page.onUnload();
  const updates = fixture.calls.updates.length;
  fixture.publish({state: 'syncing'});
  fixture.remoteUpdate(data => { data.nickname = '更新后的称呼'; data.profileUpdatedAt = 6; });
  assert.equal(fixture.calls.updates.length, updates);
  assert.equal(fixture.syncListeners.size, 0);
});

test('pending, error, syncing and unconfigured states never claim current data is saved in the cloud', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  fixture.publish({state: 'synced', message: '已同步当前微信账号', lastSyncedAt: 1000});
  assert.match(page.data.storageDescription, /^已保存到当前微信账号/);
  for (const state of ['pending', 'error', 'syncing', 'unconfigured']) {
    fixture.publish({state, message: '当前未同步'});
    assert.notEqual(page.data.syncTitle, '已同步');
    assert.doesNotMatch(page.data.storageDescription, /^已保存到当前微信账号/);
    assert.equal(page.data.syncMessage, '当前未同步');
    assert.match(page.data.syncTime, /^上次同步/);
  }
  await page.syncNow();
  assert.equal(fixture.calls.sync, 1);
  assert.equal(page.data.syncState, 'unconfigured', 'a button tap alone must not claim success');
});

test('background sync never reloads an unsaved recipe or meal-record form', () => {
  for (const name of ['editor', 'record-editor']) {
    const fixture = setup();
    const page = fixture.open(name, {id: 'one'});
    if (name === 'editor') page.input({currentTarget: {dataset: {field: 'name'}}, detail: {value: '尚未保存的菜名'}});
    else { page.rate({detail: {value: 3}}); page.note({detail: {value: '尚未保存的用餐笔记'}}); }
    const draft = page.draftSnapshot();
    fixture.remoteUpdate(data => {
      data.recipes[0].name = '云端更新后的菜名'; data.recipes[0].updatedAt = 10;
    });
    assert.equal(page.draftSnapshot(), draft);
    assert.equal(fixture.store.getRecipe('one').name, '云端更新后的菜名');
    fixture.app.onShow();
    assert.equal(page.draftSnapshot(), draft);
  }
});

test('visible recipe lists refresh after sync without losing search or filter selections', () => {
  const fixture = setup();
  const page = fixture.open('recipes');
  page.searchInput({detail: {value: '南瓜'}});
  page.chooseCategory({detail: {value: '粥饭主食'}});
  fixture.remoteUpdate(data => { data.recipes.push(recipe('remote', {name: '南瓜鸡肉粥', createdAt: 10})); });
  assert.equal(page.data.search, '南瓜');
  assert.equal(page.data.category, '粥饭主食');
  assert.deepEqual(page.data.recipes.map(item => item.id), ['remote', 'one']);
  assert.deepEqual(fixture.calls.errors, []);
});

test('home refresh keeps the chosen dish and reflects synchronized nickname and recipe changes', () => {
  const fixture = setup();
  const page = fixture.open('home');
  const selected = page.data.result.id;
  fixture.remoteUpdate(data => {
    data.nickname = '小麦'; data.profileUpdatedAt = 10;
    const chosen = data.recipes.find(item => item.id === selected);
    chosen.name = '更新后的做法'; chosen.updatedAt = 10;
  });
  assert.equal(page.data.result.id, selected);
  assert.equal(page.data.result.name, '更新后的做法');
  assert.equal(page.data.nickname, '小麦');
  assert.deepEqual(fixture.calls.errors, []);
});

test('a synchronized recipe deletion clears the visible detail without navigating away', () => {
  const fixture = setup();
  const page = fixture.open('detail', {id: 'one'});
  assert.equal(page.data.recipe.id, 'one');
  fixture.remoteUpdate((data, deleted) => {
    data.recipes = data.recipes.filter(item => item.id !== 'one');
    deleted.recipes.push({id: 'one', updatedAt: 20});
  });
  assert.equal(page.data.recipe, null);
  assert.deepEqual(fixture.calls.errors, []);
});

test('foreground starts sync only when there is no active synchronization', () => {
  const fixture = setup();
  assert.equal(fixture.calls.start, 1);
  fixture.publish({state: 'syncing'});
  fixture.app.onShow();
  assert.equal(fixture.calls.sync, 0);
  fixture.publish({state: 'pending'});
  fixture.app.onShow();
  assert.equal(fixture.calls.sync, 1);
  fixture.show(null);
  fixture.remoteUpdate(data => { data.nickname = '无需页面也可同步'; data.profileUpdatedAt = 10; });
  assert.deepEqual(fixture.calls.errors, []);
});

test('cloud photo file IDs reach detail and editor preview APIs without being mistaken for local paths', () => {
  const fixture = setup();
  const photo = 'cloud://cloud1-test.bucket/users/' + OWNER + '/photos/food.png';
  fixture.remoteUpdate(data => { data.recipes[0].photo = photo; data.recipes[0].updatedAt = 10; });
  const detail = fixture.open('detail', {id: 'one'});
  assert.equal(detail.data.recipe.photoSrc, photo);
  detail.previewPhoto();
  const editor = fixture.open('editor', {id: 'one'});
  assert.equal(editor.data.photo, photo);
  editor.previewPhoto();
  assert.deepEqual(fixture.calls.previews, [{current: photo, urls: [photo]}, {current: photo, urls: [photo]}]);
});

function fillNewRecipe(page) {
  for (const [field, value] of Object.entries({name: '未保存的新菜', minutes: '20', ingredients: '南瓜 50 克', steps: '蒸熟后煮粥。'})) {
    page.input({currentTarget: {dataset: {field}}, detail: {value}});
  }
}

test('a nickname draft from account A cannot be saved into account B', () => {
  const fixture = setup();
  const page = fixture.open('settings');
  page.nickname({detail: {value: '账号 A 的草稿'}});
  fixture.store.bindAccount(OTHER);
  const before = copy(fixture.store.getState());
  page.saveNickname();
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(fixture.calls.errors.at(-1), /账号已切换.*重新打开/);
  assert.equal(page.data.nickname, '账号 A 的草稿');
  assert.equal(page._nicknameDirty, true);
});

test('first null-to-A binding permits a nickname draft, but a later A-to-B switch is still locked', () => {
  const fixture = setup({unbound: true});
  const page = fixture.open('settings');
  page.nickname({detail: {value: '首次绑定前输入'}});
  fixture.store.bindAccount(OWNER);
  page.saveNickname();
  assert.equal(fixture.store.getState().nickname, '首次绑定前输入');
  page.nickname({detail: {value: '再次输入'}});
  fixture.store.bindAccount(OTHER);
  page.saveNickname();
  assert.equal(fixture.store.getState().nickname, '宝宝');
  assert.match(fixture.calls.errors.at(-1), /账号已切换/);
});

test('new and existing recipe drafts cannot write after account A switches to B', async () => {
  for (const options of [{}, {id: 'one'}]) {
    const fixture = setup();
    const page = fixture.open('editor', options);
    fillNewRecipe(page);
    const draft = page.draftSnapshot();
    fixture.store.bindAccount(OTHER);
    const before = copy(fixture.store.getState());
    await page.save();
    assert.deepEqual(copy(fixture.store.getState()), before);
    assert.equal(page.draftSnapshot(), draft);
    assert.match(page.data.error, /账号已切换.*重新打开/);
  }
});

test('a recipe draft follows the first account binding but not a second account binding', async () => {
  const allowed = setup({unbound: true});
  const first = allowed.open('editor');
  fillNewRecipe(first);
  allowed.store.bindAccount(OWNER);
  await first.save();
  assert.ok(allowed.store.getState().recipes.some(item => item.name === '未保存的新菜'));
  const blocked = setup({unbound: true});
  const second = blocked.open('editor');
  fillNewRecipe(second);
  blocked.store.bindAccount(OWNER);
  blocked.store.bindAccount(OTHER);
  await second.save();
  assert.match(second.data.error, /账号已切换/);
  assert.ok(!blocked.store.getState().recipes.some(item => item.name === '未保存的新菜'));
});

test('switching accounts while saving a selected photo aborts recipe commit and keeps the draft recoverable', async () => {
  const fixture = setup();
  const page = fixture.open('editor');
  fillNewRecipe(page);
  page.pendingPhoto = 'wxfile://tmp/selected.jpg';
  page.setData({photo: page.pendingPhoto});
  let completeSave;
  const unlinked = [];
  fixture.wx.getFileSystemManager = () => ({saveFile(options) { completeSave = options.success; },
    unlink(options) { unlinked.push(options.filePath); }});
  const saving = page.save();
  fixture.store.bindAccount(OTHER);
  const before = copy(fixture.store.getState());
  completeSave({savedFilePath: 'wxfile://usr/staged-photo.jpg'});
  await saving;
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(page.data.error, /账号已切换/);
  assert.equal(page.data.form.name, '未保存的新菜');
  assert.equal(page.data.photo, 'wxfile://usr/staged-photo.jpg');
  page.onUnload();
  assert.deepEqual(unlinked, ['wxfile://usr/staged-photo.jpg']);
});

test('meal save and deletion confirmations cannot mutate another account with matching record IDs', () => {
  const fixture = setup();
  const logId = fixture.store.addLog({recipeId: 'one', rating: 2, date: '2024-01-01', note: '原来的记录'});
  const firstState = fixture.store.exportBackup();
  const page = fixture.open('record-editor', {logId});
  page.note({detail: {value: '尚未保存的新记录'}});
  page.deleteLog();
  fixture.store.bindAccount(OTHER);
  fixture.store.importBackup(firstState);
  const before = copy(fixture.store.getState());
  page.confirmDelete();
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(fixture.calls.errors.at(-1), /账号已切换/);
  page.save();
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(page.data.error, /账号已切换/);
});

test('an unbound meal draft can be saved after the first account binding', () => {
  const fixture = setup({unbound: true});
  const page = fixture.open('record-editor', {id: 'one'});
  page.rate({detail: {value: 3}});
  page.changeDate({detail: {value: '2024-01-01'}});
  fixture.store.bindAccount(OWNER);
  page.save();
  assert.equal(fixture.store.getState().logs.length, 1);
  assert.equal(fixture.store.getState().logs[0].rating, 3);
});

test('a backup confirmation opened by A cannot import after switching to B', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  page.inputBackup({detail: {value: fixture.store.exportBackup()}});
  const importing = page.confirmImport();
  assert.equal(page.data.importVisible, true);
  fixture.store.bindAccount(OTHER);
  const before = copy(fixture.store.getState());
  page.confirmImportDialog();
  await importing;
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(page.data.error, /账号已切换/);
  assert.equal(page.data.busy, false);
  assert.ok(page.data.backupText);
});

test('settings passes a guard that rejects account switches during asynchronous backup decoding', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  page.inputBackup({detail: {value: fixture.store.exportBackup()}});
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let guardReceived = false;
  fixture.backup.importText = async (text, guard) => {
    assert.equal(typeof guard, 'function');
    guard(); guardReceived = true;
    await waiting;
    guard();
    fixture.store.importBackup(text);
  };
  const importing = page.confirmImport();
  page.confirmImportDialog();
  await Promise.resolve();
  assert.equal(guardReceived, true);
  fixture.store.bindAccount(OTHER);
  const before = copy(fixture.store.getState());
  release();
  await importing;
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.match(page.data.error, /账号已切换/);
  assert.ok(!fixture.calls.toasts.includes('已合并导入'));
});

test('account changes during the system file picker reject the chosen backup before opening confirmation', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  let selected;
  fixture.wx.chooseMessageFile = options => { selected = options.success; };
  const choosing = page.chooseBackup();
  fixture.store.bindAccount(OTHER);
  selected({tempFiles: [{path: 'wxfile://tmp/backup.json', size: 100}]});
  await choosing;
  assert.equal(page.data.importVisible, false);
  assert.equal(page.data.busy, false);
  assert.match(page.data.error, /账号已切换/);
});

test('leaving settings cancels a pending backup confirmation and never imports afterwards', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  page.inputBackup({detail: {value: fixture.store.exportBackup()}});
  const before = copy(fixture.store.getState());
  const importing = page.confirmImport();
  page.onUnload();
  const updates = fixture.calls.updates.length;
  await importing;
  assert.deepEqual(copy(fixture.store.getState()), before);
  assert.equal(fixture.calls.updates.length, updates);
  assert.equal(page.resolveImportConfirmation, null);
});

test('a prepared export cannot be shared by a newly active account', async () => {
  const fixture = setup();
  const page = fixture.open('settings');
  const removed = [];
  fixture.wx.shareFileMessage = () => { assert.fail('sharing an old account export is forbidden'); };
  fixture.backup.exportFile = async () => 'wxfile://usr/prepared-backup.json';
  fixture.backup.removeFile = async filePath => { removed.push(filePath); };
  await page.exportBackup();
  assert.equal(page.data.exportVisible, true);
  fixture.store.bindAccount(OTHER);
  await page.confirmExportDialog();
  assert.equal(page.data.exportVisible, false);
  assert.match(page.data.error, /账号已切换/);
  assert.deepEqual(removed, ['wxfile://usr/prepared-backup.json']);
});
