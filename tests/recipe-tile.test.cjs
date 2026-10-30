'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {getProfileAvatar} = require('../utils/profile-avatar');

function setup() {
  let definition; const events = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/recipe-tile/index.js'), 'utf8'), {
    Component(value) { definition = value; },
    require(name) {
      if (name.endsWith('/profile-avatar')) return {getProfileAvatar};
      throw Error(name);
    }
  });
  const component = {...definition.methods, data: {...definition.data, recipe: null, showAuthor: false},
    setData(value) { Object.assign(this.data, value); }, triggerEvent(name, detail) { events.push({name, detail: {...detail}}); }};
  return {component, events, setRecipe(recipe) { component.data.recipe = recipe; definition.observers.recipe.call(component, recipe); }};
}

test('tiles display only provided recipe photos and never substitute photos for unphotographed user recipes', () => {
  const {component, setRecipe} = setup();
  setRecipe({id: 'mine', imageKey: 'pumpkin', ingredients: [{name: '南瓜'}]});
  assert.equal(component.data.imageSource, '');
  setRecipe({id: 'mine', photo: 'wxfile://my-photo'}); assert.equal(component.data.imageSource, 'wxfile://my-photo');
  setRecipe({id: 'public', photoURL: 'https://example.test/signed'}); assert.equal(component.data.imageSource, 'https://example.test/signed');
  setRecipe({id: 'example', displayPhoto: 'wxfile://usr/recipe-cover-cache/pumpkin.jpg'}); assert.equal(component.data.imageSource, 'wxfile://usr/recipe-cover-cache/pumpkin.jpg');
});

test('image failures fall back without deleting recipe data and stale image failures cannot hide refreshed photos', () => {
  const {component, events, setRecipe} = setup();
  const recipe = {id: 'public', photoURL: 'https://example.test/first'};
  setRecipe(recipe);
  component.photoError({currentTarget: {dataset: {id: recipe.id, url: recipe.photoURL}}});
  assert.equal(component.data.photoFailed, true); assert.equal(recipe.photoURL, 'https://example.test/first');
  assert.deepEqual(events, [{name: 'photoerror', detail: {id: recipe.id, url: recipe.photoURL}}]);
  setRecipe({...recipe, photoURL: 'https://example.test/refreshed'});
  assert.equal(component.data.photoFailed, false);
  component.photoError({currentTarget: {dataset: {id: recipe.id, url: recipe.photoURL}}});
  assert.equal(component.data.photoFailed, false); assert.equal(events.length, 1);
});

test('recipe and author actions emit distinct IDs and unavailable authors emit no event', () => {
  const {component, events, setRecipe} = setup();
  component.open(); component.author(); assert.deepEqual(events, []);
  setRecipe({id: 'recipe-id', profileId: 'author-id'});
  component.open(); component.author();
  component.data.showAuthor = true; component.author();
  assert.deepEqual(events, [{name: 'open', detail: {id: 'recipe-id'}}, {name: 'author', detail: {id: 'author-id'}}]);
});

test('tile author avatars follow stable profile IDs without mutating recipes or resetting a failed food photo', () => {
  const {component, setRecipe} = setup();
  const firstId = '0'.repeat(31) + '1', nextId = '0'.repeat(31) + '2';
  const recipe = Object.freeze({id: 'same-recipe', profileId: firstId, authorName: '旧昵称', photoURL: 'https://example.test/photo'});
  setRecipe(recipe);
  assert.equal(component.data.authorAvatar, getProfileAvatar(firstId));
  component.photoError({currentTarget: {dataset: {id: recipe.id, url: recipe.photoURL}}});
  setRecipe(Object.freeze({...recipe, authorName: '新昵称'}));
  assert.equal(component.data.authorAvatar, getProfileAvatar(firstId));
  assert.equal(component.data.photoFailed, true);
  setRecipe(Object.freeze({...recipe, profileId: nextId}));
  assert.equal(component.data.authorAvatar, getProfileAvatar(nextId));
  assert.equal(component.data.photoFailed, true);
  assert.equal(recipe.profileId, firstId);
  assert.equal(recipe.authorAvatar, undefined);
  setRecipe(null);
  assert.equal(component.data.authorAvatar, '/assets/cute/pocket-mascot.png');
});
