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
  const coverSources = new Map(Object.entries(options.coverSources || {}));
  const coverLoader = {getSource: key => coverSources.get(key) || '',
    isReady: () => false, prepare() { return hooks.coverPrepare ? hooks.coverPrepare() : Promise.resolve(false); }};
  const coverModule = {exports: {}};
  vm.runInNewContext(source('recipe-covers.js'), {module: coverModule, require(name) {
    if (name === './cover-loader') return coverLoader;
    if (name === '../data/recipe-cover-catalog') return require('../data/recipe-cover-catalog');
    throw Error(name);
  }});
  const socialModule = {exports: {}};
  vm.runInNewContext(source('social.js'), {module: socialModule, wx, console, ArrayBuffer, Uint8Array,
    require(name) {
      if (name === './store') return store;
      if (name === './cloud-sync') return sync;
      if (name === './recipe-covers') return coverModule.exports;
      if (name === './cover-loader') return coverLoader;
      if (name === './baby-age') return {isValidBirthDate: value => require('../utils/baby-age').isValidBirthDate(value, options.today || '2026-10-29')};
      if (name === './recipe-ages') return require('../utils/recipe-ages');
      if (name === '../config/cloud') return {env: 'social-test', socialEnabled: options.enabled !== false};
      throw Error(name);
    }});
  return {social: socialModule.exports, store, files, hooks, calls, storage, coverSources,
    setSyncOwner(value) { syncOwner = value; }, setSyncState(value) { syncState = value; }};
}

test('saving public recipes retains explicit age groups but never infers them from a starter cover', async () => {
  for (const ageGroups of [undefined, [], ['18+', '9-11', '18+']]) {
    const app = setup();
    app.hooks.request = args => args.data.action === 'recipe' ? {recipe: {...publicRecipe(), imageKey: 'dish:pumpkin-millet',
      ...(ageGroups === undefined ? {} : {ageGroups})}} : undefined;
    const added = await app.social.addToCookbook(PUBLIC_ID);
    const recipe = app.store.getRecipe(added.recipeId);
    if (ageGroups === undefined) assert.equal(Object.hasOwn(recipe, 'ageGroups'), false);
    else assert.deepEqual(copy(recipe.ageGroups), ageGroups.length ? ['9-11', '18+'] : []);
    assert.equal(app.calls.filter(item => item.action === 'download').length, 0);
  }
});

test('invalid public recipe age groups fail before photo download or private writes', async () => {
  for (const ageGroups of [null, '6-8', ['all'], Array(5).fill('6-8')]) {
    const app = setup(), before = copy(app.store.getState());
    app.hooks.request = args => args.data.action === 'recipe' ? {recipe: {...publicRecipe(), ageGroups,
      photoURL: 'https://storage.example/photo'}} : undefined;
    await assert.rejects(app.social.addToCookbook(PUBLIC_ID), /适用月龄/);
    assert.deepEqual(copy(app.store.getState()), before);
    assert.equal(app.files.size, 0); assert.equal(app.calls.filter(item => item.action === 'download').length, 0);
  }
});

test('explicit example publication retains only stored age metadata and missing metadata stays missing', async () => {
  for (const ageGroups of [undefined, [], ['9-11', '12-17']]) {
    const app = setup();
    const snapshot = {version: 1, data: app.store.getState(), deleted: {recipes: [], logs: []}};
    const original = snapshot.data.recipes[0];
    if (ageGroups === undefined) delete original.ageGroups; else original.ageGroups = ageGroups;
    const info = app.store.getSyncInfo();
    app.store.applySyncedSnapshot(snapshot, {owner: OWNER, sequence: info.sequence, revision: 1});
    app.hooks.sync = () => {
      const state = app.store.getSyncInfo();
      if (state.dirty) app.store.applySyncedSnapshot(app.store.getSyncSnapshot(), {owner: OWNER, sequence: state.sequence, revision: state.revision + 1});
    };
    await app.social.publishRecipe(original.id);
    const stored = app.store.getRecipe(original.id);
    if (ageGroups === undefined) assert.equal(Object.hasOwn(stored, 'ageGroups'), false);
    else assert.deepEqual(copy(stored.ageGroups), ageGroups);
    assert.equal(stored.isExample, false);
    assert.deepEqual(app.calls.map(item => item.action), ['sync', 'sync', 'publish']);
    assert.equal(Object.hasOwn(app.calls[2], 'ageGroups'), false, 'the server reads only its authoritative snapshot');
  }
});

test('social writes confirm identity and use it as a backend precondition', async () => {
  const app = setup();
  await app.social.saveProfile({name: ' 小厨房 ', bio: ' 家常辅食 '});
  assert.deepEqual(app.calls, [{action: 'identity'}, {action: 'updateProfile', name: '小厨房', bio: '家常辅食', expectedOwner: OWNER}]);
});

test('public catalog covers render from available cache sources and copying never downloads or deletes that source', async () => {
  const cachedCover = 'wxfile://usr/recipe-cover-cache/carrot-chicken.jpg';
  const app = setup({coverSources: {'dish:carrot-chicken': cachedCover}});
  app.files.set(cachedCover, Buffer.from('already verified cache image'));
  app.hooks.request = async args => {
    const recipe = {...publicRecipe(), imageKey: 'dish:carrot-chicken'};
    if (args.data.action === 'recipe') return {recipe};
    if (['profile', 'feed', 'discover'].includes(args.data.action)) return {recipes: [recipe]};
  };
  const detail = await app.social.getRecipe(PUBLIC_ID);
  assert.equal(detail.recipe.displayPhoto, cachedCover);
  assert.equal(detail.recipe.photoURL, '');
  for (const result of [await app.social.getProfile(PROFILE_ID), await app.social.getFeed(), await app.social.getDiscover()]) {
    assert.equal(result.recipes[0].displayPhoto, detail.recipe.displayPhoto);
  }
  const imported = await app.social.addToCookbook(PUBLIC_ID);
  const stored = app.store.getRecipe(imported.recipeId);
  assert.equal(stored.imageKey, 'dish:carrot-chicken');
  assert.equal(stored.photo, ''); assert.equal(stored.displayPhoto, undefined);
  assert.equal(app.calls.filter(call => call.action === 'download').length, 0);
  assert.ok(app.files.has(cachedCover), 'copying must not remove the shared cover cache');
  assert.doesNotMatch(app.store.exportBackup(), /recipe-cover-cache|displayPhoto/);
});

test('a public starter dish with an uploaded photo preserves and copies that photo ahead of its catalog cover', async () => {
  const app = setup({coverSources: {'dish:carrot-chicken': 'https://storage.example/default-cover'}});
  const photoURL = 'https://storage.example/author-photo?sign=current';
  app.hooks.request = async args => args.data.action === 'recipe'
    ? {recipe: {...publicRecipe(), imageKey: 'dish:carrot-chicken', photoURL}} : undefined;
  const detail = await app.social.getRecipe(PUBLIC_ID);
  assert.equal(detail.recipe.photoURL, photoURL);
  assert.equal(detail.recipe.displayPhoto, undefined);
  const imported = await app.social.addToCookbook(PUBLIC_ID);
  const stored = app.store.getRecipe(imported.recipeId);
  assert.equal(stored.imageKey, 'dish:carrot-chicken');
  assert.match(stored.photo, /^wxfile:\/\/usr\/shared-.+\.png$/);
  assert.deepEqual(app.files.get(stored.photo), PNG);
  assert.deepEqual(app.calls.filter(call => call.action === 'download'), [{action: 'download', url: photoURL}]);
  assert.equal(require('../utils/selectors').enrichRecipe(app.store.getState(), stored).displayPhoto, stored.photo);
  assert.equal(stored.displayPhoto, undefined);
});

test('public reads render ready covers independently and missing sources stay empty through copying', {timeout: 1000}, async () => {
  const signedCover = 'https://storage.example/current-cover-signature';
  const app = setup({coverSources: {'dish:pumpkin-millet': signedCover}});
  app.hooks.coverPrepare = () => new Promise(() => {});
  app.hooks.request = async args => {
    if (args.data.action === 'discover') return {recipes: [
      {...publicRecipe(), imageKey: 'dish:pumpkin-millet'},
      {...publicRecipe(), id: 'e'.repeat(64), imageKey: 'dish:carrot-chicken'}
    ]};
    if (args.data.action === 'recipe') return {recipe: {...publicRecipe(), imageKey: 'dish:carrot-chicken'}};
  };
  const result = await app.social.getDiscover();
  assert.equal(result.recipes[0].displayPhoto, signedCover);
  assert.equal(result.recipes[1].displayPhoto, undefined); assert.equal(result.recipes[1].photoURL, '');
  const imported = await app.social.addToCookbook(PUBLIC_ID), stored = app.store.getRecipe(imported.recipeId);
  assert.equal(stored.imageKey, 'dish:carrot-chicken'); assert.equal(stored.photo, ''); assert.equal(stored.displayPhoto, undefined);
  assert.equal(app.calls.filter(call => call.action === 'download').length, 0);
  assert.doesNotMatch(app.store.exportBackup(), /current-cover-signature|recipe-media\/food|displayPhoto/);
});

test('a user recipe cannot acquire a starter photo from a matching name or generic image key during reads or copying', async () => {
  const app = setup();
  const recipe = {...publicRecipe(), name: '南瓜小米粥', imageKey: 'pumpkin'};
  app.hooks.request = async args => {
    if (args.data.action === 'recipe') return {recipe: {...recipe}};
    if (['profile', 'feed', 'discover'].includes(args.data.action)) return {recipes: [{...recipe}]};
  };
  assert.equal((await app.social.getRecipe(PUBLIC_ID)).recipe.displayPhoto, undefined);
  for (const result of [await app.social.getProfile(PROFILE_ID), await app.social.getFeed(), await app.social.getDiscover()]) {
    assert.equal(result.recipes[0].displayPhoto, undefined);
    assert.equal(result.recipes[0].photoURL, '');
  }
  const imported = await app.social.addToCookbook(PUBLIC_ID);
  const stored = app.store.getRecipe(imported.recipeId);
  assert.equal(stored.photo, '');
  assert.equal(require('../utils/selectors').enrichRecipe(app.store.getState(), stored).displayPhoto, '');
  assert.equal(app.calls.filter(call => call.action === 'download').length, 0);
});

test('public baby age forwards zero, whole months, the upper bound and explicit clearing without changing private data', async () => {
  const app = setup();
  const before = copy(app.store.getState());
  for (const babyAgeMonths of [0, 8, 120, null]) {
    await app.social.saveProfile({name: ' 小厨房 ', bio: ' 家常辅食 ', babyAgeMonths});
  }
  assert.deepEqual(app.calls.filter(call => call.action === 'updateProfile'), [0, 8, 120, null].map(babyAgeMonths => ({
    action: 'updateProfile', name: '小厨房', bio: '家常辅食', babyAgeMonths, expectedOwner: OWNER
  })));
  assert.equal(app.calls.filter(call => call.action === 'identity').length, 4);
  assert.deepEqual(copy(app.store.getState()), before);
});

test('legacy profile saves omit baby age instead of clearing it or carrying a previous request value', async () => {
  const app = setup();
  await app.social.saveProfile({name: '小厨房', bio: '', babyAgeMonths: 8});
  await app.social.saveProfile({name: '修改昵称', bio: '修改简介'});
  const request = app.calls.filter(call => call.action === 'updateProfile')[1];
  assert.deepEqual(request, {action: 'updateProfile', name: '修改昵称', bio: '修改简介', expectedOwner: OWNER});
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'babyAgeMonths'), false);
});

test('invalid public baby ages are rejected before identity lookup or cloud requests', () => {
  const app = setup();
  const before = copy(app.store.getState());
  for (const babyAgeMonths of [-1, 121, 0.5, NaN, Infinity, -Infinity, '8', '', true, false, {}, [], undefined]) {
    assert.throws(() => app.social.saveProfile({name: '小厨房', bio: '', babyAgeMonths}), error =>
      error.code === 'INVALID_BABY_AGE' && /0–120/.test(error.message) && error.userMessage === error.message);
  }
  assert.deepEqual(app.calls, []);
  assert.deepEqual(copy(app.store.getState()), before);
});

test('server baby-age validation uses the same friendly message without exposing diagnostics', async () => {
  const app = setup();
  app.hooks.request = () => ({error: {code: 'INVALID_BABY_AGE', message: 'secret server diagnostic'}});
  await assert.rejects(app.social.saveProfile({name: '小厨房', bio: '', babyAgeMonths: 8}), error =>
    error.code === 'INVALID_BABY_AGE' && /月龄/.test(error.message) && /0–120/.test(error.message) && !/secret/.test(error.message));
});

test('baby birthday forwards valid dates, today and explicit clearing without changing private data', async () => {
  const app = setup({today: '2026-10-29'});
  const before = copy(app.store.getState());
  const birthdays = ['1900-01-01', '2024-02-29', '2026-10-29', null];
  for (const babyBirthDate of birthdays) {
    await app.social.saveProfile({name: ' 小厨房 ', bio: ' 家常辅食 ', babyBirthDate});
  }
  assert.deepEqual(app.calls.filter(call => call.action === 'updateProfile'), birthdays.map(babyBirthDate => ({
    action: 'updateProfile', name: '小厨房', bio: '家常辅食', babyBirthDate, expectedOwner: OWNER
  })));
  assert.equal(app.calls.filter(call => call.action === 'identity').length, birthdays.length);
  assert.deepEqual(copy(app.store.getState()), before);
  assert.equal(JSON.stringify(app.store.getSyncSnapshot()).includes('babyBirthDate'), false);
  assert.equal(app.store.exportBackup().includes('babyBirthDate'), false);
});

test('omitted birthdays remain omitted on later saves and legacy manual age stays supported', async () => {
  const app = setup();
  await app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2026-04-29'});
  await app.social.saveProfile({name: '修改昵称', bio: '修改简介'});
  await app.social.saveProfile({name: '旧版资料', bio: '', babyAgeMonths: 8});
  const updates = app.calls.filter(call => call.action === 'updateProfile');
  assert.deepEqual(updates[1], {action: 'updateProfile', name: '修改昵称', bio: '修改简介', expectedOwner: OWNER});
  assert.deepEqual(updates[2], {action: 'updateProfile', name: '旧版资料', bio: '', babyAgeMonths: 8, expectedOwner: OWNER});
  assert.equal(Object.prototype.hasOwnProperty.call(updates[1], 'babyBirthDate'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[2], 'babyBirthDate'), false);
});

test('malformed, impossible, too early and future birthdays fail before identity or cloud requests', () => {
  const app = setup({today: '2026-10-29'});
  const before = copy(app.store.getState());
  const invalid = ['1899-12-31', '1900-02-29', '2025-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '2026-1-01', '2026-01-1', '2026-10-30', '9999-12-31', '2026-10-29T00:00:00Z',
    ' 2026-10-29 ', '', 'not-a-date', 20261029, true, false, {}, [], undefined];
  for (const babyBirthDate of invalid) {
    assert.throws(() => app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate}), error =>
      error.code === 'INVALID_BABY_BIRTH_DATE' && error.message === '请选择有效的宝宝生日，不能晚于今天。' &&
      error.userMessage === error.message);
  }
  assert.deepEqual(app.calls, []);
  assert.deepEqual(copy(app.store.getState()), before);
});

test('birthday date validation uses the supplied current-day boundary rather than a fixed calendar date', async () => {
  const app = setup({today: '2027-01-01'});
  await app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2027-01-01'});
  assert.throws(() => app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2027-01-02'}), error =>
    error.code === 'INVALID_BABY_BIRTH_DATE');
  assert.equal(app.calls.filter(call => call.action === 'updateProfile').length, 1);
});

test('server birthday validation maps to the friendly message without exposing private diagnostics', async () => {
  const app = setup();
  app.hooks.request = () => ({error: {code: 'INVALID_BABY_BIRTH_DATE', message: 'secret birth date diagnostic'}});
  await assert.rejects(app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2026-04-29'}), error =>
    error.code === 'INVALID_BABY_BIRTH_DATE' && error.message === '请选择有效的宝宝生日，不能晚于今天。' &&
    error.userMessage === error.message && !/secret/.test(error.message));
});

test('account changes during identity prevent sending a birthday update, including A to B to A switches', async () => {
  for (const returnToOriginal of [false, true]) {
    const app = setup();
    const before = copy(app.store.getState());
    app.hooks.identity = () => {
      app.store.bindAccount(OTHER);
      if (returnToOriginal) app.store.bindAccount(OWNER);
      return {owner: returnToOriginal ? OWNER : OTHER, revision: 0, fileID: ''};
    };
    await assert.rejects(app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2026-04-29'}), error =>
      error.code === 'ACCOUNT_CHANGED');
    assert.deepEqual(app.calls.map(call => call.action), ['identity']);
    app.store.bindAccount(OWNER);
    assert.deepEqual(copy(app.store.getState()), before);
  }
});

test('account changes during a birthday response reject stale profile data and retain the request owner', async () => {
  const app = setup();
  const before = copy(app.store.getState());
  app.hooks.request = () => {
    app.store.bindAccount(OTHER);
    return {profile: {id: PROFILE_ID, name: '旧账号', babyBirthDate: '2026-04-29', babyAgeMonths: 6}};
  };
  await assert.rejects(app.social.saveProfile({name: '小厨房', bio: '', babyBirthDate: '2026-04-29'}), error =>
    error.code === 'ACCOUNT_CHANGED');
  assert.deepEqual(app.calls.find(call => call.action === 'updateProfile'), {
    action: 'updateProfile', name: '小厨房', bio: '', babyBirthDate: '2026-04-29', expectedOwner: OWNER
  });
  app.store.bindAccount(OWNER);
  assert.deepEqual(copy(app.store.getState()), before);
});

test('discovery and share-code requests confirm identity and validate user-controlled arguments', async () => {
  const app = setup();
  await app.social.getDiscover({search: ' 南瓜 ', cursor: 'a-cursor'});
  await app.social.getShareCode(PROFILE_ID, 'trial');
  assert.deepEqual(app.calls, [{action: 'identity'}, {action: 'discover', search: '南瓜', cursor: 'a-cursor', expectedOwner: OWNER},
    {action: 'identity'}, {action: 'shareCode', profileId: PROFILE_ID, envVersion: 'trial', expectedOwner: OWNER}]);
  for (const input of [null, {search: 'x'.repeat(61)}, {cursor: {}}, {cursor: 'x'.repeat(4001)}]) {
    assert.throws(() => app.social.getDiscover(input), error => error.code === 'INVALID_INPUT');
  }
  assert.throws(() => app.social.getShareCode('private-owner', 'trial'));
  assert.throws(() => app.social.getShareCode(PROFILE_ID, 'unknown'));
  assert.equal(app.calls.length, 4);
});

test('unpublished QR and server account-switch failures expose safe messages without sensitive diagnostics', async () => {
  const app = setup();
  app.hooks.request = async () => ({error: {code: 'SHARE_CODE_NOT_PUBLISHED', message: 'secret diagnostic'}});
  await assert.rejects(app.social.getShareCode(PROFILE_ID, 'release'), error => /尚未发布/.test(error.message) && !/secret/.test(error.message));
  app.hooks.request = async () => ({error: {code: 'ACCOUNT_CHANGED'}});
  await assert.rejects(app.social.getShareCode(PROFILE_ID, 'trial'), error => error.code === 'ACCOUNT_CHANGED');
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

test('profile moderation errors explain the rejected field or retry without leaking provider diagnostics', async () => {
  const messages = {
    PROFILE_NAME_REJECTED: '昵称未通过内容审核，请修改后重试。',
    PROFILE_BIO_REJECTED: '简介未通过内容审核，请修改后重试。',
    PROFILE_MODERATION_UNAVAILABLE: '内容审核暂时不可用，资料尚未保存，请稍后重试。'
  };
  for (const [code, message] of Object.entries(messages)) {
    const app = setup();
    app.hooks.request = () => ({error: {code, message: 'secret openid and provider diagnostics'}});
    await assert.rejects(app.social.saveProfile({name: '小厨房', bio: '今天的辅食'}), error =>
      error.code === code && error.userMessage === message && error.message === message);
  }
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
