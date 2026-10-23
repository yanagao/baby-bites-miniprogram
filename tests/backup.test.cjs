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
  const storage = new Map([['baby-bites-v1', clone(initial)]]);
  let failStorage = false;
  let failWriteAt = 0;
  const files = new Map();
  const writes = [];
  const removed = [];
  const wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync(key) { return clone(storage.get(key)); },
    setStorageSync(key, data) { if (failStorage) throw Error('Quota exceeded'); storage.set(key, clone(data)); },
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
  return {wx, store, backup, files, writes, removed, saved: () => clone(storage.get('baby-bites-v1')),
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
  const savedBefore = app.saved();
  const data = imageBackup(app, 2);
  data.recipes.forEach(item => { item.updatedAt = Date.now() + 100; });
  app.failStorage();
  await assert.rejects(app.backup.importText(JSON.stringify(data)), /保存失败/);
  assert.deepEqual(app.store.getState(), before);
  assert.deepEqual(app.saved(), savedBefore);
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
  const page = settingsPage(app);
  const pending = page.chooseBackup();
  assert.equal(page.data.busy, true);
  await page.chooseBackup();
  assert.equal(pickCount, 1);
  picker.success({tempFiles: [{path: '/chat/backup.json', size: 1000}]});
  await turn();
  assert.equal(page.data.importVisible, true);
  page.confirmImportDialog();
  await pending;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.error, '');
  assert.equal(app.store.getState().nickname, '文件导入的小豆');
  assert.equal(page.data.backupText, '');
});

test('confirmation uses its captured backup and cancellation neither writes nor leaves busy set', async () => {
  const app = setup();
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
  assert.equal(page.data.importVisible, true);
  page.confirmImportDialog();
  await pending;
  assert.equal(app.store.getState().nickname, '确认时的内容');
  const before = app.saved();
  page.setData({backupText: JSON.stringify(data)});
  pending = page.confirmImport();
  page.cancelImportDialog();
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
  assert.equal(sharedPath, undefined, 'Preparing the file must not consume the original tap gesture.');
  assert.equal(page.data.exportVisible, true);
  assert.equal(page.data.busy, false);
  const sharing = page.confirmExportDialog();
  assert.ok(sharedPath);
  await sharing;
  assert.equal(app.files.has(sharedPath), false);
  assert.ok(app.removed.includes(sharedPath));
  assert.equal(page.data.busy, false);
});

test('export confirmation invokes the correct file API synchronously from its own tap', async t => {
  for (const platform of [undefined, 'ios', 'android', 'devtools', 'mac', 'windows']) {
    await t.test(platform || 'no device information', async () => {
      const app = setup();
      const before = app.saved();
      if (platform) app.wx.getDeviceInfo = () => ({platform});
      const calls = [];
      app.wx.shareFileMessage = options => calls.push({api: 'share', options});
      app.wx.saveFileToDisk = options => calls.push({api: 'save', options});
      const page = settingsPage(app);

      await page.exportBackup();
      assert.equal(calls.length, 0, 'File preparation must wait for a new user confirmation.');
      assert.equal(page.data.exportVisible, true);
      assert.equal(page.data.busy, false);
      const filePath = page._exportFilePath;
      assert.ok(app.files.has(filePath));

      const pending = page.confirmExportDialog();
      assert.equal(calls.length, 1, 'The file API must run before the first await/microtask.');
      assert.equal(calls[0].api, ['mac', 'windows'].includes(platform) ? 'save' : 'share');
      assert.equal(calls[0].options.filePath, filePath);
      assert.equal(page.data.busy, true);
      assert.equal(page.data.exportVisible, false);
      page.confirmExportDialog();
      assert.equal(calls.length, 1, 'Repeated taps cannot start a second file operation.');
      calls[0].options.success({});
      await pending;

      assert.equal(page.data.busy, false);
      assert.equal(page.data.error, '');
      assert.equal(app.files.has(filePath), false);
      assert.ok(app.removed.includes(filePath));
      assert.deepEqual(app.saved(), before, 'Export must not change stored recipes or records.');
    });
  }
});

test('failed and cancelled file operations release busy and clean up the prepared backup', async t => {
  for (const errMsg of [
    'shareFileMessage:fail can only be invoked by user TAP gesture',
    'shareFileMessage:fail not supported',
    'shareFileMessage:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发',
    'shareFileMessage:fail file not found',
    'shareFileMessage:fail cancel'
  ]) {
    await t.test(errMsg, async () => {
      const app = setup();
      const before = app.saved();
      let operation;
      app.wx.shareFileMessage = options => { operation = options; };
      const page = settingsPage(app);
      await page.exportBackup();
      const filePath = page._exportFilePath;
      const pending = page.confirmExportDialog();
      assert.ok(operation);
      operation.fail({errMsg});
      await pending;

      assert.equal(page.data.busy, false);
      assert.equal(page.data.exportVisible, false);
      assert.equal(app.files.has(filePath), false);
      assert.ok(app.removed.includes(filePath));
      if (errMsg.includes('cancel')) assert.equal(page.data.error, '');
      else if (errMsg.includes('TAP gesture')) assert.match(page.data.error, /重新导出.*分享备份文件/);
      else if (errMsg.includes('not supported')) assert.match(page.data.error, /手机微信.*复制备份内容/);
      else if (errMsg.includes('开发者工具')) assert.match(page.data.error, /开发者工具不支持文件分享.*手机微信.*复制备份内容/);
      else assert.ok(page.data.error.includes(errMsg), 'The native error must remain available to diagnose failures.');
      assert.deepEqual(app.saved(), before);
    });
  }
});

test('cancelling export confirmation removes its file without sharing or changing storage', async () => {
  const app = setup();
  const before = app.saved();
  let shareCount = 0;
  app.wx.shareFileMessage = () => { shareCount += 1; };
  const page = settingsPage(app);
  await page.exportBackup();
  const filePath = page._exportFilePath;
  await page.cancelExportDialog();
  await turn();

  assert.equal(shareCount, 0);
  assert.equal(page.data.exportVisible, false);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.error, '');
  assert.equal(app.files.has(filePath), false);
  assert.ok(app.removed.includes(filePath));
  assert.deepEqual(app.saved(), before);
});

test('leaving settings while an export is preparing or awaiting confirmation does not leak a file', async t => {
  for (const leaveDuringPreparation of [true, false]) {
    await t.test(leaveDuringPreparation ? 'during preparation' : 'awaiting confirmation', async () => {
      const app = setup();
      const before = app.saved();
      let shareCount = 0;
      app.wx.shareFileMessage = () => { shareCount += 1; };
      let release;
      if (leaveDuringPreparation) {
        const ready = new Promise(resolve => { release = resolve; });
        const exportFile = app.backup.exportFile;
        app.backup.exportFile = async () => { await ready; return exportFile(); };
      }
      const page = settingsPage(app);
      const pending = page.exportBackup();
      if (!leaveDuringPreparation) await pending;
      const updatesAfterUnload = [];
      const setData = page.setData;
      page.setData = fields => { updatesAfterUnload.push(fields); setData(fields); };
      const unloading = page.onUnload();
      if (release) release();
      await pending;
      await unloading;
      await turn();

      assert.equal(app.writes.length, 1);
      assert.equal(app.files.size, 0);
      assert.ok(app.removed.includes(app.writes[0]));
      assert.equal(shareCount, 0);
      assert.equal(updatesAfterUnload.some(fields => fields.exportVisible === true), false);
      assert.deepEqual(app.saved(), before);
    });
  }
});

test('unsupported file export offers the explicit copy option without silently copying data', async () => {
  const app = setup();
  const before = app.saved();
  let clipboardCount = 0;
  app.wx.setClipboardData = () => { clipboardCount += 1; };
  const page = settingsPage(app);
  await page.exportBackup();

  assert.equal(clipboardCount, 0);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.exportVisible, false);
  assert.match(page.data.error, /复制/);
  assert.equal(app.files.size, 0);
  assert.deepEqual(app.saved(), before);
});

test('leaving during sharing keeps the file until its callback and avoids updating the unloaded page', async t => {
  for (const outcome of ['success', 'fail']) {
    await t.test(outcome, async () => {
      const app = setup();
      const before = app.saved();
      let operation;
      app.wx.shareFileMessage = options => { operation = options; };
      const page = settingsPage(app);
      await page.exportBackup();
      const filePath = page._exportFilePath;
      const pending = page.confirmExportDialog();
      assert.ok(operation);
      assert.ok(app.files.has(filePath));

      const updatesAfterUnload = [];
      page.setData = fields => updatesAfterUnload.push(fields);
      await page.onUnload();
      assert.ok(app.files.has(filePath), 'The native share operation still needs its input file.');
      assert.equal(app.removed.includes(filePath), false);

      operation[outcome](outcome === 'success' ? {} : {errMsg: 'shareFileMessage:fail file not found'});
      await pending;
      assert.equal(app.files.has(filePath), false);
      assert.ok(app.removed.includes(filePath));
      assert.equal(updatesAfterUnload.length, 0, 'The completed operation must not update an unloaded page.');
      assert.deepEqual(app.saved(), before);
    });
  }
});

test('cloud photos export as portable images and only the downloaded temporary file is removed', async () => {
  const app = setup();
  const recipe = app.store.getState().recipes[0];
  const cloudID = 'cloud://cloud1-test.bucket/users/owner/photos/food.png';
  recipe.photo = cloudID;
  app.store.saveRecipe(recipe);
  const downloaded = 'http://tmp/cloud-photo.png';
  const requests = [];
  app.wx.cloud = {downloadFile(options) {
    requests.push(options.fileID);
    app.files.set(downloaded, png);
    options.success({tempFilePath: downloaded, statusCode: 200});
  }};
  const before = app.saved();
  const exported = JSON.parse(await app.backup.exportText());
  assert.equal(exported.recipes.find(item => item.id === recipe.id).photo, photoUri);
  assert.deepEqual(requests, [cloudID]);
  assert.deepEqual(app.removed, [downloaded]);
  assert.equal(app.files.has(downloaded), false);
  assert.deepEqual(app.saved(), before);
  assert.equal(app.store.getRecipe(recipe.id).photo, cloudID);
  const other = setup();
  await other.backup.importText(JSON.stringify(exported));
  assert.deepEqual(other.files.get(other.store.getRecipe(recipe.id).photo), png);
});

test('failed cloud downloads report the recipe without deleting local or cloud originals', async () => {
  const app = setup();
  const recipe = app.store.getState().recipes[0];
  recipe.photo = 'cloud://cloud1-test.bucket/users/owner/photos/food.png';
  app.store.saveRecipe(recipe);
  const before = app.saved();
  app.wx.cloud = {downloadFile({fail}) { fail({errMsg: 'network unavailable'}); }};
  await assert.rejects(app.backup.exportText(), new RegExp(recipe.name));
  assert.deepEqual(app.removed, []);
  assert.deepEqual(app.saved(), before);
  delete app.wx.cloud;
  await assert.rejects(app.backup.exportText(), /照片无法读取/);
  assert.deepEqual(app.saved(), before);
});

test('cloud download read errors and invalid image contents still reclaim the temporary file', async t => {
  for (const kind of ['unreadable', 'oversized', 'invalid-format', 'http-error']) {
    await t.test(kind, async () => {
      const app = setup();
      const recipe = app.store.getState().recipes[0];
      recipe.photo = 'cloud://cloud1-test.bucket/users/owner/photos/food.png';
      app.store.saveRecipe(recipe);
      const temporary = 'wxfile://tmp_cloud-photo.png';
      app.wx.cloud = {downloadFile({success}) {
        if (kind === 'oversized') {
          const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
          png.copy(bytes);
          app.files.set(temporary, bytes);
        } else if (kind === 'invalid-format') app.files.set(temporary, Buffer.from('not an image'));
        else if (kind === 'http-error') app.files.set(temporary, png);
        success({tempFilePath: temporary, statusCode: kind === 'http-error' ? 403 : 200});
      }};
      await assert.rejects(app.backup.exportText(), kind === 'oversized' ? /超过 2 MB/ :
        kind === 'invalid-format' ? /格式不受支持/ : new RegExp(recipe.name));
      assert.deepEqual(app.removed, [temporary]);
      assert.equal(app.files.has(temporary), false);
      assert.equal(app.store.getRecipe(recipe.id).photo, recipe.photo);
    });
  }
});

test('a cloud download cannot cause deletion of a saved local photo or a cloud file ID', async () => {
  const app = setup();
  const recipe = app.store.getState().recipes[0];
  recipe.photo = 'cloud://cloud1-test.bucket/users/owner/photos/food.png';
  app.store.saveRecipe(recipe);
  const savedPhoto = 'wxfile://usr/existing-photo.png';
  app.files.set(savedPhoto, png);
  for (const returnedPath of [savedPhoto, recipe.photo, '', undefined]) {
    app.wx.cloud = {downloadFile({success}) { success({tempFilePath: returnedPath, statusCode: 200}); }};
    await assert.rejects(app.backup.exportText(), /照片无法读取/);
  }
  await app.backup.removeFile(recipe.photo);
  assert.deepEqual(app.removed, []);
  assert.deepEqual(app.files.get(savedPhoto), png);
});

test('importing a replacement for a cloud photo never unlinks or deletes its cloud original', async () => {
  const app = setup();
  const recipe = app.store.getState().recipes[0];
  const cloudID = 'cloud://cloud1-test.bucket/users/owner/photos/old.png';
  recipe.photo = cloudID;
  app.store.saveRecipe(recipe);
  app.wx.cloud = {deleteFile() { assert.fail('backup import must never delete cloud objects'); }};
  const incoming = imageBackup(app);
  incoming.recipes[0].updatedAt = Date.now() + 100;
  await app.backup.importText(JSON.stringify(incoming));
  assert.notEqual(app.store.getRecipe(recipe.id).photo, cloudID);
  assert.deepEqual(app.files.get(app.store.getRecipe(recipe.id).photo), png);
  assert.equal(app.removed.includes(cloudID), false);
  assert.ok(app.removed.every(filePath => filePath.indexOf('cloud://') !== 0));
});

test('import guard runs before reading current photos and rejects without creating files', async () => {
  const app = setup();
  const incoming = imageBackup(app);
  const before = app.store.getState();
  const savedBefore = app.saved();
  let reads = 0;
  const originalGetState = app.store.getState;
  app.store.getState = () => { reads += 1; return originalGetState(); };
  await assert.rejects(app.backup.importText(JSON.stringify(incoming), () => {
    throw Error('账号已切换');
  }), /账号已切换/);
  assert.equal(reads, 0, 'No current-account photo set may be captured before its ownership guard succeeds.');
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.saved(), savedBefore);
  assert.deepEqual(originalGetState(), before);
});

test('account switch while importing photos aborts before storage commit and reclaims only staged files', async () => {
  const app = setup();
  const ownerA = 'a'.repeat(64);
  const ownerB = 'b'.repeat(64);
  app.store.bindAccount(ownerA);
  const originalRecipe = app.store.getState().recipes[0];
  originalRecipe.photo = 'wxfile://usr/original-A.png';
  app.store.saveRecipe(originalRecipe);
  app.files.set(originalRecipe.photo, png);
  const beforeA = app.store.getState();
  const incoming = imageBackup(app, 2);
  incoming.nickname = '不可写到账号乙';
  incoming.profileUpdatedAt = Date.now() + 100;
  incoming.recipes.forEach(item => { item.updatedAt = Date.now() + 100; });
  const getManager = app.wx.getFileSystemManager;
  let beforeB;
  app.wx.getFileSystemManager = () => {
    const manager = getManager();
    const writeFile = manager.writeFile;
    manager.writeFile = options => writeFile(Object.assign({}, options, {success(result) {
      if (!beforeB) { app.store.bindAccount(ownerB); beforeB = app.store.getState(); }
      options.success(result);
    }}));
    return manager;
  };
  let guards = 0;
  await assert.rejects(app.backup.importText(JSON.stringify(incoming), () => {
    guards += 1;
    if (app.store.getSyncInfo().owner !== ownerA) throw Error('账号已切换');
  }), /账号已切换/);
  assert.equal(guards, 2);
  assert.equal(app.store.getSyncInfo().owner, ownerB);
  assert.deepEqual(app.store.getState(), beforeB);
  assert.deepEqual(new Set(app.removed), new Set(app.writes));
  assert.deepEqual([...app.files.keys()], [originalRecipe.photo]);
  app.store.bindAccount(ownerA);
  assert.deepEqual(app.store.getState(), beforeA);
});

test('successful import validates account twice while asynchronous guards are rejected before writing', async () => {
  const app = setup();
  const incoming = imageBackup(app);
  let guards = 0;
  await app.backup.importText(JSON.stringify(incoming), () => { guards += 1; });
  assert.equal(guards, 2);
  const savedBefore = app.saved();
  const writesBefore = app.writes.length;
  await assert.rejects(app.backup.importText(JSON.stringify(incoming), async () => {}), /同步函数/);
  await assert.rejects(app.backup.importText(JSON.stringify(incoming), 'not a function'), /同步函数/);
  assert.equal(app.writes.length, writesBefore);
  assert.deepEqual(app.saved(), savedBefore);
});

test('reimporting an identical portable backup repairs an unreadable local photo and advances only its edit timestamp', async () => {
  const app = setup();
  const original = app.store.getState().recipes[0];
  original.photo = 'wxfile://usr/missing-original.png';
  app.store.saveRecipe(original);
  const before = app.store.getRecipe(original.id);
  const incoming = app.store.getState();
  incoming.recipes.find(item => item.id === original.id).photo = photoUri;
  const result = await app.backup.importText(JSON.stringify(incoming));
  const repaired = app.store.getRecipe(original.id);
  assert.equal(result.updatedRecipes, 1);
  assert.notEqual(repaired.photo, before.photo);
  assert.ok(repaired.updatedAt > before.updatedAt);
  assert.deepEqual(Object.assign({}, repaired, {photo: before.photo, updatedAt: before.updatedAt}), before);
  assert.deepEqual(app.files.get(repaired.photo), png);
  assert.equal(JSON.parse(await app.backup.exportText()).recipes.find(item => item.id === original.id).photo, photoUri);
});

test('same-version photo repair never replaces an available local photo or a cloud reference', async t => {
  for (const existingPhoto of ['wxfile://usr/available.png', 'cloud://cloud1-test.bucket/users/owner/photos/available.png']) {
    await t.test(existingPhoto.indexOf('cloud://') === 0 ? 'cloud' : 'local', async () => {
      const app = setup();
      const original = app.store.getState().recipes[0];
      original.photo = existingPhoto;
      app.store.saveRecipe(original);
      if (existingPhoto.indexOf('cloud://') !== 0) app.files.set(existingPhoto, png);
      const before = app.store.getRecipe(original.id);
      const incoming = app.store.getState();
      incoming.recipes.find(item => item.id === original.id).photo = photoUri;
      const result = await app.backup.importText(JSON.stringify(incoming));
      assert.equal(result.updatedRecipes, 0);
      assert.deepEqual(app.store.getRecipe(original.id), before);
      assert.deepEqual(new Set(app.removed), new Set(app.writes));
      if (existingPhoto.indexOf('cloud://') !== 0) assert.deepEqual(app.files.get(existingPhoto), png);
    });
  }
});

test('same-version missing-photo repair cannot change other recipe contents or restore an older version', async t => {
  for (const kind of ['different-content', 'older-version']) {
    await t.test(kind, async () => {
      const app = setup();
      const original = app.store.getState().recipes[0];
      original.photo = 'wxfile://usr/missing-original.png';
      app.store.saveRecipe(original);
      const before = app.store.getRecipe(original.id);
      const incoming = app.store.getState();
      const replacement = incoming.recipes.find(item => item.id === original.id);
      replacement.photo = photoUri;
      if (kind === 'different-content') replacement.note = '备份内容不同';
      else replacement.updatedAt -= 1;
      const result = await app.backup.importText(JSON.stringify(incoming));
      assert.equal(result.updatedRecipes, 0);
      assert.deepEqual(app.store.getRecipe(original.id), before);
      assert.deepEqual(new Set(app.removed), new Set(app.writes));
    });
  }
});

test('photo repair rechecks the current recipe after asynchronous file writes and preserves an intervening edit', async () => {
  const app = setup();
  const original = app.store.getState().recipes[0];
  original.photo = 'wxfile://usr/missing-original.png';
  app.store.saveRecipe(original);
  const incoming = app.store.getState();
  incoming.recipes.find(item => item.id === original.id).photo = photoUri;
  const getManager = app.wx.getFileSystemManager;
  let edited;
  app.wx.getFileSystemManager = () => {
    const manager = getManager();
    const writeFile = manager.writeFile;
    manager.writeFile = options => writeFile(Object.assign({}, options, {success(result) {
      if (!edited) {
        const current = app.store.getRecipe(original.id);
        app.store.saveRecipe(Object.assign({}, current, {note: '导入时刚刚写下的心得'}));
        edited = app.store.getRecipe(original.id);
      }
      options.success(result);
    }}));
    return manager;
  };
  const result = await app.backup.importText(JSON.stringify(incoming));
  assert.equal(result.updatedRecipes, 0);
  assert.deepEqual(app.store.getRecipe(original.id), edited);
  assert.deepEqual(new Set(app.removed), new Set(app.writes));
});
