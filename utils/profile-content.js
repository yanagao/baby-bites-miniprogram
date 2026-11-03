'use strict';

const selectors = require('./selectors');

function build(state, options = {}) {
  const tab = ['recipes', 'favorites', 'records'].includes(options.tab) ? options.tab : 'recipes';
  const allRecipes = selectors.listRecipes(state);
  const allLogs = selectors.listLogs(state);
  const favorites = allRecipes.filter(recipe => recipe.favorite);
  return {
    recipes: tab === 'records' ? [] : tab === 'favorites' ? favorites : allRecipes,
    logs: tab === 'records' ? allLogs : [],
    recipeCount: allRecipes.length,
    favoriteCount: favorites.length,
    logCount: allLogs.length
  };
}

module.exports = {build};
