'use strict';

const builtInIds = new Set(require('../data/recipes').map(recipe => recipe.id));

// Older clients cleared isExample when editing a starter recipe. Its stable ID
// still identifies the built-in origin; imported examples retain their marker.
function isBuiltInRecipe(recipe) {
  return Boolean(recipe && (recipe.isExample === true || builtInIds.has(recipe.id)));
}

module.exports = {isBuiltInRecipe};
