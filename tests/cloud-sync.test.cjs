'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/recipes');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const backend = require('../cloudfunctions/babyBitesSync/validate');
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const ENV = 'baby-bites-test';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const fileID = (owner, kind, name, env = ENV) => `cloud://${env}.mock-bucket/users/${owner}/${kind}/${name}`;
const code = filename => fs.readFileSync(path.resolve(__dirname, '../utils/', filename), 'utf8');
const requireStore = createRequire(path.resolve(__dirname, '../utils/store.js'));
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function recipe(id, overrides = {}) {
  return Object.assign({id, name: '南瓜小米粥', category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
    ingredients: [{name: '南瓜', amount: '50 克'}], steps: ['蒸熟后煮粥。'], note: '', photo: '', imageKey: '',
    favorite: false, isExample: false, createdAt: 1, updatedAt: 1}, overrides);
}
function state(recipes = [], overrides = {}) {
  return Object.assign({version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes, logs: []}, overrides);
}
function snapshot(data = state()) { return {version: 1, data, deleted: {recipes: [], logs: []}}; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function setup(options = {}) {
  const localFiles = new Map(Object.entries(options.files || {}));
  const cloudFiles = new Map();
  const records = new Map();
  const storage = new Map();
  if (options.initial != null) storage.set('baby-bites-v1', copy(options.initial));
  const hooks = {};
  const calls = {init: [], identity: 0, commit: 0, upload: [], download: [], unlink: [], read: []};
  let currentOwner = OWNER;
  let networkListener;
  let timerId = 0;
  const timers = new Map();
  function putRemote(owner, incoming, revision = 1) {
    const id = fileID(owner, 'snapshots', `remote-${revision}.json`);
    cloudFiles.set(id, Buffer.from(JSON.stringify(incoming)));
    records.set(owner, {owner, revision, fileID: id});
    return id;
  }
  function getRemote(owner = currentOwner) {
    const entry = records.get(owner);
    return entry ? JSON.parse(cloudFiles.get(entry.fileID).toString()) : null;
  }
  function dispatch(args, action) {
    Promise.resolve().then(action).then(value => args.success(value), error => args.fail(error));
  }
  const manager = {
    getFileInfo(args) { dispatch(args, () => {
      if (!localFiles.has(args.filePath)) throw Error('File missing');
      return {size: hooks.fileSize ? hooks.fileSize(args.filePath) : Buffer.byteLength(localFiles.get(args.filePath))};
    }); },
    readFile(args) { dispatch(args, () => {
      calls.read.push(args.filePath);
      if (hooks.read) hooks.read(args);
      if (!localFiles.has(args.filePath)) throw Error('File missing');
      const data = localFiles.get(args.filePath);
      if (hooks.readResult) return {data: hooks.readResult(data, args)};
      return {data: args.encoding === 'utf8' ? data.toString() : Buffer.from(data)};
    }); },
    writeFile(args) { dispatch(args, async () => {
      localFiles.set(args.filePath, Buffer.from(args.data));
      if (hooks.write) await hooks.write(args);
      return {};
    }); },
    unlink(args) { dispatch(args, () => { calls.unlink.push(args.filePath); localFiles.delete(args.filePath); return {}; }); }
  };
  const wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) { storage.set(key, copy(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    getFileSystemManager() { return manager; },
    onNetworkStatusChange(listener) { networkListener = listener; },
    cloud: {
      init(args) { calls.init.push(args); },
      callFunction(args) { dispatch(args, async () => {
        if (args.data.action === 'identity') {
          calls.identity += 1;
          if (hooks.identity) {
            const result = await hooks.identity(args);
            if (result !== undefined) return {result};
          }
          return {result: copy(records.get(currentOwner) || {owner: currentOwner, revision: 0, fileID: ''})};
        }
        calls.commit += 1;
        if (hooks.beforeCommit) {
          const result = await hooks.beforeCommit(args);
          if (result !== undefined) return {result};
        }
        const current = records.get(currentOwner) || {owner: currentOwner, revision: 0, fileID: ''};
        if (current.revision !== args.data.baseRevision) return {result: Object.assign({conflict: true}, copy(current))};
        backend.validateSnapshot(cloudFiles.get(args.data.fileID), {env: ENV, owner: currentOwner});
        const next = {owner: currentOwner, revision: current.revision + 1, fileID: args.data.fileID};
        records.set(currentOwner, next);
        if (hooks.afterCommit) await hooks.afterCommit(args);
        return {result: copy(next)};
      }); },
      uploadFile(args) { dispatch(args, async () => {
        calls.upload.push({filePath: args.filePath, cloudPath: args.cloudPath});
        if (hooks.upload) await hooks.upload(args);
        if (!localFiles.has(args.filePath)) throw Error('File missing');
        const id = `cloud://${ENV}.mock-bucket/${args.cloudPath}`;
        cloudFiles.set(id, Buffer.from(localFiles.get(args.filePath)));
        return {fileID: hooks.uploadID ? hooks.uploadID(id) : id};
      }); },
      downloadFile(args) { dispatch(args, async () => {
        calls.download.push(args.fileID);
        if (hooks.download) await hooks.download(args);
        if (!cloudFiles.has(args.fileID)) throw Error('Cloud file missing');
        const tempFilePath = 'wxfile://tmp-download-' + calls.download.length;
        localFiles.set(tempFilePath, cloudFiles.get(args.fileID));
        return {tempFilePath, statusCode: 200};
      }); }
    }
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(code('store.js'), {module: storeModule, require: requireStore, wx, console}, {filename: 'store.js'});
  const store = storeModule.exports;
  const syncModule = {exports: {}};
  const context = {module: syncModule, wx, console, ArrayBuffer, Uint8Array,
    require(name) {
      if (name === '../config/cloud') return {env: options.unconfigured ? '' : ENV, functionName: 'babyBitesSync'};
      if (name === './store') return store;
      return requireStore(name);
    },
    setTimeout(callback) { timerId += 1; timers.set(timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(code('cloud-sync.js'), context, {filename: 'cloud-sync.js'});
  const sync = syncModule.exports;
  return {wx, sync, store, calls, hooks, records, localFiles, cloudFiles, storage, putRemote, getRemote,
    setOwner(value) { currentOwner = value; },
    network(isConnected) { if (networkListener) networkListener({isConnected}); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    timerCount() { return timers.size; }};
}

test('unconfigured start and syncNow never initialize cloud or bind local data', async () => {
  const app = setup({unconfigured: true, initial: state([recipe('local')])});
  await app.sync.start();
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'unconfigured');
  assert.equal(app.store.getSyncInfo().owner, null);
  assert.equal(app.calls.identity, 0);
  assert.equal(app.calls.init.length, 0);
  assert.equal(app.calls.upload.length, 0);
});

test('a new empty account keeps local examples without uploading them or applying an empty snapshot', async () => {
  const app = setup();
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.store.getState().recipes.length, seed.length);
  assert.equal(app.store.getSyncInfo().hasLocalData, false);
  assert.equal(app.calls.commit, 0);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.calls.init[0].env, ENV);
  assert.equal(app.calls.init[0].traceUser, false);
});

test('an existing account restores recipes, favorites, profile and meal records to another device', async () => {
  const app = setup();
  const remote = snapshot(state([recipe('remote', {favorite: true})], {nickname: '小米', profileUpdatedAt: 5,
    logs: [{id: 'log-remote', recipeId: 'remote', rating: 3, date: '2024-01-01', portion: '吃了一些', note: '', createdAt: 5, updatedAt: 5}]}));
  app.putRemote(OWNER, remote, 3);
  await app.sync.syncNow();
  assert.equal(app.store.getState().nickname, '小米');
  assert.equal(app.store.getRecipe('remote').favorite, true);
  assert.equal(app.store.getState().logs.length, 1);
  assert.equal(app.store.getSyncInfo().revision, 3);
  assert.equal(app.calls.commit, 0);
  assert.equal(app.calls.unlink.length, 1);
});

test('first migration merges local and other-device records and skips an unchanged follow-up commit', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.putRemote(OWNER, snapshot(state([recipe('remote')])), 2);
  await app.sync.syncNow();
  assert.deepEqual([...app.getRemote().data.recipes.map(item => item.id)].sort(), ['local', 'remote']);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.storage.get('baby-bites-v1').__syncMigratedTo, OWNER);
  await app.sync.syncNow();
  assert.equal(app.calls.commit, 1);
  assert.equal(app.calls.init.length, 1);
  assert.equal(app.calls.identity, 2);
});

test('local photos are checked, uploaded to the current owner, and replaced by cloud references', async () => {
  const localPhoto = 'wxfile://usr/photo-with-no-extension';
  const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: PNG}});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.upload.length, 2);
  assert.match(app.calls.upload[0].cloudPath, new RegExp('^users/' + OWNER + '/photos/.+\\.png$'));
  assert.equal(app.store.getRecipe('local').photo, app.getRemote().data.recipes[0].photo);
  assert.match(app.store.getRecipe('local').photo, /^cloud:\/\//);
  assert.ok(app.localFiles.has(localPhoto));
  assert.ok(![...app.localFiles.keys()].some(name => name.includes('/sync-')));
});

test('WeChat ArrayBuffers from another JS realm are recognized without instanceof', async () => {
  const localPhoto = 'http://usr/import-photo.png';
  const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: PNG}});
  const foreignBuffer = vm.runInNewContext('new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).buffer');
  assert.equal(foreignBuffer instanceof ArrayBuffer, false);
  assert.equal(ArrayBuffer.isView(foreignBuffer), false);
  assert.equal(Object.prototype.toString.call(foreignBuffer), '[object ArrayBuffer]');
  app.hooks.readResult = () => foreignBuffer;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.upload.length, 2);
  assert.match(app.calls.upload[0].cloudPath, /\/photos\/.+\.png$/);
  assert.match(app.store.getRecipe('local').photo, /^cloud:\/\//);
});

test('cross-realm typed-array views inspect only their declared byte range', async () => {
  const localPhoto = 'http://usr/import-photo.jpg';
  const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: Buffer.from([255, 216, 255, 1])}});
  const foreignView = vm.runInNewContext('new Uint8Array(new Uint8Array([0, 0, 255, 216, 255, 1]).buffer, 2, 4)');
  assert.equal(foreignView instanceof Uint8Array, false);
  assert.equal(ArrayBuffer.isView(foreignView), true);
  app.hooks.readResult = () => foreignView;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.match(app.calls.upload[0].cloudPath, /\/photos\/.+\.jpg$/);
});

test('a spoofed ArrayBuffer tag cannot bypass validation as an array-like photo', async () => {
  const localPhoto = 'wxfile://usr/food.png';
  const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: PNG}});
  const fake = {0: 137, 1: 80, 2: 78, 3: 71, 4: 13, 5: 10, 6: 26, 7: 10, length: 8, byteLength: 8,
    [Symbol.toStringTag]: 'ArrayBuffer'};
  app.hooks.readResult = () => fake;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /照片已失效或无法读取/);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.store.getSyncInfo().dirty, true);
});

test('missing server identity prevents binding, migration and every upload', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.identity = () => ({revision: 0, fileID: ''});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.store.getSyncInfo().owner, null);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.storage.get('baby-bites-v1').__syncMigratedTo, undefined);
});

test('a server error response is not reported as synchronized', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.identity = () => ({error: {code: 'UNAUTHENTICATED', message: 'server error'}});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /微信账号/);
  assert.equal(app.sync.getStatus().lastSyncedAt, 0);
  assert.equal(app.calls.upload.length, 0);
});

test('unsupported cloud SDK resolves an actionable error status instead of rejecting', async () => {
  const app = setup({initial: state([recipe('local')])});
  delete app.wx.cloud;
  const status = await app.sync.start();
  assert.equal(status.state, 'error');
  assert.match(status.message, /更新微信/);
  assert.equal(app.store.getSyncInfo().owner, null);
  assert.ok(app.store.getRecipe('local'));
});

test('a snapshot index from another environment or owner is rejected before download', async () => {
  for (const badFile of [fileID(OWNER, 'snapshots', 'a.json', 'another-env'), fileID(OTHER, 'snapshots', 'a.json')]) {
    const app = setup({initial: state([recipe('local')])});
    app.hooks.identity = () => ({owner: OWNER, revision: 1, fileID: badFile});
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error');
    assert.equal(app.calls.download.length, 0);
    assert.equal(app.calls.upload.length, 0);
  }
});

test('remote snapshots cannot introduce local, foreign-owner or foreign-environment photos', async () => {
  for (const badPhoto of ['wxfile://usr/other-device.jpg', fileID(OTHER, 'photos', 'food.png'),
    fileID(OWNER, 'photos', 'food.png', 'another-env')]) {
    const app = setup({initial: state([recipe('local')])});
    app.putRemote(OWNER, snapshot(state([recipe('remote', {photo: badPhoto})])));
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error');
    assert.equal(app.store.getRecipe('remote'), null);
    assert.equal(app.store.getSyncInfo().dirty, true);
    assert.equal(app.calls.upload.length, 0);
  }
});

test('local cloud photo references cannot leak another account or environment into an upload', async () => {
  for (const badPhoto of [fileID(OTHER, 'photos', 'food.png'), fileID(OWNER, 'photos', 'food.png', 'another-env')]) {
    const app = setup({initial: state([recipe('local', {photo: badPhoto})])});
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error');
    assert.equal(app.calls.upload.length, 0);
    assert.equal(app.store.getRecipe('local').photo, badPhoto);
  }
});

test('a CAS conflict pulls the latest remote data and merges before retrying', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.putRemote(OWNER, snapshot(state([recipe('first-device')])), 1);
  app.hooks.beforeCommit = () => {
    if (app.calls.commit === 1) app.putRemote(OWNER, snapshot(state([recipe('first-device'), recipe('concurrent')])), 2);
  };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.commit, 2);
  assert.deepEqual(app.getRemote().data.recipes.map(item => item.id).sort(), ['concurrent', 'first-device', 'local']);
  assert.equal(app.store.getSyncInfo().revision, 3);
});

test('repeated CAS conflicts are capped and leave the local edits pending', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.beforeCommit = () => {
    app.putRemote(OWNER, snapshot(state([recipe('other-device')])), app.calls.commit);
  };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /其他设备/);
  assert.equal(app.calls.commit, 3);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.ok(app.store.getRecipe('local'));
  assert.ok(![...app.localFiles.keys()].some(name => name.includes('/sync-')));
});

test('single-flight sync preserves edits made during upload and then uploads the newer state', async () => {
  const app = setup({initial: state([recipe('local')])});
  const entered = deferred();
  const release = deferred();
  app.hooks.beforeCommit = async () => {
    if (app.calls.commit === 1) { entered.resolve(); await release.promise; }
  };
  const first = app.sync.start();
  await entered.promise;
  app.store.setNickname('同步中修改');
  const second = app.sync.syncNow();
  assert.equal(first, second);
  release.resolve();
  await first;
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.getRemote().data.nickname, '同步中修改');
  assert.equal(app.store.getState().nickname, '同步中修改');
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.calls.commit, 2);
  assert.equal(app.calls.identity, 2);
});

test('network failure keeps local data dirty without an automatic retry loop', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.identity = () => { throw {errMsg: 'callFunction:fail network timeout'}; };
  await app.sync.start();
  app.runTimers();
  assert.equal(app.sync.getStatus().state, 'pending');
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.calls.identity, 1);
  assert.equal(app.timerCount(), 0);
  assert.ok(app.store.getRecipe('local'));
});

test('an unknown commit outcome never deletes cloud files and retry confirms an already committed snapshot', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.afterCommit = () => { throw {errMsg: 'request timeout'}; };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'pending');
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.getRemote().data.recipes[0].id, 'local');
  assert.equal(app.cloudFiles.size, 1);
  assert.ok(![...app.localFiles.keys()].some(name => name.includes('/sync-')));
  delete app.hooks.afterCommit;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.commit, 1);
  assert.equal(app.store.getSyncInfo().dirty, false);
});

test('changing the authenticated account does not migrate the first account data or photos again', async () => {
  const localPhoto = 'wxfile://usr/food.png';
  const app = setup({initial: state([recipe('first-account', {photo: localPhoto})]), files: {[localPhoto]: PNG}});
  await app.sync.syncNow();
  const uploadsBefore = app.calls.upload.length;
  app.setOwner(OTHER);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().owner, OTHER);
  assert.equal(app.store.getRecipe('first-account'), null);
  assert.equal(app.store.getSyncInfo().hasLocalData, false);
  assert.equal(app.calls.upload.length, uploadsBefore);
  assert.equal(app.getRemote(OTHER), null);
  app.setOwner(OWNER);
  await app.sync.syncNow();
  assert.ok(app.store.getRecipe('first-account'));
});

test('a local account switch while awaiting upload prevents applying data to the new account', async () => {
  const app = setup({initial: state([recipe('first-account')])});
  const entered = deferred();
  const release = deferred();
  app.hooks.upload = async () => { entered.resolve(); await release.promise; };
  const syncing = app.sync.syncNow();
  await entered.promise;
  app.store.bindAccount(OTHER);
  release.resolve();
  await syncing;
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.store.getSyncInfo().owner, OTHER);
  assert.equal(app.store.getRecipe('first-account'), null);
  assert.equal(app.calls.commit, 0);
});

test('start observes local edits and reconnects, and status observers can unsubscribe', async () => {
  const app = setup({initial: state([recipe('local')])});
  const changes = [];
  const unsubscribe = app.sync.subscribe(next => changes.push(next.state));
  await app.sync.start();
  app.store.setNickname('新的称呼');
  assert.equal(app.sync.getStatus().state, 'pending');
  assert.equal(app.timerCount(), 1);
  app.runTimers();
  await app.sync.syncNow();
  assert.equal(app.getRemote().data.nickname, '新的称呼');
  const previous = changes.length;
  unsubscribe();
  app.network(false);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'pending');
  assert.equal(changes.length, previous);
  app.network(true);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
});

test('bad photo signatures and oversized photos fail without uploading source bytes', async () => {
  for (const [bytes, size] of [[Buffer.from('not-an-image'), 12], [PNG, 2 * 1024 * 1024 + 1]]) {
    const localPhoto = 'wxfile://usr/food.jpg';
    const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: bytes}});
    app.hooks.fileSize = () => size;
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error');
    assert.equal(app.calls.upload.length, 0);
    assert.equal(app.store.getRecipe('local').photo, localPhoto);
  }
});

test('expired local photo paths name the affected recipe and offer restoring a portable backup', async () => {
  const missingPhoto = 'http://store/old-app-photo.jpg';
  const app = setup({initial: state([recipe('local', {name: '香蕉松饼', photo: missingPhoto})])});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /香蕉松饼.*本机照片已失效或无法读取/);
  assert.match(app.sync.getStatus().message, /重新选择照片.*导入含照片的备份/);
  assert.doesNotMatch(app.sync.getStatus().message, /http:\/\/store/);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.calls.commit, 0);
  assert.equal(app.store.getRecipe('local').photo, missingPhoto);
  assert.equal(app.store.getSyncInfo().dirty, true);
});

test('a local photo read failure after a successful size check keeps data and reports recovery steps', async () => {
  const localPhoto = 'wxfile://usr/food.png';
  const app = setup({initial: state([recipe('local', {photo: localPhoto})]), files: {[localPhoto]: PNG}});
  app.hooks.read = () => { throw {errMsg: 'readFile:fail no such file or directory'}; };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /南瓜小米粥.*本机照片已失效或无法读取/);
  assert.match(app.sync.getStatus().message, /重新选择照片.*导入含照片的备份/);
  assert.equal(app.calls.read.length, 1);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.calls.commit, 0);
  assert.equal(app.store.getRecipe('local').photo, localPhoto);
  assert.equal(app.store.getSyncInfo().dirty, true);
});

test('partially written local snapshot files are cleaned up after a write error', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.write = () => { throw Error('Disk full'); };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.calls.upload.length, 0);
  assert.equal(app.calls.unlink.length, 1);
  assert.equal(app.localFiles.size, 0);
});

test('oversized snapshots are rejected before reading and temporary downloads are removed', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.putRemote(OWNER, snapshot(state([recipe('remote')])));
  app.hooks.fileSize = () => 5 * 1024 * 1024 + 1;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.calls.read.length, 0);
  assert.equal(app.calls.unlink.length, 1);
  assert.equal(app.store.getRecipe('remote'), null);
});

test('an upload response from a different environment cannot be committed', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.uploadID = id => id.replace(ENV, 'foreign-env');
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.calls.commit, 0);
  assert.equal(app.store.getSyncInfo().dirty, true);
});

test('a rolled-back cloud index fails without repeated commits or retry loops', async () => {
  const app = setup({initial: state([recipe('local')])});
  await app.sync.start();
  app.store.setNickname('新的称呼');
  app.hooks.identity = () => ({owner: OWNER, revision: 0, fileID: ''});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /早于本机缓存/);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.calls.identity, 2);
  assert.equal(app.store.getState().nickname, '新的称呼');
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.timerCount(), 0);
});

test('a commit response for a changed authenticated owner does not acknowledge local changes', async () => {
  const app = setup({initial: state([recipe('local')])});
  app.hooks.beforeCommit = () => ({owner: OTHER, revision: 1, fileID: fileID(OTHER, 'snapshots', 'another.json')});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.store.getSyncInfo().revision, 0);
  assert.equal(app.store.getSyncInfo().owner, OWNER);
  assert.ok(app.store.getRecipe('local'));
});
