'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function setup(options = {}) {
  let owner = 'owner-a', scope = 'personal-a', definition;
  const listeners = new Set(), calls = {routes: [], updates: 0, backs: 0};
  const store = {getSyncInfo: () => ({owner, scopeKey: scope}), getRecipe: id => !options.missing && id === 'local-recipe' ? {id, name: '本机私有内容'} : null,
    subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'pages/share-preview/index.js'), 'utf8'), {
    Page(value) {definition = value;}, wx: {redirectTo(value) {calls.routes.push(value);}},
    require(dep) {if (dep.endsWith('/store')) return store; if (dep.endsWith('/ui')) return {back() {calls.backs++;}}; throw Error('Legacy route must not call publication APIs: ' + dep);}
  });
  const page = {...definition, data: {...definition.data}, setData(value) {calls.updates++; Object.assign(this.data, value);}};
  page.onLoad({id: options.id === undefined ? 'local-recipe' : options.id});
  return {page, calls, listeners, changeOwner(value) {owner = value; listeners.forEach(fn => fn());}, changeScope(value) {scope = value; listeners.forEach(fn => fn());}};
}
test('legacy preview routes redirect to the normal detail share entry without rendering a preview or publishing', () => {
  const app = setup(); app.page.onShow(); app.page.onShow();
  assert.equal(app.calls.routes.length, 1); assert.equal(app.calls.routes[0].url, '/pages/detail/index?id=local-recipe');
  assert.equal(app.page.confirmPublish, undefined); assert.equal(app.page.data.recipe, undefined);
  const template = fs.readFileSync(path.join(root, 'pages/share-preview/index.wxml'), 'utf8');
  assert.doesNotMatch(template, /确认|预览|先留给自己|open-type="share"/);
});
test('missing or invalid old recipe links stay recoverable without guessing a share URL', () => {
  for (const options of [{missing: true}, {id: ''}, {id: 'unknown'}]) {
    const app = setup(options); app.page.onShow();
    assert.equal(app.calls.routes.length, 0); assert.match(app.page.data.error, /没有找到/);
    assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
  }
});
test('legacy-route navigation failure permits a deliberate retry', () => {
  const app = setup(); app.page.onShow(); app.calls.routes[0].fail();
  assert.equal(app.page.data.loading, false); assert.match(app.page.data.error, /重试/);
  app.page.openRecipe(); assert.equal(app.calls.routes.length, 2);
});
test('account or family changes prevent an old route from opening another scope even after ABA', () => {
  for (const mode of ['owner', 'scope']) {
    const app = setup();
    if (mode === 'owner') {app.changeOwner('owner-b'); app.changeOwner('owner-a');}
    else {app.changeScope('family-b'); app.changeScope('personal-a');}
    app.page.onShow(); assert.equal(app.calls.routes.length, 0); assert.match(app.page.data.error, /账号|家庭/);
  }
});
test('unload ignores late navigation failure and removes the subscription', () => {
  const app = setup(); app.page.onShow(); app.page.onUnload(); const updates = app.calls.updates;
  app.calls.routes[0].fail(); assert.equal(app.calls.updates, updates); assert.equal(app.listeners.size, 0);
});
test('legacy routes only return the fixed app card without local metadata', () => {
  const app = setup(); app.page.onShow();
  assert.deepEqual(JSON.parse(JSON.stringify(app.page.onShareAppMessage())), {
    title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'
  });
});
