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
const FAMILY_SCOPE = {kind: 'family', id: 'f'.repeat(64), membershipId: 'c'.repeat(32)};
const familyFileID = (kind, name, id = FAMILY_SCOPE.id) => `cloud://${ENV}.mock-bucket/families/${id}/${kind}/${name}`;
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
// Cache shape written by the pre-allergy client's validateData/validateSync.
// It has a valid cloud revision but neither the new data nor a parser marker.
function legacyCache(data, revision = 1) {
  const {allergies, allergiesUpdatedAt, ...knownData} = copy(data);
  return {version: 1, data: knownData, __sync: {sequence: 0, revision, dirty: false,
    hasLocalData: true, migratedLegacy: false, deleted: {recipes: [], logs: []}}};
}
function cachedStorage(data, revision = 1) {
  return new Map([['baby-bites-active-owner', OWNER], ['baby-bites-account-' + OWNER, legacyCache(data, revision)]]);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function setup(options = {}) {
  const localFiles = new Map(Object.entries(options.files || {}));
  const cloudFiles = new Map();
  const records = new Map();
  const storage = new Map(Array.from(options.storage || [], ([key, value]) => [key, copy(value)]));
  if (options.initial != null) storage.set('baby-bites-v1', copy(options.initial));
  const hooks = {};
  const calls = {init: [], identity: 0, commit: 0, upload: [], download: [], urlDownload: [], unlink: [], read: [], social: [], requests: []};
  let currentOwner = OWNER;
  let networkListener;
  let timerId = 0;
  let now = Date.now();
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
    setStorageSync(key, value) { if (hooks.storage) hooks.storage(key, value); storage.set(key, copy(value)); },
    getStorageInfoSync() { return {keys: [...storage.keys()]}; },
    getFileSystemManager() { return manager; },
    onNetworkStatusChange(listener) { networkListener = listener; },
    downloadFile(args) { dispatch(args, async () => {
      calls.urlDownload.push(args.url);
      if (hooks.downloadURL) {const result = await hooks.downloadURL(args); if (result !== undefined) return result;}
      if (!cloudFiles.has(args.url)) throw Error('Signed file missing');
      const tempFilePath = 'wxfile://tmp-signed-' + calls.urlDownload.length;
      localFiles.set(tempFilePath, cloudFiles.get(args.url));
      return {tempFilePath, statusCode: 200};
    }); },
    cloud: {
      init(args) { calls.init.push(args); },
      callFunction(args) { dispatch(args, async () => {
        calls.requests.push(copy(args.data));
        if (hooks.request) { const override = await hooks.request(args); if (override !== undefined) return {result: override}; }
        if (args.name === 'babyBitesSocial') {
          calls.social.push(copy(args.data));
          return {result: hooks.social ? await hooks.social(args) : {updated: 0, removed: 0, hasMore: false}};
        }
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
  const config = {env: options.unconfigured ? '' : ENV, functionName: 'babyBitesSync', socialEnabled: options.socialEnabled === true};
  const familyPhotosModule = {exports: {}};
  vm.runInNewContext(code('family-photos.js'), {module: familyPhotosModule, wx,
    Date: class extends Date { static now() { return now; } },
    require(name) { if (name === './store') return store; if (name === '../config/cloud') return config; throw Error(name); }
  });
  const publicationModule = {exports: {}};
  vm.runInNewContext(code('publication-sync.js'), {module: publicationModule, wx,
    require(name) { if (name === './store') return store; if (name === '../config/cloud') return config; throw Error(name); }
  });
  const syncModule = {exports: {}};
  const context = {module: syncModule, wx, console, ArrayBuffer, Uint8Array,
    Date: class extends Date { static now() { return now; } },
    require(name) {
      if (name === '../config/cloud') return config;
      if (name === './store') return store;
      if (name === './publication-sync') return publicationModule.exports;
      if (name === './family-photos') return familyPhotosModule.exports;
      return requireStore(name);
    },
    setTimeout(callback) { timerId += 1; timers.set(timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  vm.runInNewContext(code('cloud-sync.js'), context, {filename: 'cloud-sync.js'});
  const sync = syncModule.exports;
  return {wx, sync, store, photos: familyPhotosModule.exports, calls, hooks, records, localFiles, cloudFiles, storage, putRemote, getRemote,
    setOwner(value) { currentOwner = value; },
    advanceTime(milliseconds) { now += milliseconds; },
    network(isConnected) { if (networkListener) networkListener({isConnected}); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
    timerCount() { return timers.size; }};
}

test('family sync keeps the signed-in actor and never merges the previous personal baby into the shared one', async () => {
  const app = setup(); app.putRemote(OWNER, snapshot(state([recipe('personal')], {nickname: '个人宝宝'})), 1);
  await app.sync.syncNow();
  const familyPhoto = familyFileID('photos', 'shared.jpg');
  const shared = snapshot(state([recipe('family', {photo: familyPhoto, createdBy: OTHER})], {nickname: '家庭宝宝', babyBirthDate: '2024-01-01', babyBirthDateUpdatedAt: 2}));
  const remote = {owner: OWNER, scope: FAMILY_SCOPE, revision: 1, fileID: familyFileID('snapshots', 'shared.json')};
  app.hooks.request = args => args.data.action === 'identity' ? remote : args.data.action === 'familyRead' ?
    {...remote, snapshot: shared, photoURLs: {[familyPhoto]: 'https://example.test/family-photo.jpg'}} : undefined;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced'); assert.equal(app.store.getSyncInfo().owner, OWNER);
  assert.equal(app.store.getSyncInfo().scope.kind, 'family'); assert.equal(app.store.getState().nickname, '家庭宝宝');
  assert.deepEqual(copy(app.store.getState().recipes.map(item => item.id)), ['family']);
  assert.equal(app.photos.photoURL(familyPhoto), 'https://example.test/family-photo.jpg');
  assert.ok(app.calls.requests.every(item => item.protocolVersion === 2));
  app.hooks.request = undefined; await app.sync.syncNow();
  assert.equal(app.store.getSyncInfo().scope.kind, 'personal'); assert.equal(app.store.getState().nickname, '个人宝宝');
  assert.equal(app.photos.photoURL(familyPhoto), '');
});

test('family commit uploads only caller-owned staging files and applies server-stamped canonical content', async () => {
  const app = setup({files: {'wxfile://usr/new.jpg': PNG}});
  let shared = snapshot(state([recipe('family')])), revision = 1;
  const identity = () => ({owner: OWNER, scope: FAMILY_SCOPE, revision, fileID: familyFileID('snapshots', 'family-' + revision + '.json')});
  app.hooks.request = args => {
    if (args.data.action === 'identity') return identity();
    if (args.data.action === 'familyRead') return {...identity(), snapshot: shared, photoURLs: {}};
    if (args.data.action === 'commit') {
      assert.deepEqual(copy(args.data.expectedScope), FAMILY_SCOPE);
      assert.match(args.data.fileID, new RegExp('/users/' + OWNER + '/snapshots/'));
      const submitted = JSON.parse(app.cloudFiles.get(args.data.fileID).toString());
      const created = submitted.data.recipes.find(item => item.id !== 'family');
      assert.match(created.photo, new RegExp('/users/' + OWNER + '/photos/'));
      created.photo = familyFileID('photos', 'canonical.png'); created.createdBy = OWNER;
      shared = submitted; revision++;
      return {...identity(), snapshot: shared, photoURLs: {[created.photo]: 'https://example.test/canonical.png'}};
    }
  };
  await app.sync.syncNow();
  const id = app.store.saveRecipe(recipe('', {photo: 'wxfile://usr/new.jpg'}));
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced'); assert.equal(app.store.getRecipe(id).createdBy, OWNER);
  assert.equal(app.store.getRecipe(id).photo, familyFileID('photos', 'canonical.png'));
  assert.equal(app.store.getSyncInfo().dirty, false);
});

test('offline family edits and meal logs survive a concurrent photo replacement or removal', async () => {
  const app = setup();
  const oldPhoto = familyFileID('photos', 'old.jpg'), newPhoto = familyFileID('photos', 'new.jpg');
  let shared = snapshot(state([
    recipe('replaced', {photo: oldPhoto}), recipe('removed', {photo: familyFileID('photos', 'removed.jpg')}),
    recipe('still-using-old-photo', {photo: oldPhoto})
  ]));
  let revision = 1, attempts = 0;
  const identity = () => ({owner: OWNER, scope: FAMILY_SCOPE, revision, fileID: familyFileID('snapshots', revision + '.json')});
  app.hooks.request = ({data}) => {
    if (data.action === 'identity') return identity();
    if (data.action === 'familyRead') return {...identity(), snapshot: copy(shared)};
    if (data.action === 'commit') {
      attempts++;
      if (attempts === 1) {
        Object.assign(shared.data.recipes[0], {photo: newPhoto, updatedAt: 2});
        Object.assign(shared.data.recipes[1], {photo: '', updatedAt: 2});
        revision++;
        return {...identity(), conflict: true};
      }
      const allowed = new Set(shared.data.recipes.map(item => item.photo));
      shared = backend.validateSnapshot(app.cloudFiles.get(data.fileID), {owner: OWNER, env: ENV, photoAllowed: id => allowed.has(id)});
      revision++;
      return {...identity(), snapshot: copy(shared)};
    }
  };
  await app.sync.syncNow();
  app.store.saveRecipe({...app.store.getRecipe('replaced'), name: '离线改过的粥'});
  app.store.toggleFavorite('removed');
  const logId = app.store.addLog({recipeId: 'replaced', rating: 3});
  assert.equal((await app.sync.syncNow()).state, 'synced');
  assert.equal(attempts, 2);
  assert.equal(app.store.getRecipe('replaced').name, '离线改过的粥');
  assert.equal(app.store.getRecipe('replaced').photo, newPhoto);
  assert.equal(app.store.getRecipe('removed').favorite, true);
  assert.equal(app.store.getRecipe('removed').photo, '');
  assert.equal(app.store.getRecipe('still-using-old-photo').photo, oldPhoto);
  assert.ok(shared.data.logs.some(item => item.id === logId));
});

test('late family reads cannot apply after membership changes even for the same actor', async () => {
  const app = setup(), gate = deferred();
  const remote = {owner: OWNER, scope: FAMILY_SCOPE, revision: 1, fileID: familyFileID('snapshots', 'shared.json')};
  app.hooks.request = async args => {
    if (args.data.action === 'identity') return remote;
    if (args.data.action === 'familyRead') { await gate.promise; return {...remote, snapshot: snapshot(state([recipe('old-family')])), photoURLs: {}}; }
  };
  const work = app.sync.syncNow();
  while (!app.calls.requests.some(item => item.action === 'familyRead')) await new Promise(resolve => setImmediate(resolve));
  app.store.bindScope(OWNER, {kind: 'personal', id: OWNER}); gate.resolve(); await work;
  assert.equal(app.store.getSyncInfo().scope.kind, 'personal');
  assert.equal(app.store.getRecipe('old-family'), null); assert.notEqual(app.sync.getStatus().state, 'synced');
});

test('family synchronization rejects a foreign-family photo before storing or uploading it', async () => {
  const app = setup(); const remote = {owner: OWNER, scope: FAMILY_SCOPE, revision: 1, fileID: familyFileID('snapshots', 'shared.json')};
  app.hooks.request = args => args.data.action === 'identity' ? remote : {...remote,
    snapshot: snapshot(state([recipe('bad', {photo: familyFileID('photos', 'not-ours.png', 'e'.repeat(64))})])), photoURLs: {}};
  await app.sync.syncNow(); assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.store.getRecipe('bad'), null); assert.equal(app.calls.upload.length, 0);
});

test('large family snapshots download through signed URLs and canonical commit responses apply without a second read', async () => {
  const app = setup(); let revision = 1;
  let shared = snapshot(state(Array.from({length: 14}, (_, i) => recipe('large-' + i, {steps: Array(30).fill('米'.repeat(1000))}))));
  assert.ok(Buffer.byteLength(JSON.stringify(shared)) > 1024 * 1024);
  const identity = () => ({owner: OWNER, scope: FAMILY_SCOPE, revision, fileID: familyFileID('snapshots', 'large-' + revision + '.json')});
  const response = () => {
    const snapshotURL = 'https://signed.example.test/snapshot-' + revision;
    app.cloudFiles.set(snapshotURL, Buffer.from(JSON.stringify(shared)));
    return {...identity(), snapshotURL, photoURLs: {}};
  };
  app.hooks.request = args => {
    if (args.data.action === 'identity') return identity();
    if (args.data.action === 'familyRead') return response();
    if (args.data.action === 'commit') {
      shared = JSON.parse(app.cloudFiles.get(args.data.fileID).toString()); revision++;
      shared.data.recipes[0].createdBy = OWNER;
      return response();
    }
  };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced'); assert.equal(app.store.getState().recipes.length, 14);
  app.store.setNickname('共享宝宝'); await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced'); assert.equal(app.store.getSyncInfo().revision, 2);
  assert.equal(app.store.getRecipe('large-0').createdBy, OWNER);
  assert.equal(app.calls.requests.filter(item => item.action === 'familyRead').length, 2);
  assert.equal(app.calls.urlDownload.length, 3); assert.equal(app.calls.download.length, 0);
  assert.equal([...app.localFiles.keys()].filter(name => name.includes('tmp-signed')).length, 0);
  assert.equal(JSON.stringify([...app.storage.values()]).includes('signed.example.test'), false);
});

test('signed family snapshot transport rejects invalid URLs, oversized files, failed downloads and invalid content', async () => {
  for (const mode of ['missing-url', 'http-url', 'oversized', 'bad-json', 'failed-status', 'foreign-photo']) {
    const app = setup(), url = 'https://signed.example.test/data';
    const remote = {owner: OWNER, scope: FAMILY_SCOPE, revision: 1, fileID: familyFileID('snapshots', 'large.json')};
    const data = snapshot(state([recipe('untrusted', mode === 'foreign-photo' ? {photo: familyFileID('photos', 'other.png', 'e'.repeat(64))} : {})]));
    const payload = mode === 'oversized' ? Buffer.alloc(5 * 1024 * 1024 + 1) : Buffer.from(mode === 'bad-json' ? 'not JSON' : JSON.stringify(data));
    app.cloudFiles.set(url, payload);
    app.hooks.request = args => args.data.action === 'identity' ? remote : {...remote,
      ...(mode === 'missing-url' ? {} : {snapshotURL: mode === 'http-url' ? 'http://signed.example.test/data' : url}), photoURLs: {}};
    if (mode === 'failed-status') app.hooks.downloadURL = () => {
      app.localFiles.set('wxfile://failed-download', payload); return {tempFilePath: 'wxfile://failed-download', statusCode: 403};
    };
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error', mode); assert.equal(app.store.getRecipe('untrusted'), null, mode);
    assert.equal(app.calls.upload.length, 0, mode); assert.equal(app.localFiles.size, 0, mode);
  }
});

test('a signed family snapshot download is discarded and cleaned after membership ABA', async () => {
  const app = setup(), gate = deferred(), url = 'https://signed.example.test/stale';
  const remote = {owner: OWNER, scope: FAMILY_SCOPE, revision: 1, fileID: familyFileID('snapshots', 'stale.json')};
  app.cloudFiles.set(url, Buffer.from(JSON.stringify(snapshot(state([recipe('stale')])))));
  app.hooks.request = args => args.data.action === 'identity' ? remote : {...remote, snapshotURL: url, photoURLs: {}};
  app.hooks.downloadURL = async () => {await gate.promise;};
  const work = app.sync.syncNow();
  while (!app.calls.urlDownload.length) await new Promise(resolve => setImmediate(resolve));
  app.store.bindScope(OWNER, {kind: 'personal', id: OWNER}); app.store.bindScope(OWNER, FAMILY_SCOPE);
  gate.resolve(); await work;
  assert.equal(app.store.getRecipe('stale'), null); assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.localFiles.size, 0); assert.equal(app.sync.getStatus().identityInvalid, true);
});

test('family photo reads are coalesced, bounded, cooled down after failure and explicitly retryable', async () => {
  const app = setup(); app.store.bindAccount(OWNER); app.store.bindScope(OWNER, FAMILY_SCOPE);
  const photos = Array.from({length: 23}, (_, i) => familyFileID('photos', 'photo-' + i + '.png'));
  app.hooks.request = args => {
    assert.equal(args.data.action, 'familyPhotos'); assert.ok(args.data.fileIDs.length <= 20);
    return {owner: OWNER, scope: FAMILY_SCOPE, photoURLs: Object.fromEntries(args.data.fileIDs.map(id => [id, 'https://example.test/' + id.split('/').pop()]))};
  };
  photos.forEach(id => { assert.equal(app.photos.photoURL(id), ''); app.photos.photoURL(id); });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.requests.length, 2); assert.match(app.photos.photoURL(photos[0]), /^https:/);
  app.advanceTime(5 * 60 * 1000); app.hooks.request = () => ({error: {code: 'FAMILY_FORBIDDEN'}});
  app.photos.photoURL(photos[0]); await new Promise(resolve => setImmediate(resolve));
  const count = app.calls.requests.length;
  for (let i = 0; i < 5; i++) app.photos.photoURL(photos[0]);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(app.calls.requests.length, count);
  await assert.rejects(app.photos.ensure([photos[0]], {force: true})); assert.equal(app.calls.requests.length, count + 1);
});

test('family photo responses do not survive account or membership ABA switches', async () => {
  const app = setup(), gate = deferred(), id = familyFileID('photos', 'old.png');
  app.store.bindAccount(OWNER); app.store.bindScope(OWNER, FAMILY_SCOPE);
  app.hooks.request = async () => { await gate.promise; return {owner: OWNER, scope: FAMILY_SCOPE, photoURLs: {[id]: 'https://example.test/old.png'}}; };
  const work = app.photos.ensure([id]);
  app.store.bindScope(OWNER, {kind: 'personal', id: OWNER}); app.store.bindScope(OWNER, FAMILY_SCOPE);
  gate.resolve(); assert.deepEqual(copy(await work), {});
  assert.equal(app.photos.photoURL(id), '');
});

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

test('recipe reconciliation waits for committed account data and retries even after dirty state is cleared', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('existing'), recipe('new')])});
  const synchronizedAt = new Map();
  let failUpdate = true;
  app.hooks.social = args => {
    assert.equal(app.store.getSyncInfo().dirty, false);
    assert.equal(app.getRemote().data.recipes.length, 2);
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    if (failUpdate) throw Error('offline');
    let updated = 0;
    for (const item of app.getRemote().data.recipes) {
      if (synchronizedAt.get(item.id) !== item.updatedAt) {
        synchronizedAt.set(item.id, item.updatedAt);
        updated++;
      }
    }
    return {updated, removed: 0, hasMore: false};
  };
  await app.sync.start();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationPending, true);
  assert.match(app.sync.getStatus().publicationMessage, /记录已同步，公开菜谱暂未更新/);
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.timerCount(), 0, 'a failed public update does not spin retries');
  failUpdate = false;
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationPending, false);
  assert.equal(app.sync.getStatus().publicationErrorCode, '');
  assert.equal(app.calls.commit, 1, 'retry does not commit private data again');
  assert.equal(app.calls.social.length, 2);
  assert.equal(synchronizedAt.size, 2, 'both existing and newly added user recipes are reconciled');
  const version = app.sync.getStatus().publicationVersion;
  await app.sync.syncNow();
  assert.equal(app.calls.social.length, 3, 'explicit synchronization checks the server for outstanding work');
  assert.equal(app.sync.getStatus().publicationVersion, version, 'a no-op batch does not invalidate cached lists');
});

test('private save failure never runs public reconciliation and reconnect resumes deferred updates', async () => {
  const failed = setup({socialEnabled: true, initial: state([recipe('published')])});
  failed.hooks.beforeCommit = () => { throw Error('network unavailable'); };
  await failed.sync.start();
  assert.deepEqual(failed.calls.social, []);
  assert.equal(failed.store.getSyncInfo().dirty, true);
  delete failed.hooks.beforeCommit;
  failed.network(false);
  await failed.sync.syncNow();
  assert.deepEqual(failed.calls.social, []);
  failed.network(true);
  await failed.sync.syncNow();
  assert.equal(failed.sync.getStatus().state, 'synced');
  assert.deepEqual(failed.calls.social, [{action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2}]);
});

test('editing again during public reconciliation synchronizes and reconciles the newer save', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('published')])});
  let publishedAt = 0, first = true;
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    publishedAt = app.getRemote().data.recipes[0].updatedAt;
    const hasMore = first;
    if (first) {
      first = false;
      app.store.saveRecipe({...app.store.getRecipe('published'), name: '第二次保存的菜名'});
    }
    return {updated: 1, removed: 0, hasMore};
  };
  await app.sync.start();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.getRemote().data.recipes[0].name, '第二次保存的菜名');
  assert.equal(app.calls.commit, 2);
  assert.equal(app.calls.social.length, 2, 'a queued local edit is committed before the next batch');
  assert.equal(publishedAt, app.store.getRecipe('published').updatedAt);
});

test('a failed public update still commits a private save queued while it was in flight without retrying itself', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('published')])});
  let updates = 0;
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    updates++;
    if (updates === 1) app.store.saveRecipe({...app.store.getRecipe('published'), name: '第二次保存的菜名'});
    throw Error('temporary public update failure');
  };
  await app.sync.start();
  assert.equal(app.getRemote().data.recipes[0].name, '第二次保存的菜名');
  assert.equal(app.store.getRecipe('published').name, '第二次保存的菜名');
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.calls.commit, 2);
  assert.equal(updates, 1, 'a failed publication must not retry itself while draining private changes');
  assert.deepEqual(app.calls.social.map(item => item.action), ['syncPublications']);
  assert.equal(app.timerCount(), 0);
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationPending, true);
  assert.match(app.sync.getStatus().publicationMessage, /记录已同步，公开菜谱暂未更新/);
});

test('an A to B to A account switch cannot accept a stale reconciliation response or continue its batches', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('published')])});
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    app.store.bindAccount(OTHER); app.store.bindAccount(OWNER);
    return {updated: 8, removed: 0, hasMore: true};
  };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.match(app.sync.getStatus().message, /账号已切换/);
  assert.equal(app.calls.social.length, 1);
  assert.equal(app.sync.getStatus().publicationVersion, 0, 'the previous account session cannot update the active cache version');
});

test('unchanged account revisions skip downloads and store notifications but still check server identity', async () => {
  const app = setup();
  app.putRemote(OWNER, snapshot(state([recipe('remote')])), 3);
  await app.sync.syncNow();
  let notifications = 0;
  app.store.subscribe(() => notifications++);
  await app.sync.syncNow();
  assert.equal(app.calls.identity, 2);
  assert.equal(app.calls.download.length, 1);
  assert.equal(app.calls.commit, 0);
  assert.equal(notifications, 0);
  assert.equal(app.sync.getStatus().revision, 3);

  app.putRemote(OWNER, snapshot(state([recipe('remote', {name: '另一台设备的新菜名', updatedAt: 2})])), 4);
  await app.sync.syncNow();
  assert.equal(app.calls.download.length, 2);
  assert.equal(notifications, 1);
  assert.equal(app.store.getRecipe('remote').name, '另一台设备的新菜名');
  assert.equal(app.sync.getStatus().revision, 4);
});

test('upgrading an old clean cache restores same-revision allergies before enabling download skips', async () => {
  const egg = recipe('egg', {ingredients: [{name: '鸡蛋', amount: '1 个'}]});
  const remote = snapshot(state([egg, recipe('pumpkin')], {allergies: ['鸡蛋'], allergiesUpdatedAt: 20}));
  const app = setup({storage: cachedStorage(remote.data, 7)});
  app.putRemote(OWNER, remote, 7);
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.store.getState().allergies, undefined);
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.download.length, 1);
  assert.equal(app.calls.commit, 0);
  assert.equal(app.store.getSyncInfo().revision, 7);
  assert.equal(app.store.getSyncInfo().snapshotCurrent, true);
  assert.deepEqual(copy(app.store.getState().allergies), ['鸡蛋']);
  const selectors = require('../utils/selectors');
  assert.deepEqual(copy(selectors.listRecipes(app.store.getState(), {excludeAllergies: true}).map(item => item.id)), ['pumpkin']);
  assert.match(selectors.enrichRecipe(app.store.getState(), egg).allergyWarning, /鸡蛋/);

  let changes = 0;
  app.store.subscribe(() => changes++);
  await app.sync.syncNow();
  assert.equal(app.calls.identity, 2);
  assert.equal(app.calls.download.length, 1);
  assert.equal(changes, 0);
  const restarted = setup({storage: app.storage});
  restarted.putRemote(OWNER, remote, 7);
  await restarted.sync.syncNow();
  assert.equal(restarted.calls.identity, 1);
  assert.equal(restarted.calls.download.length, 0, 'the complete-cache marker survives restart');
  assert.deepEqual(copy(restarted.store.getState().allergies), ['鸡蛋']);
});

test('foreground startup also restores old caches with empty or absent allergy settings', async () => {
  for (const allergyFields of [{allergies: [], allergiesUpdatedAt: 20}, {}]) {
    const remote = snapshot(state([recipe('remote')], allergyFields));
    const app = setup({storage: cachedStorage(remote.data, 4)});
    app.putRemote(OWNER, remote, 4);
    await app.sync.start();
    assert.equal(app.sync.getStatus().state, 'synced');
    assert.equal(app.calls.download.length, 1);
    assert.equal(app.calls.commit, 0);
    assert.equal(app.store.getSyncInfo().snapshotCurrent, true);
    assert.deepEqual(copy(app.store.getState().allergies), allergyFields.allergies);
    await app.sync.syncNow({ifNeeded: true});
    assert.equal(app.calls.identity, 1);
    await app.sync.syncNow();
    assert.equal(app.calls.identity, 2);
    assert.equal(app.calls.download.length, 1);
  }
});

test('downgrade writes drop the parser marker so re-upgrading restores omitted fields again', async () => {
  const remote = snapshot(state([recipe('remote')], {allergies: ['鸡蛋'], allergiesUpdatedAt: 20}));
  const app = setup();
  app.putRemote(OWNER, remote, 5);
  await app.sync.syncNow();
  const oldWrite = legacyCache(app.store.getState(), 5);
  app.storage.set('baby-bites-account-' + OWNER, oldWrite);
  const upgraded = setup({storage: app.storage});
  upgraded.putRemote(OWNER, remote, 5);
  assert.equal(upgraded.store.getState().allergies, undefined);
  await upgraded.sync.syncNow();
  assert.equal(upgraded.calls.download.length, 1);
  assert.equal(upgraded.calls.commit, 0);
  assert.deepEqual(copy(upgraded.store.getState().allergies), ['鸡蛋']);
  assert.equal(upgraded.store.getSyncInfo().snapshotCurrent, true);
});

test('failed upgrade downloads, parsing and persistence remain incomplete and retry the same revision', async () => {
  for (const failure of ['download', 'parse', 'storage']) {
    const remote = snapshot(state([recipe('remote')], {allergies: ['鸡蛋'], allergiesUpdatedAt: 20}));
    const app = setup({storage: cachedStorage(remote.data, 3)});
    const remoteFile = app.putRemote(OWNER, remote, 3);
    if (failure === 'download') app.hooks.download = () => { throw Error('network offline'); };
    if (failure === 'parse') app.cloudFiles.set(remoteFile, Buffer.from('{invalid json'));
    if (failure === 'storage') app.hooks.storage = () => { throw Error('quota exceeded'); };
    await app.sync.syncNow();
    assert.notEqual(app.sync.getStatus().state, 'synced', failure);
    assert.equal(app.store.getSyncInfo().snapshotCurrent, false, failure);
    assert.equal(app.store.getState().allergies, undefined, failure);
    assert.equal(app.storage.get('baby-bites-account-' + OWNER).__sync.snapshotSchemaVersion, undefined, failure);
    delete app.hooks.download; delete app.hooks.storage;
    app.putRemote(OWNER, remote, 3);
    await app.sync.syncNow({ifNeeded: true});
    assert.equal(app.sync.getStatus().state, 'synced', failure);
    assert.equal(app.calls.download.length, 2, failure);
    assert.equal(app.calls.commit, 0, failure);
    assert.deepEqual(copy(app.store.getState().allergies), ['鸡蛋'], failure);
    assert.equal(app.store.getSyncInfo().snapshotCurrent, true, failure);
  }
});

test('edits made before the first upgraded sync merge with restored allergy settings', async () => {
  const remote = snapshot(state([recipe('remote')], {allergies: ['鸡蛋'], allergiesUpdatedAt: 20}));
  const app = setup({storage: cachedStorage(remote.data, 2)});
  app.putRemote(OWNER, remote, 2);
  app.store.setNickname('本机新称呼');
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.calls.download.length, 1);
  assert.equal(app.calls.commit, 1);
  assert.deepEqual(copy(app.store.getState().allergies), ['鸡蛋']);
  assert.equal(app.store.getState().nickname, '本机新称呼');
  assert.equal(app.getRemote().data.nickname, '本机新称呼');
  assert.deepEqual(app.getRemote().data.allergies, ['鸡蛋']);
  assert.equal(app.store.getSyncInfo().snapshotCurrent, true);
});

test('foreground checks reuse confirmed clean state for thirty seconds and periodically reconcile publications', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('local')])});
  await app.sync.start();
  const initial = app.sync.getStatus();
  await app.sync.syncNow({ifNeeded: true});
  await app.sync.start();
  app.network(true);
  app.advanceTime(29999);
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 1);
  assert.equal(app.calls.social.length, 1);
  assert.equal(app.sync.getStatus().lastSyncedAt, initial.lastSyncedAt);

  app.advanceTime(1);
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 2);
  assert.equal(app.calls.social.length, 2, 'periodic checks reconcile changes made by older clients');
  assert.equal(app.calls.download.length, 0);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.sync.getStatus().publicationVersion, 0);
  assert.equal(app.sync.getStatus().identityCheckedAt, initial.identityCheckedAt + 30000);

  await app.sync.syncNow();
  assert.equal(app.calls.identity, 3, 'an explicit sync always contacts the server');
  assert.equal(app.calls.social.length, 3);
});

test('joining an in-flight sync without edits does not queue another identity or publication check', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('local')])});
  const entered = deferred(), release = deferred();
  app.hooks.social = async () => {
    entered.resolve(); await release.promise;
    return {updated: 0, removed: 0, hasMore: false};
  };
  const first = app.sync.start();
  await entered.promise;
  assert.equal(app.sync.syncNow(), first);
  assert.equal(app.sync.syncNow({ifNeeded: true}), first);
  release.resolve();
  await first;
  assert.equal(app.calls.identity, 1);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.calls.social.length, 1);
});

test('edits included while awaiting identity do not cause a second redundant pass', async () => {
  const app = setup({initial: state([recipe('local')])});
  const entered = deferred(), release = deferred();
  app.hooks.identity = async () => { entered.resolve(); await release.promise; };
  const work = app.sync.start();
  await entered.promise;
  app.store.setNickname('身份确认时的新称呼');
  release.resolve();
  await work;
  assert.equal(app.calls.identity, 1);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.getRemote().data.nickname, '身份确认时的新称呼');
  assert.equal(app.store.getSyncInfo().dirty, false);
});

test('dirty edits and failed checks bypass the foreground interval and preserve verified identity on network failure', async () => {
  const app = setup({initial: state([recipe('local')])});
  await app.sync.syncNow();
  const checkedAt = app.sync.getStatus().identityCheckedAt;
  app.store.setNickname('新称呼');
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 2);
  assert.equal(app.calls.commit, 2);
  assert.equal(app.getRemote().data.nickname, '新称呼');

  app.hooks.identity = () => { throw Error('network timeout'); };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'pending');
  assert.equal(app.sync.getStatus().identityCheckedAt, checkedAt);
  assert.equal(app.sync.getStatus().identityInvalid, false, 'network failures do not invalidate verified identity');
  delete app.hooks.identity;
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 4);
  assert.equal(app.sync.getStatus().state, 'synced');
});

test('fresh startup, account switches and invalid identity responses cannot use the foreground cache', async () => {
  const app = setup();
  assert.equal(app.sync.getStatus().identityInvalid, false);
  app.store.bindAccount(OWNER);
  assert.equal(app.sync.getStatus().identityCheckedAt, 0);
  assert.equal(app.sync.getStatus().identityInvalid, true);
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 1);
  assert.equal(app.sync.getStatus().identityInvalid, false);
  app.store.bindAccount(OTHER);
  app.store.bindAccount(OWNER);
  assert.equal(app.sync.getStatus().identityCheckedAt, 0);
  assert.equal(app.sync.getStatus().identityInvalid, true);
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 2);
  assert.equal(app.sync.getStatus().identityInvalid, false);

  app.hooks.identity = () => ({owner: 'invalid', revision: 0, fileID: ''});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.sync.getStatus().identityCheckedAt, 0);
  assert.equal(app.sync.getStatus().identityInvalid, true);
  app.hooks.identity = () => { throw Error('network timeout'); };
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().identityInvalid, true, 'network retries cannot restore an invalidated identity');
  delete app.hooks.identity;
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.identity, 5);
  assert.equal(app.sync.getStatus().identityInvalid, false);
});

test('server account mismatches invalidate previously confirmed identity for all subscribers', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('local')])});
  await app.sync.start();
  assert.equal(app.sync.getStatus().identityInvalid, false);
  const changes = [];
  app.sync.subscribe(status => changes.push(status.identityInvalid));
  app.hooks.social = () => ({error: {code: 'ACCOUNT_CHANGED'}});
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().state, 'error');
  assert.equal(app.sync.getStatus().identityCheckedAt, 0);
  assert.equal(app.sync.getStatus().identityInvalid, true);
  assert.ok(changes.includes(true));
  delete app.hooks.social;
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.sync.getStatus().identityInvalid, false);
  assert.equal(app.sync.getStatus().state, 'synced');
});

test('publication failures preserve data readiness, throttle foreground checks and permit explicit retries', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('first'), recipe('second')])});
  const completed = new Set();
  let failSecond = true;
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    let updated = 0;
    if (!completed.has('first')) { completed.add('first'); updated++; }
    if (failSecond) return {updated, removed: 0, hasMore: true, error: {code: 'STORAGE_FAILED'}};
    if (!completed.has('second')) { completed.add('second'); updated++; }
    return {updated, removed: 0, hasMore: false};
  };
  const versions = [];
  app.sync.subscribe(status => versions.push(status.publicationVersion));
  await app.sync.start();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationPending, true);
  assert.equal(app.sync.getStatus().revision, 1);
  assert.equal(app.sync.getStatus().publicationVersion, 1);
  assert.ok(versions.includes(1));
  assert.equal(app.calls.social.length, 1, 'a partial batch error does not retry itself');
  assert.equal(app.timerCount(), 0);
  failSecond = false;
  await app.sync.syncNow({ifNeeded: true});
  assert.equal(app.calls.social.length, 1, 'foreground checks retain the cooldown after a public-only failure');
  await app.sync.syncNow();
  assert.equal(app.calls.identity, 2);
  assert.equal(app.calls.commit, 1);
  assert.equal(app.calls.download.length, 0);
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationVersion, 2);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().publicationVersion, 2);
});

test('a large set of already-shared recipe updates drains bounded batches after a single account commit', async () => {
  const recipes = Array.from({length: 9}, (_, index) => recipe('imported-' + index));
  const app = setup({socialEnabled: true, initial: state(recipes)});
  const completed = new Set();
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    assert.equal(app.store.getSyncInfo().dirty, false);
    const pending = app.getRemote().data.recipes.filter(item => !completed.has(item.id));
    const batch = pending.slice(0, 8);
    batch.forEach(item => completed.add(item.id));
    return {updated: batch.length, removed: 0, hasMore: pending.length > batch.length};
  };
  await app.sync.start();
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(completed.size, recipes.length);
  assert.equal(app.calls.social.length, 2);
  assert.equal(app.calls.identity, 1, 'continuing a batch does not repeat account synchronization');
  assert.equal(app.calls.commit, 1);
  assert.equal(app.sync.getStatus().publicationVersion, 2);
  assert.equal(app.timerCount(), 0);
});

test('deletion reconciliation waits for the committed tombstone and invalidates lists for removed-only batches', async () => {
  const app = setup({socialEnabled: true, initial: state([recipe('removed')])});
  let exists = false;
  app.hooks.social = args => {
    assert.deepEqual(copy(args.data), {action: 'syncPublications', expectedOwner: OWNER, expectedScope: {kind: 'personal', id: OWNER}, protocolVersion: 2});
    assert.equal(app.store.getSyncInfo().dirty, false);
    const remote = app.getRemote();
    if (remote.data.recipes.some(item => item.id === 'removed')) {
      const updated = exists ? 0 : 1;
      exists = true;
      return {updated, removed: 0, hasMore: false};
    }
    assert.ok(remote.deleted.recipes.some(item => item.id === 'removed'));
    const removed = exists ? 1 : 0;
    exists = false;
    return {updated: 0, removed, hasMore: false};
  };
  await app.sync.start();
  assert.equal(exists, true);
  assert.equal(app.sync.getStatus().publicationVersion, 1);
  app.store.deleteRecipe('removed');
  await app.sync.syncNow();
  assert.equal(exists, false);
  assert.equal(app.sync.getStatus().state, 'synced');
  assert.equal(app.sync.getStatus().publicationVersion, 2);
  assert.equal(app.calls.commit, 2);
  assert.equal(app.calls.social.length, 2);
  await app.sync.syncNow();
  assert.equal(app.sync.getStatus().publicationVersion, 2, 'retrying an acknowledged removal is a no-op');
  assert.equal(app.calls.commit, 2);
});

test('public reconciliation identity rejection still invalidates the synchronized session', async () => {
  for (const code of ['FAMILY_CHANGED', 'UNAUTHENTICATED']) {
    const app = setup({socialEnabled: true, initial: state([recipe('published')])});
    app.hooks.social = () => ({error: {code}});
    await app.sync.syncNow();
    assert.equal(app.sync.getStatus().state, 'error');
    assert.equal(app.sync.getStatus().identityInvalid, true);
    assert.equal(app.sync.getStatus().publicationPending, false);
  }
});
