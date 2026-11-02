'use strict';

// These are ingredient-name matching rules, not a diagnosis or a complete
// packaged-food ingredient database. Only foods explicitly recorded by the user
// are considered. Unlisted compounds still need their actual labels checked.
const ingredientAliases = {
  西红柿: '番茄', 马铃薯: '土豆', 燕麦片: '燕麦', 鸡胸肉: '鸡肉',
  鸡腿肉: '鸡肉', 红萝卜: '胡萝卜', 红枣肉: '红枣', 花生米: '花生', 黄豆: '大豆'
};
const groups = [
  {names: ['鸡蛋', '蛋', '蛋黄', '蛋清', '蛋白', '全蛋', '鸡蛋白'],
    ingredients: ['鸡蛋', '蛋黄', '蛋清', '全蛋', '蛋液', '鸡蛋白', '蛋白液']},
  {names: ['牛奶', '牛乳', '奶', '奶制品', '乳制品'],
    ingredients: ['牛奶', '牛乳', '奶粉', '配方奶', '酸奶', '酸乳', '奶酪', '芝士', '黄油', '奶油', '乳清', '酪蛋白', '炼乳', '炼奶']},
  {names: ['大豆', '黄豆', '豆制品'],
    ingredients: ['大豆', '黄豆', '豆腐', '豆浆', '豆奶', '豆干', '豆皮', '腐竹', '酱油', '豆豉']},
  {names: ['小麦', '小麦粉', '面粉'],
    ingredients: ['小麦', '面粉', '面条', '挂面', '面包', '馒头', '饼干', '面筋', '通心粉', '意大利面', '酱油'],
    // Explicitly named alternative flours are not wheat synonyms. An additional
    // wheat ingredient elsewhere in the same name is still matched below.
    alternatives: /(?:玉米|大米|糯米|荞麦|燕麦|高粱)面粉/g},
  {names: ['花生', '花生米'], ingredients: ['花生']},
  {names: ['坚果', '树坚果'], ingredients: ['坚果', '核桃', '腰果', '杏仁', '榛子', '开心果', '碧根果', '松子', '夏威夷果', '巴旦木']},
  {names: ['鱼', '鱼类'], ingredients: ['鱼', '魚']},
  {names: ['虾', '虾类', '蝦'], ingredients: ['虾', '蝦']},
  {names: ['芝麻'], ingredients: ['芝麻', '麻酱', '香油']}
];

function normalizeAllergies(input) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 50) throw Error('过敏食物最多记录 50 项。');
  const result = [];
  for (const value of input) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
      !value.trim() || value.trim().length > 40) throw Error('每项过敏食物请填写 1–40 个字。');
    const name = value.trim();
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function normalizedName(value) {
  const name = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
  return Object.prototype.hasOwnProperty.call(ingredientAliases, name) ? ingredientAliases[name] : name;
}

function containsIngredient(name, term) {
  // Keep English names on word boundaries (e.g. egg must not match eggplant).
  if (/^[a-z0-9 ]+$/i.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z])' + escaped + '([^a-z]|$)', 'i').test(name);
  }
  return name.replace(/\s+/g, '').includes(term.replace(/\s+/g, ''));
}

let cachedKey = '';
let cachedRules = [];
function matchingRules(recorded) {
  // Reuse only the current list's name rules while filtering a recipe catalog.
  // Results are never cached: every recipe is checked against its current data.
  const key = JSON.stringify(recorded);
  if (key === cachedKey) return cachedRules;
  cachedRules = recorded.map(label => {
    const name = normalizedName(label);
    const group = groups.find(item => item.names.some(alias => normalizedName(alias) === name));
    const terms = (group ? group.ingredients : [name]).flatMap(term => {
      const canonical = normalizedName(term);
      return [canonical, ...Object.keys(ingredientAliases).filter(alias => normalizedName(alias) === canonical)];
    });
    return {label, terms: [...new Set(terms)], alternatives: group && group.alternatives,
      exact: group ? group.names.map(normalizedName) : [name]};
  });
  cachedKey = key;
  return cachedRules;
}

function findRecipeAllergens(recipe, allergies) {
  const recorded = normalizeAllergies(allergies) || [];
  if (!recorded.length || !recipe || !Array.isArray(recipe.ingredients)) return [];
  const ingredients = recipe.ingredients.map(item => normalizedName(item && item.name)).filter(Boolean);
  return matchingRules(recorded).filter(rule => ingredients.some(ingredient => {
    if (rule.exact.includes(ingredient)) return true;
    const candidate = rule.alternatives ? ingredient.replace(rule.alternatives, '') : ingredient;
    return rule.terms.some(term => containsIngredient(candidate, term));
  })).map(rule => rule.label);
}

module.exports = {normalizeAllergies, findRecipeAllergens};
