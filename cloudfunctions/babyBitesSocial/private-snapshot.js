'use strict';

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const CATEGORIES = ['早餐饼', '肉饼肉丸', '面包糕点', '粥饭主食', '蔬菜手抓', '蒸蛋豆腐', '汤羹炖菜'];
const TEXTURES = ['细腻泥糊', '软烂颗粒', '手指食物'];
const AGE_GROUPS = ['6-8', '9-11', '12-17', '18+'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max) => typeof value === 'string' && value.length <= max;
const nonempty = (value, max) => string(value, max) && Boolean(value.trim()) && !/[\u0000-\u001f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const optionalTime = value => value == null || timestamp(value);
const optionalString = (value, max) => value == null || string(value, max);
const optionalBoolean = value => value == null || typeof value === 'boolean';

function reject(message, code = 'INVALID_SNAPSHOT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeAgeGroups(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > AGE_GROUPS.length ||
    !value.every(item => AGE_GROUPS.includes(item))) reject('请选择有效的适用月龄。');
  return AGE_GROUPS.filter(item => value.includes(item));
}

function keys(value, allowed) {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}

function ownedFile(fileID, env, owner, kind) {
  if (!string(fileID, 2000) || !nonempty(env, 160) || !/^[a-f0-9]{64}$/.test(owner)) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  if (!match || match[1] !== env) return false;
  const prefix = `users/${owner}/${kind}/`;
  if (!match[3].startsWith(prefix)) return false;
  const filename = match[3].slice(prefix.length);
  return kind === 'snapshots' ? /^[A-Za-z0-9_-]{1,160}\.json$/.test(filename) :
    kind === 'photos' && /^[A-Za-z0-9_-]{1,160}\.(?:jpg|png|webp)$/.test(filename);
}

function validDate(value, now) {
  if (!string(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && value <= today;
}

function validateSnapshot(content, {env, owner, now = Date.now()}) {
  if (!Buffer.isBuffer(content) || !content.length || content.length > MAX_SNAPSHOT_BYTES) {
    reject('同步文件为空或超过 5 MB。');
  }
  let snapshot;
  try { snapshot = JSON.parse(content.toString('utf8')); }
  catch (_) { reject('同步文件不是有效的 JSON。'); }
  if (!keys(snapshot, ['version', 'data', 'deleted']) || snapshot.version !== 1 ||
    !keys(snapshot.data, ['version', 'nickname', 'profileUpdatedAt', 'recipes', 'logs']) ||
    !keys(snapshot.deleted, ['recipes', 'logs'])) reject('同步文件格式不正确。');
  const data = snapshot.data;
  if (data.version !== 1 || !nonempty(data.nickname, 20) || !timestamp(data.profileUpdatedAt) ||
    !Array.isArray(data.recipes) || data.recipes.length > 1000 ||
    !Array.isArray(data.logs) || data.logs.length > 20000) reject('同步数据超过限制或缺少宝宝称呼。');
  const recipeIds = new Set();
  data.recipes.forEach(recipe => {
    if (!keys(recipe, ['id', 'name', 'category', 'minutes', 'texture', 'ingredients', 'steps', 'note', 'photo',
      'imageKey', 'favorite', 'isExample', 'createdAt', 'updatedAt', 'source', 'ageGroups']) ||
      !nonempty(recipe.id, 100) || recipeIds.has(recipe.id) || !nonempty(recipe.name, 60) ||
      !CATEGORIES.includes(recipe.category) || !TEXTURES.includes(recipe.texture) ||
      !Number.isFinite(recipe.minutes) || recipe.minutes < 1 || recipe.minutes > 480 ||
      !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 50 ||
      !recipe.ingredients.every(item => keys(item, ['name', 'amount']) && nonempty(item.name, 80) && string(item.amount, 80)) ||
      !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 30 ||
      !recipe.steps.every(step => nonempty(step, 2000)) ||
      !optionalString(recipe.note, 2000) || !optionalString(recipe.imageKey, 40) ||
      !optionalBoolean(recipe.favorite) || !optionalBoolean(recipe.isExample) ||
      !optionalTime(recipe.createdAt) || !optionalTime(recipe.updatedAt)) reject('菜谱信息不完整或超过限制。');
    if (recipe.source != null && (!keys(recipe.source, ['profileId', 'recipeId', 'authorName']) ||
      !/^[a-f0-9]{32}$/.test(recipe.source.profileId || '') ||
      !/^[a-f0-9]{64}$/.test(recipe.source.recipeId || '') || !nonempty(recipe.source.authorName, 30))) {
      reject('菜谱来源信息不正确。');
    }
    if (recipe.photo !== '' && !ownedFile(recipe.photo, env, owner, 'photos')) {
      reject('菜谱照片必须属于当前微信账号的云端照片。');
    }
    const ageGroups = normalizeAgeGroups(recipe.ageGroups);
    if (ageGroups !== undefined) recipe.ageGroups = ageGroups;
    recipeIds.add(recipe.id);
  });
  const logIds = new Set();
  data.logs.forEach(log => {
    if (!keys(log, ['id', 'recipeId', 'rating', 'date', 'portion', 'note', 'createdAt', 'updatedAt']) ||
      !nonempty(log.id, 100) || logIds.has(log.id) || !recipeIds.has(log.recipeId) ||
      ![1, 2, 3].includes(log.rating) || !validDate(log.date, now) ||
      !optionalString(log.portion, 40) || !optionalString(log.note, 500) ||
      !optionalTime(log.createdAt) || !optionalTime(log.updatedAt)) reject('用餐记录缺少有效菜谱、喜好或日期。');
    logIds.add(log.id);
  });
  for (const kind of ['recipes', 'logs']) {
    const entries = snapshot.deleted[kind];
    if (!Array.isArray(entries) || entries.length > (kind === 'recipes' ? 10000 : 100000)) reject('删除记录超过同步限制。');
    const ids = new Set();
    entries.forEach(entry => {
      if (!keys(entry, ['id', 'updatedAt']) || !nonempty(entry.id, 100) || ids.has(entry.id) || !timestamp(entry.updatedAt)) {
        reject('删除记录格式不正确。');
      }
      ids.add(entry.id);
    });
  }
  return snapshot;
}

module.exports = {MAX_SNAPSHOT_BYTES, ownedFile, validateSnapshot, normalizeAgeGroups, reject};
