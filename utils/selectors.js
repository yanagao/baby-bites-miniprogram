'use strict';

const {categories} = require('./categories');
const textures = ['细腻泥糊', '软烂颗粒', '手指食物'];
const ratings = {
  1: { name: '不太喜欢', icon: 'unhappy' },
  2: { name: '还不错', icon: 'smile' },
  3: { name: '很喜欢', icon: 'happy' }
};
const pantryItems = [
  ['南瓜', 'pumpkin'], ['胡萝卜', 'carrot'], ['西兰花', 'broccoli'],
  ['土豆', 'tuber'], ['番茄', 'tomato'], ['菠菜', 'leaf'], ['山药', 'leaf'],
  ['鸡蛋', 'egg'], ['鸡肉', 'drumstick'], ['牛肉', 'meat'], ['三文鱼', 'fish'],
  ['小米', 'grain'], ['大米', 'bowl'], ['面条', 'noodle'], ['面粉', 'grain'],
  ['红枣', 'bean'], ['香蕉', 'banana'], ['燕麦', 'grain']
];
const aliases = {
  西红柿: '番茄', 马铃薯: '土豆', 燕麦片: '燕麦', 鸡胸肉: '鸡肉',
  鸡腿肉: '鸡肉', 红萝卜: '胡萝卜', 红枣肉: '红枣'
};
const dishIcons = {
  pumpkin: 'pumpkin', noodle: 'noodle', broccoli: 'broccoli', chicken: 'bowl',
  yam: 'tuber', pancake: 'pancake', salmon: 'fish', banana: 'pancake'
};

function today() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function normalizeIngredient(value) {
  const name = String(value == null ? '' : value).trim();
  return Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : name;
}

function logOrder(a, b) {
  return b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);
}

function latestRatings(state) {
  const latest = new Map();
  state.logs.forEach(log => {
    const previous = latest.get(log.recipeId);
    if (!previous || logOrder(log, previous) < 0) latest.set(log.recipeId, log);
  });
  return latest;
}

function ratingOf(state, recipeId) {
  let latest = null;
  state.logs.forEach(log => {
    if (log.recipeId === recipeId && (!latest || logOrder(log, latest) < 0)) latest = log;
  });
  return latest ? latest.rating : 0;
}

const examplePhotos = {pumpkin: '/assets/food/pumpkin.jpg', noodle: '/assets/food/noodle.jpg', broccoli: '/assets/food/broccoli.jpg'};
function displayPhoto(recipe) { return recipe.photo || (recipe.isExample && examplePhotos[recipe.imageKey]) || ''; }

function enrichWithRating(recipe, feedback) {
  const rating = feedback ? feedback.rating : 0;
  return Object.assign({}, recipe, {
    rating,
    ratingDate: feedback ? feedback.date : '',
    ratingName: rating ? ratings[rating].name : '未记录喜好',
    ratingIcon: rating ? ratings[rating].icon : 'heart',
    ingredientText: recipe.ingredients.map(item => item.name).join(' · '),
    photoSrc: recipe.photo || '',
    displayPhoto: displayPhoto(recipe),
    placeholderIcon: Object.prototype.hasOwnProperty.call(dishIcons, recipe.imageKey)
      ? dishIcons[recipe.imageKey] : 'bowl'
  });
}

function enrichRecipe(state, recipe) {
  return recipe ? enrichWithRating(recipe, latestRatings(state).get(recipe.id)) : null;
}

function listRecipes(state, options) {
  const opts = Object.assign({ category: '全部', search: '', sort: 'recent', onlyFavorites: false,
    texture: '全部口感' }, options || {});
  const search = String(opts.search || '').trim().toLowerCase();
  const normalizedSearch = normalizeIngredient(search);
  const feedback = latestRatings(state);
  const list = state.recipes.filter(recipe =>
    (!opts.category || opts.category === '全部' || recipe.category === opts.category) &&
    (!opts.onlyFavorites || recipe.favorite) &&
    (!opts.texture || opts.texture === '全部' || opts.texture === '全部口感' || recipe.texture === opts.texture) &&
    (!search || [recipe.name].concat(recipe.ingredients.map(item => item.name))
      .some(value => value.toLowerCase().includes(search) || normalizeIngredient(value).toLowerCase().includes(normalizedSearch)))
  ).map(recipe => enrichWithRating(recipe, feedback.get(recipe.id)));
  list.sort((a, b) => {
    const recent = (b.createdAt || 0) - (a.createdAt || 0);
    if (opts.sort === 'quick') return a.minutes - b.minutes || recent;
    if (opts.sort === 'liked') return b.rating - a.rating || recent;
    return recent;
  });
  return list;
}

function matchRecipes(state, ingredients, completeOnly) {
  const selected = new Set(Array.from(ingredients || []).map(normalizeIngredient).filter(Boolean));
  if (!selected.size) return [];
  const feedback = latestRatings(state);
  return state.recipes.map(recipe => {
    const missing = recipe.ingredients.filter(item => !selected.has(normalizeIngredient(item.name)));
    const totalCount = recipe.ingredients.length;
    const foundCount = totalCount - missing.length;
    return Object.assign(enrichWithRating(recipe, feedback.get(recipe.id)), {
      foundCount, totalCount, missingCount: missing.length, missingText: missing.map(item => item.name).join('、'), complete: !missing.length
    });
  }).filter(recipe => recipe.foundCount > 0 && (!completeOnly || recipe.complete))
    .sort((a, b) => b.foundCount / b.totalCount - a.foundCount / a.totalCount || b.foundCount - a.foundCount);
}

function randomRecipe(state, options, rng) {
  const opts = Object.assign({ category: '全部', skipDisliked: true, lastId: null }, options || {});
  const pool = listRecipes(state, { category: opts.category }).filter(recipe => !opts.skipDisliked || recipe.rating !== 1);
  const candidates = pool.length > 1 ? pool.filter(recipe => recipe.id !== opts.lastId) : pool;
  if (!candidates.length) return null;
  const random = (rng || Math.random)();
  const index = Math.min(candidates.length - 1, Math.max(0, Math.floor((Number.isFinite(random) ? random : 0) * candidates.length)));
  return candidates[index];
}

function stats(state) {
  const feedback = latestRatings(state);
  return {
    recipeCount: state.recipes.length,
    likedCount: state.recipes.filter(recipe => feedback.has(recipe.id) && feedback.get(recipe.id).rating === 3).length,
    logCount: state.logs.length,
    triedCount: new Set(state.logs.map(log => log.recipeId)).size
  };
}

function listLogs(state, filter) {
  const selected = filter == null ? 'all' : filter;
  const recipes = new Map(state.recipes.map(recipe => [recipe.id, recipe]));
  return state.logs.filter(log => recipes.has(log.recipeId) &&
    (selected === 'all' || selected === '全部' || log.rating === Number(selected)))
    .slice().sort(logOrder).map(log => {
      const recipe = recipes.get(log.recipeId);
      return Object.assign({}, log, {
        recipeName: recipe.name, ratingName: ratings[log.rating].name,
        ratingIcon: ratings[log.rating].icon, photoSrc: recipe.photo || '',
    displayPhoto: displayPhoto(recipe),
        placeholderIcon: Object.prototype.hasOwnProperty.call(dishIcons, recipe.imageKey) ? dishIcons[recipe.imageKey] : 'bowl'
      });
    });
}

module.exports = {
  categories, textures, ratings, pantryItems, today, normalizeIngredient,
  ratingOf, enrichRecipe, listRecipes, matchRecipes, randomRecipe, stats, listLogs
};
