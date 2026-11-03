'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const storePath = path.resolve(__dirname, '../utils/store.js');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const FAMILY = {kind: 'family', id: 'f'.repeat(64), membershipId: 'c'.repeat(32)};
const PREFIX = 'baby-bites-allergy-filter-v1:';
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

function setup() {
  const saved = {};
  const writes = [];
  let failRead = '', failWrite = '';
  function reload() {
    global.wx = {
      getStorageSync(name) {
        if (name === failRead) throw Error('unreadable');
        return copy(saved[name]);
      },
      getStorageInfoSync: () => ({keys: Object.keys(saved)}),
      setStorageSync(name, value) {
        if (name === failWrite) throw Error('quota');
        saved[name] = copy(value); writes.push(name);
      }
    };
    delete require.cache[storePath];
    return require(storePath);
  }
  return {store: reload(), reload, saved, writes,
    failRead: key => { failRead = key; }, failWrite: key => { failWrite = key; }};
}

test('recorded allergies do not opt in, and a chosen filter survives restarting the app', () => {
  const app = setup();
  assert.equal(app.store.getAllergyFilterEnabled(), false);
  app.store.bindAccount(A);
  app.store.setAllergies(['鸡蛋']);
  assert.equal(app.store.getAllergyFilterEnabled(), false);
  assert.equal(app.writes.some(key => key.startsWith(PREFIX)), false);
  app.store.setAllergyFilterEnabled(true);
  const restarted = app.reload();
  assert.equal(restarted.getAllergyFilterEnabled(), true);
  assert.deepEqual(restarted.getState().allergies, ['鸡蛋']);
  restarted.setAllergyFilterEnabled(false);
  assert.equal(app.reload().getAllergyFilterEnabled(), false);
  assert.deepEqual(app.reload().getState().allergies, ['鸡蛋']);
});

test('changing the filter refreshes listeners without changing shared data, sync state or backups', () => {
  const app = setup(); app.store.bindAccount(A); app.store.setAllergies(['牛奶']);
  const snapshot = app.store.getSyncSnapshot();
  app.store.applySyncedSnapshot(snapshot, {owner: A, scopeKey: app.store.getScopeKey(),
    sequence: app.store.getSyncInfo().sequence, revision: 1});
  const before = {info: app.store.getSyncInfo(), snapshot: app.store.getSyncSnapshot(), backup: app.store.exportBackup()};
  assert.equal(before.info.dirty, false);
  let notified = 0;
  app.store.subscribe(() => { notified++; });
  app.store.setAllergyFilterEnabled(true);
  assert.equal(notified, 1);
  assert.deepEqual(app.store.getSyncInfo(), before.info);
  assert.deepEqual(app.store.getSyncSnapshot(), before.snapshot);
  assert.equal(app.store.exportBackup(), before.backup);
  app.store.setAllergyFilterEnabled(true);
  assert.equal(notified, 1);
  app.store.setAllergyFilterEnabled(false);
  assert.equal(notified, 2);
  assert.deepEqual(app.store.getSyncInfo(), before.info);
});

test('each account and family membership chooses separately and returning restores its preference', () => {
  const app = setup(); app.store.bindAccount(A); app.store.setAllergyFilterEnabled(true);
  app.store.bindScope(A, FAMILY);
  assert.equal(app.store.getAllergyFilterEnabled(), false, 'joining does not inherit the personal choice');
  app.store.setAllergyFilterEnabled(true);
  app.store.bindScope(B, {...FAMILY, membershipId: 'd'.repeat(32)});
  assert.equal(app.store.getAllergyFilterEnabled(), false, 'another family member chooses independently');
  app.store.bindScope(A, {...FAMILY, membershipId: 'e'.repeat(32)});
  assert.equal(app.store.getAllergyFilterEnabled(), false, 'rejoining uses a fresh membership preference');
  app.store.bindScope(A, FAMILY);
  assert.equal(app.store.getAllergyFilterEnabled(), true);
  app.store.bindScope(A, {kind: 'personal', id: A});
  assert.equal(app.store.getAllergyFilterEnabled(), true);
  app.store.bindAccount(B);
  assert.equal(app.store.getAllergyFilterEnabled(), false);
  app.store.bindAccount(A);
  assert.equal(app.reload().getAllergyFilterEnabled(), true);
});

test('a guest filter does not silently enable filtering for the first authenticated account', () => {
  const app = setup(); app.store.setAllergyFilterEnabled(true);
  assert.equal(app.reload().getAllergyFilterEnabled(), true);
  app.store.bindAccount(A);
  assert.equal(app.store.getAllergyFilterEnabled(), false);
});

test('failed preference writes preserve the current choice and can be retried without touching allergy records', () => {
  const app = setup(); app.store.bindAccount(A); app.store.setAllergies(['花生']);
  const key = PREFIX + app.store.getScopeKey();
  let notified = 0; app.store.subscribe(() => { notified++; });
  const before = app.store.getSyncSnapshot();
  app.failWrite(key);
  assert.throws(() => app.store.setAllergyFilterEnabled(true), /筛选偏好未保存/);
  assert.equal(app.store.getAllergyFilterEnabled(), false);
  assert.equal(notified, 0);
  assert.deepEqual(app.store.getSyncSnapshot(), before);
  app.failWrite(''); app.store.setAllergyFilterEnabled(true);
  assert.equal(app.store.getAllergyFilterEnabled(), true);
  app.failWrite(key);
  assert.throws(() => app.store.setAllergyFilterEnabled(false), /筛选偏好未保存/);
  assert.equal(app.store.getAllergyFilterEnabled(), true);
  assert.equal(notified, 1);
});

test('scope transitions reject preference writes and malformed or unavailable preferences default off', () => {
  const app = setup(); app.store.bindAccount(A);
  const release = app.store.beginScopeChange();
  assert.throws(() => app.store.setAllergyFilterEnabled(true), /切换家庭/);
  release();
  assert.throws(() => app.store.setAllergyFilterEnabled('true'), /请选择/);
  const key = PREFIX + app.store.getScopeKey();
  for (const value of ['true', 1, {}, null]) {
    app.saved[key] = value;
    assert.equal(app.store.getAllergyFilterEnabled(), false);
  }
  app.saved[key] = true; app.failRead(key);
  assert.equal(app.store.getAllergyFilterEnabled(), false);
  assert.equal(app.store.getSyncInfo().blocked, false);
  app.failRead('');
  assert.equal(app.store.getAllergyFilterEnabled(), true);
});
