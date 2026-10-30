'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {evaluatePage} = require('./page-runtime.cjs');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const input = value => ({detail: {value}});
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const PUBLIC = {id: 'a'.repeat(32), name: '公开厨房', bio: '公开介绍', exists: true};

function setup(options = {}) {
  let owner = 'owner-a', failPrivate = false, savedProfile = {...PUBLIC, ...options.profile};
  const state = {nickname: '小豆豆', recipes: [], logs: []}, listeners = new Set();
  const calls = {public: [], private: [], order: [], errors: [], toasts: [], reads: 0, mine: 0, updates: 0, codes: 0, backs: 0, events: []};
  const store = options.store || {
    getSyncInfo: () => ({owner}), getState() { calls.reads++; return clone(state); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setNickname(value) {
      calls.private.push(value); calls.order.push('private');
      if (failPrivate) throw Error('本机存储失败');
      if (!value.trim() || value.trim().length > 20) throw Error('宝宝称呼请填写 1–20 个字。');
      state.nickname = value.trim(); listeners.forEach(fn => fn());
      if (options.afterPrivate) options.afterPrivate(fixture);
      return state.nickname;
    }
  };
  const wx = {showShareMenu() {}, hideShareMenu() {}, showToast(value) { calls.toasts.push(value.title); },
    getAccountInfoSync: () => ({miniProgram: {envVersion: 'develop'}}), navigateBack() { calls.backs++; }};
  const social = {
    async getMine() { calls.mine++; if (options.offline) throw Error('离线'); return {profile: clone(savedProfile), published: []}; },
    async getProfile() { return {profile: clone(savedProfile), isSelf: !options.visitor, recipes: [], nextOffset: null}; },
    async saveProfile(value) {
      calls.public.push(clone(value)); calls.order.push('public-start');
      if (options.save) await options.save(value);
      savedProfile = {...savedProfile, ...value, exists: true}; calls.order.push('public-done');
      return options.noSaveResult ? undefined : {profile: clone(savedProfile)};
    },
    async getShareCode() { calls.codes++; return {codeURL: 'https://example.test/code'}; }
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require: () => store});
  let definition, pages;
  evaluatePage(options.visitor || options.returnAfterSave ? 'profile' : 'mine', {
    wx, socialEnabled: options.socialEnabled, getCurrentPages: () => pages, Page(value) { definition = value; }, require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-poster')) return {remove() {}, render: async () => '/tmp/mock-poster.png'};
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, route: 'pages/profile/index', data: clone(definition.data),
    setData(value) { calls.updates++; Object.assign(this.data, clone(value)); if (options.afterSetData) options.afterSetData(value, fixture); },
    getOpenerEventChannel: () => ({emit(value) { calls.events.push(value); }})};
  pages = [{route: 'pages/detail/index'}, page];
  const fixture = {page, calls, state, store, listeners,
    changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); },
    failPrivate(value = true) { failPrivate = value; }};
  page.onLoad(options.visitor ? {id: PUBLIC.id} : options.returnAfterSave ? {edit: '1', returnToRecipe: '1'} : {});
  return fixture;
}

async function editing(options) { const fixture = setup(options); await fixture.page.load(); fixture.page.edit(); return fixture; }

function assertPrivateCleared(page) {
  assert.equal(page.data.babyNickname, ''); assert.equal(page.data.babyNicknameBase, '');
  assert.equal(page.data.babyNicknameDirty, false); assert.equal(page.data.babyNicknameError, '');
}

test('baby nickname editor loads the existing private name, keeps public name separate, and cancel discards only the draft', async () => {
  const {page, state, calls} = await editing();
  assert.equal(page.data.name, PUBLIC.name); assert.equal(page.data.babyNickname, '小豆豆');
  page.changeBabyNickname(input('小团子')); assert.equal(page.data.babyNicknameDirty, true);
  await page.onShow(); assert.equal(page.data.babyNickname, '小团子');
  page.cancelEdit(); assert.equal(state.nickname, '小豆豆'); assertPrivateCleared(page);
  page.edit(); assert.equal(page.data.babyNickname, '小豆豆');
  page.changeBabyNickname(input(' 小豆豆 ')); assert.equal(page.data.babyNicknameDirty, false);
  assert.deepEqual(calls.public, []); assert.deepEqual(calls.private, []);
});

test('private-only save trims the name, does not create a public profile or reload it, and empty input defaults to 宝宝', async () => {
  const {page, state, calls} = await editing({profile: {exists: false, name: '小胡萝卜1233'}});
  const reads = calls.mine;
  page.changeBabyNickname(input(' 小团子 ')); await page.save();
  assert.equal(state.nickname, '小团子'); assert.deepEqual(calls.private, ['小团子']);
  assert.deepEqual(calls.public, []); assert.equal(calls.mine, reads); assert.equal(page.data.profile.exists, false);
  assert.equal(page.data.editing, false); assertPrivateCleared(page);
  page.edit(); page.changeBabyNickname(input('   ')); await page.save();
  assert.equal(state.nickname, '宝宝'); assert.deepEqual(calls.toasts, ['宝宝称呼已保存', '宝宝称呼已保存']);
});

test('no-change save keeps existing public-save semantics and never rewrites an untouched private name', async () => {
  const {page, calls} = await editing({profile: {exists: false}});
  await page.save();
  assert.deepEqual(calls.public, [{name: PUBLIC.name, bio: PUBLIC.bio}]);
  assert.deepEqual(calls.private, []); assert.equal(page.data.profile.exists, true);
});

test('public fields and private nickname save in order and the private field never enters the public DTO', async () => {
  const {page, calls, state} = await editing();
  page.changeName(input(' 新厨房 ')); page.changeBabyNickname(input('小团子'));
  page.changeBabyBirthDate(input('2025-01-01')); await page.save();
  assert.deepEqual(calls.order, ['public-start', 'public-done', 'private']);
  assert.deepEqual(calls.public, [{name: '新厨房', bio: PUBLIC.bio, babyBirthDate: '2025-01-01'}]);
  assert.doesNotMatch(JSON.stringify(calls.public), /babyNickname|nickname|小团子|小豆豆/);
  assert.equal(state.nickname, '小团子'); assert.deepEqual(calls.toasts, ['资料已保存']);
});

test('public failure keeps both drafts and never writes the private name', async () => {
  const {page, calls, state} = await editing({save: async () => { throw Error('公开保存失败'); }});
  page.changeName(input('新厨房')); page.changeBabyNickname(input('小团子')); await page.save();
  assert.equal(state.nickname, '小豆豆'); assert.deepEqual(calls.private, []);
  assert.equal(page.data.editing, true); assert.equal(page.data.name, '新厨房'); assert.equal(page.data.babyNickname, '小团子');
  assert.equal(page.data.profile.name, PUBLIC.name); assert.equal(page.data.saving, false);
  assert.deepEqual(calls.toasts, []); assert.deepEqual(calls.errors, ['公开保存失败']);
});

test('partial failure accepts saved public values and retries only the private name without a false success', async () => {
  const f = await editing(); f.failPrivate();
  f.page.changeName(input('新厨房')); f.page.changeBabyNickname(input('小团子')); f.page.changeBabyBirthDate(input('2025-01-01'));
  await f.page.save();
  assert.equal(f.page.data.profile.name, '新厨房'); assert.equal(f.page.data.birthdayDirty, false);
  assert.equal(f.page.data.profile.babyBirthDate, '2025-01-01'); assert.equal(f.state.nickname, '小豆豆');
  assert.equal(f.page.data.editing, true); assert.equal(f.page.data.babyNicknameDirty, true); assert.equal(f.page.data.babyNickname, '小团子');
  assert.equal(f.page.data.babyNicknameError, '主页已保存，宝宝称呼未保存，请重试');
  assert.equal(f.page.data.saving, false); assert.deepEqual(f.calls.toasts, []);
  f.failPrivate(false); await f.page.save();
  assert.equal(f.calls.public.length, 1); assert.deepEqual(f.calls.private, ['小团子', '小团子']);
  assert.equal(f.state.nickname, '小团子'); assert.equal(f.page.data.editing, false); assert.deepEqual(f.calls.toasts, ['资料已保存']);
});

test('private-only failure stays editable and retries without any public request', async () => {
  const f = await editing(); f.failPrivate(); f.page.changeBabyNickname(input('小团子')); await f.page.save();
  assert.equal(f.page.data.editing, true); assert.equal(f.page.data.babyNicknameDirty, true);
  assert.equal(f.page.data.babyNicknameError, '本机存储失败'); assert.deepEqual(f.calls.public, []); assert.deepEqual(f.calls.toasts, []);
  f.failPrivate(false); await f.page.save(); assert.equal(f.state.nickname, '小团子'); assert.equal(f.calls.public.length, 0);
});

test('private nickname remains editable offline while unknown public fields cannot be submitted', async () => {
  const {page, calls, state} = await editing({offline: true});
  assert.equal(page.data.profile, null); assert.equal(page.data.editing, true);
  const reads = calls.mine;
  page.changeName(input('不应发送')); page.changeBio(input('不应发送')); page.changeBabyBirthDate(input('2025-01-01'));
  assert.equal(page.data.name, ''); assert.equal(page.data.bio, ''); assert.equal(page.data.birthdayDirty, false);
  page.changeBabyNickname(input('离线称呼')); await page.save();
  assert.equal(state.nickname, '离线称呼'); assert.equal(calls.mine, reads); assert.deepEqual(calls.public, []);
  assert.equal(page.data.editing, false); assert.deepEqual(calls.toasts, ['宝宝称呼已保存']);
});

test('turning off social features keeps private nickname editing available without public API calls', async () => {
  const {page, calls, state} = await editing({socialEnabled: false});
  page.changeName(input('不应发送')); page.changeBabyBirthDate(input('2025-01-01'));
  assert.equal(page.data.name, '我的小口袋'); assert.equal(page.data.birthdayDirty, false);
  page.changeBabyNickname(input('私人称呼')); await page.save();
  assert.equal(state.nickname, '私人称呼'); assert.equal(calls.mine, 0); assert.deepEqual(calls.public, []);
});

test('visitors never read or mutate the private nickname and native sharing excludes it', async () => {
  const {page, calls} = setup({visitor: true}); await page.load(); page.edit(); page.changeBabyNickname(input('访客输入')); await page.save();
  assert.equal(calls.reads, 0); assertPrivateCleared(page); assert.deepEqual(calls.private, []); assert.deepEqual(calls.public, []);
  assert.equal(page.data.editing, false); assert.doesNotMatch(JSON.stringify(page.onShareAppMessage()), /小豆豆|babyNickname/);
});

test('refresh accepts a remote private-name update only while the editor draft is untouched', async () => {
  const {page, state, calls} = await editing();
  state.nickname = '另一端称呼'; page.refresh(); assert.equal(page.data.babyNickname, '另一端称呼'); assert.equal(page.data.babyNicknameDirty, false);
  page.changeBabyNickname(input('本地草稿')); state.nickname = '更新的远端称呼'; page.refresh();
  assert.equal(page.data.babyNickname, '本地草稿'); assert.equal(page.data.babyNicknameDirty, true);
  page.cancelEdit(); page.edit(); assert.equal(page.data.babyNickname, '更新的远端称呼');
  page.changeBio(input('只改公开介绍')); await page.save();
  assert.deepEqual(calls.private, []); assert.equal(state.nickname, '更新的远端称呼');
});

test('oversized private drafts fail before any public write and no input changes during a pending save', async () => {
  const pending = deferred(), f = await editing({save: () => pending.promise});
  f.page.changeBabyNickname(input('字'.repeat(21))); f.page.changeName(input('新厨房')); await f.page.save();
  assert.deepEqual(f.calls.public, []); assert.deepEqual(f.calls.private, []); assert.match(f.calls.errors[0], /1–20/);
  f.page.changeBabyNickname(input('小团子')); const saving = f.page.save();
  f.page.changeBabyNickname(input('不接受')); f.page.cancelEdit(); await f.page.save();
  assert.equal(f.page.data.babyNickname, '小团子'); assert.equal(f.page.data.editing, true); assert.equal(f.calls.public.length, 1);
  pending.resolve(); await saving; assert.equal(f.state.nickname, '小团子');
});

test('account changes before save or during public await clear drafts and never write to the next account', async t => {
  for (const phase of ['before', 'await']) await t.test(phase, async () => {
    const pending = deferred(), f = await editing({save: () => pending.promise});
    f.page.changeName(input('新厨房')); f.page.changeBabyNickname(input('小团子'));
    if (phase === 'before') f.changeOwner('owner-b', false);
    const saving = f.page.save();
    if (phase === 'await') f.changeOwner('owner-b', false);
    pending.resolve(); await saving;
    assertPrivateCleared(f.page); assert.equal(f.page.data.editing, false); assert.deepEqual(f.calls.private, []); assert.deepEqual(f.calls.toasts, []);
    assert.equal(f.calls.public.length, phase === 'before' ? 0 : 1);
  });
});

test('identity is checked again after accepting the public response and after the synchronous private commit', async t => {
  await t.test('between public and private', async () => {
    const f = await editing({afterSetData(update, fixture) {
      if (update.profile && update.profile.name === '新厨房') fixture.changeOwner('owner-b', false);
    }});
    f.page.changeName(input('新厨房')); f.page.changeBabyNickname(input('小团子')); await f.page.save();
    assert.deepEqual(f.calls.private, []); assert.deepEqual(f.calls.toasts, []); assertPrivateCleared(f.page);
  });
  await t.test('after private commit', async () => {
    const f = await editing({afterPrivate(fixture) { fixture.changeOwner('owner-b'); }});
    f.page.changeBabyNickname(input('小团子')); await f.page.save();
    assert.deepEqual(f.calls.private, ['小团子']); assert.deepEqual(f.calls.toasts, []); assertPrivateCleared(f.page);
  });
});

test('unload and newer requests prevent late saves from writing a private draft', async t => {
  for (const phase of ['unload', 'reload']) await t.test(phase, async () => {
    const pending = deferred(), f = await editing({save: () => pending.promise});
    f.page.changeName(input('新厨房')); f.page.changeBabyNickname(input('小团子')); const saving = f.page.save();
    if (phase === 'unload') f.page.onUnload(); else await f.page.load();
    pending.resolve(); await saving;
    assert.deepEqual(f.calls.private, []); assert.deepEqual(f.calls.toasts, []);
  });
});

test('sharing and returning to a recipe still create a profile before private-only edits complete', async t => {
  for (const returning of [false, true]) await t.test(returning ? 'return' : 'share', async () => {
    const f = await editing({profile: {exists: false}, returnAfterSave: returning, noSaveResult: true});
    if (!returning) { f.page.cancelEdit(); await f.page.requestShare(); }
    f.page.changeBabyNickname(input('小团子')); f.failPrivate(); await f.page.save();
    assert.equal(f.calls.public.length, 1); assert.equal(f.calls.codes, 0); assert.equal(f.calls.backs, 0);
    assert.equal(f.page.data.profile.exists, true); f.failPrivate(false); await f.page.save();
    assert.equal(f.calls.public.length, 1, 'retry must not save the already accepted public profile twice');
    if (returning) { assert.equal(f.calls.backs, 1); assert.deepEqual(f.calls.events, ['profileSaved']); }
    else { assert.equal(f.calls.codes, 1); assert.equal(f.page.data.shareVisible, true); }
  });
});

test('actual store nickname persistence preserves the private sync dirty flag and atomic failure behavior', async () => {
  const storage = new Map([['baby-bites-v1', {version: 1, nickname: '原称呼', profileUpdatedAt: 1, recipes: [], logs: []}]]);
  let fail = false, notifications = 0;
  const storeFile = path.join(__dirname, '../utils/store.js'), storeModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(storeFile, 'utf8'), {module: storeModule, require: createRequire(storeFile), Date, Map, Set,
    wx: {getStorageSync: key => clone(storage.get(key)), setStorageSync(key, value) { if (fail) throw Error('存储已满'); storage.set(key, clone(value)); }}});
  const store = storeModule.exports; store.init(); store.subscribe(() => notifications++);
  const f = await editing({store}); f.page.changeBabyNickname(input(' 新称呼 ')); await f.page.save();
  assert.equal(store.getState().nickname, '新称呼'); assert.equal(store.getSyncInfo().dirty, true); assert.equal(notifications, 1);
  assert.equal(storage.get('baby-bites-v1').nickname, '新称呼'); assert.ok(store.getState().profileUpdatedAt > 1); assert.deepEqual(f.calls.public, []);
  const before = clone(storage.get('baby-bites-v1')); fail = true; f.page.edit(); f.page.changeBabyNickname(input('未保存称呼')); await f.page.save();
  assert.equal(store.getState().nickname, '新称呼'); assert.deepEqual(storage.get('baby-bites-v1'), before); assert.equal(notifications, 1);
  assert.equal(f.page.data.editing, true); assert.equal(f.page.data.babyNickname, '未保存称呼');
});

const moderationError = (code, message) => Object.assign(Error(message), {code, userMessage: message});

test('profile moderation failures persist beside Save, retain all drafts, and never commit the private nickname', async t => {
  for (const [code, message] of [
    ['PROFILE_NAME_REJECTED', '公开昵称未通过内容审核，请修改后重试。'],
    ['PROFILE_BIO_REJECTED', '简介未通过内容审核，请修改后重试。'],
    ['PROFILE_MODERATION_UNAVAILABLE', '内容审核暂时不可用，请稍后重试。']
  ]) await t.test(code, async () => {
    const f = await editing({save: async () => { throw moderationError(code, message); }});
    f.page.changeName(input('待审核昵称')); f.page.changeBio(input('待审核介绍'));
    f.page.changeBabyNickname(input('私人草稿')); f.page.changeBabyBirthDate(input('2025-01-01'));
    const drafts = () => clone({name: f.page.data.name, bio: f.page.data.bio, babyNickname: f.page.data.babyNickname,
      babyNicknameDirty: f.page.data.babyNicknameDirty, babyBirthDate: f.page.data.babyBirthDate,
      birthdayDirty: f.page.data.birthdayDirty, birthdayAgeLabel: f.page.data.birthdayAgeLabel});
    const before = drafts(), originalProfile = clone(f.page.data.profile);
    await f.page.save();
    assert.equal(f.page.data.profileSaveError, message); assert.equal(f.page.data.editing, true);
    assert.equal(f.page.data.saving, false); assert.equal(f.page.data.profileModerating, false);
    assert.deepEqual(drafts(), before); assert.deepEqual(f.page.data.profile, originalProfile);
    assert.equal(f.state.nickname, '小豆豆'); assert.deepEqual(f.calls.private, []);
    assert.deepEqual(f.calls.toasts, []); assert.deepEqual(f.calls.events, []); assert.equal(f.calls.codes, 0);
    const mineReads = f.calls.mine;
    await f.page.onShow(); f.page.refresh();
    assert.equal(f.calls.mine, mineReads); assert.equal(f.page.data.profileSaveError, message);
    assert.deepEqual(drafts(), before);
    f.page.changeBabyNickname(input('另一个私人草稿'));
    assert.equal(f.page.data.profileSaveError, message, 'editing another field must not hide the rejection');
    f.page.cancelEdit(); assert.equal(f.page.data.profileSaveError, '');
    f.page.edit(); assert.equal(f.page.data.profileSaveError, ''); assert.equal(f.page.data.name, PUBLIC.name);
    assert.equal(f.page.data.babyNickname, '小豆豆');
  });
});

test('retrying after moderation rejection clears the old error while review is pending and saves only after acceptance', async () => {
  const approved = deferred(); let attempts = 0;
  const f = await editing({save: () => ++attempts === 1
    ? Promise.reject(moderationError('PROFILE_NAME_REJECTED', '请修改公开昵称后重试。')) : approved.promise});
  f.page.changeName(input('待修改昵称')); f.page.changeBabyNickname(input('私人草稿'));
  await f.page.save(); assert.notEqual(f.page.data.profileSaveError, '');
  f.page.changeName(input('新的公开昵称'));
  const saving = f.page.save();
  assert.equal(f.page.data.saving, true); assert.equal(f.page.data.profileModerating, true);
  assert.equal(f.page.data.profileSaveError, ''); assert.deepEqual(f.calls.private, []);
  f.page.cancelEdit(); await f.page.save();
  f.page.changeName(input('保存时不接受新草稿')); f.page.changeBio(input('保存时不接受新介绍'));
  f.page.changeBabyNickname(input('保存时不接受称呼')); f.page.changeBabyBirthDate(input('2025-01-01'));
  assert.equal(f.page.data.editing, true); assert.equal(f.calls.public.length, 2);
  assert.equal(f.page.data.name, '新的公开昵称'); assert.equal(f.page.data.bio, PUBLIC.bio);
  assert.equal(f.page.data.babyNickname, '私人草稿'); assert.equal(f.page.data.birthdayDirty, false);
  approved.resolve(); await saving;
  assert.equal(f.state.nickname, '私人草稿'); assert.deepEqual(f.calls.private, ['私人草稿']);
  assert.deepEqual(f.calls.order, ['public-start', 'public-start', 'public-done', 'private']);
  assert.equal(f.page.data.editing, false); assert.equal(f.page.data.profileModerating, false);
  assert.equal(f.page.data.profileSaveError, ''); assert.deepEqual(f.calls.toasts, ['资料已保存']);
});

test('private-only nickname saves never enter public moderation or claim to be under review', async () => {
  const states = [];
  const f = await editing({profile: {exists: false}, afterSetData(update) {
    if (update.saving === true) states.push(update.profileModerating);
  }});
  f.page.changeBabyNickname(input('仅私人称呼')); await f.page.save();
  assert.deepEqual(states, [false]); assert.deepEqual(f.calls.public, []);
  assert.equal(f.page.data.profile.exists, false); assert.equal(f.page.data.profileModerating, false);
  assert.equal(f.page.data.profileSaveError, ''); assert.equal(f.state.nickname, '仅私人称呼');
});

test('a pending moderation rejection cannot restore old errors or drafts after account replacement, unload or reload', async t => {
  for (const phase of ['switch', 'unnotified-switch', 'A-B-A', 'unload', 'reload']) await t.test(phase, async () => {
    const pending = deferred(), f = await editing({save: () => pending.promise});
    f.page.changeName(input('旧账号昵称')); f.page.changeBabyNickname(input('旧账号称呼'));
    const saving = f.page.save(); assert.equal(f.page.data.profileModerating, true);
    if (phase === 'unload') f.page.onUnload();
    else if (phase === 'reload') await f.page.load();
    else { f.changeOwner('owner-b', phase !== 'unnotified-switch'); if (phase === 'A-B-A') f.changeOwner('owner-a'); }
    const updates = f.calls.updates;
    pending.reject(moderationError('PROFILE_NAME_REJECTED', '旧账号的审核结果')); await saving;
    assert.equal(f.page.data.profileSaveError, ''); assert.deepEqual(f.calls.private, []);
    assert.deepEqual(f.calls.errors, []); assert.deepEqual(f.calls.toasts, []);
    if (phase !== 'unnotified-switch') assert.equal(f.calls.updates, updates);
    if (phase !== 'unload') assert.equal(f.page.data.profileModerating, false);
    if (['switch', 'unnotified-switch', 'A-B-A'].includes(phase)) assertPrivateCleared(f.page);
  });
});

test('account invalidation clears a displayed moderation error and service identity mismatch closes the editor', async () => {
  const rejected = await editing({save: async () => { throw moderationError('PROFILE_BIO_REJECTED', '请修改简介'); }});
  rejected.page.changeBio(input('待修改介绍')); await rejected.page.save();
  assert.equal(rejected.page.data.profileSaveError, '请修改简介');
  rejected.changeOwner('owner-b'); assert.equal(rejected.page.data.profileSaveError, '');
  assert.equal(rejected.page.data.profileModerating, false); assert.equal(rejected.page.data.editing, false);
  const mismatch = await editing({save: async () => { throw Object.assign(Error('微信账号已切换'), {code: 'ACCOUNT_CHANGED'}); }});
  mismatch.page.changeName(input('新昵称')); await mismatch.page.save();
  assert.equal(mismatch.page.data.editing, false); assert.equal(mismatch.page.data.profile, null);
  assert.equal(mismatch.page.data.profileSaveError, ''); assert.equal(mismatch.page.data.profileModerating, false);
  assert.match(mismatch.page.data.error, /账号已切换/); assert.deepEqual(mismatch.calls.private, []);
});
