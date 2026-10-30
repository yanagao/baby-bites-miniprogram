'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {ageGroups, ageGroupForMonths, normalizeAgeGroups, recipeAgeGroups, matchesAgeGroups, ageLabel} = require('../utils/recipe-ages');
const seed = require('../data/recipes');
const copy = value => JSON.parse(JSON.stringify(value));

test('recipe age choices have stable values and display order', () => {
  assert.deepEqual(ageGroups, [
    {value: '6-8', label: '6–8个月'},
    {value: '9-11', label: '9–11个月'},
    {value: '12-17', label: '12–17个月'},
    {value: '18+', label: '18个月以上'}
  ]);
});

test('completed months map to the matching age group at every boundary', () => {
  for (const months of [6, 7, 8]) assert.equal(ageGroupForMonths(months), '6-8');
  for (const months of [9, 10, 11]) assert.equal(ageGroupForMonths(months), '9-11');
  for (const months of [12, 13, 14, 15, 16, 17]) assert.equal(ageGroupForMonths(months), '12-17');
  for (const months of [18, 19, 24, 120, 121, 1000]) assert.equal(ageGroupForMonths(months), '18+');
});

test('missing, invalid and younger-than-six-month values do not choose an age group', () => {
  const invalid = [undefined, null, NaN, Infinity, -Infinity, -12, -1, 0, 1, 2, 3, 4, 5,
    5.99, 6.5, 8.5, 11.5, 17.5, 18.5, '', '6', '18', true, false, {}, [], [6], new Number(6)];
  for (const months of invalid) assert.equal(ageGroupForMonths(months), null, String(months));
});

test('omitted age labels stay omitted and explicit clearing stays an empty array', () => {
  assert.equal(normalizeAgeGroups(undefined), undefined);
  assert.deepEqual(normalizeAgeGroups([]), []);
  assert.equal(JSON.stringify({ageGroups: normalizeAgeGroups(undefined)}), '{}');
  assert.equal(JSON.stringify({ageGroups: normalizeAgeGroups([])}), '{"ageGroups":[]}');
});

test('valid multi-select labels are deduplicated and sorted without mutating the caller array', () => {
  const input = ['18+', '9-11', '6-8', '9-11'];
  const before = input.slice();
  const normalized = normalizeAgeGroups(input);
  assert.deepEqual(normalized, ['6-8', '9-11', '18+']);
  assert.deepEqual(input, before);
  normalized.push('12-17');
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeAgeGroups(['18+', '12-17', '9-11', '6-8']), ['6-8', '9-11', '12-17', '18+']);
  for (const group of ageGroups) assert.deepEqual(normalizeAgeGroups([group.value]), [group.value]);
});

test('invalid types, unknown values, sparse entries and arrays over four items are rejected', () => {
  const invalid = [null, '', '6-8', 6, true, false, {}, {0: '6-8', length: 1},
    [''], ['全部'], ['6–8'], ['6-8个月'], ['6-8 '], [' 6-8'], [6], [null], [undefined],
    [true], [{}], [[]], [new String('6-8')], ['6-8', 'unknown'], new Array(1),
    ['6-8', '6-8', '6-8', '6-8', '6-8']];
  for (const value of invalid) {
    assert.throws(() => normalizeAgeGroups(value), error => error instanceof Error &&
      error.message === '请选择有效的适用月龄。', JSON.stringify(value));
  }
});

test('all existing default recipes are unrestricted without adding age metadata', () => {
  const before = copy(seed);
  assert.equal(seed.length, 21);
  for (const original of seed) {
    assert.deepEqual(recipeAgeGroups(original), [], original.id);
    assert.equal(ageLabel(original), '不限月龄', original.id);
    for (const group of ageGroups) assert.equal(matchesAgeGroups(original, [group.value]), true, original.id);
    const copied = {...copy(original), id: 'shared-' + original.id, imageKey: 'dish:' + original.id};
    assert.deepEqual(recipeAgeGroups(copied), [], original.id + ' copied');
    assert.equal(ageLabel(copied), '不限月龄', original.id + ' copied');
    assert.equal(Object.prototype.hasOwnProperty.call(original, 'ageGroups'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(copied, 'ageGroups'), false);
  }
  assert.deepEqual(seed, before);
});

test('explicit labels work for default, edited, custom and copied recipes independently of their texture', () => {
  for (const recipe of [copy(seed[0]), {...copy(seed[0]), name: '改过的做法'},
    {id: 'custom', texture: '手指食物'}, {id: 'shared-recipe', imageKey: 'dish:pumpkin-millet'}]) {
    recipe.ageGroups = ['18+', '6-8'];
    const before = copy(recipe);
    const selected = recipeAgeGroups(recipe);
    assert.deepEqual(selected, ['6-8', '18+']);
    assert.equal(ageLabel(recipe), '6–8个月、18个月以上');
    selected.length = 0;
    assert.deepEqual(recipe, before);
    recipe.ageGroups = [];
    assert.deepEqual(recipeAgeGroups(recipe), []);
    assert.equal(ageLabel(recipe), '不限月龄');
  }
});

test('missing, undefined and empty selections are unrestricted while editor values remain empty', () => {
  for (const recipe of [{}, {ageGroups: undefined}, {ageGroups: []}, Object.create({ageGroups: ['6-8']})]) {
    const original = recipe.ageGroups;
    assert.deepEqual(recipeAgeGroups(recipe), []);
    assert.equal(ageLabel(recipe), '不限月龄');
    assert.equal(matchesAgeGroups(recipe, []), true);
    for (const group of ageGroups) assert.equal(matchesAgeGroups(recipe, [group.value]), true);
    assert.equal(recipe.ageGroups, original);
  }
});

test('malformed stored labels never become unrestricted matches or labels and are not repaired', () => {
  for (const value of [null, '6-8', {}, ['unknown'], ['6-8', 'unknown'], new Array(1),
    ['6-8', '9-11', '12-17', '18+', '6-8']]) {
    const recipe = {id: 'pumpkin-millet', texture: '细腻泥糊', ageGroups: value};
    const original = recipe.ageGroups;
    assert.deepEqual(recipeAgeGroups(recipe), []);
    assert.equal(ageLabel(recipe), '');
    assert.equal(matchesAgeGroups(recipe, ['6-8']), false);
    assert.equal(matchesAgeGroups(recipe, ageGroups.map(group => group.value)), false);
    assert.equal(matchesAgeGroups(recipe, []), true, 'no age filter still includes existing data');
    assert.equal(recipe.ageGroups, original);
  }
  for (const value of [undefined, null, '', 6, true, [], ['6-8']]) {
    assert.deepEqual(recipeAgeGroups(value), []);
    assert.equal(ageLabel(value), '');
    assert.equal(matchesAgeGroups(value, ['6-8']), false);
  }
});

test('specific age selections match any selected group, and an empty filter includes every recipe', () => {
  const values = ageGroups.map(group => group.value);
  for (let configuredMask = 0; configuredMask < 16; configuredMask++) {
    const configured = values.filter((_, index) => configuredMask & (1 << index));
    const recipe = {id: 'custom', ageGroups: configured};
    for (let selectedMask = 0; selectedMask < 16; selectedMask++) {
      const selected = values.filter((_, index) => selectedMask & (1 << index));
      const before = selected.slice();
      const expected = !selected.length || !configured.length || Boolean(configuredMask & selectedMask);
      assert.equal(matchesAgeGroups(recipe, selected), expected, `${configuredMask}/${selectedMask}`);
      assert.deepEqual(selected, before);
      assert.deepEqual(recipe.ageGroups, configured);
    }
  }
});

test('display labels follow canonical order and never repeat a selected range', () => {
  assert.equal(ageLabel({ageGroups: ['18+', '6-8', '12-17', '9-11']}), '6–8个月、9–11个月、12–17个月、18个月以上');
  assert.equal(ageLabel({ageGroups: ['9-11', '9-11']}), '9–11个月');
});
