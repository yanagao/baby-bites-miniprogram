'use strict';

const recipeCategories = [
  '早餐饼', '肉饼肉丸', '面包糕点', '粥饭主食',
  '蔬菜手抓', '蒸蛋豆腐', '汤羹炖菜'
];
const categories = ['全部'].concat(recipeCategories);
const legacyCategories = ['粥与面', '蔬菜泥', '小点心'];

function normalizeCategory(category, recipeName) {
  // An explicit current category is the user's choice; only migrate legacy labels.
  if (recipeCategories.includes(category)) return category;
  const previousLabel = recipeCategories.find(value => value + '类' === category);
  if (previousLabel) return previousLabel;
  if (!legacyCategories.includes(category)) return null;
  const name = typeof recipeName === 'string' ? recipeName.trim() : '';

  // Prefer the finished dish over an ingredient (e.g. 豆腐粥 and 肉丸汤).
  if (/(?:粥|饭|面|面条|米粉|米线)$/.test(name)) return '粥饭主食';
  if (/蒸蛋|蛋羹/.test(name)) return '蒸蛋豆腐';
  if (/(?:汤|羹|炖菜)$/.test(name)) return '汤羹炖菜';
  if (/肉饼|肉丸|鱼丸|虾丸|鱼饼|虾饼/.test(name)) return '肉饼肉丸';
  if (/豆腐/.test(name)) return '蒸蛋豆腐';

  if (category === '粥与面') return '粥饭主食';
  if (category === '蔬菜泥') return '蔬菜手抓';
  return name.includes('饼') ? '早餐饼' : '面包糕点';
}

module.exports = {categories, recipeCategories, normalizeCategory};
