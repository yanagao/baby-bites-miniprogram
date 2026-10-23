'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const validator = require('../cloudfunctions/babyBitesSync/validate');
const requireStore = createRequire(path.resolve(__dirname, '../utils/store.js'));
const OWNER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const PUBLIC_ID = 'c'.repeat(64);
const PROFILE_ID = 'd'.repeat(32);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const source = name => fs.readFileSync(path.resolve(__dirname, '../utils/', name), 'utf8');
const publicRecipe = () => ({id: PUBLIC_ID, profileId: PROFILE_ID, authorName: '朋友的小厨房', name: '南瓜饭',
  category: '粥饭主食', texture: '软烂颗粒', minutes: 20, ingredients: [{name: '南瓜', amount: '20 克'}],
  steps: ['切碎蒸熟。'], imageKey: 'pumpkin', photoURL: '', updatedAt: 100, publishedAt: 100});
function setup(options = {}) {
  const storage = new Map();
  const files = new Map();
  const calls = [];
  const hooks = {};
  let syncOwner = OWNER;
  let syncState = 'synced';
  const dispatch = (args, action) => Promise.resolve().then(action).then(args.success, args.fail);
  const manager = {
    getFileInfo(args) { dispatch(args, async () => {
      if (hooks.info) await hooks.info();
      return {size: hooks.size == null ? files.get(args.filePath).length : hooks.size};
    }); },
    readFile(args) { dispatch(args, async () => {
      if (hooks.read) await hooks.read();
      return {data: hooks.bytes || files.get(args.filePath)};
    }); },
    copyFile(args) { dispatch(args, async () => {
      files.set(args.destPath, files.get(args.srcPath));
      if (hooks.copy) await hooks.copy();
      return {};
    }); },
    unlink(args) { dispatch(args, () => { files.delete(args.filePath); return {}; }); }
  };
  const wx = {
    env: {USER_DATA_PATH: 'wxfile://usr'},
    getStorageSync(key) { return copy(storage.get(key)); },
    setStorageSync(key, value) { if (hooks.storage) hooks.storage(key); storage.set(key, copy(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    getFileSystemManager() { return manager; },
    downloadFile(args) { dispatch(args, async () => {
      calls.push({action: 'download', url: args.url});
      if (hooks.download) await hooks.download();
      const tempFilePath = 'wxfile://tmp/photo';
      files.set(tempFilePath, PNG);
      return {tempFilePath, statusCode: 200};
    }); },
    cloud: {init() {}, callFunction(args) { dispatch(args, async () => {
      calls.push(copy(args.data));
      if (args.data.action === 'identity') {
        if (hooks.identity) return {result: await hooks.identity()};
        return {result: {owner: syncOwner, revision: 0, fileID: ''}};
      }
      if (hooks.request) {
        const result = await hooks.request(args);
        if (result !== undefined) return {result};
      }
      return {result: args.data.action === 'recipe' ? {recipe: Object.assign(publicRecipe(), options.photo ? {photoURL: 'https://storage.example/photo?sign=123'} : {})} : {ok: true}};
    }); }}
  };
  const storeModule = {exports: {}};
  vm.runInNewContext(source('store.js'), {module: storeModule, require: requireStore, wx, console});
  const store = storeModule.exports;
  store.bindAccount(OWNER);
  const sync = {async syncNow() {
    calls.push({action: 'sync'});
    if (hooks.sync) await hooks.sync();
    store.bindAccount(syncOwner);
    return {state: syncState, owner: syncOwner, message: syncState === 'synced' ? '已同步' : '等待联网同步'};
  }};
  const socialModule = {exports: {}};
  vm.runInNewContext(source('social.js'), {module: socialModule, wx, console, ArrayBuffer, Uint8Array,
    require(name) {
      if (name === './store') return store;
      if (name === './cloud-sync') return sync;
      if (name === '../config/cloud') return {env: 'social-test', socialEnabled: options.enabled !== false};
      throw Error(name);
    }});
  return {social: socialModule.exports, store, files, hooks, calls, storage,
    setSyncOwner(value) { syncOwner = value; }, setSyncState(value) { syncState = value; }};
}

test('social writes confirm identity and use it as a backend precondition', async () => {
  const app = setup();
  await app.social.saveProfile({name: ' 小厨房 ', bio: ' 家常辅食 '});
  assert.deepEqual(app.calls, [{action: 'identity'}, {action: 'updateProfile', name: '小厨房', bio: '家常辅食', expectedOwner: OWNER}]);
});

test('unconfigured social feature rejects requests before any cloud or private snapshot work', async () => {
  const app = setup({enabled: false});
  await assert.rejects(app.social.getMine(), /准备中/);
  await assert.rejects(app.social.publishRecipe('one'), /准备中/);
  await assert.rejects(app.social.unpublishRecipe('one'), /准备中/);
  await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /准备中/);
  assert.deepEqual(app.calls, []);
});

test('unavailable private sync prevents adding a copy without a current cross-device snapshot', async () => {
  const app = setup();
  app.setSyncState('pending');
  await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /等待联网同步/);
  assert.equal(app.calls.length, 1);
});

test('an account switch while identifying prevents requests for the old view', async () => {
  const app = setup();
  app.setSyncOwner(OTHER);
  await assert.rejects(app.social.getMine(), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(app.calls.length, 1);
});

test('private snapshot errors do not prevent withdrawing public content after successful identity verification', async () => {
  const app = setup();
  app.setSyncState('error');
  await app.social.unpublishRecipe('private-recipe');
  assert.deepEqual(app.calls.map(item => item.action), ['identity', 'unpublish']);
  assert.equal(app.calls[1].expectedOwner, OWNER);
});

test('identity failure never sends a withdrawal request', async () => {
  const app = setup();
  app.hooks.identity = () => ({error: {code: 'UNAUTHENTICATED'}});
  await assert.rejects(app.social.unpublishRecipe('private-recipe'), /确认当前微信账号/);
  assert.deepEqual(app.calls.map(item => item.action), ['identity']);
});

test('an account switch during a cloud response discards its data', async () => {
  const app = setup();
  app.hooks.request = () => { app.store.bindAccount(OTHER); return {profile: {name: 'old user'}}; };
  await assert.rejects(app.social.getProfile(PROFILE_ID), error => error.code === 'ACCOUNT_CHANGED');
});

test('backend errors become safe, actionable Chinese without exposing server details', async () => {
  const app = setup();
  app.hooks.request = () => ({error: {code: 'NOT_FOUND', message: 'secret owner and path'}});
  await assert.rejects(app.social.getRecipe(PUBLIC_ID), error => /取消公开/.test(error.message) && !error.message.includes('secret'));
  app.hooks.request = () => ({error: {code: 'ACCOUNT_CHANGED'}});
  await assert.rejects(app.social.getMine(), error => error.code === 'ACCOUNT_CHANGED');
});

test('publishing never runs while a local edit still awaits synchronization', async () => {
  const app = setup();
  const recipeId = app.store.saveRecipe(Object.assign(publicRecipe(), {id: undefined}));
  await assert.rejects(app.social.publishRecipe(recipeId), /先保存并同步/);
  assert.equal(app.calls.filter(item => item.action === 'publish').length, 0);
});

test('explicit publication saves only the selected example as personal and syncs before publish', async () => {
  const app = setup();
  const original = app.store.getState().recipes[0];
  app.hooks.sync = () => {
    const info = app.store.getSyncInfo();
    if (info.dirty) app.store.applySyncedSnapshot(app.store.getSyncSnapshot(),
      {owner: OWNER, sequence: info.sequence, revision: info.revision + 1});
  };
  await app.social.publishRecipe(original.id);
  const saved = app.store.getRecipe(original.id);
  assert.equal(saved.isExample, false);
  assert.equal(saved.imageKey, original.imageKey);
  assert.deepEqual(copy(saved.ingredients), copy(original.ingredients));
  assert.deepEqual(copy(saved.steps), copy(original.steps));
  assert.equal(app.store.getState().recipes.filter(item => !item.isExample).length, 1);
  assert.equal(app.store.getState().logs.length, 0);
  assert.deepEqual(app.calls.map(item => item.action), ['sync', 'sync', 'publish']);
  assert.equal(app.calls[2].sourceRecipeId, original.id);
});

test('duplicate add taps share one request and create an independent private recipe', async () => {
  const app = setup();
  const before = app.store.getState();
  const first = app.social.addToCookbook(PUBLIC_ID);
  assert.equal(app.social.addToCookbook(PUBLIC_ID), first);
  const result = await first;
  assert.equal(result.recipeId, 'shared-' + PUBLIC_ID);
  assert.equal(result.added, true);
  const own = app.social.findImportedRecipe(PUBLIC_ID);
  assert.equal(own.note, '');
  assert.equal(own.favorite, false);
  assert.equal(own.isExample, false);
  assert.deepEqual(copy(own.source), {profileId: PROFILE_ID, recipeId: PUBLIC_ID, authorName: '朋友的小厨房'});
  assert.equal(app.store.getState().recipes.length, before.recipes.length + 1);
  assert.deepEqual(copy(app.store.getState().logs), copy(before.logs));
  assert.equal((await app.social.addToCookbook(PUBLIC_ID)).added, false);
  assert.equal(app.calls.filter(item => item.action === 'recipe').length, 1);
  app.store.saveRecipe(Object.assign({}, own, {name: '我改过的南瓜饭'}));
  assert.equal(app.social.findImportedRecipe(PUBLIC_ID).name, '我改过的南瓜饭');
  assert.equal((await app.social.addToCookbook(PUBLIC_ID)).added, false);
  assert.equal(app.social.findImportedRecipe(PUBLIC_ID).name, '我改过的南瓜饭');
});

test('copying public photos creates a local persistent file and removes the temporary download', async () => {
  const app = setup({photo: true});
  const result = await app.social.addToCookbook(PUBLIC_ID);
  const recipe = app.store.getRecipe(result.recipeId);
  assert.match(recipe.photo, /^wxfile:\/\/usr\/shared-.+\.png$/);
  assert.equal(app.files.size, 1);
  assert.deepEqual(app.files.get(recipe.photo), PNG);
  assert.ok(!recipe.photo.includes('storage.example'));
  assert.ok(!recipe.photo.startsWith('cloud://'));
});

test('photo signatures work with native ArrayBuffers from another realm', async () => {
  const app = setup({photo: true});
  app.hooks.bytes = vm.runInNewContext('new Uint8Array([137,80,78,71,13,10,26,10,1]).buffer');
  const result = await app.social.addToCookbook(PUBLIC_ID);
  assert.match(app.store.getRecipe(result.recipeId).photo, /\.png$/);
});

test('oversized and invalid image downloads never add partial recipes or retain files', async () => {
  for (const invalid of ['size', 'bytes']) {
    const app = setup({photo: true});
    app.hooks[invalid] = invalid === 'size' ? 2 * 1024 * 1024 + 1 : Buffer.from('invalid');
    await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /照片/);
    assert.equal(app.social.findImportedRecipe(PUBLIC_ID), null);
    assert.equal(app.files.size, 0);
  }
});

test('account changes at each photo await prevent copying data into the new account and clean files', async () => {
  for (const phase of ['download', 'info', 'read', 'copy']) {
    const app = setup({photo: true});
    app.hooks[phase] = () => app.store.bindAccount(OTHER);
    await assert.rejects(app.social.addToCookbook(PUBLIC_ID), error => error.code === 'ACCOUNT_CHANGED');
    assert.equal(app.social.findImportedRecipe(PUBLIC_ID), null);
    assert.equal(app.files.size, 0);
    app.store.bindAccount(OWNER);
    assert.equal(app.social.findImportedRecipe(PUBLIC_ID), null);
  }
});

test('switching from A to B and back to A during identity, sync or download invalidates the request session', async () => {
  for (const phase of ['identity', 'sync', 'download']) {
    const app = setup({photo: true});
    app.hooks[phase] = () => {
      app.store.bindAccount(OTHER);
      app.store.bindAccount(OWNER);
      return {owner: OWNER, revision: 0, fileID: ''};
    };
    const work = phase === 'identity' ? app.social.saveProfile({name: '未提交昵称', bio: ''}) : app.social.addToCookbook(PUBLIC_ID);
    await assert.rejects(work, error => error.code === 'ACCOUNT_CHANGED');
    assert.equal(app.social.findImportedRecipe(PUBLIC_ID), null);
    assert.equal(app.calls.filter(item => item.action === 'updateProfile').length, 0);
    assert.equal(app.files.size, 0);
  }
});

test('a storage write failure removes the newly saved photo and leaves existing recipes intact', async () => {
  const app = setup({photo: true});
  const before = app.store.getState();
  app.hooks.copy = () => { app.hooks.storage = () => { throw Error('Disk full'); }; };
  await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /保存失败/);
  assert.deepEqual(copy(app.store.getState()), copy(before));
  assert.equal(app.files.size, 0);
});

test('an unpublished recipe cannot be newly copied', async () => {
  const app = setup();
  app.hooks.request = () => ({error: {code: 'NOT_FOUND'}});
  await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /取消公开/);
  assert.equal(app.social.findImportedRecipe(PUBLIC_ID), null);
});

test('re-adding a deliberately deleted shared recipe advances past its tombstone', () => {
  const app = setup();
  const first = app.store.addPublicRecipe(publicRecipe(), OWNER);
  app.store.deleteRecipe(first.recipeId);
  const deletion = app.store.getSyncSnapshot().deleted.recipes.find(item => item.id === first.recipeId);
  const second = app.store.addPublicRecipe(publicRecipe(), OWNER);
  assert.equal(second.recipeId, first.recipeId);
  assert.ok(app.store.getRecipe(second.recipeId).updatedAt > deletion.updatedAt);
  assert.equal(app.store.getSyncSnapshot().deleted.recipes.length, 1);
});

test('source metadata survives editing, portable backup, local reload and private cloud validation', async () => {
  const app = setup();
  await app.social.addToCookbook(PUBLIC_ID);
  const own = app.social.findImportedRecipe(PUBLIC_ID);
  app.store.saveRecipe(Object.assign({}, own, {note: '我自己的小心得'}));
  const exported = JSON.parse(app.store.exportBackup());
  const saved = exported.recipes.find(item => item.id === own.id);
  assert.deepEqual(saved.source, copy(own.source));
  app.store.bindAccount(OTHER);
  app.store.bindAccount(OWNER);
  assert.deepEqual(copy(app.store.getRecipe(own.id).source), copy(own.source));
  const snapshot = app.store.getSyncSnapshot();
  const clean = validator.validateSnapshot(Buffer.from(JSON.stringify(snapshot)), {env: 'social-test', owner: OWNER});
  assert.deepEqual(clean.data.recipes.find(item => item.id === own.id).source, copy(own.source));
});

test('malformed source metadata is rejected both locally and by private cloud validation', () => {
  const app = setup();
  const result = app.store.addPublicRecipe(publicRecipe(), OWNER);
  for (const invalid of [{profileId: 'raw-openid'}, {recipeId: '../secret'}, {authorName: ''}, {owner: OWNER}]) {
    const snapshot = copy(app.store.getSyncSnapshot());
    const recipe = snapshot.data.recipes.find(item => item.id === result.recipeId);
    recipe.source = Object.assign(recipe.source, invalid);
    assert.throws(() => app.store.validateSnapshot(snapshot));
    assert.throws(() => validator.validateSnapshot(Buffer.from(JSON.stringify(snapshot)), {env: 'social-test', owner: OWNER}));
  }
});

test('stable shared IDs from a synced second device prevent importing another copy', () => {
  const first = setup();
  first.store.addPublicRecipe(publicRecipe(), OWNER);
  const second = setup();
  const info = second.store.getSyncInfo();
  second.store.applySyncedSnapshot(first.store.getSyncSnapshot(), {owner: OWNER, sequence: info.sequence, revision: 1});
  const count = second.store.getState().recipes.length;
  assert.equal(second.store.addPublicRecipe(publicRecipe(), OWNER).added, false);
  assert.equal(second.store.getState().recipes.length, count);
});
