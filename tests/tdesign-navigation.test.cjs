const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('home ingredient tags apply TDesign checked values without toggling twice', () => {
  const app = {globalData:{pantry:['南瓜']}};
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root,'pages/home/index.js'),'utf8'), {
    Page: value => { definition = value; }, require: () => ({}), getApp: () => app
  });
  const page = {...definition, refresh() {}};
  const event = checked => ({currentTarget:{dataset:{name:'南瓜'}},detail:{checked}});
  page.toggleIngredient(event(true));
  page.toggleIngredient(event(true));
  assert.deepEqual(Array.from(app.globalData.pantry),['南瓜']);
  page.toggleIngredient(event(false));
  page.toggleIngredient(event(false));
  assert.deepEqual(Array.from(app.globalData.pantry),[]);
});

// WeChat caches a separate custom-tab-bar instance for each tab page.
// Deliberately rely on Page.onShow, not component pageLifetimes.show forwarding.
function navigationHarness() {
  let active;
  let component;
  const requests = [];
  const pages = {};
  const common = {
    getCurrentPages: () => active ? [active] : [],
    wx: {nextTick: callback => callback(), switchTab: options => requests.push(options)}
  };
  let helpers;
  const loadHelpers = () => {
    if (!helpers) {
      const module = {exports: {}};
      vm.runInNewContext(fs.readFileSync(path.join(root, 'utils/tab-bar.js'), 'utf8'), {...common, module});
      helpers = module.exports;
    }
    return helpers;
  };
  const requireModule = name => name.endsWith('/tab-bar') ? loadHelpers() : {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'custom-tab-bar/index.js'), 'utf8'), {
    ...common, require: requireModule, Component: value => { component = value; }
  });
  for (const name of ['home', 'recipes', 'ingredients', 'records']) {
    let definition;
    vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`), 'utf8'), {
      ...common, require: requireModule, Page: value => { definition = value; }
    });
    const page = {...definition, route: `pages/${name}/index`, refresh() {}, getTabBar() { return this.tab; }};
    pages[name] = page;
  }
  function activate(name) {
    active = pages[name];
    active.onShow();
    if (!active.tab) {
      active.tab = {...component.methods, data: JSON.parse(JSON.stringify(component.data)),
        setData(value) { Object.assign(this.data, value); }};
      component.lifetimes.attached.call(active.tab);
      if (component.lifetimes.ready) component.lifetimes.ready.call(active.tab);
      if (active.onReady) active.onReady();
    }
    return active.tab;
  }
  function tap(name) { active.tab.change({detail: {value: `/pages/${name}/index`}}); }
  function finish(index, name) { activate(name); requests[index].success(); }
  return {pages, requests, activate, tap, finish};
}

test('cached tab pages retain their own highlight when switching away and returning', () => {
  const h = navigationHarness();
  const home = h.activate('home');
  h.tap('recipes');
  h.finish(0, 'recipes');
  assert.equal(home.data.value, '/pages/home/index', 'the hidden source bar must not adopt the destination');
  assert.equal(h.pages.recipes.tab.data.value, '/pages/recipes/index');
  h.tap('home');
  h.finish(1, 'home');
  assert.equal(home.data.value, '/pages/home/index');
  h.tap('recipes');
  assert.equal(h.requests.length, 3, 'returning to a cached page must not swallow the next tap');
  h.finish(2, 'recipes');
  assert.equal(h.pages.recipes.tab.data.value, '/pages/recipes/index');
});

test('every tab synchronizes on page show and when its bar becomes ready', () => {
  const h = navigationHarness();
  for (const name of ['home', 'recipes', 'ingredients', 'records']) {
    const tab = h.activate(name);
    assert.equal(tab.data.value, `/pages/${name}/index`);
    tab.data.value = '/pages/not-the-visible-page/index';
    h.activate(name);
    assert.equal(tab.data.value, `/pages/${name}/index`);
  }
  assert.equal(h.requests.length, 0, 'programmatic navigation needs no extra switchTab call');
});

test('tap decisions use the displayed page even if the bar state is stale', () => {
  const h = navigationHarness();
  const home = h.activate('home');
  home.data.value = '/pages/recipes/index';
  h.tap('recipes');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/pages/recipes/index');
  h.requests[0].fail();
  assert.equal(home.data.value, '/pages/home/index');
  home.data.value = '/pages/recipes/index';
  h.tap('home');
  assert.equal(h.requests.length, 1, 'tapping the actual current page must not navigate again');
  assert.equal(home.data.value, '/pages/home/index');
  h.tap('not-a-tab');
  assert.equal(h.requests.length, 1);
});

test('late navigation callbacks cannot overwrite the visible tab with an older destination', () => {
  const h = navigationHarness();
  h.activate('home');
  h.tap('recipes');
  h.activate('recipes');
  h.tap('ingredients');
  h.finish(1, 'ingredients');
  h.requests[0].success();
  assert.equal(h.pages.ingredients.tab.data.value, '/pages/ingredients/index');
  assert.equal(h.pages.home.tab.data.value, '/pages/home/index');
  assert.equal(h.pages.recipes.tab.data.value, '/pages/recipes/index');
});

test('a failed switch preserves the displayed tab and allows retrying', () => {
  const h = navigationHarness();
  const tab = h.activate('records');
  h.tap('ingredients');
  h.requests[0].fail();
  assert.equal(tab.data.value, '/pages/records/index');
  h.tap('ingredients');
  assert.equal(h.requests.length, 2);
  h.finish(1, 'ingredients');
  assert.equal(h.pages.ingredients.tab.data.value, '/pages/ingredients/index');
});
