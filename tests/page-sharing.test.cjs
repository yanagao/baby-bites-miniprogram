'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const routes = new Set(JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).pages);
const imageUrl = '/assets/cute/pocket-mascot.png';
const destinations = {
  home: 'home', discover: 'discover', recipes: 'recipes', ingredients: 'ingredients',
  'ingredient-results': 'ingredients', random: 'random', records: 'home',
  editor: 'home', 'record-editor': 'home', settings: 'home', following: 'home'
};
const clone = value => JSON.parse(JSON.stringify(value));

function loadPage(name) {
  let definition;
  const forbidden = operation => () => { throw Error('Sharing must not call ' + operation); };
  const moduleStub = name => new Proxy({}, {get: (_, key) => forbidden(name + '.' + String(key))});
  const selectors = {
    categories: ['全部', '粥'], textures: ['细腻泥糊'], ageGroups: [{value: '6-8', label: '6–8个月'}],
    today: () => '2026-11-02'
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages', name, 'index.js'), 'utf8'), {
    Page(value) { definition = value; },
    wx: moduleStub('wx'), getApp: forbidden('getApp'), getCurrentPages: forbidden('getCurrentPages'),
    require(dependency) {
      if (dependency.endsWith('/selectors')) return selectors;
      if (dependency.endsWith('/share-prompt/controller')) return require('../components/share-prompt/controller');
      if (dependency.endsWith('/recipe-ages')) return {ageGroups: selectors.ageGroups};
      if (dependency.endsWith('/cloud')) return {socialEnabled: true};
      return moduleStub(dependency);
    }
  });
  assert.equal(typeof definition.onShareAppMessage, 'function', name + ' provides the native forwarding handler');
  return definition;
}

function privatePage(definition) {
  const recipe = {id: 'private-recipe-id', name: '私密菜名测试', note: '私人心得测试',
    photo: 'cloud://private-environment/private-photo.jpg', ingredients: [{name: '私人食材测试'}]};
  return {
    ...definition,
    data: {...clone(definition.data), nickname: '私人宝宝称呼测试', babyNickname: '私人宝宝称呼测试',
      babyBirthDate: '2025-04-03', owner: 'private-owner-id', profile: {name: '私人资料草稿测试'},
      recipe, result: recipe, recipes: [recipe], recommendations: [recipe],
      logs: [{id: 'private-log-id', note: '私人记录测试'}],
      form: {name: '未保存草稿测试', note: '私人心得测试'}, photo: recipe.photo,
      search: '私人搜索词测试', query: '私人搜索词测试', pantry: ['私人食材测试'],
      selectedAgeGroups: ['6-8'], selectedCategories: ['粥'], visibility: 'private',
      backupText: '私人备份内容测试', editing: true, loading: true, error: '私人错误信息测试'},
    recipeId: recipe.id, logId: 'private-log-id', _sessionOwner: 'private-owner-id',
    accountSession: {owner: 'private-owner-id', changed: true},
    setData() { throw Error('Sharing must not mutate page state'); }
  };
}

for (const [name, destination] of Object.entries(destinations)) {
  test(name + ' forwards a safe registered entry without sender data or side effects', () => {
    const definition = loadPage(name);
    const page = privatePage(definition);
    const before = clone(page.data);
    const result = page.onShareAppMessage({from: 'menu', target: {dataset: {id: 'private-recipe-id'}}});
    assert.deepEqual(Object.keys(result).sort(), ['imageUrl', 'path', 'title']);
    assert.equal(result.path, '/pages/' + destination + '/index');
    assert.ok(routes.has(result.path.slice(1)), 'recipient opens a registered entry');
    assert.match(result.title, /口袋/);
    assert.equal(result.imageUrl, imageUrl, 'fixed artwork prevents a screenshot of private content');
    assert.ok(fs.existsSync(path.join(root, result.imageUrl)));
    assert.doesNotMatch(JSON.stringify(result), /private-|私人|私密|未保存|cloud:\/\/|\?|2025-04-03/);
    assert.deepEqual(clone(page.data), before, 'sharing does not save, clear, or alter a draft');

    const original = clone(result);
    result.path = '/pages/detail/index?id=private-recipe-id';
    result.title = '私人标题测试';
    result.imageUrl = 'cloud://private-environment/private-photo.jpg';
    const next = page.onShareAppMessage({from: 'menu'});
    assert.notEqual(next, result);
    assert.deepEqual(clone(next), original, 'a previous share object cannot contaminate a later share');
  });
}

test('home can be forwarded before account binding or page initialization', () => {
  const page = loadPage('home');
  const result = page.onShareAppMessage.call({});
  assert.equal(result.path, '/pages/home/index');
  assert.equal(result.imageUrl, imageUrl);
  assert.match(result.title, /口袋/);
});
