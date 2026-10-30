'use strict';

const catalog = require('../data/recipe-cover-catalog');
const coverLoader = require('./cover-loader');
// Exact catalog IDs or explicit public dish keys only: names and generic
// ingredient icons must never assign an unrelated starter photo to a user recipe.
const knownKeys = new Set(catalog.files.map(file => file.key));

function getCoverKey(recipe) {
  if (!recipe || typeof recipe !== 'object') return '';
  const key = typeof recipe.id === 'string' ? 'dish:' + recipe.id : '';
  if (knownKeys.has(key)) return key;
  return typeof recipe.imageKey === 'string' && knownKeys.has(recipe.imageKey) ? recipe.imageKey : '';
}

function getCover(recipe) {
  const key = getCoverKey(recipe);
  return key ? coverLoader.getSource(key) : '';
}

function withCover(recipe) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  const photo = recipe.photoURL || recipe.photo;
  if (photo) {
    // A previously decorated card must not hide a newly supplied user photo.
    return recipe.displayPhoto && recipe.displayPhoto !== photo ? Object.assign({}, recipe, {displayPhoto: photo}) : recipe;
  }
  const cover = getCover(recipe);
  if (cover) return Object.assign({}, recipe, {displayPhoto: cover});
  // Retire expired/evicted display sources without changing the recipe's photo.
  return recipe.displayPhoto && getCoverKey(recipe) ? Object.assign({}, recipe, {displayPhoto: ''}) : recipe;
}

module.exports = {getCoverKey, getCover, withCover};
