'use strict';

const starterRecipes = new Map(require('../data/recipes').map(recipe => [recipe.id, recipe]));
const contentFields = ['name', 'category', 'minutes', 'texture'];

function isUnusedStarter(recipe, referenced) {
  const original = starterRecipes.get(recipe.id);
  if (!original || recipe.isExample !== true || recipe.updatedAt !== 0 ||
    recipe.favorite || recipe.photo || recipe.source ||
    recipe.ageGroups !== undefined || original.ageGroups !== undefined || referenced.has(recipe.id)) return false;
  if (contentFields.some(field => recipe[field] !== original[field]) ||
    recipe.note !== (original.note || '') || recipe.imageKey !== (original.imageKey || '')) return false;
  if (recipe.ingredients.length !== original.ingredients.length ||
    recipe.ingredients.some((item, index) => item.name !== original.ingredients[index].name ||
      item.amount !== original.ingredients[index].amount)) return false;
  return recipe.steps.length === original.steps.length &&
    recipe.steps.every((step, index) => step === original.steps[index]);
}

// Input is already validated snapshot data. Retiring an unused default is not a
// user deletion: do not create tombstones that could erase another device's
// edits, meal plans or history when snapshots merge.
function removeUnusedStarterRecipes(data) {
  const referenced = new Set(data.logs.map(log => log.recipeId));
  (data.mealPlans || []).forEach(plan => referenced.add(plan.recipeId));
  const recipes = data.recipes.filter(recipe => !isUnusedStarter(recipe, referenced));
  return recipes.length === data.recipes.length ? data : {...data, recipes};
}

module.exports = {removeUnusedStarterRecipes};
