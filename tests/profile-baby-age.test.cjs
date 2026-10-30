"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {evaluatePage} = require('./page-runtime.cjs');
const age = require('../utils/baby-age');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const profile = {id: 'a'.repeat(32), name: '公开的小厨房', bio: '分享做法', exists: true};
const pick = value => ({detail: {value}});
const TODAY = '2026-10-29', BIRTH = '2026-02-28';

function setup(options = {}) {
  let owner = 'owner-a', today = TODAY;
  let savedProfile = {...profile, ...options.profile};
  const babyAge = {todayString: () => today,
    isValidBirthDate: (value, day = today) => age.isValidBirthDate(value, day),
    ageInMonths: (value, day = today) => age.ageInMonths(value, day), ageLabel: age.ageLabel};
  const listeners = new Set();
  const calls = {saved: [], updates: 0, errors: [], toasts: [], reads: 0};
  const state = {recipes: [], logs: [], nickname: 'PRIVATE BABY', baby: {birthday: '2025-01-01'}};
  const store = {getSyncInfo: () => ({owner}), getState: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const wx = {hideShareMenu() {}, showShareMenu() {}, showToast(value) { calls.toasts.push(value.title); },
    navigateTo() {}, navigateBack() {}, switchTab() {}};
  const social = {
    getMine: async () => { calls.reads++; return {profile: clone(savedProfile), published: []}; },
    getProfile: async () => { calls.reads++; return {profile: clone(savedProfile), isSelf: !options.visitor, recipes: [], nextOffset: null}; },
    saveProfile: async input => {
      calls.saved.push(clone(input)); savedProfile = {...savedProfile, ...input};
      if (Object.hasOwn(input, 'babyBirthDate')) savedProfile.babyAgeMonths = babyAge.ageInMonths(input.babyBirthDate);
      return {profile: clone(savedProfile)};
    }, ...options.social
  };
  const accountModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require: () => store});
  let definition;
  evaluatePage(options.visitor || options.selfId ? 'profile' : 'mine', {
    wx, babyAge, Page(value) { definition = value; }, require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-poster')) return {remove() {}};
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); }};
  page.onLoad(options.visitor || options.selfId ? {id: profile.id} : {});
  return {page, calls, listeners, setToday(value) { today = value; },
    changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

function assertCleared(page) {
  assert.equal(page.data.profile, null); assert.equal(page.data.babyBirthDate, null);
  assert.equal(page.data.birthdayAgeLabel, ''); assert.equal(page.data.birthdayDirty, false);
  assert.equal(page.data.babyAgeLabel, ''); assert.equal(page.data.babyAgeMonths, null);
}

test('missing birthday remains unset and nickname saves never infer or submit private baby details', async () => {
  const {page, calls} = setup(); await page.load(); page.edit();
  assert.equal(page.data.babyBirthDate, null); assert.equal(page.data.birthdayDirty, false);
  assert.equal(page.data.birthDateToday, TODAY); assert.equal(page.data.babyAgeLabel, '');
  await page.save();
  assert.deepEqual(calls.saved, [{name: profile.name, bio: profile.bio}]);
  assert.doesNotMatch(JSON.stringify(calls.saved), /PRIVATE BABY|birthday|2025-01-01|babyAgeMonths/);
});

test('legacy manual months remain visible and untouched when only name or bio is edited', async t => {
  for (const months of [0, 8, 120, 121]) await t.test(String(months), async () => {
    const {page, calls} = setup({profile: {babyAgeMonths: months}}); await page.load(); page.edit();
    assert.equal(page.data.babyAgeLabel, age.ageLabel(months));
    assert.equal(page.data.babyBirthDate, null); assert.equal(page.data.birthdayAgeLabel, '');
    page.changeBio(pick('改了介绍')); await page.save();
    assert.deepEqual(calls.saved[0], {name: profile.name, bio: '改了介绍'});
    assert.equal(page.data.babyAgeMonths, months);
  });
});

test('date picker drafts preview the calculated age without changing the saved homepage or being reset by onShow', async () => {
  const {page, calls} = setup({profile: {babyBirthDate: BIRTH, babyAgeMonths: 8}}); await page.load(); page.edit();
  page.changeBabyBirthDate(pick(TODAY));
  assert.equal(page.data.babyBirthDate, TODAY); assert.equal(page.data.birthdayAgeLabel, '宝宝未满1个月');
  assert.equal(page.data.birthdayDirty, true); assert.equal(page.data.profile.babyBirthDate, BIRTH);
  assert.equal(page.data.babyAgeLabel, '宝宝8个月');
  const reads = calls.reads; await page.onShow();
  assert.equal(calls.reads, reads); assert.equal(page.data.babyBirthDate, TODAY);
  page.cancelEdit();
  assert.equal(page.data.babyBirthDate, BIRTH); assert.equal(page.data.birthdayDirty, false);
  assert.equal(page.data.babyAgeLabel, '宝宝8个月'); assert.deepEqual(calls.saved, []);
  page.edit(); assert.equal(page.data.babyBirthDate, BIRTH);
});

test('birthday picker rejects invalid, future and pre-1900 dates and supports the documented lower bound', async () => {
  const {page} = setup({profile: {babyBirthDate: BIRTH}}); await page.load(); page.edit();
  for (const value of ['', ' ', null, undefined, '2026-02-30', '2025-02-29', '2026-10-30', '1899-12-31', '2026-2-1', '0']) {
    page.changeBabyBirthDate(pick(value));
    assert.equal(page.data.babyBirthDate, BIRTH, String(value)); assert.equal(page.data.birthdayDirty, false);
  }
  page.changeBabyBirthDate(pick('1900-01-01'));
  assert.equal(page.data.babyBirthDate, '1900-01-01');
  assert.equal(page.data.birthdayAgeLabel, age.ageLabel(age.ageInMonths('1900-01-01', TODAY)));
});

test('only explicit birthday edits submit a date, unchanged edits omit it, and clearing submits null', async () => {
  const {page, calls} = setup({profile: {babyAgeMonths: 8}}); await page.load(); page.edit();
  page.changeBabyBirthDate(pick(TODAY)); await page.save();
  assert.deepEqual(calls.saved[0], {name: profile.name, bio: profile.bio, babyBirthDate: TODAY});
  assert.equal(page.data.babyAgeLabel, '宝宝未满1个月'); assert.equal(page.data.birthdayDirty, false);
  page.edit(); await page.save(); assert.equal(Object.hasOwn(calls.saved[1], 'babyBirthDate'), false);
  page.edit(); page.clearBabyBirthDate();
  assert.equal(page.data.babyAgeLabel, '宝宝未满1个月'); assert.equal(page.data.birthdayAgeLabel, '');
  await page.save(); assert.equal(calls.saved[2].babyBirthDate, null);
  assert.equal(page.data.babyBirthDate, null); assert.equal(page.data.babyAgeLabel, '');
});

test('clearing legacy manual age can be cancelled, or explicitly saved as a null birthday', async () => {
  const {page, calls} = setup({profile: {babyAgeMonths: 8}}); await page.load(); page.edit();
  page.clearBabyBirthDate(); page.cancelEdit();
  assert.equal(page.data.birthdayDirty, false); assert.equal(page.data.babyAgeLabel, '宝宝8个月');
  page.edit(); await page.save(); assert.equal(Object.hasOwn(calls.saved[0], 'babyBirthDate'), false);
  page.edit(); page.clearBabyBirthDate(); await page.save();
  assert.equal(calls.saved[1].babyBirthDate, null); assert.equal(page.data.babyAgeLabel, '');
});

test('opening the own profile by public ID takes the authoritative private birthday from mine', async () => {
  const {page} = setup({selfId: true, profile: {babyBirthDate: BIRTH, babyAgeMonths: 8}, social: {
    getProfile: async () => ({profile: {...profile, babyAgeMonths: 7}, isSelf: true, recipes: []})
  }});
  await page.load(); page.edit();
  assert.equal(page.data.babyBirthDate, BIRTH); assert.equal(page.data.babyAgeLabel, '宝宝8个月');
});

test('visitors see only the returned public month count and cannot read or edit a birthday', async () => {
  const {page, calls} = setup({visitor: true, profile: {babyBirthDate: BIRTH, babyAgeMonths: 12}});
  await page.load(); page.edit(); page.changeBabyBirthDate(pick(TODAY)); page.clearBabyBirthDate(); await page.save();
  assert.equal(page.data.isSelf, false); assert.equal(page.data.editing, false);
  assert.equal(page.data.babyAgeLabel, '宝宝12个月'); assert.equal(page.data.babyBirthDate, null);
  assert.equal(page.data.profile.babyBirthDate, undefined); assert.equal(page.data.birthdayDirty, false);
  assert.deepEqual(calls.saved, []);
  assert.doesNotMatch(JSON.stringify(page.onShareAppMessage()), /babyBirthDate|2026-02-28/);
});

test('invalid public month values are hidden and invalid stored birthdays never become editor drafts', async () => {
  for (const months of [null, -1, 2.5, '8']) {
    const {page} = setup({visitor: true, profile: {babyAgeMonths: months}}); await page.load();
    assert.equal(page.data.babyAgeLabel, '');
  }
  const {page} = setup({profile: {babyBirthDate: '2099-01-01', babyAgeMonths: 8}}); await page.load(); page.edit();
  assert.equal(page.data.babyBirthDate, null); assert.equal(page.data.babyAgeLabel, '宝宝8个月');
});

test('own saved birthday recalculates on the next visit without saving or changing the birthday', async () => {
  const fixture = setup({profile: {babyBirthDate: TODAY, babyAgeMonths: 0}}); await fixture.page.load();
  assert.equal(fixture.page.data.babyAgeLabel, '宝宝未满1个月');
  fixture.setToday('2026-11-29'); await fixture.page.onShow();
  assert.equal(fixture.page.data.babyAgeLabel, '宝宝1个月');
  assert.equal(fixture.page.data.babyBirthDate, TODAY); assert.deepEqual(fixture.calls.saved, []);
});

test('failed own and visitor reloads clear all birthday and age presentation', async t => {
  for (const visitor of [false, true]) await t.test(visitor ? 'visitor' : 'own', async () => {
    let reads = 0;
    const read = async () => { if (++reads > 1) throw Error('暂时离线');
      return {profile: {...profile, babyBirthDate: BIRTH, babyAgeMonths: 8}, isSelf: !visitor, recipes: [], published: []}; };
    const {page} = setup({visitor, social: {getMine: read, getProfile: read}}); await page.load(); await page.load();
    assertCleared(page);
  });
});

test('failed birthday saves keep the draft and old public label; changes are blocked while saving', async () => {
  const pending = deferred();
  const {page} = setup({profile: {babyBirthDate: BIRTH, babyAgeMonths: 8}, social: {saveProfile: () => pending.promise}});
  await page.load(); page.edit(); page.changeBabyBirthDate(pick(TODAY)); const task = page.save();
  page.changeBabyBirthDate(pick('2024-01-01')); page.clearBabyBirthDate(); page.cancelEdit();
  assert.equal(page.data.babyBirthDate, TODAY); assert.equal(page.data.editing, true);
  pending.reject(Error('暂时离线')); await task;
  assert.equal(page.data.babyAgeLabel, '宝宝8个月'); assert.equal(page.data.birthdayDirty, true);
  assert.equal(page.data.saving, false); assert.equal(page.data.babyBirthDate, TODAY);
});

test('invalid injected birthday drafts are rejected before a save request', async () => {
  const {page, calls} = setup(); await page.load(); page.edit();
  page.setData({birthdayDirty: true, babyBirthDate: '2099-01-01'}); await page.save();
  assert.deepEqual(calls.saved, []); assert.match(calls.errors[0], /生日/);
});

test('account changes clear private birthday drafts and discard late saves', async () => {
  const pending = deferred();
  const fixture = setup({profile: {babyBirthDate: BIRTH, babyAgeMonths: 8}, social: {saveProfile: () => pending.promise}});
  await fixture.page.load(); fixture.page.edit(); fixture.page.changeBabyBirthDate(pick(TODAY));
  const task = fixture.page.save(); fixture.changeOwner('owner-b');
  pending.resolve({profile: {...profile, babyBirthDate: TODAY, babyAgeMonths: 0}}); await task;
  assertCleared(fixture.page); assert.equal(fixture.page.data.editing, false);
  assert.equal(fixture.page.data.birthDateToday, ''); assert.deepEqual(fixture.calls.toasts, []);
  assert.match(fixture.page.data.error, /账号已切换/);
});

test('unnotified account changes block birthday mutation before network writes', async () => {
  const fixture = setup({profile: {babyBirthDate: BIRTH}}); await fixture.page.load(); fixture.page.edit();
  fixture.page.changeBabyBirthDate(pick(TODAY)); fixture.changeOwner('owner-b', false); await fixture.page.save();
  assert.deepEqual(fixture.calls.saved, []); assertCleared(fixture.page);
});

test('unloaded pages and stale requests cannot restore birthdays or show a saved toast', async () => {
  const pending = deferred();
  const fixture = setup({profile: {babyBirthDate: BIRTH}, social: {saveProfile: () => pending.promise}});
  await fixture.page.load(); fixture.page.edit(); fixture.page.changeBabyBirthDate(pick(TODAY));
  const saving = fixture.page.save(); fixture.page.onUnload(); const updates = fixture.calls.updates;
  pending.resolve({profile: {...profile, babyBirthDate: TODAY}}); await saving;
  assert.equal(fixture.calls.updates, updates); assert.deepEqual(fixture.calls.toasts, []); assert.equal(fixture.listeners.size, 0);
  const old = deferred(); let reads = 0;
  const next = setup({social: {getMine: () => ++reads === 1 ? old.promise : Promise.resolve({profile: {...profile, babyBirthDate: TODAY}, published: []})}});
  const first = next.page.load(); await next.page.load(); old.resolve({profile: {...profile, babyBirthDate: BIRTH}, published: []}); await first;
  assert.equal(next.page.data.babyBirthDate, TODAY); assert.equal(next.page.data.babyAgeLabel, '宝宝未满1个月');
});
