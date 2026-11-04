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
const ACTIVE_SCOPE = 'baby-bites-active-scope';
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
const FAMILY = {kind: 'family', id: 'f'.repeat(64), membershipId: 'c'.repeat(32)};
function accountCache(data = empty(), schemaVersion) {
  return {version: 1, data: copy(data), __sync: {sequence: 0, revision: 3, dirty: false, hasLocalData: true,
    deleted: {recipes: [], logs: []}, migratedLegacy: false,
    ...(schemaVersion === undefined ? {} : {snapshotSchemaVersion: schemaVersion})}};
}

test('a newer local family edit cannot put an unverifiable cached author or recorder back into a migrated snapshot', () => {
  const data = dataWith([oneRecipe('old', 10)]);
  data.logs = [{id: 'meal', recipeId: 'old', rating: 3, date: '2026-01-01', createdAt: 1, updatedAt: 10}];
  const remote = snapshot(data), local = snapshot(data);
  Object.assign(local.data.recipes[0], {createdBy: B, name: '新的家常做法', updatedAt: 20});
  Object.assign(local.data.logs[0], {recordedBy: {memberId: 'b'.repeat(32), label: '爸爸'}, note: '吃了两口', updatedAt: 20});
  const merged = mergeSnapshots(local, remote, true);
  assert.equal(merged.data.recipes[0].createdBy, undefined);
  assert.equal(merged.data.recipes[0].name, '新的家常做法');
  assert.equal(merged.data.logs[0].recordedBy, undefined);
  assert.equal(merged.data.logs[0].note, '吃了两口');
});

function plannedLogSnapshot(log, deletion) {
  return snapshot({...dataWith([oneRecipe('dish-a', 1), oneRecipe('dish-b', 1)]), mealPlans: [],
    logs: [{id: 'meal-log-meal-2024-04-02-breakfast', recipeId: 'dish-a', date: '2024-04-02', meal: 'breakfast',
      rating: 2, portion: '', note: '', createdAt: 10, updatedAt: 10, ...log}]},
  {recipes: [], logs: deletion === undefined ? [] : [{id: log.id || 'meal-log-meal-2024-04-02-breakfast', updatedAt: deletion}], mealPlans: []});
}

test('a deletion boundary separates rebuilt meal attribution even when the old generation was edited later', () => {
  const mother = {memberId: 'a'.repeat(32), label: '妈妈'}, imported = {memberId: 'c'.repeat(32), label: '阿姨'};
  for (const oldUpdatedAt of [15, 30, 100]) for (const claim of [undefined, imported]) {
    const local = plannedLogSnapshot({recipeId: 'dish-b', createdAt: 30, updatedAt: 30,
      ...(claim ? {recordedBy: claim} : {})}, 20);
    const remote = plannedLogSnapshot({updatedAt: oldUpdatedAt, recordedBy: mother});
    const merged = mergeSnapshots(local, remote, true);
    assert.equal(merged.data.logs.length, 1);
    assert.deepEqual(merged.data.logs[0], local.data.logs[0], 'old attribution cannot move onto a new generation');
    assert.deepEqual(mergeSnapshots(local, remote).data.logs, mergeSnapshots(remote, local).data.logs);
  }
});

test('an authoritative rebuilt meal survives an older generation backup restore and retains its recorder', () => {
  const father = {memberId: 'b'.repeat(32), label: '爸爸'};
  const restore = plannedLogSnapshot({createdAt: 10, updatedAt: 100}, 20);
  const remote = plannedLogSnapshot({recipeId: 'dish-b', createdAt: 30, updatedAt: 30, recordedBy: father}, 20);
  assert.deepEqual(mergeSnapshots(restore, remote, true).data.logs, remote.data.logs);
  const oldRemote = plannedLogSnapshot({recordedBy: father}, 20);
  const sameGeneration = mergeSnapshots(restore, oldRemote, true).data.logs[0];
  assert.equal(sameGeneration.updatedAt, 100);
  assert.equal(sameGeneration.createdAt, 10, 'restoring a backup does not create a generation');
  assert.deepEqual(sameGeneration.recordedBy, father);
});

test('a later deletion cannot erase an observed generation boundary and turn restored old content into a newer recorder', () => {
  const mother = {memberId: 'a'.repeat(32), label: '妈妈'}, father = {memberId: 'b'.repeat(32), label: '爸爸'};
  for (const claim of [undefined, mother]) {
    const restored = plannedLogSnapshot({createdAt: 10, updatedAt: 100,
      ...(claim ? {recordedBy: claim} : {})}, 40);
    const remote = plannedLogSnapshot({recipeId: 'dish-b', createdAt: 30, updatedAt: 30, recordedBy: father}, 20);
    const merged = mergeSnapshots(restored, remote, true);
    assert.deepEqual(merged.data.logs, restored.data.logs,
      'the explicitly restored old history survives; the newer generation was itself deleted');
    assert.deepEqual(merged.deleted.logs, restored.deleted.logs);
    assert.deepEqual(mergeSnapshots(remote, restored, true).data.logs, restored.data.logs);
  }
});

test('a newer surviving meal generation still wins when a later deletion covers both creation times', () => {
  const restored = plannedLogSnapshot({createdAt: 10, updatedAt: 100}, 40);
  const remote = plannedLogSnapshot({recipeId: 'dish-b', createdAt: 30, updatedAt: 60,
    recordedBy: {memberId: 'b'.repeat(32), label: '爸爸'}}, 20);
  assert.deepEqual(mergeSnapshots(restored, remote, true).data.logs, remote.data.logs);
  assert.deepEqual(mergeSnapshots(remote, restored, true).data.logs, remote.data.logs);
});

test('ambiguous pre-deletion meal generations keep the selected history intact for server arbitration', () => {
  const mother = {memberId: 'a'.repeat(32), label: '妈妈'}, father = {memberId: 'b'.repeat(32), label: '爸爸'};
  for (const claim of [undefined, mother]) {
    const restored = plannedLogSnapshot({createdAt: 10, updatedAt: 100,
      ...(claim ? {recordedBy: claim} : {})}, 40);
    const remote = plannedLogSnapshot({recipeId: 'dish-b', createdAt: 30, updatedAt: 60, recordedBy: father}, 40);
    assert.deepEqual(mergeSnapshots(restored, remote, true).data.logs, restored.data.logs,
      'without an observed separating boundary the original selected identity must reach the server');
    assert.deepEqual(mergeSnapshots(remote, restored, true).data.logs, restored.data.logs);
  }
});

test('concurrent first meal completions retain one cloud identity and recorder within the same generation', () => {
  const mother = {memberId: 'a'.repeat(32), label: '妈妈'};
  for (const deletion of [undefined, 5]) for (const author of [undefined, mother]) {
    const local = plannedLogSnapshot({createdAt: 11, updatedAt: 40, note: '本机反馈',
      recordedBy: {memberId: 'b'.repeat(32), label: '爸爸'}}, deletion);
    const remote = plannedLogSnapshot(author ? {recordedBy: author} : {}, deletion);
    const log = mergeSnapshots(local, remote, true).data.logs[0];
    assert.equal(log.note, '本机反馈'); assert.equal(log.createdAt, 10);
    assert.deepEqual(log.recordedBy, author);
  }
});

test('generation preference never applies to ordinary or malformed completion IDs', () => {
  for (const id of ['ordinary-log', 'prefix-meal-log-meal-2024-04-02-breakfast',
    'meal-log-meal-2024-04-02-breakfast-extra', 'meal-log-meal-2024-02-30-breakfast']) {
    const local = plannedLogSnapshot({id, recipeId: 'dish-b', createdAt: 30, updatedAt: 30}, 20);
    const remote = plannedLogSnapshot({id, createdAt: 10, updatedAt: 100});
    assert.deepEqual(mergeSnapshots(local, remote, true).data.logs, remote.data.logs);
  }
});

test('reading, binding and ordinary edits do not certify legacy snapshot caches', () => {
  const app = setup({[ACTIVE]: A, [key(A)]: accountCache()});
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  app.store.bindAccount(A);
  app.store.setNickname('保留本机修改');
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.equal(app.reload().getSyncInfo().snapshotCurrent, false);
  assert.equal(app.saved[key(A)].__sync.snapshotSchemaVersion, 0);

  const legacy = setup({[LEGACY]: empty()});
  legacy.store.setNickname('待迁移资料');
  legacy.store.bindAccount(B);
  assert.equal(legacy.store.getSyncInfo().snapshotCurrent, false);
  assert.equal(legacy.saved[key(B)].__sync.snapshotSchemaVersion, 0);
});

test('family scope keeps actor identity while isolating the personal baby data and pending edits', () => {
  const app = setup(); app.store.bindAccount(A); app.store.setNickname('个人宝宝');
  const personal = app.store.getSyncSnapshot(), personalKey = app.store.getScopeKey();
  app.store.bindScope(A, FAMILY);
  assert.equal(app.store.getSyncInfo().owner, A); assert.equal(app.store.getSyncInfo().scope.kind, 'family');
  assert.equal(app.store.getState().recipes.length, 0); assert.equal(app.store.getSyncInfo().dirty, false);
  assert.notEqual(app.store.getScopeKey(), personalKey);
  app.store.setNickname('家庭宝宝'); const familyKey = app.store.getScopeKey();
  app.store.bindScope(A, {kind: 'personal', id: A});
  assert.deepEqual(app.store.getSyncSnapshot(), personal); assert.equal(app.store.getSyncInfo().dirty, true);
  app.store.bindScope(A, FAMILY); assert.equal(app.store.getScopeKey(), familyKey); assert.equal(app.store.getState().nickname, '家庭宝宝');
  assert.equal(app.reload().getState().nickname, '家庭宝宝'); assert.equal(app.reload().getSyncInfo().owner, A);
});

test('a new membership never reuses revoked family cache or uploads its old pending edits', () => {
  const app = setup(); app.store.bindAccount(A); app.store.bindScope(A, FAMILY); app.store.setNickname('已退出家庭的草稿');
  const oldKey = app.store.getScopeKey(); app.store.bindScope(A, {kind: 'personal', id: A});
  app.store.bindScope(A, {...FAMILY, membershipId: 'd'.repeat(32)});
  assert.notEqual(app.store.getScopeKey(), oldKey); assert.equal(app.store.getSyncInfo().dirty, false);
  assert.equal(app.store.getState().nickname, '宝宝');
  assert.throws(() => app.store.applySyncedSnapshot(snapshot(empty()), {owner: A, scopeKey: oldKey, sequence: 0, revision: 10}), /家庭已切换/);
});

test('family cache is separated between two actors in the same family', () => {
  const app = setup(); app.store.bindAccount(A); app.store.bindScope(A, FAMILY); app.store.setNickname('A 的离线草稿');
  app.store.bindScope(B, {...FAMILY, membershipId: 'e'.repeat(32)});
  assert.equal(app.store.getState().nickname, '宝宝'); assert.equal(app.store.getSyncInfo().owner, B);
  app.store.bindScope(A, FAMILY); assert.equal(app.store.getState().nickname, 'A 的离线草稿');
});

test('failed family pointer writes preserve the old active data and a retry recovers the new cache', () => {
  const app = setup(); app.store.bindAccount(A); app.store.setNickname('保留个人记录');
  const before = app.store.getSyncSnapshot(); app.fail(ACTIVE_SCOPE);
  assert.throws(() => app.store.bindScope(A, FAMILY), /未切换/);
  assert.deepEqual(app.store.getSyncSnapshot(), before); assert.equal(app.store.getSyncInfo().scope.kind, 'personal');
  app.fail(null); app.store.bindScope(A, FAMILY); assert.equal(app.store.getState().recipes.length, 0);
});

test('baby profile patches are atomic and retain birthday through a nickname-only edit and backup roundtrip', () => {
  const app = setup(); app.store.bindAccount(A);
  app.store.setBabyProfile({nickname: '小米', babyBirthDate: '2024-01-01'});
  const savedDate = app.store.getState().babyBirthDateUpdatedAt;
  app.store.setBabyProfile({nickname: '小豆'});
  assert.equal(app.store.getState().babyBirthDate, '2024-01-01'); assert.equal(app.store.getState().babyBirthDateUpdatedAt, savedDate);
  const before = app.store.getState();
  assert.throws(() => app.store.setBabyProfile({nickname: '不应保存', babyBirthDate: '2099-99-99'}));
  assert.deepEqual(app.store.getState(), before);
  const imported = setup(); imported.store.importBackup(app.store.exportBackup());
  assert.equal(imported.store.getState().babyBirthDate, '2024-01-01');
  app.store.setBabyBirthDate(null); assert.equal(app.store.getState().babyBirthDate, null);
});

test('scope transition locks new local writes until released but allows verified sync data', () => {
  const app = setup(); app.store.bindAccount(A); const release = app.store.beginScopeChange();
  assert.throws(() => app.store.setNickname('过渡中的编辑'), /切换家庭/);
  app.store.applySyncedSnapshot(snapshot(empty()), {owner: A, scopeKey: app.store.getScopeKey(), sequence: 0, revision: 1});
  release(); release(); app.store.setNickname('完成后的编辑'); assert.equal(app.store.getState().nickname, '完成后的编辑');
});

test('family provenance and birthday survive concurrent content merge without exposing scope metadata in backups', () => {
  const original = oneRecipe('recipe-family', 10), member = {memberId: 'c'.repeat(32), label: '爸爸'};
  const local = snapshot({...dataWith([{...original, name: '修改后的做法', updatedAt: 12}]),
    logs: [{id: 'log', recipeId: original.id, rating: 3, date: '2024-01-01', note: '本地修改', createdAt: 1, updatedAt: 12}],
    babyBirthDate: '2024-01-01', babyBirthDateUpdatedAt: 10});
  const remote = snapshot({...dataWith([{...original, createdBy: A}]),
    logs: [{id: 'log', recipeId: original.id, rating: 2, date: '2024-01-01', note: '', createdAt: 1, recordedBy: member}],
    babyBirthDate: null, babyBirthDateUpdatedAt: 15});
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.data.recipes[0].name, '修改后的做法'); assert.equal(merged.data.recipes[0].createdBy, A);
  assert.equal(merged.data.logs[0].note, '本地修改'); assert.deepEqual(merged.data.logs[0].recordedBy, member);
  assert.equal(merged.data.babyBirthDate, null);
  const app = setup(); app.store.bindAccount(A); app.store.bindScope(A, FAMILY);
  app.store.applySyncedSnapshot(merged, {owner: A, scopeKey: app.store.getScopeKey(), sequence: 0, revision: 1});
  assert.doesNotMatch(app.store.exportBackup(), /membershipId|scopeKey|family-cache/);
});

test('only a successfully persisted complete snapshot certifies its account cache across restarts', () => {
  const data = {...empty(), allergies: ['鸡蛋'], allergiesUpdatedAt: 100};
  const app = setup({[ACTIVE]: A, [key(A)]: accountCache()});
  app.store.applySyncedSnapshot(snapshot(data), {owner: A, sequence: 0, revision: 3});
  assert.equal(app.store.getSyncInfo().snapshotCurrent, true);
  assert.equal(app.saved[key(A)].__sync.snapshotSchemaVersion, 3);
  assert.deepEqual(app.reload().getState().allergies, ['鸡蛋']);
  const restarted = app.reload();
  assert.equal(restarted.getSyncInfo().snapshotCurrent, true);
  assert.doesNotMatch(JSON.stringify(restarted.getSyncSnapshot()), /snapshotSchemaVersion|snapshotCurrent|__sync/);
  assert.doesNotMatch(restarted.exportBackup(), /snapshotSchemaVersion|snapshotCurrent|__sync/);

  restarted.bindAccount(B);
  assert.equal(restarted.getSyncInfo().snapshotCurrent, false);
  assert.equal(restarted.getState().allergies, undefined);
  restarted.bindAccount(A);
  assert.equal(restarted.getSyncInfo().snapshotCurrent, true);
  assert.deepEqual(restarted.getState().allergies, ['鸡蛋']);
  restarted.setNickname('本机继续编辑');
  assert.equal(restarted.getSyncInfo().snapshotCurrent, true);
  assert.equal(restarted.getSyncInfo().dirty, true, 'a local edit must still upload even with a current parser marker');
});

test('failed snapshot persistence keeps the unverified marker and data atomic until retry succeeds', () => {
  const app = setup({[ACTIVE]: A, [key(A)]: accountCache()});
  const data = {...empty(), allergies: ['牛奶'], allergiesUpdatedAt: 100};
  const before = copy(app.saved[key(A)]);
  const notifications = [];
  app.store.subscribe(info => notifications.push(info));
  app.fail(key(A));
  assert.throws(() => app.store.applySyncedSnapshot(snapshot(data), {owner: A, sequence: 0, revision: 3}), /保存失败/);
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  assert.equal(app.store.getState().allergies, undefined);
  assert.deepEqual(app.saved[key(A)], before);
  assert.equal(notifications.length, 0);
  const restarted = app.reload();
  assert.equal(restarted.getSyncInfo().snapshotCurrent, false);
  app.fail(null);
  restarted.applySyncedSnapshot(snapshot(data), {owner: A, sequence: 0, revision: 3});
  assert.equal(restarted.getSyncInfo().snapshotCurrent, true);
  assert.deepEqual(restarted.getState().allergies, ['牛奶']);
  assert.equal(app.saved[key(A)].__sync.snapshotSchemaVersion, 3);
});

test('missing, unknown and malformed parser versions remain readable but cannot certify completeness', () => {
  for (const version of [undefined, 0, 1, 2, 4, '3', null, -1, true, {}]) {
    const data = {...empty(), allergies: ['花生'], allergiesUpdatedAt: 100};
    const app = setup({[ACTIVE]: A, [key(A)]: accountCache(data, version)});
    assert.equal(app.store.getSyncInfo().blocked, false);
    assert.equal(app.store.getSyncInfo().snapshotCurrent, false, 'unrecognized marker: ' + JSON.stringify(version));
    assert.deepEqual(app.store.getState().allergies, ['花生']);
    app.store.bindAccount(B);
    app.store.bindAccount(A);
    assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
    assert.equal(app.saved[key(A)].__sync.snapshotSchemaVersion, 0);
  }
});

test('rejected snapshots cannot add the current parser marker to an old account cache', () => {
  const app = setup({[ACTIVE]: A, [key(A)]: accountCache()});
  const before = copy(app.saved[key(A)]);
  assert.equal(app.store.applySyncedSnapshot(snapshot(empty()), {owner: A, sequence: 0, revision: 2}), false);
  assert.throws(() => app.store.applySyncedSnapshot(snapshot(empty()), {owner: B, sequence: 0, revision: 4}), /账号已切换/);
  assert.throws(() => app.store.applySyncedSnapshot(snapshot({...empty(), allergies: ['']}), {owner: A, sequence: 0, revision: 4}));
  assert.equal(app.store.getSyncInfo().snapshotCurrent, false);
  assert.deepEqual(app.saved[key(A)], before);
});

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
  assert.deepEqual(app.writes(), [key(A), LEGACY, ACTIVE_SCOPE, ACTIVE]);
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
  for (const failedKey of [key(A), LEGACY, ACTIVE_SCOPE, ACTIVE]) {
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
