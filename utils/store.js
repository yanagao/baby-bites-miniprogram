'use strict';

const seed = require('../data/recipes');
const selectors = require('./selectors');
const STORAGE_KEY = 'baby-bites-v1';
let state = null;
let warning = '';
let readBlocked = false;
let sequence = 0;

const clone = value => JSON.parse(JSON.stringify(value));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validString = (value, max) => typeof value === 'string' && value.length <= max;
const validTimestamp = value => value == null || (Number.isFinite(value) && value >= 0);

function fail(message) { throw new Error(message); }
function timestamp(previous) { return Math.max(Date.now(), (Number(previous) || 0) + 1); }
function makeId(prefix) { sequence += 1; return `${prefix}-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 10)}`; }

function freshState() {
  const now = Date.now();
  return {
    version: 1, nickname: '宝宝', profileUpdatedAt: 0,
    recipes: seed.map((recipe, index) => Object.assign(clone(recipe), {
      isExample: true, favorite: false, photo: '', createdAt: now - index, updatedAt: 0
    })), logs: []
  };
}

function validDate(value) {
  if (!validString(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value > selectors.today()) return false;
  const parts = value.split('-').map(Number);
  if (parts[0] < 1000) return false;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
}

function validPhoto(photo) {
  if (photo == null || photo === '') return true;
  if (!validString(photo, 2000) || /[\u0000-\u001f]/.test(photo)) return false;
  // wx.saveFile / USER_DATA_PATH paths on devices and the developer tool.
  return /^wxfile:\/\/(?:usr(?:\/|$)|store(?:_|\/))/.test(photo) ||
    /^https?:\/\/(?:usr|store)(?:\/|_)/.test(photo) || /^\/usr\//.test(photo);
}

function validateData(data) {
  if (!isObject(data) || data.version !== 1 || !Array.isArray(data.recipes) || !Array.isArray(data.logs)) {
    fail('文件格式不正确，请选择小口袋导出的备份。');
  }
  if (data.recipes.length > 1000 || data.logs.length > 20000) {
    fail('小口袋最多支持 1000 道菜谱和 20000 条记录；本次未保存，已有数据不受影响。');
  }
  const nickname = data.nickname == null ? '宝宝' : data.nickname;
  if (!validString(nickname, 20) || !nickname.trim() || !validTimestamp(data.profileUpdatedAt)) fail('宝宝称呼或更新时间不正确。');
  const recipeIds = new Set();
  const recipes = data.recipes.map(recipe => {
    if (!isObject(recipe) || !validString(recipe.id, 100) || !recipe.id.trim() || recipeIds.has(recipe.id) ||
      !validString(recipe.name, 60) || !recipe.name.trim() || !selectors.categories.slice(1).includes(recipe.category) ||
      !selectors.textures.includes(recipe.texture) || !Number.isFinite(recipe.minutes) || recipe.minutes < 1 || recipe.minutes > 480 ||
      !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 50 ||
      !recipe.ingredients.every(item => isObject(item) && validString(item.name, 80) && item.name.trim() && validString(item.amount, 80)) ||
      !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 30 ||
      !recipe.steps.every(step => validString(step, 2000) && step.trim()) ||
      (recipe.note != null && !validString(recipe.note, 2000)) ||
      (recipe.imageKey != null && !validString(recipe.imageKey, 40)) ||
      (recipe.favorite != null && typeof recipe.favorite !== 'boolean') ||
      (recipe.isExample != null && typeof recipe.isExample !== 'boolean') ||
      !validTimestamp(recipe.createdAt) || !validTimestamp(recipe.updatedAt)) {
      fail('菜谱信息不完整：请检查名称、分类、用时、食材和制作步骤。');
    }
    if (!validPhoto(recipe.photo)) fail('照片必须是保存在本机的图片，请重新选择并保存照片。');
    recipeIds.add(recipe.id);
    return {
      id: recipe.id, name: recipe.name.trim(), category: recipe.category, minutes: recipe.minutes,
      texture: recipe.texture, ingredients: recipe.ingredients.map(item => ({name: item.name.trim(), amount: item.amount.trim()})),
      steps: recipe.steps.map(step => step.trim()), note: recipe.note || '', photo: recipe.photo || '',
      imageKey: recipe.imageKey || '', favorite: Boolean(recipe.favorite), isExample: Boolean(recipe.isExample),
      createdAt: recipe.createdAt || 0, updatedAt: recipe.updatedAt || 0
    };
  });
  const logIds = new Set();
  const logs = data.logs.map(log => {
    if (!isObject(log) || !validString(log.id, 100) || !log.id.trim() || logIds.has(log.id) ||
      !recipeIds.has(log.recipeId) || ![1, 2, 3].includes(log.rating) || !validDate(log.date) ||
      (log.note != null && !validString(log.note, 500)) || (log.portion != null && !validString(log.portion, 40)) ||
      !validTimestamp(log.createdAt)) fail('喜好记录不完整：请检查对应菜谱、喜好程度和吃饭日期。');
    logIds.add(log.id);
    return {id: log.id, recipeId: log.recipeId, rating: log.rating, date: log.date,
      portion: log.portion || '', note: log.note || '', createdAt: log.createdAt || 0};
  });
  return {version: 1, nickname: nickname.trim(), profileUpdatedAt: data.profileUpdatedAt || 0, recipes, logs};
}

function init() {
  if (state) return clone(state);
  try {
    const saved = wx.getStorageSync(STORAGE_KEY);
    state = saved === '' || saved == null ? freshState() : validateData(typeof saved === 'string' ? JSON.parse(saved) : saved);
  } catch (error) {
    state = freshState();
    readBlocked = true;
    warning = '未能读取本机记录，原数据未被覆盖。当前显示示例菜谱，请导入有效备份后再保存。';
  }
  return clone(state);
}

function getState() { init(); return clone(state); }
function getWarning() { init(); return warning; }
function getRecipe(recipeId) { init(); const recipe = state.recipes.find(item => item.id === recipeId); return recipe ? clone(recipe) : null; }

function commit(mutator, recover) {
  init();
  if (readBlocked && !recover) fail(warning);
  const next = clone(state);
  mutator(next);
  const validated = validateData(next);
  try { wx.setStorageSync(STORAGE_KEY, validated); }
  catch (error) { fail('保存失败：本机存储空间不足或暂时不可用。已有记录未改变，请备份后重试。'); }
  state = validated;
  warning = '';
  readBlocked = false;
}

function saveRecipe(input, initialRating) {
  init();
  if (!isObject(input)) fail('请填写菜谱信息。');
  const existing = input.id ? state.recipes.find(recipe => recipe.id === input.id) : null;
  if (input.id && !existing) fail('这道菜谱已被移除，请返回菜谱列表后重试。');
  const rating = initialRating == null ? 0 : Number(initialRating);
  if (![0, 1, 2, 3].includes(rating)) fail('请选择有效的喜好程度。');
  const recipeId = existing ? existing.id : makeId('recipe');
  const recipe = Object.assign({}, existing || {}, input, {
    id: recipeId, name: typeof input.name === 'string' ? input.name.trim() : input.name,
    minutes: input.minutes === '' || input.minutes == null ? NaN : Number(input.minutes),
    ingredients: Array.isArray(input.ingredients) ? input.ingredients.map(item => isObject(item) ? {
      name: typeof item.name === 'string' ? selectors.normalizeIngredient(item.name) : item.name,
      amount: item.amount == null || item.amount === '' ? '适量' : item.amount
    } : item) : input.ingredients,
    note: input.note == null ? '' : input.note,
    photo: input.photo == null ? (existing ? existing.photo : '') : input.photo,
    imageKey: input.imageKey == null ? (existing ? existing.imageKey : '') : input.imageKey,
    favorite: existing ? existing.favorite : Boolean(input.favorite),
    isExample: false,
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: timestamp(existing && existing.updatedAt)
  });
  commit(next => {
    if (existing) next.recipes = next.recipes.map(item => item.id === recipeId ? recipe : item);
    else next.recipes.unshift(recipe);
    if (!existing && rating) next.logs.push({id: makeId('log'), recipeId, rating,
      date: selectors.today(), portion: '', note: '', createdAt: Date.now()});
  });
  return recipeId;
}

function deleteRecipe(recipeId) {
  if (!getRecipe(recipeId)) fail('这道菜谱已经不存在了。');
  commit(next => {
    next.recipes = next.recipes.filter(recipe => recipe.id !== recipeId);
    next.logs = next.logs.filter(log => log.recipeId !== recipeId);
  });
  return true;
}

function toggleFavorite(recipeId) {
  const recipe = getRecipe(recipeId);
  if (!recipe) fail('这道菜谱已经不存在了。');
  commit(next => {
    const target = next.recipes.find(item => item.id === recipeId);
    target.favorite = !target.favorite;
    target.updatedAt = timestamp(target.updatedAt);
  });
  return !recipe.favorite;
}

function addLog(input) {
  if (!isObject(input) || !getRecipe(input.recipeId)) fail('这道菜谱已经不存在了，请重新选择菜谱。');
  const logId = makeId('log');
  const log = {id: logId, recipeId: input.recipeId, rating: Number(input.rating),
    date: input.date || selectors.today(), portion: input.portion == null ? '' : input.portion,
    note: input.note == null ? '' : input.note, createdAt: Date.now()};
  commit(next => { next.logs.push(log); });
  return logId;
}

function deleteLog(logId) {
  init();
  if (!state.logs.some(log => log.id === logId)) fail('这条试吃记录已经不存在了。');
  commit(next => { next.logs = next.logs.filter(log => log.id !== logId); });
  return true;
}

function setNickname(value) {
  const nickname = typeof value === 'string' ? value.trim() : '';
  if (!nickname || nickname.length > 20) fail('宝宝称呼请填写 1–20 个字。');
  commit(next => { next.nickname = nickname; next.profileUpdatedAt = timestamp(next.profileUpdatedAt); });
  return nickname;
}

function importBackup(text) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) fail('备份内容为空或超过 5 MB，请选择有效的备份。');
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { fail('这个文件不是有效的 JSON 备份。'); }
  const incoming = validateData(parsed);
  const summary = {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0};
  commit(next => {
    const recipes = new Map(next.recipes.map(recipe => [recipe.id, recipe]));
    incoming.recipes.forEach(recipe => {
      const local = recipes.get(recipe.id);
      if (!local) { recipes.set(recipe.id, recipe); summary.addedRecipes += 1; }
      else if (recipe.updatedAt > local.updatedAt) { recipes.set(recipe.id, recipe); summary.updatedRecipes += 1; }
    });
    next.recipes = Array.from(recipes.values());
    const logIds = new Set(next.logs.map(log => log.id));
    incoming.logs.forEach(log => {
      if (!logIds.has(log.id)) { next.logs.push(log); logIds.add(log.id); summary.addedLogs += 1; }
    });
    if (incoming.profileUpdatedAt > next.profileUpdatedAt || (!next.profileUpdatedAt && next.nickname === '宝宝')) {
      next.nickname = incoming.nickname;
      next.profileUpdatedAt = incoming.profileUpdatedAt;
    }
  }, true);
  return summary;
}

function exportBackup() {
  init();
  if (readBlocked) fail('本机原数据暂时无法读取，不能将示例菜谱当作原数据导出。请先恢复有效备份。');
  return JSON.stringify(getState(), null, 2);
}

module.exports = {
  STORAGE_KEY, init, getState, getWarning, getRecipe, saveRecipe, deleteRecipe,
  toggleFavorite, addLog, deleteLog, setNickname, importBackup, exportBackup
};
