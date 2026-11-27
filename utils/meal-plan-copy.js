'use strict';

const store = require('./store');
const social = require('./social');
const {MEALS, validPlanDate, planId} = require('./meal-plans');
const {getBuiltInRecipe} = require('./recipe-origin');
const {normalizeMealPlan} = require('./public-meal-plans');
const {today} = require('./selectors');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function fail(message, code = 'INVALID_INPUT') {
  const error = Error(message); error.code = code; error.userMessage = message; throw error;
}
function rethrowSourceError(error) {
  if (['NOT_FOUND', 'NOT_PUBLIC', 'RECIPE_NOT_FOUND', 'PROFILE_NOT_FOUND'].includes(error && error.code)) {
    fail('原餐单已更新或取消分享，请刷新后重新选择。', 'SOURCE_CHANGED');
  }
  throw error;
}
const writable = action => action === 'add' || action === 'replace';
function validateTarget(date, mode) {
  if (!validPlanDate(date) || date < today()) fail('请选择今天或之后的日期。');
  if (mode !== 'keep' && mode !== 'replace') fail('请选择保留或替换已有安排。');
}
function normalizeRows(value) {
  if (!Array.isArray(value) || value.length !== MEALS.length) fail('餐单信息不完整，请重新打开。');
  const rows = new Map();
  for (const row of value) {
    if (!object(row) || !MEALS.some(meal => meal.value === row.meal) || rows.has(row.meal) ||
      typeof row.planned !== 'boolean' || row.recipe === undefined || !row.planned && row.recipe !== null) fail('餐单信息不完整，请重新打开。');
    let recipe = null;
    if (row.recipe !== null) {
      const item = row.recipe;
      if (!object(item) || !['public', 'builtin'].includes(item.kind) ||
        (item.kind === 'public' ? !id64(item.id) : !getBuiltInRecipe(item.id)) ||
        !text(item.name, 60) || !text(item.texture, 40) || !Number.isFinite(item.minutes) || item.minutes < 1 || item.minutes > 480 ||
        item.imageKey != null && (typeof item.imageKey !== 'string' || item.imageKey.length > 100) ||
        item.photoURL != null && (typeof item.photoURL !== 'string' || item.photoURL.length > 8000 ||
          item.photoURL !== '' && !/^https:\/\/[^\s]+$/.test(item.photoURL))) fail('菜谱信息已失效，请重新打开餐单。');
      recipe = {id: item.id, kind: item.kind, name: item.name, minutes: item.minutes,
        texture: item.texture, imageKey: item.imageKey || ''};
    }
    rows.set(row.meal, {meal: row.meal, planned: row.planned, recipe});
  }
  return MEALS.map(({value: meal, label}) => ({...rows.get(meal), label}));
}
function currentPlans(state, date) {
  return (state.mealPlans || []).filter(plan => plan.date === date).slice().sort((a, b) => a.id.localeCompare(b.id));
}
function planVersion(plans) {
  return JSON.stringify(plans.slice().sort((a, b) => a.id.localeCompare(b.id)).map(plan =>
    [plan.id, plan.date, plan.meal, plan.recipeId, plan.createdAt, plan.updatedAt]));
}
function validateExpected(expected, date) {
  if (!Array.isArray(expected) || expected.length > 3) fail('餐单确认信息不完整，请重新选择日期。');
  const ids = new Set();
  for (const plan of expected) {
    if (!object(plan) || plan.date !== date || plan.id !== planId(date, plan.meal) || !plan.id || ids.has(plan.id) ||
      !text(plan.recipeId, 100) || ![plan.createdAt, plan.updatedAt].every(value => Number.isSafeInteger(value) && value >= 0)) {
      fail('餐单确认信息不完整，请重新选择日期。');
    }
    ids.add(plan.id);
  }
  return copy(expected);
}
function sameRecipe(local, source) {
  return !!local && !!source && (source.kind === 'builtin' ? local.id === source.id :
    store.matchesPublicRecipe(local, source.id));
}
function buildPreview(meals, targetDate, mode, state) {
  const expected = currentPlans(state, targetDate);
  const plans = new Map(expected.map(plan => [plan.meal, plan]));
  const rows = meals.map(source => {
    const previous = plans.get(source.meal), existing = previous && state.recipes.find(recipe => recipe.id === previous.recipeId);
    const locked = state.logs.some(log => log.date === targetDate && log.meal === source.meal);
    const same = previous && sameRecipe(existing, source.recipe);
    const conflict = !!previous && !!source.recipe && !same;
    const action = !source.planned ? 'empty' : !source.recipe ? 'unavailable' : locked ? 'locked' : same ? 'same' :
      previous ? mode === 'replace' ? 'replace' : 'keep' : 'add';
    return {meal: source.meal, label: source.label, name: source.recipe ? source.recipe.name : '',
      existingName: existing ? existing.name : '', conflict, locked, action};
  });
  return {rows, expected: copy(expected), saveCount: rows.filter(row => ['add', 'replace'].includes(row.action)).length,
    conflictCount: rows.filter(row => row.conflict).length,
    unavailableCount: rows.filter(row => row.action === 'unavailable').length};
}
function preview(meals, targetDate, mode = 'keep') {
  validateTarget(targetDate, mode);
  return buildPreview(normalizeRows(meals), targetDate, mode, store.getState());
}

async function save(input) {
  if (!object(input) || typeof input.profileId !== 'string' || !/^[a-f0-9]{32}$/.test(input.profileId) ||
    !validPlanDate(input.sourceDate) || typeof input.isCurrent !== 'function') fail('餐单保存信息不完整，请重新打开。');
  const {profileId, sourceDate, targetDate, isCurrent} = input, mode = input.mode === undefined ? 'keep' : input.mode;
  validateTarget(targetDate, mode);
  const meals = normalizeRows(input.meals), expected = validateExpected(input.expected, targetDate);
  const sourceVersion = JSON.stringify(meals);
  const initial = store.getSyncInfo(), originalScope = initial.scopeKey || initial.owner || '';
  if (!id64(initial.owner) || !originalScope || initial.blocked) fail('请先完成当前账号同步后再保存餐单。', 'SYNC_REQUIRED');
  const selected = buildPreview(meals, targetDate, mode, store.getState());
  const selectedActions = new Map(selected.rows.map(row => [row.meal, row.action]));
  let changed = false;
  const unsubscribe = store.subscribe(info => {
    if (info.owner !== initial.owner || (info.scopeKey || info.owner || '') !== originalScope) changed = true;
  });
  function check() {
    const info = store.getSyncInfo();
    if (changed || info.owner !== initial.owner || (info.scopeKey || info.owner || '') !== originalScope) {
      fail('账号或家庭已切换，请重新打开餐单。', 'ACCOUNT_CHANGED');
    }
    if (!isCurrent()) fail('已取消保存餐单。', 'CANCELLED');
    if (info.blocked) fail('当前记录暂时无法读取，请重新同步。', 'SYNC_REQUIRED');
    validateTarget(targetDate, mode);
  }
  function checkTarget() {
    if (planVersion(currentPlans(store.getState(), targetDate)) !== planVersion(expected)) {
      fail('这一天的餐单已有变化，请重新确认后保存。', 'TARGET_CHANGED');
    }
    const current = buildPreview(meals, targetDate, mode, store.getState());
    if (current.rows.some(row => row.action !== selectedActions.get(row.meal) && row.action !== 'locked' &&
      (writable(row.action) || writable(selectedActions.get(row.meal))))) {
      fail('这一天的用餐情况已有变化，请重新确认后保存。', 'TARGET_CHANGED');
    }
  }
  async function readSource() {
    check();
    let response;
    try { response = await social.getMealPlan(profileId, sourceDate, {force: true}); }
    catch (error) {
      check();
      rethrowSourceError(error);
    }
    check();
    const day = normalizeMealPlan(response, profileId, sourceDate);
    const entries = new Map(day.meals.map(row => [row.meal, row]));
    const current = normalizeRows(MEALS.map(({value: meal, label}) => ({meal, label,
      planned: entries.has(meal), recipe: entries.has(meal) ? entries.get(meal).recipe : null})));
    if (JSON.stringify(current) !== sourceVersion) fail('原餐单已有变化，请刷新后重新选择。', 'SOURCE_CHANGED');
  }
  try {
    check(); checkTarget();
    await readSource(); check(); checkTarget();
    const recipes = new Map();
    for (const row of selected.rows) {
      if (!['add', 'replace'].includes(row.action)) continue;
      const recipe = meals.find(item => item.meal === row.meal).recipe, key = recipe.kind + ':' + recipe.id;
      recipes.set(key, recipe);
    }
    // A day has at most three different recipes. Start their reads/downloads
    // together so they share the initial sync instead of syncing after each
    // import. Settle every task before returning an error or allowing a retry.
    const results = await Promise.all([...recipes].map(async ([key, recipe]) => {
      check(); checkTarget();
      let result;
      if (recipe.kind === 'builtin') result = store.addBuiltInRecipe(recipe.id, initial.owner);
      else {
        try { result = await social.addToCookbook(recipe.id); }
        catch (error) { check(); rethrowSourceError(error); }
      }
      check(); checkTarget();
      const local = result && typeof result.recipeId === 'string' && store.getRecipe(result.recipeId);
      if (!sameRecipe(local, recipe)) fail('菜谱未能保存，请重新打开后再试。', 'IMPORT_FAILED');
      return [key, result.recipeId];
    }).map(work => work.then(value => ({value}), error => ({error}))));
    check(); checkTarget();
    const failed = results.find(result => 'error' in result);
    if (failed) throw failed.error;
    const localIds = new Map(results.map(result => result.value));
    if (localIds.size) { await readSource(); check(); checkTarget(); }
    const latest = buildPreview(meals, targetDate, mode, store.getState()), entries = [];
    for (const row of latest.rows) {
      if (!['add', 'replace'].includes(row.action)) continue;
      const recipe = meals.find(item => item.meal === row.meal).recipe;
      const recipeId = localIds.get(recipe.kind + ':' + recipe.id);
      if (!recipeId || !sameRecipe(store.getRecipe(recipeId), recipe)) fail('菜谱已有变化，请重新确认餐单。', 'IMPORT_FAILED');
      entries.push({date: targetDate, meal: row.meal, recipeId});
    }
    check(); checkTarget();
    // Imports may remain after an error, but the day's arrangements are one
    // atomic store commit. No await is permitted between this guard and save.
    if (entries.length) store.saveMealPlans(entries, {expected});
    return {date: targetDate, savedCount: entries.length,
      keptCount: latest.rows.filter(row => ['keep', 'locked', 'same'].includes(row.action)).length,
      unavailableCount: latest.unavailableCount, scopeKey: originalScope};
  } finally { unsubscribe(); }
}

module.exports = {preview, save};
