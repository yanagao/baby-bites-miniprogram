'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const validators = [
  ['sync', require('../cloudfunctions/babyBitesSync/validate').validateSnapshot],
  ['social', require('../cloudfunctions/babyBitesSocial/private-snapshot').validateSnapshot]
];
const NOW = Date.parse('2026-11-04T04:00:00Z');
const context = {env: 'meal-plan-test', owner: 'a'.repeat(64), now: NOW};
const plan = (date = '2026-11-05', meal = 'breakfast') => ({
  id: `meal-${date}-${meal}`, date, meal, recipeId: 'r1', createdAt: NOW, updatedAt: NOW
});
function snapshot() {
  return {version: 1, data: {version: 1, nickname: '宝宝', profileUpdatedAt: 0,
    recipes: [{id: 'r1', name: '南瓜粥', category: '粥饭主食', texture: '软烂颗粒', minutes: 20,
      ingredients: [{name: '南瓜', amount: '20克'}], steps: ['煮熟'], note: '', photo: '', imageKey: '',
      favorite: false, isExample: false, createdAt: NOW, updatedAt: NOW}],
    logs: [], mealPlans: [plan()]}, deleted: {recipes: [], logs: [], mealPlans: []}};
}
const log = patch => ({id: 'l1', recipeId: 'r1', date: '2026-11-04', meal: 'breakfast',
  rating: 0, portion: '', note: '', createdAt: NOW, ...patch});

for (const [name, validate] of validators) {
  const check = data => validate(Buffer.from(JSON.stringify(data)), context);
  test(`${name}: future plans and unrated completions round-trip without creating a preference`, () => {
    const data = snapshot(); data.data.logs = [log()];
    const result = check(data);
    assert.deepEqual(result.data.mealPlans, data.data.mealPlans);
    assert.equal(result.data.logs[0].rating, 0);
    assert.equal(result.data.logs[0].portion, '');
    assert.equal(result.data.logs[0].meal, 'breakfast');
    assert.deepEqual(result.deleted.mealPlans, []);
    data.data.mealPlans = [];
    assert.deepEqual(check(data).data.mealPlans, []);
    assert.equal(check(data).data.logs[0].rating, 0);
  });

  test(`${name}: legacy snapshots remain readable without inventing plans or meal slots`, () => {
    const data = snapshot(); delete data.data.mealPlans; delete data.deleted.mealPlans;
    data.data.logs = [log({rating: 3})]; delete data.data.logs[0].meal;
    assert.deepEqual(check(data), data);
    data.data.logs[0].rating = 0;
    assert.throws(() => check(data), {code: 'INVALID_SNAPSHOT'});
    data.data.logs[0].rating = 3; data.data.logs[0].meal = 'breakfast';
    assert.throws(() => check(data), {code: 'INVALID_SNAPSHOT'});
  });

  test(`${name}: completed meals still reject future dates and invalid meal/rating values`, () => {
    for (const patch of [{date: '2026-11-05'}, {date: '2026-02-30'}, {meal: 'snack'}, {meal: null},
      {rating: -1}, {rating: 4}, {rating: null}, {rating: '0'}]) {
      const data = snapshot(); data.data.logs = [log(patch)];
      assert.throws(() => check(data), {code: 'INVALID_SNAPSHOT'});
    }
    // Calendar validation follows China time even when UTC is the previous day.
    const data = snapshot(); data.data.logs = [log({date: '2026-11-05'})];
    assert.equal(validate(Buffer.from(JSON.stringify(data)), {...context, now: Date.parse('2026-11-04T16:01:00Z')}).data.logs[0].date, '2026-11-05');
  });

  test(`${name}: plan slots are canonical, unique, and reference a real recipe`, () => {
    for (const change of [
      data => {data.data.mealPlans[0].id = 'arbitrary';},
      data => {data.data.mealPlans[0].meal = 'snack';},
      data => {data.data.mealPlans[0] = plan('2026-02-30');},
      data => {data.data.mealPlans[0].recipeId = 'missing';},
      data => {delete data.data.mealPlans[0].updatedAt;},
      data => {data.data.mealPlans[0].createdAt = -1;},
      data => {data.data.mealPlans[0].secret = 'unexpected';},
      data => {data.data.mealPlans.push(plan());},
      data => {data.data.mealPlans = Array(3001).fill(plan());},
      data => {data.data.mealPlans = null;},
      data => {delete data.deleted.mealPlans;},
      data => {delete data.data.mealPlans;}
    ]) {
      const data = snapshot(); change(data);
      assert.throws(() => check(data), {code: 'INVALID_SNAPSHOT'});
    }
    const data = snapshot(); data.data.mealPlans.push(plan('2026-11-05', 'lunch'), plan('2026-11-05', 'dinner'));
    assert.equal(check(data).data.mealPlans.length, 3);
  });

  test(`${name}: deletion history preserves the meal schema and rejects malformed tombstones`, () => {
    const data = snapshot(); data.data.mealPlans = [];
    data.deleted.mealPlans = [{id: plan().id, updatedAt: NOW}];
    assert.deepEqual(check(data).deleted.mealPlans, data.deleted.mealPlans);
    for (const entries of [null, {}, [{id: 'wrong', updatedAt: NOW}], [{id: 'meal-2026-02-30-breakfast', updatedAt: NOW}],
      [{id: plan().id, updatedAt: -1}], [{id: plan().id, updatedAt: NOW, recipeId: 'r1'}],
      [data.deleted.mealPlans[0], data.deleted.mealPlans[0]], Array(30001).fill(data.deleted.mealPlans[0])]) {
      assert.throws(() => check({...data, deleted: {...data.deleted, mealPlans: entries}}), {code: 'INVALID_SNAPSHOT'});
    }
  });

  test(`${name}: only family log tombstones may retain a valid deleted generation`, () => {
    const data = snapshot();
    data.deleted.logs = [{id: 'meal-log-meal-2026-11-04-breakfast', updatedAt: NOW, createdAt: NOW - 10,
      recordedBy: {memberId: 'a'.repeat(32), label: '妈妈'}}];
    const familyCheck = value => validate(Buffer.from(JSON.stringify(value)), {...context, familyTombstones: true});
    assert.deepEqual(familyCheck(data).deleted.logs, data.deleted.logs);
    assert.throws(() => check(data), {code: 'INVALID_SNAPSHOT'});
    for (const createdAt of [null, -1, NOW + 1, 1.5, '0']) {
      assert.throws(() => familyCheck({...data, deleted: {...data.deleted,
        logs: [{...data.deleted.logs[0], createdAt}]}}), {code: 'INVALID_SNAPSHOT'});
    }
    for (const kind of ['recipes', 'mealPlans']) {
      const invalid = snapshot();
      invalid.deleted[kind] = [{id: kind === 'recipes' ? 'r1' : plan().id, updatedAt: NOW, createdAt: NOW - 10}];
      assert.throws(() => familyCheck(invalid), {code: 'INVALID_SNAPSHOT'});
    }
  });
}
