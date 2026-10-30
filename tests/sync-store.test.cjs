'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/recipes');
const path = require('node:path');
const {mergeSnapshots} = require('../utils/sync-merge');
const storePath = path.resolve(__dirname, '../utils/store.js');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const LEGACY = 'baby-bites-v1';
const ACTIVE = 'baby-bites-active-owner';
const key = owner => 'baby-bites-account-' + owner;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function setup(initial = {}) {
  const saved = copy(initial);
  let failKey = null;
  let writes = [];
  function reload() {
    global.wx = {
      getStorageSync: name => copy(saved[name]),
      getStorageInfoSync: () => ({keys: Object.keys(saved)}),
      setStorageSync(name, value) {
        if (name === failKey) throw Error('quota');
        writes.push(name);
        saved[name] = copy(value);
      }
    };
    delete require.cache[storePath];
    return require(storePath);
  }
  return {store: reload(), reload, saved, fail: name => { failKey = name; }, writes: () => writes};
}
function baseline() {
  const app = setup();
  return app.store.getState();
}
function snapshot(data, deleted = {recipes: [], logs: []}) { return {version: 1, data: copy(data), deleted: copy(deleted)}; }
function oneRecipe(id, updatedAt, name = id) {
  return Object.assign(baseline().recipes[0], {id, name, isExample: false, createdAt: 1, updatedAt});
}
function empty() { return {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []}; }
function dataWith(recipes) { return Object.assign(empty(), {recipes}); }

test('recipe age metadata survives sync merge, account restore and explicit clearing without filling legacy rows', () => {
  const legacy = oneRecipe('legacy-age', 1), tagged = {...oneRecipe('tagged-age', 2), ageGroups: ['9-11', '18+']};
  delete legacy.ageGroups;
  const incoming = snapshot(dataWith([legacy, tagged]));
  const app = setup(); app.store.bindAccount(A);
  const info = app.store.getSyncInfo();
  app.store.applySyncedSnapshot(incoming, {owner: A, sequence: info.sequence, revision: 1});
  assert.deepEqual(app.store.getRecipe(tagged.id).ageGroups, ['9-11', '18+']);
  assert.equal(Object.hasOwn(app.store.getRecipe(legacy.id), 'ageGroups'), false);
  assert.deepEqual(app.reload().getRecipe(tagged.id).ageGroups, ['9-11', '18+']);
  const cleared = snapshot(dataWith([{...tagged, ageGroups: [], updatedAt: 3}]));
  const merged = mergeSnapshots(incoming, cleared);
  assert.deepEqual(merged.data.recipes.find(item => item.id === tagged.id).ageGroups, []);
  assert.equal(Object.hasOwn(merged.data.recipes.find(item => item.id === legacy.id), 'ageGroups'), false);
  assert.deepEqual(mergeSnapshots(cleared, incoming), merged);
  const fresh = setup(); fresh.store.bindAccount(B);
  assert.equal(fresh.store.getRecipe(tagged.id), null);
});

test('new-device examples are not included in upload and legacy migration preserves identities and dates', () => {
  const original = baseline();
  const fresh = setup();
  assert.equal(fresh.store.getState().recipes.length, seed.length);
  assert.equal(fresh.store.getSyncInfo().hasLocalData, false);
  assert.deepEqual(fresh.store.getSyncSnapshot().data.recipes, []);
  fresh.store.bindAccount(A);
  assert.equal(fresh.store.getState().recipes.length, seed.length);
  assert.deepEqual(fresh.store.getSyncSnapshot().data.recipes, []);
  const app = setup({[LEGACY]: original});
  app.store.bindAccount(A);
  assert.deepEqual(app.store.getState(), app.store.validateData(original));
  assert.deepEqual(app.saved[key(A)].data, app.store.getState());
  assert.equal(app.saved[LEGACY].__syncMigratedTo, A);
  assert.equal(app.saved[ACTIVE], A);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(app.writes(), [key(A), LEGACY, ACTIVE]);
});

test('account caches remain isolated and migration cannot copy data to a second owner', () => {
  const original = baseline();
  original.nickname = 'Tommy';
  const app = setup({[LEGACY]: original});
  app.store.bindAccount(A);
  app.store.setNickname('账号甲');
  app.store.bindAccount(B);
  assert.equal(app.store.getState().nickname, '宝宝');
  assert.deepEqual(app.store.getSyncSnapshot().data.recipes, []);
  app.store.setNickname('账号乙');
  app.store.bindAccount(A);
  assert.equal(app.store.getState().nickname, '账号甲');
  assert.equal(app.saved[LEGACY].nickname, 'Tommy');
  assert.equal(app.saved[LEGACY].__syncMigratedTo, A);
  const restarted = app.reload();
  assert.equal(restarted.getSyncInfo().owner, A);
  assert.equal(restarted.getState().nickname, '账号甲');
});

test('partial migration failures do not switch memory, and retries recover safely', () => {
  for (const failedKey of [key(A), LEGACY, ACTIVE]) {
    const original = baseline();
    original.nickname = '保留';
    const app = setup({[LEGACY]: original});
    const before = app.store.getState();
    app.fail(failedKey);
    assert.throws(() => app.store.bindAccount(A), /未切换/);
    assert.deepEqual(app.store.getState(), before);
    assert.equal(app.store.getSyncInfo().owner, null);
    app.fail(null);
    app.store.bindAccount(A);
    const restored = app.store.getState();
    restored.recipes.sort((a, b) => a.id.localeCompare(b.id));
    before.recipes.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(restored, before);
    assert.equal(app.saved[ACTIVE], A);
  }
});

test('a failed legacy claim can retry with intervening edits but cannot migrate to another owner', () => {
  const app = setup({[LEGACY]: baseline()});
  app.fail(LEGACY);
  assert.throws(() => app.store.bindAccount(A));
  app.fail(null);
  assert.throws(() => app.store.bindAccount(B), /之前账号/);
  app.store.setNickname('未丢失的修改');
  const restarted = app.reload();
  assert.equal(restarted.getSyncInfo().blocked, true);
  assert.throws(() => restarted.bindAccount(B), /未切换/);
  restarted.bindAccount(A);
  assert.equal(restarted.getState().nickname, '未丢失的修改');
});

test('missing or corrupt active pointer never silently uploads a default or another account cache', () => {
  const app = setup({[LEGACY]: baseline()});
  app.store.bindAccount(A);
  delete app.saved[ACTIVE];
  let restarted = app.reload();
  assert.equal(restarted.getSyncInfo().blocked, true);
  assert.throws(() => restarted.getSyncSnapshot(), /未能读取/);
  restarted.bindAccount(A);
  assert.equal(restarted.getSyncInfo().blocked, false);
  app.saved[ACTIVE] = 'bad-owner';
  restarted = app.reload();
  assert.throws(() => restarted.getSyncSnapshot(), /未能读取/);
  restarted.bindAccount(A);
  assert.equal(restarted.getSyncInfo().owner, A);
  app.saved[key(A)].data = {broken: true};
  restarted = app.reload();
  assert.throws(() => restarted.bindAccount(A), /未切换/);
  assert.throws(() => restarted.setNickname('cannot overwrite'));
  assert.deepEqual(app.saved[key(A)].data, {broken: true});
});

test('same-key commits keep tombstones, revision, and data atomic and notify only after success', () => {
  const app = setup({[LEGACY]: baseline()});
  app.store.bindAccount(A);
  const notifications = [];
  const unsubscribe = app.store.subscribe(info => notifications.push(info));
  const id = app.store.getState().recipes[0].id;
  const logId = app.store.addLog({recipeId: id, rating: 3, date: '2024-01-01'});
  app.store.deleteRecipe(id);
  assert.equal(app.store.getSyncInfo().sequence, 2);
  const deleted = app.store.getSyncSnapshot().deleted;
  assert.equal(deleted.recipes[0].id, id);
  assert.equal(deleted.logs[0].id, logId);
  assert.equal(notifications.length, 2);
  const before = copy(app.saved[key(A)]);
  app.fail(key(A));
  assert.throws(() => app.store.setNickname('不能保存'), /保存失败/);
  assert.deepEqual(app.saved[key(A)], before);
  assert.equal(app.store.getSyncInfo().sequence, 2);
  assert.equal(notifications.length, 2);
  unsubscribe();
  app.fail(null);
  app.store.setNickname('已保存');
  assert.equal(notifications.length, 2);
  assert.deepEqual(app.reload().getSyncSnapshot().deleted, deleted);
});

test('sync acknowledgement merges edits made during flight and only clears clean acknowledgements', () => {
  const app = setup({[LEGACY]: baseline()});
  app.store.bindAccount(A);
  const sent = app.store.getSyncSnapshot();
  const seq = app.store.getSyncInfo().sequence;
  app.store.setNickname('同步时编辑');
  const remoteRecipe = Object.assign(copy(sent.data.recipes[0]), {id: 'other-device', name: '其他设备的菜'});
  sent.data.recipes.push(remoteRecipe);
  app.store.applySyncedSnapshot(sent, {sequence: seq, revision: 1, owner: A});
  assert.equal(app.store.getState().nickname, '同步时编辑');
  assert.ok(app.store.getRecipe('other-device'));
  assert.equal(app.store.getSyncInfo().dirty, true);
  const latest = app.store.getSyncSnapshot();
  app.store.applySyncedSnapshot(latest, {sequence: app.store.getSyncInfo().sequence, revision: 2});
  assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.store.getSyncInfo().revision, 2);
  assert.equal(app.store.applySyncedSnapshot(sent, {sequence: 0, revision: 1}), false);
  assert.throws(() => app.store.applySyncedSnapshot(sent, {sequence: 0, revision: 3, owner: B}), /账号已切换/);
});

test('failed sync persistence leaves state, revision and dirty flag unchanged', () => {
  const app = setup({[LEGACY]: baseline()});
  app.store.bindAccount(A);
  const before = app.store.getSyncSnapshot();
  const info = app.store.getSyncInfo();
  const incoming = copy(before);
  incoming.data.nickname = '云端';
  incoming.data.profileUpdatedAt = 100;
  app.fail(key(A));
  assert.throws(() => app.store.applySyncedSnapshot(incoming, {sequence: info.sequence, revision: 1}), /保存失败/);
  assert.deepEqual(app.store.getSyncSnapshot(), before);
  assert.deepEqual(app.store.getSyncInfo(), info);
});

test('merging retains independent additions, resolves timestamps and ties deterministically', () => {
  const base = oneRecipe('same', 5);
  const a = snapshot(dataWith([base, oneRecipe('local-only', 2)]));
  const b = snapshot(dataWith([Object.assign(copy(base), {name: 'updated', updatedAt: 6}), oneRecipe('remote-only', 2)]));
  const merged = mergeSnapshots(a, b);
  assert.deepEqual(merged, mergeSnapshots(b, a));
  assert.equal(merged.data.recipes.length, 3);
  assert.equal(merged.data.recipes.find(item => item.id === 'same').name, 'updated');
  const localPhoto = snapshot(dataWith([Object.assign(copy(base), {photo: 'wxfile://usr/a.jpg'})]));
  const cloudPhoto = snapshot(dataWith([Object.assign(copy(base), {photo: 'cloud://env.bucket/path/a.jpg'})]));
  assert.equal(mergeSnapshots(localPhoto, cloudPhoto).data.recipes[0].photo, 'cloud://env.bucket/path/a.jpg');
  assert.deepEqual(mergeSnapshots(localPhoto, cloudPhoto), mergeSnapshots(cloudPhoto, localPhoto));
});

test('deletions win ties and cascade even through independently added newer meal records', () => {
  const recipe = oneRecipe('deleted', 10);
  const local = snapshot(dataWith([recipe]));
  local.data.logs.push({id: 'offline-log', recipeId: recipe.id, rating: 3, date: '2024-01-01', createdAt: 20, updatedAt: 0});
  const remote = snapshot(empty(), {recipes: [{id: recipe.id, updatedAt: 10}], logs: []});
  const merged = mergeSnapshots(local, remote);
  assert.deepEqual(merged.data.recipes, []);
  assert.deepEqual(merged.data.logs, []);
  assert.deepEqual(merged.deleted.logs, [{id: 'offline-log', updatedAt: 20}]);
  assert.deepEqual(mergeSnapshots(merged, local), merged);
  assert.deepEqual(mergeSnapshots(remote, local), merged);
});

test('cloud file IDs are accepted, but traversal, external URLs and malformed IDs are rejected', () => {
  const app = setup();
  const base = app.store.getState();
  for (const photo of ['cloud://env-123.bucket-456/baby-bites/user/photo.jpg', 'cloud://env.bucket/photo_1.png']) {
    base.recipes[0].photo = photo;
    assert.equal(app.store.validateData(base).recipes[0].photo, photo);
  }
  for (const photo of ['cloud://', 'cloud:///a.jpg', 'cloud://env/../other.jpg', 'cloud://env/%2e%2e/a.jpg', 'https://untrusted/a.jpg']) {
    base.recipes[0].photo = photo;
    assert.throws(() => app.store.validateData(base), /照片/);
  }
});


test('recently initialized untouched examples cannot revive deleted or edited cloud recipes', () => {
  const example = Object.assign(oneRecipe('example', 0), {isExample: true, createdAt: Date.now()});
  const local = snapshot(dataWith([example]));
  const remoteDeleted = snapshot(empty(), {recipes: [{id: 'example', updatedAt: 100}], logs: []});
  assert.equal(mergeSnapshots(local, remoteDeleted).data.recipes.length, 0);
  const edited = Object.assign(copy(example), {name: '云端已修改', isExample: false, updatedAt: 200});
  assert.equal(mergeSnapshots(local, snapshot(dataWith([edited]))).data.recipes[0].name, '云端已修改');
  local.data.nickname = '之前的称呼';
  assert.equal(mergeSnapshots(local, snapshot(empty())).data.nickname, '之前的称呼');
  assert.deepEqual(mergeSnapshots(local, snapshot(empty())), mergeSnapshots(snapshot(empty()), local));
});

test('explicit backup restore of known deleted recipes and meals survives the next sync and retains tombstones', () => {
  const app = setup({[LEGACY]: baseline()});
  app.store.bindAccount(A);
  const recipeId = app.store.getState().recipes[0].id;
  const logId = app.store.addLog({recipeId, rating: 3, date: '2024-01-01'});
  const backup = app.store.exportBackup();
  const original = JSON.parse(backup);
  app.store.deleteRecipe(recipeId);
  const remoteDeleted = app.store.getSyncSnapshot();
  assert.equal(remoteDeleted.deleted.recipes[0].id, recipeId);
  assert.equal(remoteDeleted.deleted.logs[0].id, logId);
  const result = app.store.importBackup(backup);
  assert.deepEqual(result, {addedRecipes: 1, updatedRecipes: 0, addedLogs: 1});
  const restoredRecipe = app.store.getRecipe(recipeId);
  const restoredLog = app.store.getLog(logId);
  assert.ok(restoredRecipe.updatedAt > remoteDeleted.deleted.recipes[0].updatedAt);
  assert.ok(restoredLog.updatedAt > remoteDeleted.deleted.logs[0].updatedAt);
  assert.equal(restoredRecipe.createdAt, original.recipes.find(item => item.id === recipeId).createdAt);
  assert.equal(restoredLog.createdAt, original.logs.find(item => item.id === logId).createdAt);
  const merged = mergeSnapshots(app.store.getSyncSnapshot(), remoteDeleted);
  app.store.applySyncedSnapshot(merged, {sequence: app.store.getSyncInfo().sequence, revision: 1, owner: A});
  assert.deepEqual(app.store.getRecipe(recipeId), restoredRecipe);
  assert.deepEqual(app.store.getLog(logId), restoredLog);
  assert.deepEqual(app.store.getSyncSnapshot().deleted, remoteDeleted.deleted);
  assert.equal(app.store.getSyncInfo().dirty, false);
});

test('restoration advances beyond future-dated known tombstones without changing creation time', () => {
  const future = Date.now() + 60000;
  const original = dataWith([oneRecipe('future-recipe', future)]);
  original.logs = [{id: 'future-log', recipeId: 'future-recipe', rating: 2, date: '2024-01-01',
    createdAt: 1, updatedAt: future + 1, note: '', portion: ''}];
  const app = setup({[LEGACY]: original});
  const backup = app.store.exportBackup();
  app.store.deleteRecipe('future-recipe');
  const removed = app.store.getSyncSnapshot();
  app.store.importBackup(backup);
  assert.ok(app.store.getRecipe('future-recipe').updatedAt > removed.deleted.recipes[0].updatedAt);
  assert.ok(app.store.getLog('future-log').updatedAt > removed.deleted.logs[0].updatedAt);
  assert.equal(app.store.getRecipe('future-recipe').createdAt, 1);
  assert.equal(app.store.getLog('future-log').createdAt, 1);
});

test('backup import does not override a cloud deletion this device has not observed yet', () => {
  const original = dataWith([oneRecipe('remote-deleted', 10)]);
  original.logs = [{id: 'remote-log', recipeId: 'remote-deleted', rating: 2, date: '2024-01-01',
    createdAt: 1, updatedAt: 10, note: '', portion: ''}];
  const app = setup({[LEGACY]: empty()});
  app.store.bindAccount(A);
  app.store.importBackup(JSON.stringify(original));
  assert.equal(app.store.getRecipe('remote-deleted').updatedAt, 10);
  assert.equal(app.store.getLog('remote-log').updatedAt, 10);
  const remote = snapshot(empty(), {recipes: [{id: 'remote-deleted', updatedAt: 20}],
    logs: [{id: 'remote-log', updatedAt: 20}]});
  const merged = mergeSnapshots(app.store.getSyncSnapshot(), remote);
  app.store.applySyncedSnapshot(merged, {sequence: app.store.getSyncInfo().sequence, revision: 1});
  assert.equal(app.store.getRecipe('remote-deleted'), null);
  assert.equal(app.store.getLog('remote-log'), null);
});
