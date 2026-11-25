'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const originalRecipes = require('../data/recipes');
const {setup: detailSetup} = require('./detail-runtime.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const first = originalRecipes[0];
const PRIVATE_NAME = '收件人本地私密改名';
const PRIVATE_NOTE = '只给家人看的调整心得';
const PRIVATE_PHOTO = 'wxfile://usr/private-local-recipe-photo.jpg';

function setup(options = {}) {
  const catalog = clone(originalRecipes), listeners = new Set();
  let state = options.deleted ? {recipes: [], logs: [], allergies: []} : {
    recipes: [{...clone(first), name: PRIVATE_NAME, note: PRIVATE_NOTE, photo: PRIVATE_PHOTO,
      ingredients: [{name: '本地私密食材', amount: '100 克'}], steps: ['本地私密做法']}],
    logs: [{id: 'private-log', note: '私密用餐记录'}], allergies: []
  };
  let owner = 'owner-a';
  const calls = {cloud: 0, writes: 0, shares: [], updates: 0, covers: []};
  const store = {
    getState() { return clone(state); },
    getSyncInfo() { return {owner, scopeKey: owner}; },
    getRecipe() { throw Error('A built-in share must not depend on a local editable recipe'); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const wx = {
    showShareMenu() { calls.shares.push('show'); }, hideShareMenu() { calls.shares.push('hide'); },
    cloud: {callFunction() { calls.cloud++; throw Error('A built-in recipe must not request cloud data'); }},
    setStorageSync() { calls.writes++; throw Error('Opening a built-in share must not write local data'); }
  };
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/builtin-recipe/index.js'), 'utf8'), {
    Page(value) { definition = value; }, wx,
    require(name) {
      if (name.endsWith('/store')) return store;
      if (name.endsWith('/data/recipes')) return catalog;
      if (name.endsWith('/recipe-origin')) return require('../utils/recipe-origin');
      if (name.endsWith('/allergies')) return require('../utils/allergies');
      if (name.endsWith('/recipe-covers')) return {getCover(recipe) {
        return options.cover ? options.cover(recipe) : '/static-catalog/' + recipe.id + '.jpg';
      }, withCover(recipe) {
        calls.covers.push(recipe.id);
        return {...clone(recipe), displayPhoto: '/static-catalog/' + recipe.id + '.jpg'};
      }};
      if (name.endsWith('/ui')) return {back() {}};
      throw Error('Unexpected dependency: ' + name);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(update) {
    calls.updates++; Object.assign(this.data, clone(update));
  }};
  return {page, calls, catalog, listeners,
    async open(id = first.id) { await page.onLoad({id}); if (page.onShow) await page.onShow(); return page; },
    changeAccount(nextOwner, allergies) {
      owner = nextOwner; state = {...state, allergies}; listeners.forEach(listener => listener());
    }
  };
}

test('every packaged built-in recipe has a direct read-only landing route and stable forwarding card', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  assert.ok(config.pages.includes('pages/builtin-recipe/index'));
  for (const recipe of originalRecipes) {
    const app = setup({deleted: true}); await app.open(recipe.id);
    assert.equal(app.page.data.error || '', '');
    for (const field of ['id', 'name', 'ingredients', 'steps', 'note']) {
      assert.deepEqual(clone(app.page.data.recipe[field]), clone(recipe[field]));
    }
    const share = app.page.onShareAppMessage();
    assert.equal(share.path, '/pages/builtin-recipe/index?id=' + encodeURIComponent(recipe.id));
    assert.ok(share.title.includes(recipe.name));
    assert.equal(share.imageUrl, '/static-catalog/' + recipe.id + '.jpg');
    assert.equal(app.calls.shares.at(-1), 'show');
    assert.equal(app.calls.cloud, 0); assert.equal(app.calls.writes, 0);
  }
});

test('the recipient sees the packaged original even when their matching local seed was changed or deleted', async () => {
  for (const deleted of [false, true]) {
    const app = setup({deleted}); await app.open();
    const serialized = JSON.stringify(app.page.data) + JSON.stringify(app.page.onShareAppMessage());
    for (const privateValue of [PRIVATE_NAME, PRIVATE_NOTE, PRIVATE_PHOTO, '本地私密食材', '本地私密做法', '私密用餐记录']) {
      assert.equal(serialized.includes(privateValue), false);
    }
    assert.equal(app.page.data.recipe.name, first.name);
    assert.deepEqual(clone(app.page.data.recipe.steps), first.steps);
    assert.deepEqual(app.catalog, originalRecipes);
    assert.equal(app.calls.writes, 0);
  }
});

test('sharing and returning does not request remote data or modify stored recipes', async () => {
  const app = setup(); await app.open();
  const originalShare = clone(app.page.onShareAppMessage());
  const originalView = clone(app.page.data);
  for (let i = 0; i < 3; i++) {
    if (app.page.onHide) app.page.onHide();
    await app.page.onShow();
    assert.deepEqual(clone(app.page.onShareAppMessage()), originalShare);
  }
  assert.deepEqual(clone(app.page.data), originalView);
  assert.equal(app.calls.cloud, 0); assert.equal(app.calls.writes, 0);
});

test('allergy warnings follow the current recipient while the shared card always contains only the original recipe', async () => {
  const app = setup(); await app.open();
  const originalShare = clone(app.page.onShareAppMessage());
  app.changeAccount('owner-b', ['南瓜']); await app.page.onShow();
  assert.match(app.page.data.allergyWarning, /南瓜/);
  assert.deepEqual(clone(app.page.onShareAppMessage()), originalShare);
  app.changeAccount('owner-c', []); await app.page.onShow();
  assert.equal(app.page.data.allergyWarning, '');
  assert.deepEqual(clone(app.page.onShareAppMessage()), originalShare);
  assert.equal(app.calls.cloud, 0); assert.equal(app.calls.writes, 0);
});

test('invalid IDs cannot select local recipes or create misleading recipe shares', async () => {
  for (const id of ['', 'unknown-built-in', 'private-recipe-one', 'a'.repeat(64), '../home/index', ['pumpkin-millet'], {}, null]) {
    const app = setup(); await app.open(id);
    assert.equal(app.page.data.recipe, null);
    assert.ok(app.page.data.error);
    assert.equal(app.calls.shares.at(-1), 'hide');
    const share = app.page.onShareAppMessage();
    assert.equal(share.path, '/pages/home/index');
    assert.equal(JSON.stringify(share).includes(PRIVATE_NAME), false);
    assert.equal(app.calls.cloud, 0); assert.equal(app.calls.writes, 0);
  }
});

test('an unavailable cover does not change the recipe route, and an unloaded page cannot share its old recipe', async () => {
  const app = setup(); await app.open();
  const share = clone(app.page.onShareAppMessage());
  app.page.photoError();
  assert.equal(app.page.data.photoFailed, true);
  assert.deepEqual(clone(app.page.onShareAppMessage()), share);
  app.page.onUnload();
  const updates = app.calls.updates;
  app.changeAccount('owner-b', ['南瓜']); await app.page.onShow();
  assert.equal(app.calls.updates, updates);
  assert.equal(app.listeners.size, 0);
  assert.equal(app.page.onShareAppMessage().path, '/pages/home/index');
});

test('sharing an edited built-in from local detail uses the original title and a recipe-specific landing page', async () => {
  const app = detailSetup({recipe: {...clone(first), name: PRIVATE_NAME, note: PRIVATE_NOTE,
    photo: PRIVATE_PHOTO, isExample: true}, cover: recipe => {
      assert.equal(recipe.photo || '', '');
      return '/static-catalog/' + recipe.id + '.jpg';
    }});
  const page = await app.open();
  const share = page.onShareAppMessage();
  assert.equal(share.path, '/pages/builtin-recipe/index?id=' + first.id);
  assert.ok(share.title.includes(first.name));
  assert.equal(share.imageUrl, '/static-catalog/' + first.id + '.jpg');
  assert.equal(JSON.stringify(share).includes(PRIVATE_NAME), false);
  assert.equal(JSON.stringify(share).includes(PRIVATE_NOTE), false);
  assert.equal(JSON.stringify(share).includes(PRIVATE_PHOTO), false);
  assert.deepEqual(app.calls.shareLinks, []);
});
