'use strict';

const builtInRecipes = new Map(require('../data/recipes').map(recipe => [recipe.id, recipe]));

// Older clients cleared isExample when editing a starter recipe. Its stable ID
// still identifies the built-in origin; imported examples retain their marker.
function isBuiltInRecipe(recipe) {
  return Boolean(recipe && (recipe.isExample === true || builtInRecipes.has(recipe.id)));
}

function getBuiltInRecipe(id) {
  const recipe = typeof id === 'string' && builtInRecipes.get(id);
  return recipe ? JSON.parse(JSON.stringify(recipe)) : null;
}

module.exports = {isBuiltInRecipe, getBuiltInRecipe};
