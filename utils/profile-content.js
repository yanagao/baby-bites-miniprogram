'use strict';

const selectors = require('./selectors');

function build(state, options = {}) {
  const tab = ['recipes', 'favorites', 'records', 'mealPlans'].includes(options.tab) ? options.tab : 'recipes';
  const allRecipes = selectors.listRecipes(state);
  const allLogs = selectors.listLogs(state);
  const favorites = allRecipes.filter(recipe => recipe.favorite);
  return {
    recipes: tab === 'records' || tab === 'mealPlans' ? [] : tab === 'favorites' ? favorites : allRecipes,
    logs: tab === 'records' ? allLogs : [],
    recipeCount: allRecipes.length,
    favoriteCount: favorites.length,
    logCount: allLogs.length
  };
}

function mealPlanDays(days) {
  const labels = {breakfast: '早餐', lunch: '午餐', dinner: '晚餐'};
  return (Array.isArray(days) ? days : []).filter(day => day && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Array.isArray(day.meals))
    .map(day => ({date: day.date,
      dateLabel: Number(day.date.slice(0, 4)) + '年' + Number(day.date.slice(5, 7)) + '月' + Number(day.date.slice(8, 10)) + '日',
      meals: day.meals.filter(meal => meal && labels[meal.meal]).map(meal => ({meal: meal.meal,
        label: labels[meal.meal], name: meal.recipe && meal.recipe.name || '菜谱暂不可查看'}))}));
}

module.exports = {build, mealPlanDays};
