'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const root = path.resolve(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZS0AAAAASUVORK5CYII=', 'base64');
const photoUri = 'data:image/png;base64,' + png.toString('base64');

function setup(initial) {
  let saved = clone(initial);
  let failStorage = false;
  let failWriteAt = 0;
  const files = new Map();
  const writes = [];
  const removed = [];
  const wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync() { return clone(saved); },
    setStorageSync(key, data) { if (failStorage) throw Error('Quota exceeded'); saved = clone(data); },
    getFileSystemManager() {
      return {
        readFile({filePath, encoding, success, fail}) {
          if (!files.has(filePath)) { fail({errMsg: 'file not found'}); return; }
          success({data: files.get(filePath).toString(encoding)});
        },
        writeFile({filePath, data, encoding, success, fail}) {
          writes.push(filePath);
          files.set(filePath, Buffer.from(data, encoding));
          if (writes.length === failWriteAt) { fail({errMsg: 'partial write failure'}); return; }
          success({});
        },
        unlink({filePath, success}) { removed.push(filePath); files.delete(filePath); success({}); }
      };
    },
    showToast() {}
  };
  global.wx = wx;
  const storePath = require.resolve('../utils/store');
  const backupPath = require.resolve('../utils/backup');
  delete require.cache[storePath];
  delete require.cache[backupPath];
  const store = require(storePath);
  const backup = require(backupPath);
  return {wx, store, backup, files, writes, removed, saved: () => clone(saved),
    failStorage() { failStorage = true; }, failWrite(number) { failWriteAt = number; }};
}

function imageBackup(app, count = 1) {
  const data = app.store.getState();
  for (let i = 0; i < count; i += 1) {
    data.recipes[i].photo = photoUri;
    data.recipes[i].updatedAt = 100;
  }
  return data;
}

function settingsPage(app) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/settings/index.js'), 'utf8'), {
    require(name) { return require(path.resolve(root, 'pages/settings', name)); },
    Page(value) { definition = value; }, wx: app.wx, Promise, String, Error
  });
  const page = Object.assign({}, definition, {data: clone(definition.data)});
  page.setData = fields => Object.assign(page.data, fields);
  return page;
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('photo backup detects content type without an extension and restores on another device', async () => {
  const app = setup();
  const recipe = app.store.getState().recipes[0];
  recipe.photo = 'wxfile://store_photo_without_extension';
  app.store.saveRecipe(recipe);
  app.files.set(recipe.photo, png);
  const text = await app.backup.exportText();
  const exported = JSON.parse(text);
  assert.equal(exported.recipes[0].photo, photoUri);
  assert.equal(app.store.getRecipe(recipe.id).photo, recipe.photo, 'Export must not replace persistent paths with base64 in storage.');
  const otherDevice = setup();
  await otherDevice.backup.importText(text);
  const restored = otherDevice.store.getRecipe(recipe.id);
  assert.match(restored.photo, /^wxfile:\/\/usr\/import-.*\.png$/);
  assert.deepEqual(otherDevice.files.get(restored.photo), png);
});

test('storage failure removes newly imported photos and preserves current files and records', async () => {
  const app = setup();
  const local = app.store.getState().recipes[0];
  local.photo = 'wxfile://usr/original.png';
  app.store.saveRecipe(local);
  app.files.set(local.photo, png);
  const before = app.store.getState();
  const data = imageBackup(app, 2);
  data.recipes.forEach(item => { item.updatedAt = Date.now() + 100; });
  app.failStorage();
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /保存失败/);
  assert.deepEqual(app.store.getState(), before);
  assert.deepEqual(app.saved(), before);
  assert.deepEqual([...app.files.keys()], [local.photo]);
  assert.equal(app.removed.length, 2);
});

test('partial filesystem writes are tracked and removed before any records are committed', async () => {
  const app = setup();
  const before = app.store.getState();
  app.failWrite(2);
  await assert.rejects(app.backup.importText(JSON.stringify(imageBackup(app, 2))));
  assert.equal(app.writes.length, 2);
  assert.equal(app.files.size, 0);
  assert.deepEqual(new Set(app.removed), new Set(app.writes));
  assert.deepEqual(app.store.getState(), before);
  assert.equal(app.saved(), undefined);
});

test('invalid recipe data rolls back imported photos as well as records', async () => {
  const app = setup();
  const before = app.store.getState();
  const data = imageBackup(app);
  data.recipes[0].name = '';
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /菜谱信息/);
  assert.equal(app.files.size, 0);
  assert.deepEqual(app.store.getState(), before);
});

test('stale photo imports are cleaned up and replacing a photo removes only the unused old file', async () => {
  const app = setup();
  const local = app.store.getState().recipes[0];
  local.photo = 'wxfile://usr/current.png';
  app.store.saveRecipe(local);
  app.files.set(local.photo, png);
  const stale = imageBackup(app);
  await app.backup.importText(JSON.stringify(stale));
  assert.equal(app.store.getRecipe(local.id).photo, local.photo);
  assert.deepEqual([...app.files.keys()], [local.photo]);
  const newer = imageBackup(app);
  newer.recipes[0].updatedAt = Date.now() + 100;
  await app.backup.importText(JSON.stringify(newer));
  const path = app.store.getRecipe(local.id).photo;
  assert.notEqual(path, local.photo);
  assert.deepEqual([...app.files.keys()], [path]);
});

test('all photos are preflighted, including exact decoded-size and base64 padding checks', async () => {
  const app = setup();
  const data = imageBackup(app, 2);
  data.recipes[1].photo = 'data:image/png;base64,AAAAA';
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /编码不完整/);
  assert.equal(app.writes.length, 0);
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
  png.copy(oversized);
  data.recipes[1].photo = 'data:image/png;base64,' + oversized.toString('base64');
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /超过 2 MB/);
  assert.equal(app.writes.length, 0);
  data.recipes[1].photo = 'wxfile://usr/file-from-another-device.png';
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /可迁移/);
  assert.equal(app.writes.length, 0);
});

test('failed export removes a partially written backup and missing photos report their recipe', async () => {
  const app = setup();
  app.failWrite(1);
  await assert.rejects(app.backup.exportFile(), /写入失败/);
  assert.equal(app.files.size, 0);
  const local = app.store.getState().recipes[0];
  local.photo = 'wxfile://usr/missing.png';
  app.store.saveRecipe(local);
  await assert.rejects(app.backup.exportText(), new RegExp(local.name));
});

test('file selection holds busy throughout selection and immediate confirmation still imports once', async () => {
  const app = setup();
  const data = app.store.getState();
  data.nickname = '文件导入的小豆';
  data.profileUpdatedAt = 100;
  app.files.set('/chat/backup.json', Buffer.from(JSON.stringify(data)));
  let picker;
  let pickCount = 0;
  app.wx.chooseMessageFile = options => { picker = options; pickCount += 1; };
  app.wx.showModal = options => options.success({confirm: true});
  const page = settingsPage(app);
  const pending = page.chooseBackup();
  assert.equal(page.data.busy, true);
  await page.chooseBackup();
  assert.equal(pickCount, 1);
  picker.success({tempFiles: [{path: '/chat/backup.json', size: 1000}]});
  await pending;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.error, '');
  assert.equal(app.store.getState().nickname, '文件导入的小豆');
  assert.equal(page.data.backupText, '');
});

test('confirmation uses its captured backup and cancellation neither writes nor leaves busy set', async () => {
  const app = setup();
  let modal;
  app.wx.showModal = options => { modal = options; };
  const data = app.store.getState();
  data.nickname = '确认时的内容';
  data.profileUpdatedAt = 100;
  const page = settingsPage(app);
  page.setData({backupText: JSON.stringify(data)});
  let pending = page.confirmImport();
  assert.equal(page.data.busy, true);
  page.inputBackup({detail: {value: '{}'}});
  assert.notEqual(page.data.backupText, '{}');
  page.setData({backupText: '{}'});
  modal.success({confirm: true});
  await pending;
  assert.equal(app.store.getState().nickname, '确认时的内容');
  const before = app.saved();
  page.setData({backupText: JSON.stringify(data)});
  pending = page.confirmImport();
  modal.success({confirm: false});
  await pending;
  assert.equal(page.data.busy, false);
  assert.deepEqual(app.saved(), before);
});

test('clipboard callbacks keep the operation locked and shared backup files are removed afterwards', async () => {
  const app = setup();
  let clipboard;
  app.wx.setClipboardData = options => { clipboard = options; };
  const page = settingsPage(app);
  const pending = page.copyBackup();
  await turn();
  assert.ok(clipboard);
  assert.equal(page.data.busy, true);
  clipboard.fail({errMsg: 'Clipboard unavailable'});
  await pending;
  assert.equal(page.data.busy, false);
  assert.match(page.data.error, /复制失败/);
  let sharedPath;
  app.wx.shareFileMessage = options => { sharedPath = options.filePath; options.success({}); };
  await page.exportBackup();
  assert.ok(sharedPath);
  assert.equal(app.files.has(sharedPath), false);
  assert.ok(app.removed.includes(sharedPath));
  assert.equal(page.data.busy, false);
});
