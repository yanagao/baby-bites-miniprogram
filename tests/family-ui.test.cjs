'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64), FAMILY = 'c'.repeat(64), MEMBER = 'd'.repeat(32);
const personal = {kind: 'personal', id: OWNER};
const shared = {kind: 'family', id: FAMILY, membershipId: MEMBER};
const key = scope => scope.kind + ':' + scope.id + ':' + (scope.membershipId || '');
const change = value => ({detail: {value}});
const tap = id => ({currentTarget: {dataset: {id}}});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const group = (overrides = {}) => ({id: FAMILY, name: '宝宝的小家庭', isManager: true, memberId: MEMBER,
  membershipId: MEMBER, memberCount: 2, members: [{id: MEMBER, label: '妈妈', isSelf: true, isManager: true},
    {id: 'e'.repeat(32), label: '爸爸', isSelf: false, isManager: false}], ...overrides});
function setup(options = {}) {
  let owner = OWNER, scope = options.family ? shared : personal, family = options.family || null;
  let state = {nickname: '团团', babyBirthDate: '2025-01-01', recipes: [], logs: [], allergies: ['鸡蛋']};
  const hooks = {}, listeners = new Set();
  const calls = {info: 0, create: [], preview: [], join: [], invite: 0, role: [], remove: [], transfer: [], leave: 0, baby: [], clipboard: [], toast: []};
  const store = {getSyncInfo: () => ({owner, scope, scopeKey: key(scope)}), getState: () => clone(state), getWarning: () => '',
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, setBabyProfile(patch) {calls.baby.push(clone(patch)); Object.assign(state, patch); listeners.forEach(fn => fn(store.getSyncInfo()));}};
  const result = () => ({owner, scope: clone(scope), family: clone(family)});
  const setScope = value => {scope = value; listeners.forEach(fn => fn(store.getSyncInfo()));};
  const service = {
    async info() {calls.info++; return hooks.info ? hooks.info() : result();},
    async create(input) {calls.create.push(clone(input)); if (hooks.create) return hooks.create(input); family = group({memberCount: 1, members: [group().members[0]]}); setScope(shared); return result();},
    async preview(token) {calls.preview.push(token); return hooks.preview ? hooks.preview(token) : {name: '团团的小家庭', nickname: '团团', memberCount: 2, expiresAt: Date.now() + 86400000};},
    async join(input) {calls.join.push(clone(input)); if (hooks.join) return hooks.join(input); family = group({isManager: false}); setScope(shared); return result();},
    async invite() {calls.invite++; return hooks.invite ? hooks.invite() : {token: 'valid-family-invite-token', expiresAt: Date.now() + 86400000};},
    async changeRole(input) {calls.role.push(clone(input)); family.members[0].label = input.label; return result();},
    async remove(id) {calls.remove.push(id); return result();}, async transfer(id) {calls.transfer.push(id); return result();},
    async leave() {calls.leave++; if (hooks.leave) return hooks.leave(); family = null; setScope(personal); return result();}
  };
  let definition;
  const wx = {showShareMenu() {}, showToast(value) {calls.toast.push(value.title);}, setClipboardData(value) {calls.clipboard.push(value.data);}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/family/index.js'), 'utf8'), {wx, Page(value) {definition = value;}, require(name) {
    if (name.endsWith('/family')) return service;
    if (name.endsWith('/store')) return store;
    if (name.endsWith('/ui')) return {back() {}};
    if (name.endsWith('/baby-age')) return require('../utils/baby-age');
    throw Error(name);
  }});
  const page = {...definition, data: clone(definition.data), setData(update) {Object.assign(this.data, clone(update));}};
  page.onLoad(options.query || {});
  return {page, calls, hooks, store, listeners, setScope, setState(patch) {Object.assign(state, patch);},
    changeOwner(value) {owner = value; listeners.forEach(fn => fn(store.getSyncInfo()));}};
}

test('opening family page is read-only and create requires scope confirmation plus a chosen relation', async () => {
  const app = setup(); await app.page.onShow();
  assert.equal(app.calls.create.length, 0); assert.equal(app.calls.invite, 0);
  app.page.create(); assert.match(app.page.data.actionError, /关系/);
  app.page.changeRole(change('妈妈')); app.page.create();
  assert.equal(app.page.data.confirmVisible, true); assert.match(app.page.data.confirmText, /过敏食物/);
  assert.equal(app.calls.create.length, 0);
  app.page.cancelConfirm(); await app.page.confirmOperation(); assert.equal(app.calls.create.length, 0);
  app.page.create(); await app.page.confirmOperation();
  assert.equal(app.calls.create.length, 1); assert.equal(app.page.data.family.id, FAMILY); assert.equal(app.page.locked, false);
});

test('create failures preserve fields and retries reuse the same operation identity', async () => {
  const app = setup(); await app.page.onShow(); app.page.changeRole(change('爸爸'));
  app.hooks.create = async () => {throw Error('同步尚未完成');};
  app.page.create(); await app.page.confirmOperation();
  assert.equal(app.page.data.family, null); assert.match(app.page.data.actionError, /同步尚未完成/);
  app.page.create(); await app.page.confirmOperation();
  assert.equal(app.calls.create[0].requestId, app.calls.create[1].requestId);
  assert.equal(app.page.data.roleLabel, '爸爸');
});

test('creating the same family again after dissolution uses a fresh operation identity', async () => {
  for (const lostResponse of [false, true]) {
    const app = setup();
    await app.page.onShow();
    app.page.changeRole(change('妈妈'));
    if (lostResponse) app.hooks.create = () => {throw Error('请求超时');};
    app.page.create(); await app.page.confirmOperation();
    if (lostResponse) {
      // A later membership refresh can confirm a creation whose response was lost.
      delete app.hooks.create;
      app.setScope(shared);
      app.hooks.info = () => ({family: group({memberCount: 1, members: [group().members[0]]})});
      await app.page.reload();
    }
    app.page.leave(); await app.page.confirmOperation();
    assert.equal(app.page.data.family, null);
    app.page.changeName(change('宝宝的小家庭'));
    app.page.create(); await app.page.confirmOperation();
    const [first, second] = app.calls.create;
    assert.equal(second.name, first.name);
    assert.equal(second.label, first.label);
    assert.notEqual(second.requestId, first.requestId);
    assert.equal(app.page.data.family.memberCount, 1);
  }
});

test('opening an invite previews only and joins only after explicit confirmation', async () => {
  const app = setup({query: {token: 'given-token'}}); await app.page.onShow();
  assert.deepEqual(app.calls.preview, ['given-token']); assert.equal(app.calls.join.length, 0);
  app.page.changeRole(change('姥姥')); app.page.join();
  assert.match(app.page.data.confirmText, /不会自动合并/); assert.equal(app.calls.join.length, 0);
  await app.page.confirmOperation(); assert.equal(app.calls.join.length, 1); assert.equal(app.page.data.family.isManager, false);
});

test('expired preview cannot join and changing invitation clears the previous preview', async () => {
  const app = setup(); await app.page.onShow(); app.page.changeRole(change('爷爷')); app.page.changeToken(change('token'));
  app.hooks.preview = async () => ({name: '家庭', nickname: '宝宝', memberCount: 1, expiresAt: Date.now() - 1});
  await app.page.previewInvite(); app.page.join(); assert.equal(app.page.data.preview, null); assert.equal(app.calls.join.length, 0);
  delete app.hooks.preview; await app.page.previewInvite(); app.page.changeToken(change('other'));
  assert.equal(app.page.data.preview, null);
});

test('invite is generated and copied only on request and only explicit invitation sharing includes its token', async () => {
  const app = setup({family: group()}); await app.page.onShow();
  assert.equal(app.calls.invite, 0); assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  await app.page.generateInvite(); app.page.copyInvite(); assert.equal(app.calls.invite, 1); assert.equal(app.calls.clipboard.length, 1);
  assert.equal(app.page.onShareAppMessage({from: 'menu'}).path, '/pages/home/index');
  const event = {from: 'button', target: {dataset: {custom: {invite: '1'}}}};
  const shared = app.page.onShareAppMessage(event);
  assert.equal(shared.path, '/pages/family/index?token=valid-family-invite-token');
  assert.equal(app.page.onShareAppMessage({from: 'button', target: {dataset: {invite: '1'}}}).path, shared.path);
  assert.equal(app.page.onShareAppMessage({from: 'menu', target: event.target}).path, '/pages/home/index');
  assert.equal(app.page.onShareAppMessage({from: 'button', target: {dataset: {custom: {invite: '0'}}}}).path, '/pages/home/index');
  assert.doesNotMatch(JSON.stringify(shared), /团团|鸡蛋|妈妈|爸爸/);
  app.page.data.busy = true;
  assert.equal(app.page.onShareAppMessage(event).path, '/pages/home/index');
  app.page.data.busy = false;
  app.page.data.invite.expiresAt = 1;
  assert.equal(app.page.onShareAppMessage(event).path, '/pages/home/index');
});

test('family template passes its invite marker through TDesign to the native sharing button', async () => {
  const template = fs.readFileSync(path.join(root, 'pages/family/index.wxml'), 'utf8');
  const shareButton = template.match(/<t-button\b[^>]*\bopen-type="share"[^>]*>/);
  assert.ok(shareButton, 'family page must expose an explicit share button');
  const customDataset = shareButton[0].match(/\bcustom-dataset="\{\{\s*(.*?)\s*\}\}"/);
  assert.ok(customDataset, 'component-level data attributes do not reach the native button');
  const value = vm.runInNewContext('(' + customDataset[1] + ')');
  const components = JSON.parse(fs.readFileSync(path.join(root, 'pages/family/index.json'), 'utf8')).usingComponents;
  const buttonTemplate = fs.readFileSync(path.join(root, components['t-button'].replace(/^\//, '') + '.wxml'), 'utf8');
  const nativeButton = buttonTemplate.match(/<button\b[^>]*>/);
  assert.ok(nativeButton);
  const forwarded = nativeButton[0].match(/\bdata-([a-z]+)="\{\{\s*customDataset\s*\}\}"/);
  assert.ok(forwarded, 'TDesign must forward customDataset onto its native button');
  assert.match(nativeButton[0], /\bopen-type="[^"\n]*openType[^"\n]*"/);
  const nativeEvent = {from: 'button', target: {dataset: {[forwarded[1]]: value}}};
  const app = setup({family: group()}); await app.page.onShow();
  assert.equal(app.page.onShareAppMessage(nativeEvent).path, '/pages/home/index');
  await app.page.generateInvite();
  assert.equal(app.page.onShareAppMessage(nativeEvent).path, '/pages/family/index?token=valid-family-invite-token');
});

test('ordinary members cannot generate invitations, remove members or transfer management', async () => {
  const app = setup({family: group({isManager: false})}); await app.page.onShow();
  await app.page.generateInvite(); app.page.removeMember(tap('e'.repeat(32))); app.page.transferManager(tap('e'.repeat(32)));
  assert.equal(app.calls.invite, 0); assert.equal(app.page.data.confirmVisible, false);
});

test('administrator removal and transfer use an explicit member confirmation and exclude self', async () => {
  const app = setup({family: group()}); await app.page.onShow();
  app.page.removeMember(tap(MEMBER)); assert.equal(app.page.data.confirmVisible, false);
  app.page.removeMember(tap('e'.repeat(32))); assert.match(app.page.data.confirmText, /爸爸/); assert.equal(app.calls.remove.length, 0);
  await app.page.confirmOperation(); assert.deepEqual(app.calls.remove, ['e'.repeat(32)]);
  app.page.transferManager(tap('e'.repeat(32))); assert.equal(app.calls.transfer.length, 0);
  await app.page.confirmOperation(); assert.deepEqual(app.calls.transfer, ['e'.repeat(32)]);
});

test('administrator must transfer before leaving a populated family and last member confirms dissolution', async () => {
  const app = setup({family: group()}); await app.page.onShow(); app.page.leave();
  assert.match(app.page.data.actionError, /管理权限/); assert.equal(app.calls.leave, 0);
  const last = setup({family: group({memberCount: 1, members: [group().members[0]]})}); await last.page.onShow();
  last.page.leave(); assert.equal(last.page.data.confirmTitle, '解散这个家庭？'); assert.equal(last.calls.leave, 0);
  await last.page.confirmOperation(); assert.equal(last.page.data.family, null); assert.equal(last.page.locked, false);
});

test('unsynced leave failure retains family view and does not switch to personal data', async () => {
  const app = setup({family: group({isManager: false})}); await app.page.onShow();
  app.hooks.leave = async () => {throw Error('请先同步本机记录');}; app.page.leave(); await app.page.confirmOperation();
  assert.equal(app.page.data.family.id, FAMILY); assert.match(app.page.data.actionError, /先同步/);
});

test('account and family ABA switches clear invitations and block late results', async () => {
  for (const mode of ['owner', 'scope']) {
    const app = setup({family: group()}), wait = deferred(); await app.page.onShow();
    app.hooks.invite = () => wait.promise; const work = app.page.generateInvite();
    if (mode === 'owner') {app.changeOwner(OTHER); app.changeOwner(OWNER);} else {app.setScope(personal); app.setScope(shared);}
    wait.resolve({token: 'late-token', expiresAt: Date.now() + 10000}); await work;
    assert.equal(app.page.data.invite, null); assert.equal(app.page.data.family, null); assert.equal(app.page.locked, true);
  }
});

test('unloading ignores outstanding reads and unsubscribes', async () => {
  const app = setup(), wait = deferred(); app.hooks.info = () => wait.promise;
  const work = app.page.onShow(); app.page.onUnload(); wait.resolve({owner: OWNER, scope: personal, family: group()}); await work;
  assert.equal(app.page.data.family, null); assert.equal(app.listeners.size, 0);
});

test('editing shared baby details saves only changed fields and cancellation restores the saved view', async () => {
  const app = setup({family: group()}); await app.page.onShow(); app.page.editBaby();
  app.page.changeNickname(change('小团子')); app.setState({babyBirthDate: '2025-02-01'}); app.page.saveBaby();
  assert.deepEqual(app.calls.baby, [{nickname: '小团子'}]); assert.equal(app.page.data.babyBirthDate, '2025-02-01');
  app.page.editBaby(); app.page.changeNickname(change('未保存的称呼')); app.page.cancelBaby();
  assert.equal(app.page.data.nickname, '小团子'); assert.equal(app.calls.baby.length, 1);
});

test('editing the member label does not require or write a public profile', async () => {
  const app = setup({family: group()}); await app.page.onShow(); app.page.editRole(); app.page.changeRole(change('姥姥'));
  await app.page.saveRole(); assert.deepEqual(app.calls.role, [{memberId: MEMBER, label: '姥姥'}]);
  assert.equal(app.page.data.roleEditing, false);
});

function settings(app) {
  let definition;
  const calls = {exports: 0, imports: 0, removed: [], clipboard: []};
  const backup = {removeFile: async file => calls.removed.push(file), exportText: async () => {calls.exports++; return 'private-family-backup';},
    importText: async (_, guard) => {guard(); calls.imports++;}};
  const wx = {showToast() {}, setClipboardData(value) {calls.clipboard.push(value.data); value.success();}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/settings/index.js'), 'utf8'), {wx, Page(value) {definition = value;}, require(name) {
    if (name.endsWith('/store')) return app.store;
    if (name.endsWith('/backup')) return backup;
    if (name.endsWith('/selectors')) return require('../utils/selectors');
    if (name.endsWith('/cloud-sync')) return {subscribe: () => () => {}, getStatus: () => ({state: 'synced', lastSyncedAt: Date.now()}), syncNow() {}};
    throw Error(name);
  }});
  const page = {...definition, data: clone(definition.data), setData(update) {Object.assign(this.data, clone(update));}};
  page.onLoad(); page.onShow(); return {page, calls};
}

test('settings explains shared data and confirms that import affects all family members', async () => {
  const app = setup({family: group()}), view = settings(app);
  assert.equal(view.page.data.familyActive, true); assert.match(view.page.data.storageDescription, /各自的微信账号/);
  const operation = view.page.importAfterConfirmation('backup');
  assert.equal(view.page.data.importVisible, true); assert.match(view.page.data.importDescription, /影响所有家人/);
  assert.equal(view.calls.imports, 0); view.page.cancelImportDialog(); await operation; assert.equal(view.calls.imports, 0);
});

test('switching families cancels backup confirmation, clears prepared data and blocks old exports even after switching back', async () => {
  const app = setup({family: group()}), view = settings(app);
  view.page.setData({backupText: 'PRIVATE', exportVisible: true}); view.page._exportFilePath = '/usr/old-family.json';
  const operation = view.page.importAfterConfirmation('backup');
  app.setScope(personal); app.setScope(shared); await operation;
  assert.equal(view.page.data.backupText, ''); assert.equal(view.page.data.importVisible, false);
  assert.equal(view.page.data.exportVisible, false); assert.equal(view.page.data.scopeLocked, true);
  assert.deepEqual(view.calls.removed, ['/usr/old-family.json']);
  await view.page.copyBackup(); assert.equal(view.calls.exports, 0); assert.equal(view.calls.clipboard.length, 0);
});
