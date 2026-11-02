'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {mergeSnapshots} = require('../utils/sync-merge');
const storePath = require.resolve('../utils/store');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const LEGACY = 'baby-bites-v1';
const key = owner => 'baby-bites-account-' + owner;
const empty = () => ({version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []});
const snapshot = data => ({version: 1, data: clone(data), deleted: {recipes: [], logs: []}});

function setup(initial = empty()) {
  const saved = {[LEGACY]: clone(initial)};
  let failWrite = false;
  let writes = 0;
  function reload() {
    global.wx = {
      getStorageSync: name => clone(saved[name]),
      getStorageInfoSync: () => ({keys: Object.keys(saved)}),
      setStorageSync(name, value) {
        if (failWrite) throw Error('quota exceeded');
        writes++;
        saved[name] = clone(value);
      }
    };
    delete require.cache[storePath];
    return require(storePath);
  }
  return {store: reload(), reload, saved, writes: () => writes, fail(value) { failWrite = value; }};
}

test('allergy records preserve legacy absence and explicitly save, normalize and clear independently of nickname', () => {
  const app = setup();
  assert.equal(Object.hasOwn(app.store.getState(), 'allergies'), false);
  assert.equal(Object.hasOwn(app.store.validateData(empty()), 'allergiesUpdatedAt'), false);
  assert.equal(app.writes(), 0);
  const input = [' 鸡蛋 ', '牛奶', '鸡蛋'];
  assert.deepEqual(app.store.setAllergies(input), ['鸡蛋', '牛奶']);
  input.push('花生');
  const saved = app.store.getState();
  assert.deepEqual(saved.allergies, ['鸡蛋', '牛奶']);
  assert.ok(Number.isSafeInteger(saved.allergiesUpdatedAt) && saved.allergiesUpdatedAt > 0);
  assert.equal(saved.profileUpdatedAt, 0);
  assert.equal(app.store.getSyncInfo().dirty, true);
  assert.deepEqual(JSON.parse(app.store.exportBackup()).allergies, saved.allergies);
  app.store.setNickname('新称呼');
  assert.equal(app.store.getState().allergiesUpdatedAt, saved.allergiesUpdatedAt);
  app.store.setAllergies([]);
  assert.deepEqual(app.store.getState().allergies, []);
  assert.ok(app.store.getState().allergiesUpdatedAt > saved.allergiesUpdatedAt);
  assert.deepEqual(app.reload().getState().allergies, []);
});

test('invalid allergy records and timestamps never change existing storage', () => {
  const app = setup();
  app.store.setAllergies(['鸡蛋']);
  const before = clone(app.saved);
  for (const input of [undefined, null, '', {}, [''], ['  '], [1], ['鸡蛋\n'], ['牛奶\u007f'], ['甲'.repeat(41)], Array(51).fill('鸡蛋')]) {
    assert.throws(() => app.store.setAllergies(input), /过敏|食物/);
    assert.deepEqual(app.saved, before);
  }
  for (const value of [null, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.throws(() => app.store.validateData({...empty(), allergies: ['牛奶'], allergiesUpdatedAt: value}), /过敏/);
  }
  assert.throws(() => app.store.validateData({...empty(), allergiesUpdatedAt: 0}), /过敏/);
  assert.equal(app.store.validateData({...empty(), allergies: ['牛奶']}).allergiesUpdatedAt, 0);
});

test('allergy save storage failures preserve memory, dirty sequence and observer state', () => {
  const app = setup();
  app.store.setAllergies(['鸡蛋']);
  const before = app.store.getState(), info = app.store.getSyncInfo();
  const notifications = [];
  app.store.subscribe(value => notifications.push(value));
  app.fail(true);
  assert.throws(() => app.store.setAllergies(['牛奶']), /保存失败/);
  assert.deepEqual(app.store.getState(), before);
  assert.deepEqual(app.store.getSyncInfo(), info);
  assert.deepEqual(notifications, []);
  app.fail(false);
  app.store.setAllergies(['牛奶']);
  assert.equal(notifications.length, 1);
});

test('backup import preserves missing or older allergy settings and accepts an explicit newer clear', () => {
  const app = setup({...empty(), allergies: ['鸡蛋'], allergiesUpdatedAt: 20});
  app.store.importBackup(JSON.stringify({...empty(), nickname: '旧备份称呼', profileUpdatedAt: 30}));
  assert.deepEqual(app.store.getState().allergies, ['鸡蛋']);
  assert.equal(app.store.getState().nickname, '旧备份称呼');
  app.store.importBackup(JSON.stringify({...empty(), allergies: ['牛奶'], allergiesUpdatedAt: 10}));
  assert.deepEqual(app.store.getState().allergies, ['鸡蛋']);
  app.store.importBackup(JSON.stringify({...empty(), allergies: [], allergiesUpdatedAt: 21}));
  assert.deepEqual(app.store.getState().allergies, []);
  app.store.importBackup(JSON.stringify({...empty(), allergies: ['鸡蛋'], allergiesUpdatedAt: 20}));
  assert.deepEqual(app.reload().getState().allergies, []);
});

test('allergy sync merge is independent, deterministic, idempotent and distinguishes absent from cleared', () => {
  const local = snapshot({...empty(), nickname: '本机新称呼', profileUpdatedAt: 40, allergies: ['鸡蛋'], allergiesUpdatedAt: 20});
  const remote = snapshot({...empty(), nickname: '远端旧称呼', profileUpdatedAt: 30, allergies: ['牛奶'], allergiesUpdatedAt: 21});
  const merged = mergeSnapshots(local, remote);
  assert.equal(merged.data.nickname, '本机新称呼');
  assert.deepEqual(merged.data.allergies, ['牛奶']);
  assert.deepEqual(mergeSnapshots(remote, local), merged);
  assert.deepEqual(mergeSnapshots(merged, local), merged);
  const tie = snapshot({...empty(), allergies: ['花生'], allergiesUpdatedAt: 21});
  assert.deepEqual(mergeSnapshots(remote, tie), mergeSnapshots(tie, remote));
  assert.deepEqual(mergeSnapshots(remote, tie).data.allergies, ['牛奶', '花生']);
  const tiedClear = snapshot({...empty(), allergies: [], allergiesUpdatedAt: 21});
  assert.deepEqual(mergeSnapshots(remote, tiedClear).data.allergies, ['牛奶']);
  assert.deepEqual(mergeSnapshots(tiedClear, remote).data.allergies, ['牛奶']);
  const cleared = snapshot({...empty(), allergies: [], allergiesUpdatedAt: 22});
  assert.deepEqual(mergeSnapshots(merged, cleared).data.allergies, []);
  const missing = snapshot(empty());
  assert.deepEqual(mergeSnapshots(cleared, missing).data.allergies, []);
  assert.deepEqual(mergeSnapshots(missing, snapshot({...empty(), allergies: ['鸡蛋']})).data.allergies, ['鸡蛋']);
  assert.equal(Object.hasOwn(mergeSnapshots(missing, missing).data, 'allergies'), false);
});

test('same-time allergy edits form a deterministic union without losing independent additions', () => {
  const a = snapshot({...empty(), allergies: ['鸡蛋', '牛奶'], allergiesUpdatedAt: 42});
  const b = snapshot({...empty(), allergies: ['花生', '鸡蛋'], allergiesUpdatedAt: 42});
  const beforeA = clone(a), beforeB = clone(b);
  const merged = mergeSnapshots(a, b);
  assert.deepEqual(merged.data.allergies, ['牛奶', '花生', '鸡蛋']);
  assert.deepEqual(mergeSnapshots(b, a), merged);
  assert.deepEqual(mergeSnapshots(merged, a), merged);
  assert.deepEqual(mergeSnapshots(merged, b), merged);
  assert.deepEqual(a, beforeA);
  assert.deepEqual(b, beforeB);
  assert.deepEqual(mergeSnapshots(a, a).data.allergies, ['鸡蛋', '牛奶']);
  const newer = snapshot({...empty(), allergies: [], allergiesUpdatedAt: 43});
  assert.deepEqual(mergeSnapshots(merged, newer).data.allergies, []);
});

test('an oversized same-time allergy union fails without truncating or overwriting either record', () => {
  const a = {...empty(), allergies: Array.from({length: 30}, (_, i) => '食物甲' + i), allergiesUpdatedAt: 42};
  const b = {...empty(), allergies: Array.from({length: 30}, (_, i) => '食物乙' + i), allergiesUpdatedAt: 42};
  const left = snapshot(a), right = snapshot(b), beforeLeft = clone(left), beforeRight = clone(right);
  assert.throws(() => mergeSnapshots(left, right), error => /过敏.*超过 50/.test(error.message) && error.userMessage === error.message);
  assert.throws(() => mergeSnapshots(right, left), /过敏.*超过 50/);
  assert.deepEqual(left, beforeLeft);
  assert.deepEqual(right, beforeRight);
  const app = setup(a);
  const before = clone(app.saved);
  assert.throws(() => app.store.importBackup(JSON.stringify(b)), /过敏.*超过 50/);
  assert.deepEqual(app.saved, before);
  assert.deepEqual(app.store.getState().allergies, a.allergies);
  assert.deepEqual(b.allergies, beforeRight.data.allergies);
});

test('allergy settings follow their account and survive old snapshots or an edit during sync', () => {
  const app = setup({...empty(), allergies: ['鸡蛋'], allergiesUpdatedAt: 20});
  app.store.bindAccount(A);
  assert.deepEqual(app.saved[key(A)].data.allergies, ['鸡蛋']);
  app.store.bindAccount(B);
  assert.equal(Object.hasOwn(app.store.getState(), 'allergies'), false);
  app.store.setAllergies(['牛奶']);
  app.store.bindAccount(A);
  assert.deepEqual(app.store.getState().allergies, ['鸡蛋']);
  app.store.applySyncedSnapshot(snapshot(empty()), {owner: A, sequence: app.store.getSyncInfo().sequence, revision: 1});
  assert.deepEqual(app.store.getState().allergies, ['鸡蛋']);
  const sent = app.store.getSyncSnapshot(), sequence = app.store.getSyncInfo().sequence;
  app.store.setAllergies(['花生']);
  app.store.applySyncedSnapshot(sent, {owner: A, sequence, revision: 2});
  assert.deepEqual(app.store.getState().allergies, ['花生']);
  assert.equal(app.store.getSyncInfo().dirty, true);
  const clear = app.store.getSyncSnapshot();
  clear.data.allergies = [];
  clear.data.allergiesUpdatedAt++;
  app.store.applySyncedSnapshot(clear, {owner: A, sequence: app.store.getSyncInfo().sequence, revision: 3});
  assert.deepEqual(app.reload().getState().allergies, []);
  assert.deepEqual(app.saved[key(B)].data.allergies, ['牛奶']);
});
