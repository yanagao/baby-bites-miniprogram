'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const copy = value => JSON.parse(JSON.stringify(value));
const input = value => ({detail: {value}});
const food = name => ({currentTarget: {dataset: {name}}});

function setup(initial = {}) {
  let owner = 'account-a', writeFailure = false, alerted = false;
  let state = copy(initial);
  const listeners = new Set();
  const calls = {writes: [], backs: 0, toasts: [], changes: 0};
  const store = {
    getSyncInfo: () => ({owner}), getState: () => copy(state),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setAllergies(values) {
      calls.writes.push(copy(values));
      if (writeFailure) throw Error('本机存储空间不足');
      state.allergies = copy(values);
      listeners.forEach(fn => fn());
    }
  };
  const wx = {
    enableAlertBeforeUnload() { alerted = true; },
    disableAlertBeforeUnload(options) { alerted = false; if (options.complete) options.complete(); },
    showToast(options) { calls.toasts.push(options.title); }
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/allergies/index.js'), 'utf8'), {
    wx, Page(value) { definition = value; }, require(dep) {
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/allergies')) return require('../utils/allergies');
      if (dep.endsWith('/ui')) return {back() { assert.equal(alerted, false); calls.backs++; }};
      throw Error('Unexpected dependency ' + dep);
    }
  });
  const page = {...definition, data: copy(definition.data),
    setData(values) { calls.changes++; Object.assign(this.data, copy(values)); }};
  page.onLoad();
  return {page, calls, state: () => copy(state), alerted: () => alerted,
    failWrites(value = true) { writeFailure = value; },
    changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); },
    sync(values) { state.allergies = copy(values); listeners.forEach(fn => fn()); },
    listenerCount: () => listeners.size};
}

test('allergy page reads private saved values and leaves old missing data untouched', () => {
  const saved = setup({allergies: ['鸡蛋', '芒果']});
  assert.deepEqual(saved.page.data.allergies, ['鸡蛋', '芒果']);
  assert.equal(saved.page.data.options.find(item => item.name === '鸡蛋').selected, true);
  assert.equal(saved.alerted(), false); assert.deepEqual(saved.calls.writes, []);
  const old = setup();
  assert.deepEqual(old.page.data.allergies, []);
  old.page.save();
  assert.deepEqual(old.calls.writes, []); assert.equal(old.calls.backs, 1);
  assert.equal(Object.hasOwn(old.state(), 'allergies'), false);
});

test('quick choices and typed food save only the private list, including pending input', () => {
  const {page, calls, state, alerted} = setup();
  page.toggleFood(food('鸡蛋'));
  page.changeInput(input('  芒果  '));
  assert.equal(alerted(), true);
  assert.deepEqual(calls.writes, []);
  page.save();
  assert.deepEqual(calls.writes, [['鸡蛋', '芒果']]);
  assert.deepEqual(state().allergies, ['鸡蛋', '芒果']);
  assert.equal(page.data.input, ''); assert.equal(alerted(), false);
  assert.equal(calls.backs, 1); assert.deepEqual(calls.toasts, ['过敏食物已保存']);
});

test('duplicate custom food is not added twice and invalid or excessive input retains its draft', () => {
  const {page, calls} = setup({allergies: ['鸡蛋']});
  page.changeInput(input(' 鸡蛋 ')); page.addFood();
  assert.deepEqual(page.data.allergies, ['鸡蛋']); assert.equal(page.data.input, '');
  page.changeInput(input('食'.repeat(41))); page.addFood();
  assert.ok(page.data.error); assert.equal(page.data.input.length, 41);
  assert.deepEqual(page.data.allergies, ['鸡蛋']);
  page.save(); assert.deepEqual(calls.writes, []);
  page.changeInput(input('芝麻\u0000')); page.addFood();
  assert.ok(page.data.error); assert.deepEqual(calls.writes, []);
  const full = setup({allergies: Array.from({length: 50}, (_, index) => '食物' + index)});
  full.page.toggleFood(food('鸡蛋'));
  assert.equal(full.page.data.allergies.length, 50); assert.ok(full.page.data.error);
  assert.deepEqual(full.calls.writes, []);
});

test('removing the final saved allergy explicitly persists an empty list', () => {
  const {page, calls, state} = setup({allergies: ['鸡蛋']});
  page.removeFood(food('鸡蛋')); page.save();
  assert.deepEqual(calls.writes, [[]]); assert.deepEqual(state().allergies, []);
});

test('storage failure preserves selected foods and pending input for retry', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  fixture.page.toggleFood(food('牛奶')); fixture.page.changeInput(input('芒果'));
  fixture.failWrites(); fixture.page.save();
  assert.deepEqual(fixture.state().allergies, ['鸡蛋']);
  assert.deepEqual(fixture.page.data.allergies, ['鸡蛋', '牛奶']);
  assert.equal(fixture.page.data.input, '芒果'); assert.match(fixture.page.data.error, /存储/);
  assert.equal(fixture.page.data.saving, false); assert.equal(fixture.calls.backs, 0);
  assert.equal(fixture.alerted(), true);
  fixture.failWrites(false); fixture.page.save();
  assert.deepEqual(fixture.state().allergies, ['鸡蛋', '牛奶', '芒果']);
  assert.equal(fixture.calls.backs, 1);
});

test('cancel confirms changed or typed drafts and never writes discarded values', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  fixture.page.changeInput(input('芒果')); fixture.page.cancel();
  assert.equal(fixture.page.data.discardVisible, true); assert.equal(fixture.calls.backs, 0);
  fixture.page.continueEditing();
  assert.equal(fixture.page.data.discardVisible, false); assert.equal(fixture.page.data.input, '芒果');
  fixture.page.cancel(); fixture.page.discard();
  assert.deepEqual(fixture.state().allergies, ['鸡蛋']); assert.deepEqual(fixture.calls.writes, []);
  assert.equal(fixture.calls.backs, 1); assert.equal(fixture.alerted(), false);
});

test('background sync refreshes a clean view and preserves an edited draft and unseen additions', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  fixture.sync(['鸡蛋', '牛奶']);
  assert.deepEqual(fixture.page.data.allergies, ['鸡蛋', '牛奶']);
  fixture.page.removeFood(food('鸡蛋')); fixture.page.changeInput(input('芒果'));
  fixture.sync(['鸡蛋', '牛奶', '花生']); fixture.page.onShow();
  assert.deepEqual(fixture.page.data.allergies, ['牛奶']);
  assert.equal(fixture.page.data.input, '芒果');
  fixture.page.save();
  assert.deepEqual(fixture.state().allergies, ['牛奶', '花生', '芒果']);
});

test('a changed account clears and locks the old draft even if the original account returns', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  fixture.page.changeInput(input('芒果'));
  fixture.changeOwner('account-b');
  assert.deepEqual(fixture.page.data.allergies, []); assert.equal(fixture.page.data.input, '');
  assert.match(fixture.page.data.accountError, /账号已切换/); assert.equal(fixture.alerted(), false);
  fixture.changeOwner('account-a');
  fixture.page.toggleFood(food('牛奶')); fixture.page.changeInput(input('花生')); fixture.page.save();
  assert.deepEqual(fixture.calls.writes, []); assert.deepEqual(fixture.page.data.allergies, []);
  fixture.page.cancel(); assert.equal(fixture.calls.backs, 1);
});

test('saving rechecks account identity even when the change notification was missed', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  fixture.page.toggleFood(food('牛奶')); fixture.changeOwner('account-b', false); fixture.page.save();
  assert.deepEqual(fixture.calls.writes, []); assert.match(fixture.page.data.accountError, /账号已切换/);
});

test('unloading removes the observer and prevents later draft mutation or saving', () => {
  const fixture = setup({allergies: ['鸡蛋']});
  assert.equal(fixture.listenerCount(), 1); fixture.page.onUnload();
  const changes = fixture.calls.changes;
  fixture.sync(['牛奶']); fixture.page.toggleFood(food('花生')); fixture.page.save();
  assert.equal(fixture.listenerCount(), 0); assert.equal(fixture.calls.changes, changes);
  assert.deepEqual(fixture.calls.writes, []);
});

test('allergy forwarding contains only a fixed homepage card and never the current draft', () => {
  const {page, calls} = setup({allergies: ['鸡蛋']});
  page.changeInput(input('芒果'));
  assert.deepEqual(copy(page.onShareAppMessage()), {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'});
  assert.deepEqual(calls.writes, []); assert.equal(page.data.input, '芒果');
});

test('the profile entry is self-only and respects account invalidation', () => {
  const module = {exports: {}};
  let allowed = true;
  const routes = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/profile/page.js'), 'utf8'), {
    module, wx: {navigateTo(options) { routes.push(options.url); }}, require(dep) {
      if (dep.endsWith('/account')) return {check: () => allowed};
      if (dep.endsWith('/profile-avatar')) return {getProfileAvatar: () => ''};
      if (dep.endsWith('/cloud')) return {socialEnabled: true};
      return {};
    }
  });
  const page = module.exports(true);
  page.openAllergies(); assert.deepEqual(routes, ['/pages/allergies/index']);
  page.data.isSelf = false; page.openAllergies();
  page.data.isSelf = true; allowed = false; page.openAllergies();
  assert.equal(routes.length, 1);
  const template = fs.readFileSync(path.join(root, 'pages/profile/content.wxml'), 'utf8');
  assert.match(template, /<button wx:if="\{\{isSelf\}\}" class="profile-allergies" bindtap="openAllergies"/);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.ok(config.pages.includes('pages/allergies/index'));
});
