'use strict';

// Package artwork is identified only by these public catalog IDs. Never derive
// a stock key from an arbitrary private ID, recipe name, or ingredient.
const covers = Object.freeze({
  'pumpkin-millet': 'dish:pumpkin-millet',
  'tomato-beef-noodle': 'dish:tomato-beef-noodle',
  'broccoli-potato': 'dish:broccoli-potato',
  'carrot-chicken': 'dish:carrot-chicken',
  'yam-red-date': 'dish:yam-red-date',
  'spinach-egg-pancake': 'dish:spinach-egg-pancake',
  'salmon-vegetable': 'dish:salmon-vegetable',
  'banana-oat-pancake': 'dish:banana-oat-pancake',
  'chicken-tofu-patty': 'dish:chicken-tofu-patty',
  'carrot-beef-steamed-patty': 'dish:carrot-beef-steamed-patty',
  'cabbage-pork-soft-meatball': 'dish:cabbage-pork-soft-meatball',
  'pumpkin-oat-steamed-cake': 'dish:pumpkin-oat-steamed-cake',
  'apple-yam-steamed-cake': 'dish:apple-yam-steamed-cake',
  'sweet-potato-soft-bun': 'dish:sweet-potato-soft-bun',
  'pumpkin-steamed-egg': 'dish:pumpkin-steamed-egg',
  'spinach-tofu-steamed-egg': 'dish:spinach-tofu-steamed-egg',
  'salmon-tofu-steamed-patty': 'dish:salmon-tofu-steamed-patty',
  'potato-beef-thick-soup': 'dish:potato-beef-thick-soup',
  'tomato-egg-tofu-soup': 'dish:tomato-egg-tofu-soup',
  'winter-melon-chicken-stew': 'dish:winter-melon-chicken-stew',
  'broccoli-carrot-soft-fingers': 'dish:broccoli-carrot-soft-fingers'
});

function getImageKey(sourceRecipeId, imageKey) {
  return typeof sourceRecipeId === 'string' && Object.prototype.hasOwnProperty.call(covers, sourceRecipeId)
    ? covers[sourceRecipeId] : imageKey || '';
}

module.exports = {getImageKey};
