'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createSharePhoto} = require('../utils/recipe-share-photo');

const source = 'https://storage.example/public-recipe.jpg?expires=300';
const local = 'wxfile://tmp/public-recipe.jpg';

function setup() {
  const calls = [];
  const photo = createSharePhoto({getImageInfo(options) { calls.push(options); }});
  return {photo, calls};
}

test('a prepared photo stays local after the public URL expires, without another request', t => {
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const {photo, calls} = setup();
  photo.prepare(source);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].src, source);
  assert.equal(photo.get(source), '', 'a pending download must not return the expiring URL');
  calls[0].success({path: local});
  now += 301000;
  assert.equal(photo.get(source), local);
  assert.equal(photo.get('https://storage.example/another-recipe.jpg'), '');
  assert.equal(calls.length, 1);
});

test('missing APIs, failed downloads and synchronous errors leave no share image', () => {
  for (const api of [undefined, null, {}, {getImageInfo() { throw Error('unavailable'); }}]) {
    const photo = createSharePhoto(api);
    assert.doesNotThrow(() => photo.prepare(source));
    assert.equal(photo.get(source), '');
  }
  const {photo, calls} = setup();
  photo.prepare(source);
  calls[0].fail({errMsg: 'download failed'});
  assert.equal(photo.get(source), '');
});

test('only verified local image results can replace a public URL', () => {
  for (const result of [undefined, null, {}, {path: ''}, {path: source},
    {path: 'https://storage.example/other.jpg'}, {path: 'cloud://environment/photo.jpg'},
    {path: '/tmp/photo\n.jpg'}, {path: 'relative/photo.jpg'}, {path: 123}]) {
    const {photo, calls} = setup();
    photo.prepare(source);
    assert.doesNotThrow(() => calls[0].success(result));
    assert.equal(photo.get(source), '');
  }
  for (const path of [local, 'http://tmp/public-recipe.jpg', 'https://usr/public-recipe.jpg', '/tmp/public-recipe.jpg']) {
    const {photo, calls} = setup();
    photo.prepare(source);
    calls[0].success({path});
    assert.equal(photo.get(source), path);
  }
});

test('invalid sources clear a previous photo without downloading private or local paths', () => {
  for (const invalid of [undefined, null, '', 'http://storage.example/photo.jpg', 'cloud://environment/private.jpg', local, '/tmp/private.jpg']) {
    const {photo, calls} = setup();
    photo.prepare(source); calls[0].success({path: local});
    photo.prepare(invalid);
    assert.equal(calls.length, 1);
    assert.equal(photo.get(source), '');
    assert.equal(photo.get(invalid), '');
  }
});

test('reloading the same URL rejects an earlier download that finishes out of order', () => {
  const {photo, calls} = setup();
  photo.prepare(source);
  photo.prepare(source);
  assert.equal(calls.length, 2);
  calls[1].success({path: 'wxfile://tmp/current.jpg'});
  calls[0].success({path: 'wxfile://tmp/previous.jpg'});
  calls[0].fail({errMsg: 'late failure'});
  assert.equal(photo.get(source), 'wxfile://tmp/current.jpg');
});

test('clearing a page prevents a late download from restoring its photo', () => {
  const {photo, calls} = setup();
  photo.prepare(source);
  photo.clear();
  calls[0].success({path: local});
  assert.equal(photo.get(source), '');
  photo.prepare(source);
  calls[1].success({path: 'wxfile://tmp/reloaded.jpg'});
  calls[0].success({path: local});
  assert.equal(photo.get(source), 'wxfile://tmp/reloaded.jpg');
  photo.clear();
  assert.equal(photo.get(source), '');
});
