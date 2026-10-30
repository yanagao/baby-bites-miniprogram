'use strict';

// Optional recipe labels selected by the user. No selection means unrestricted;
// it does not add inferred metadata to an existing recipe.
const ageGroups = Object.freeze([
  Object.freeze({value: '6-8', label: '6–8个月'}),
  Object.freeze({value: '9-11', label: '9–11个月'}),
  Object.freeze({value: '12-17', label: '12–17个月'}),
  Object.freeze({value: '18+', label: '18个月以上'})
]);
const values = ageGroups.map(group => group.value);
const invalid = () => { throw new Error('请选择有效的适用月龄。'); };

function ageGroupForMonths(months) {
  if (!Number.isInteger(months) || months < 6) return null;
  if (months <= 8) return '6-8';
  if (months <= 11) return '9-11';
  if (months <= 17) return '12-17';
  return '18+';
}

function normalizeAgeGroups(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > values.length) invalid();
  const selected = new Set();
  for (const value of input) {
    if (typeof value !== 'string' || !values.includes(value)) invalid();
    selected.add(value);
  }
  return values.filter(value => selected.has(value));
}

function readAgeGroups(recipe) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  try {
    const input = Object.prototype.hasOwnProperty.call(recipe, 'ageGroups') ? recipe.ageGroups : undefined;
    return normalizeAgeGroups(input) || [];
  } catch (_) { return null; }
}

function recipeAgeGroups(recipe) {
  return readAgeGroups(recipe) || [];
}

function matchesAgeGroups(recipe, selectedAgeGroups) {
  if (!selectedAgeGroups.length) return true;
  const configured = readAgeGroups(recipe);
  return configured !== null && (!configured.length || selectedAgeGroups.some(value => configured.includes(value)));
}

function ageLabel(recipe) {
  const selected = readAgeGroups(recipe);
  if (selected === null) return '';
  if (!selected.length) return '不限月龄';
  return ageGroups.filter(group => selected.includes(group.value)).map(group => group.label).join('、');
}

module.exports = {ageGroups, ageGroupForMonths, normalizeAgeGroups, recipeAgeGroups, matchesAgeGroups, ageLabel};
