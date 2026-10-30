const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {evaluatePage} = require('./page-runtime.cjs');

// WeChat caches each tab page and its own in-page navigation component.
// Deliberately rely on Page.onShow, not component pageLifetimes.show forwarding.
function navigationHarness() {
  let active;
  let component;
  const requests = [];
  const editorRequests = [];
  const pages = {};
  const common = {
    getCurrentPages: () => active ? [active] : [],
    wx: {nextTick: callback => callback(), switchTab: options => requests.push(options), navigateTo: options => editorRequests.push(options)}
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
  const requireModule = name => name.endsWith('/tab-bar') ? loadHelpers() : name.endsWith('/selectors') ? require('../utils/selectors') : {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/bottom-navigation/index.js'), 'utf8'), {
    ...common, require: requireModule, Component: value => { component = value; }
  });
  for (const name of ['home', 'discover', 'mine', 'records']) {
    let definition;
    evaluatePage(name, {
      ...common, tabBar: loadHelpers(), require: requireModule, Page: value => { definition = value; }
    });
    const page = {
      ...definition, route: `pages/${name}/index`, refresh() {}, load() {},
      selectComponent(selector) {
        assert.equal(selector, '#bottom-navigation');
        return this.tab;
      },
      getTabBar() { throw Error('the native custom-tab-bar host is intentionally empty'); }
    };
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
  return {pages, requests, editorRequests, activate, tap, finish};
}

test('navigation placeholder is rendered after tab-page content, outside the native tab-bar host', () => {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert.equal(app.tabBar.custom, true, 'prevent a duplicate native tab bar');
  assert.equal(fs.readFileSync(path.join(root, 'custom-tab-bar/index.wxml'), 'utf8').trim(), '');
  const nativeHost = JSON.parse(fs.readFileSync(path.join(root, 'custom-tab-bar/index.json'), 'utf8'));
  assert.deepEqual(nativeHost.usingComponents || {}, {});
  for (const {pagePath} of app.tabBar.list) {
    const template = fs.readFileSync(path.join(root, pagePath + '.wxml'), 'utf8').trim();
    assert.match(template, /<bottom-navigation id="bottom-navigation"\s*\/>$/);
    assert.equal((template.match(/<bottom-navigation\b/g) || []).length, 1, pagePath);
    const config = JSON.parse(fs.readFileSync(path.join(root, pagePath + '.json'), 'utf8'));
    assert.equal(config.usingComponents['bottom-navigation'], '/components/bottom-navigation/index');
  }
  const template = fs.readFileSync(path.join(root, 'components/bottom-navigation/index.wxml'), 'utf8');
  assert.match(template, /<t-tab-bar\b[^>]*\splaceholder(?:\s|>)/);
  assert.doesNotMatch(template, /fixed="\{\{false\}\}"/);
});

test('cached tab pages retain their own highlight when switching away and returning', () => {
  const h = navigationHarness();
  const home = h.activate('home');
  h.tap('discover');
  h.finish(0, 'discover');
  assert.equal(home.data.value, '/pages/home/index', 'the hidden source bar must not adopt the destination');
  assert.equal(h.pages.discover.tab.data.value, '/pages/discover/index');
  h.tap('home');
  h.finish(1, 'home');
  assert.equal(home.data.value, '/pages/home/index');
  h.tap('discover');
  assert.equal(h.requests.length, 3, 'returning to a cached page must not swallow the next tap');
  h.finish(2, 'discover');
  assert.equal(h.pages.discover.tab.data.value, '/pages/discover/index');
});

test('every tab synchronizes on page show and when its bar becomes ready', () => {
  const h = navigationHarness();
  for (const name of ['home', 'discover', 'mine', 'records']) {
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
  home.data.value = '/pages/discover/index';
  h.tap('discover');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/pages/discover/index');
  h.requests[0].fail();
  assert.equal(home.data.value, '/pages/home/index');
  home.data.value = '/pages/discover/index';
  h.tap('home');
  assert.equal(h.requests.length, 1, 'tapping the actual current page must not navigate again');
  assert.equal(home.data.value, '/pages/home/index');
  h.tap('not-a-tab');
  assert.equal(h.requests.length, 1);
});

test('late navigation callbacks cannot overwrite the visible tab with an older destination', () => {
  const h = navigationHarness();
  h.activate('home');
  h.tap('discover');
  h.activate('discover');
  h.tap('mine');
  h.finish(1, 'mine');
  h.requests[0].success();
  assert.equal(h.pages.mine.tab.data.value, '/pages/mine/index');
  assert.equal(h.pages.home.tab.data.value, '/pages/home/index');
  assert.equal(h.pages.discover.tab.data.value, '/pages/discover/index');
});

test('a failed switch preserves the displayed tab and allows retrying', () => {
  const h = navigationHarness();
  const tab = h.activate('records');
  h.tap('mine');
  h.requests[0].fail();
  assert.equal(tab.data.value, '/pages/records/index');
  h.tap('mine');
  assert.equal(h.requests.length, 2);
  h.finish(1, 'mine');
  assert.equal(h.pages.mine.tab.data.value, '/pages/mine/index');
});

test('center add action opens a form once and preserves the current tab highlight', () => {
  const h = navigationHarness();
  const mine = h.activate('mine');
  mine.change({detail: {value: 'add'}});
  mine.change({detail: {value: 'add'}});
  assert.equal(h.requests.length, 0);
  assert.equal(h.editorRequests.length, 1);
  assert.equal(h.editorRequests[0].url, '/pages/editor/index');
  assert.equal(mine.data.value, '/pages/mine/index');
  h.editorRequests[0].complete();
  mine.change({detail: {value: 'add'}});
  assert.equal(h.editorRequests.length, 2);
});
