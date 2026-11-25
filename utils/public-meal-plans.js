'use strict';

const {MEALS, validPlanDate} = require('./meal-plans');
const {getBuiltInRecipe} = require('./recipe-origin');
const {withCover} = require('./recipe-covers');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function invalid() { const error = Error('餐单信息暂时无法读取，请重试。'); error.code = 'INVALID_MEAL_PLAN'; throw error; }

function normalizeDay(value) {
  if (!object(value) || !validPlanDate(value.date) || !Array.isArray(value.meals) || !value.meals.length || value.meals.length > 3) invalid();
  const meals = new Map();
  value.meals.forEach(item => {
    const meal = object(item) && MEALS.find(meal => meal.value === item.meal);
    if (!meal || meals.has(item.meal)) invalid();
    let recipe = null;
    if (item.recipe !== null) {
      const r = item.recipe;
      if (!object(r) || !['public', 'builtin'].includes(r.kind) ||
        (r.kind === 'public' ? !/^[a-f0-9]{64}$/.test(r.id) : !getBuiltInRecipe(r.id)) ||
        !text(r.name, 60) || !text(r.texture, 40) || !Number.isFinite(r.minutes) || r.minutes < 1 || r.minutes > 480 ||
        (r.imageKey != null && (typeof r.imageKey !== 'string' || r.imageKey.length > 100)) ||
        (r.photoURL && (typeof r.photoURL !== 'string' || r.photoURL.length > 8000 || !/^https:\/\//.test(r.photoURL)))) invalid();
      recipe = withCover({id: r.id, kind: r.kind, name: r.name, texture: r.texture, minutes: r.minutes,
        imageKey: r.imageKey || '', photoURL: r.photoURL || ''});
    }
    meals.set(item.meal, {meal: item.meal, label: meal.label, recipe});
  });
  return {date: value.date, meals: MEALS.filter(meal => meals.has(meal.value)).map(meal => meals.get(meal.value))};
}

function normalizeMealPlan(value, expectedProfileId, expectedDate) {
  const day = normalizeDay(value), author = value.author;
  if (!object(author) || author.exists !== true || !/^[a-f0-9]{32}$/.test(author.id) ||
    expectedProfileId && author.id !== expectedProfileId || expectedDate && day.date !== expectedDate || !text(author.name, 20)) invalid();
  return {...day, author: {id: author.id, name: author.name, exists: true}};
}

function normalizeDays(value, offset) {
  if (!object(value) || !Array.isArray(value.days) || value.days.length > 20 ||
    value.nextOffset !== null && (!Number.isSafeInteger(value.nextOffset) || value.nextOffset <= offset || value.nextOffset > 3000)) invalid();
  const days = value.days.map(normalizeDay);
  if (days.some((day, index) => index && day.date >= days[index - 1].date)) invalid();
  return {days, nextOffset: value.nextOffset};
}

function dayVersion(state, date) {
  const plans = (state.mealPlans || []).filter(plan => plan.date === date).slice().sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(plans.map(plan => ({plan, recipe: state.recipes.find(recipe => recipe.id === plan.recipeId) || null})));
}

module.exports = {normalizeMealPlan, normalizeDays, dayVersion};
