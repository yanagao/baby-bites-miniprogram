'use strict';

const {parseDate} = require('./calendar');

const MEALS = [
  {value: 'breakfast', label: '早餐', icon: 'sunny'},
  {value: 'lunch', label: '午餐', icon: 'sunny'},
  {value: 'dinner', label: '晚餐', icon: 'moon'}
];
const validMeal = value => MEALS.some(meal => meal.value === value);
const validPlanDate = value => typeof value === 'string' && value.slice(0, 4) >= '1000' && !!parseDate(value);
const planId = (date, meal) => validPlanDate(date) && validMeal(meal) ? 'meal-' + date + '-' + meal : '';
const validPlanId = value => {
  const match = typeof value === 'string' && /^meal-(\d{4}-\d{2}-\d{2})-(breakfast|lunch|dinner)$/.exec(value);
  return !!match && validPlanDate(match[1]);
};

module.exports = {MEALS, validMeal, validPlanDate, validPlanId, planId};
