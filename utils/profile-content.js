'use strict';

const selectors = require('./selectors');

function build(state, options = {}) {
  const tab = ['recipes', 'favorites', 'records'].includes(options.tab) ? options.tab : 'recipes';
  const visibility = ['all', 'public', 'private'].includes(options.visibility) ? options.visibility : 'all';
  // A missing or malformed response cannot establish that local recipes are
  // private. The controller must also clear publicationReady on account change.
  const known = options.publicationReady === true && Array.isArray(options.published) &&
    options.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim());
  const published = new Map(known ? options.published.map(item => [item.sourceRecipeId, item]) : []);
  const allRecipes = selectors.listRecipes(state).map(recipe => {
    const publication = known && published.get(recipe.id);
    const kind = known ? publication ? 'public' : 'private' : 'unknown';
    return Object.assign({}, recipe, {
      visibility: kind,
      visibilityLabel: kind === 'public' ? '公开菜谱' : kind === 'private' ? '私密菜谱 · 仅自己可见' : '公开状态待确认',
      publicChanged: Boolean(publication && publication.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))
    });
  });
  const allLogs = selectors.listLogs(state);
  const favorites = allRecipes.filter(recipe => recipe.favorite);
  const publicCount = known ? allRecipes.filter(recipe => recipe.visibility === 'public').length : 0;
  return {
    recipes: tab === 'records' ? [] : tab === 'favorites' ? favorites :
      allRecipes.filter(recipe => visibility === 'all' || recipe.visibility === visibility),
    logs: tab === 'records' ? allLogs : [],
    recipeCount: allRecipes.length,
    favoriteCount: favorites.length,
    logCount: allLogs.length,
    publicCount,
    privateCount: known ? allRecipes.length - publicCount : 0
  };
}

module.exports = {build};
