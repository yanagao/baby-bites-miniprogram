'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createShareReturn} = require('../utils/native-share-return');

function setup() {
  let sequence = 0;
  const timers = new Map(), listeners = new Set();
  const tracker = createShareReturn({
    onAppHide(fn) { listeners.add(fn); }, offAppHide(fn) { listeners.delete(fn); }
  }, {
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return {tracker, timers, listeners,
    hide(reason) { listeners.forEach(fn => fn({reason})); },
    flush() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); }};
}

test('only an observed native hide pairs with sharing, in either callback order, and is consumed once', () => {
  for (const hideFirst of [false, true]) {
    const app = setup(), value = {recipeId: 'recipe'};
    if (hideFirst) app.hide(2);
    app.tracker.share(value);
    if (!hideFirst) app.hide(2);
    assert.equal(app.timers.size, 0);
    // The native chooser may stay open indefinitely after the pair is known.
    app.flush(); app.flush();
    assert.equal(app.tracker.show(), value);
    assert.equal(app.tracker.show(), null);
  }
});

test('ordinary or unknown hide reasons revoke intent before or after the share callback', () => {
  for (const reason of [0, 1, 3, undefined]) for (const hideFirst of [false, true]) {
    const app = setup();
    if (hideFirst) app.hide(reason);
    app.tracker.share('share');
    if (!hideFirst) app.hide(reason);
    // A later callback in the same non-native hide cannot authorize the return.
    app.tracker.share('late share');
    assert.equal(app.tracker.show(), null);
    assert.equal(app.timers.size, 0);
  }
});

test('unpaired sharing expires before an unrelated native hide and never authorizes a no-hide show', () => {
  const app = setup();
  app.tracker.share('canceled'); app.flush(); app.hide(2);
  assert.equal(app.tracker.show(), null);
  app.tracker.share('without hide');
  assert.equal(app.tracker.show(), null);
});

test('old cleanup cannot clear a newer share or a share already paired with native hide', () => {
  const app = setup();
  app.tracker.share('old'); const oldCleanup = [...app.timers.values()][0];
  app.tracker.share('new'); const newCleanup = [...app.timers.values()][0];
  oldCleanup(); assert.equal(app.timers.size, 1);
  app.hide(2); newCleanup();
  assert.equal(app.tracker.show(), 'new');
});

test('an additional hide invalidates the earlier paired native round', () => {
  for (const reason of [0, 1, 2, 3, undefined]) {
    const app = setup(); app.tracker.share('share'); app.hide(2); app.hide(reason);
    assert.equal(app.tracker.show(), null);
  }
});

test('clearing navigation and disposal cancel timers and disposal unregisters the exact listener', () => {
  const app = setup(); app.tracker.share('canceled'); app.tracker.clear(); app.hide(2);
  assert.equal(app.tracker.show(), null);
  app.tracker.share('pending'); const cleanup = [...app.timers.values()][0];
  app.tracker.dispose(); app.tracker.dispose(); cleanup(); app.hide(2); app.tracker.share('late');
  assert.equal(app.listeners.size, 0); assert.equal(app.timers.size, 0);
  assert.equal(app.tracker.show(), null);
});

test('platforms without paired app-hide listeners conservatively revalidate', () => {
  for (const api of [undefined, {}, {onAppHide() { throw Error('must not subscribe without removal'); }}]) {
    const tracker = createShareReturn(api); tracker.share('share');
    assert.equal(tracker.show(), null); tracker.dispose();
  }
});
