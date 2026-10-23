'use strict';

const seed = require('../data/recipes');
const selectors = require('./selectors');
const {normalizeCategory} = require('./categories');
const {mergeSnapshots} = require('./sync-merge');
const STORAGE_KEY = 'baby-bites-v1';
const ACTIVE_OWNER_KEY = 'baby-bites-active-owner';
const ACCOUNT_PREFIX = 'baby-bites-account-';
const validOwner = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
let owner = null;
let sync = freshSync();
let legacyClaim = null;
let pendingMigrationOwner = null;
const listeners = new Set();
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
  if (photo.indexOf('cloud://') === 0) {
    return /^cloud:\/\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._~!$&'()+,;=:@%/-]+$/.test(photo) &&
      !photo.split('/').some(part => part === '.' || part === '..') && !/%(?:2e|2f|5c)/i.test(photo);
  }
  // wx.saveFile / USER_DATA_PATH paths on devices and the developer tool.
  return /^wxfile:\/\/(?:usr(?:\/|$)|store(?:_|\/))/.test(photo) ||
    /^https?:\/\/(?:usr|store)(?:\/|_)/.test(photo) || /^\/usr\//.test(photo);
}

function validSource(source) {
  return source == null || (isObject(source) && Object.keys(source).every(key => ['profileId', 'recipeId', 'authorName'].includes(key)) &&
    typeof source.profileId === 'string' && /^[a-f0-9]{32}$/.test(source.profileId) &&
    typeof source.recipeId === 'string' && /^[a-f0-9]{64}$/.test(source.recipeId) &&
    validString(source.authorName, 30) && source.authorName.trim() && !/[\u0000-\u001f]/.test(source.authorName));
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
    const category = isObject(recipe) ? normalizeCategory(recipe.category, recipe.name) : null;
    if (!isObject(recipe) || !validString(recipe.id, 100) || !recipe.id.trim() || recipeIds.has(recipe.id) ||
      !validString(recipe.name, 60) || !recipe.name.trim() || !category ||
      !selectors.textures.includes(recipe.texture) || !Number.isFinite(recipe.minutes) || recipe.minutes < 1 || recipe.minutes > 480 ||
      !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 50 ||
      !recipe.ingredients.every(item => isObject(item) && validString(item.name, 80) && item.name.trim() && validString(item.amount, 80)) ||
      !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 30 ||
      !recipe.steps.every(step => validString(step, 2000) && step.trim()) ||
      (recipe.note != null && !validString(recipe.note, 2000)) ||
      (recipe.imageKey != null && !validString(recipe.imageKey, 40)) ||
      (recipe.favorite != null && typeof recipe.favorite !== 'boolean') ||
      (recipe.isExample != null && typeof recipe.isExample !== 'boolean') ||
      !validSource(recipe.source) ||
      !validTimestamp(recipe.createdAt) || !validTimestamp(recipe.updatedAt)) {
      fail('菜谱信息不完整：请检查名称、分类、用时、食材和制作步骤。');
    }
    if (!validPhoto(recipe.photo)) fail('照片必须是本机或云端保存的图片，请重新选择并保存照片。');
    recipeIds.add(recipe.id);
    return {
      id: recipe.id, name: recipe.name.trim(), category, minutes: recipe.minutes,
      texture: recipe.texture, ingredients: recipe.ingredients.map(item => ({name: item.name.trim(), amount: item.amount.trim()})),
      steps: recipe.steps.map(step => step.trim()), note: recipe.note || '', photo: recipe.photo || '',
      imageKey: recipe.imageKey || '', favorite: Boolean(recipe.favorite), isExample: Boolean(recipe.isExample),
      createdAt: recipe.createdAt || 0, updatedAt: recipe.updatedAt || 0,
      ...(recipe.source ? {source: {profileId: recipe.source.profileId, recipeId: recipe.source.recipeId,
        authorName: recipe.source.authorName.trim()}} : {})
    };
  });
  const logIds = new Set();
  const logs = data.logs.map(log => {
    if (!isObject(log) || !validString(log.id, 100) || !log.id.trim() || logIds.has(log.id) ||
      !recipeIds.has(log.recipeId) || ![1, 2, 3].includes(log.rating) || !validDate(log.date) ||
      (log.note != null && !validString(log.note, 500)) || (log.portion != null && !validString(log.portion, 40)) ||
      !validTimestamp(log.createdAt) || !validTimestamp(log.updatedAt)) fail('用餐记录不完整：请检查对应菜谱、本次喜好和用餐日期。');
    logIds.add(log.id);
    return {id: log.id, recipeId: log.recipeId, rating: log.rating, date: log.date,
      portion: log.portion || '', note: log.note || '', createdAt: log.createdAt || 0, updatedAt: log.updatedAt || 0};
  });
  return {version: 1, nickname: nickname.trim(), profileUpdatedAt: data.profileUpdatedAt || 0, recipes, logs};
}

function freshSync() {
  return {sequence: 0, revision: 0, dirty: false, hasLocalData: false,
    deleted: {recipes: [], logs: []}, migratedLegacy: false};
}

function emptyState() { return {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []}; }
function readValue(key) {
  const raw = wx.getStorageSync(key);
  return raw === '' || raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
}
function validateDeleted(deleted) {
  if (!isObject(deleted) || !Array.isArray(deleted.recipes) || !Array.isArray(deleted.logs)) fail('云同步删除记录格式不正确。');
  const clean = {};
  ['recipes', 'logs'].forEach(type => {
    const ids = new Set();
    clean[type] = deleted[type].map(item => {
      if (!isObject(item) || !validString(item.id, 100) || !item.id.trim() || ids.has(item.id) ||
        !Number.isFinite(item.updatedAt) || item.updatedAt < 0) fail('云同步删除记录格式不正确。');
      ids.add(item.id);
      return {id: item.id, updatedAt: item.updatedAt};
    });
  });
  return clean;
}
function validateSnapshot(snapshot) {
  if (!isObject(snapshot) || snapshot.version !== 1) fail('云同步数据版本不正确。');
  return {version: 1, data: validateData(snapshot.data), deleted: validateDeleted(snapshot.deleted)};
}
function validateSync(value, fallbackHasData) {
  if (value == null) return Object.assign(freshSync(), {dirty: Boolean(fallbackHasData), hasLocalData: Boolean(fallbackHasData)});
  if (!isObject(value) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.dirty !== 'boolean' ||
    typeof value.hasLocalData !== 'boolean' || typeof value.migratedLegacy !== 'boolean') fail('账号同步缓存格式不正确。');
  return {sequence: value.sequence, revision: value.revision, dirty: value.dirty,
    hasLocalData: value.hasLocalData, migratedLegacy: value.migratedLegacy, deleted: validateDeleted(value.deleted)};
}
function readAccount(value) {
  if (!isObject(value) || value.version !== 1 || !value.__sync) fail('账号缓存格式不正确，原数据未被覆盖。');
  return {data: validateData(value.data), sync: validateSync(value.__sync, true)};
}
function notify() {
  listeners.forEach(listener => { try { listener(getSyncInfo()); } catch (error) { /* Storage success is independent of observers. */ } });
}
function subscribe(listener) {
  if (typeof listener !== 'function') fail('监听器必须是函数。');
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function storageValue(data, metadata, targetOwner) {
  if (targetOwner) return {version: 1, data, __sync: metadata};
  return Object.assign({}, data, {__sync: metadata}, legacyClaim ? {__syncMigratedTo: legacyClaim} : {});
}
function writeState(data, metadata, targetOwner) {
  try { wx.setStorageSync(targetOwner ? ACCOUNT_PREFIX + targetOwner : STORAGE_KEY, storageValue(data, metadata, targetOwner)); }
  catch (error) { fail('保存失败：本机存储空间不足或暂时不可用。已有记录未改变，请备份后重试。'); }
}
function init() {
  if (state) return clone(state);
  try {
    const active = wx.getStorageSync(ACTIVE_OWNER_KEY);
    if (active !== '' && active != null) {
      if (!validOwner(active)) fail('账号指针不正确。');
      owner = active;
      const cached = readAccount(readValue(ACCOUNT_PREFIX + owner));
      state = cached.data;
      sync = cached.sync;
    } else {
      const saved = readValue(STORAGE_KEY);
      if (saved && saved.__syncMigratedTo != null) {
        if (!validOwner(saved.__syncMigratedTo)) fail('账号归属记录不正确。');
        legacyClaim = saved.__syncMigratedTo;
        fail('账号指针丢失，请连接网络重新确认微信账号。');
      }
      // If a prior multi-key migration was interrupted, do not treat the local
      // examples as a new account's upload. bindAccount can recover its cache.
      if (typeof wx.getStorageInfoSync === 'function') {
        const info = wx.getStorageInfoSync();
        if (info && Array.isArray(info.keys) && info.keys.some(key => key.indexOf(ACCOUNT_PREFIX) === 0)) {
          fail('账号指针丢失，请连接网络重新确认微信账号。');
        }
      }
      state = saved == null ? freshState() : validateData(saved);
      sync = validateSync(saved && saved.__sync, saved != null);
    }
  } catch (error) {
    state = freshState();
    readBlocked = true;
    warning = '未能读取本机记录，原数据未被覆盖。当前显示示例菜谱，请连接网络确认账号或导入有效备份后再保存。';
  }
  return clone(state);
}

function getState() { init(); return clone(state); }
function getWarning() { init(); return warning; }
function getRecipe(recipeId) { init(); const recipe = state.recipes.find(item => item.id === recipeId); return recipe ? clone(recipe) : null; }
function getLog(logId) { init(); const log = state.logs.find(item => item.id === logId); return log ? clone(log) : null; }
function getSyncInfo() {
  init();
  return {owner, sequence: sync.sequence, revision: sync.revision, dirty: sync.dirty,
    hasLocalData: sync.hasLocalData, blocked: readBlocked};
}
function getSyncSnapshot() {
  init();
  if (readBlocked) fail(warning);
  return clone({version: 1, data: sync.hasLocalData ? state : emptyState(), deleted: sync.deleted});
}

function bindAccount(nextOwner) {
  if (!validOwner(nextOwner)) fail('微信账号标识不正确，请重新登录。');
  init();
  if (pendingMigrationOwner && pendingMigrationOwner !== nextOwner) fail('请先完成之前账号的数据迁移，避免数据归属错误。');
  if (owner === nextOwner && !readBlocked) return getSyncInfo();
  let target;
  let legacy = null;
  let shouldClaim = false;
  try {
    const saved = readValue(ACCOUNT_PREFIX + nextOwner);
    target = saved == null ? null : readAccount(saved);
    // An existing account with no pending legacy migration does not depend on
    // unrelated legacy data being readable.
    if (!target || target.sync.migratedLegacy) legacy = readValue(STORAGE_KEY);
    const claim = legacy && legacy.__syncMigratedTo;
    if (!target && readBlocked && !owner && !claim) fail(warning);
    if (claim != null && !validOwner(claim)) fail('原数据的账号归属记录损坏，请先恢复备份。');
    if (legacy && !claim && (!target || target.sync.migratedLegacy)) {
      const legacyData = validateData(legacy);
      const legacySync = validateSync(legacy.__sync, true);
      const incoming = {version: 1, data: legacyData, deleted: legacySync.deleted};
      const snapshot = target ? mergeSnapshots({version: 1, data: target.data, deleted: target.sync.deleted}, incoming) : incoming;
      target = {data: validateData(snapshot.data), sync: Object.assign(target ? target.sync : freshSync(), {
        dirty: true, hasLocalData: true, deleted: snapshot.deleted, migratedLegacy: true
      })};
      shouldClaim = true;
    } else if (!target) {
      if (claim === nextOwner || (owner === nextOwner && readBlocked)) fail('当前账号的本机缓存丢失，请恢复备份后重试。');
      if (readBlocked && !claim && !owner) fail(warning);
      target = {data: freshState(), sync: freshSync()};
    }
    // Data first, migration claim second, active pointer last. Memory changes
    // only after all writes succeed; a retry can recover a partial migration.
    wx.setStorageSync(ACCOUNT_PREFIX + nextOwner, storageValue(target.data, target.sync, nextOwner));
    if (shouldClaim) pendingMigrationOwner = nextOwner;
    if (shouldClaim) wx.setStorageSync(STORAGE_KEY, Object.assign({}, legacy, {__syncMigratedTo: nextOwner}));
    wx.setStorageSync(ACTIVE_OWNER_KEY, nextOwner);
  } catch (error) {
    fail('账号数据未切换，原数据已保留。' + (error.message || '请检查本机存储后重试。'));
  }
  pendingMigrationOwner = null;
  state = target.data;
  sync = target.sync;
  owner = nextOwner;
  warning = '';
  readBlocked = false;
  notify();
  return getSyncInfo();
}

function commit(mutator, recover) {
  init();
  if (readBlocked && !recover) fail(warning);
  if (!owner) {
    let persisted;
    try { persisted = readValue(STORAGE_KEY); } catch (error) { if (!recover) fail(warning || '未能读取本机记录，原数据未被覆盖。'); }
    if (persisted && persisted.__syncMigratedTo) fail('本机数据已绑定微信账号，请重新同步后再保存。');
  }
  const next = clone(state);
  mutator(next);
  const validated = validateData(next);
  const nextSync = clone(sync);
  nextSync.sequence += 1;
  nextSync.dirty = true;
  nextSync.hasLocalData = true;
  ['recipes', 'logs'].forEach(type => {
    const ids = new Set(validated[type].map(item => item.id));
    const tombstones = new Map(nextSync.deleted[type].map(item => [item.id, item]));
    state[type].forEach(item => {
      if (!ids.has(item.id)) {
        const old = tombstones.get(item.id);
        tombstones.set(item.id, {id: item.id, updatedAt: timestamp(Math.max(item.updatedAt || item.createdAt || 0, old ? old.updatedAt : 0))});
      }
    });
    nextSync.deleted[type] = Array.from(tombstones.values());
  });
  writeState(validated, nextSync, owner);
  state = validated;
  sync = nextSync;
  warning = '';
  readBlocked = false;
  notify();
}

function applySyncedSnapshot(snapshot, options) {
  init();
  if (readBlocked || !owner) fail(readBlocked ? warning : '请先确认微信账号。');
  if (!isObject(options) || !Number.isSafeInteger(options.sequence) || options.sequence < 0 ||
    !Number.isSafeInteger(options.revision) || options.revision < 0) fail('同步版本不正确。');
  if (options.owner && options.owner !== owner) fail('微信账号已切换，请重新同步。');
  if (options.revision < sync.revision) return false;
  const incoming = validateSnapshot(snapshot);
  const editedDuringSync = options.sequence !== sync.sequence;
  const merged = editedDuringSync ? mergeSnapshots(getSyncSnapshot(), incoming) : incoming;
  const validated = validateData(merged.data);
  const nextSync = Object.assign({}, sync, {revision: options.revision, dirty: editedDuringSync,
    hasLocalData: true, deleted: merged.deleted});
  writeState(validated, nextSync, owner);
  state = validated;
  sync = nextSync;
  notify();
  return true;
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

function addPublicRecipe(input, expectedOwner) {
  init();
  if (!validOwner(expectedOwner) || owner !== expectedOwner) fail('微信账号已切换，请重新打开这道菜谱。');
  if (!isObject(input) || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) fail('这道公开菜谱的信息不完整。');
  const recipeId = 'shared-' + input.id;
  if (getRecipe(recipeId)) return {recipeId, added: false};
  const deletion = sync.deleted.recipes.find(item => item.id === recipeId);
  const now = timestamp(deletion && deletion.updatedAt);
  const recipe = {
    id: recipeId, name: input.name, category: input.category, minutes: input.minutes, texture: input.texture,
    ingredients: input.ingredients, steps: input.steps, imageKey: input.imageKey || '', photo: input.photo || '',
    source: {profileId: input.profileId, recipeId: input.id, authorName: input.authorName},
    note: '', favorite: false, isExample: false, createdAt: now, updatedAt: now
  };
  // The stable ID prevents a repeated tap (or another device) from creating a
  // second copy. A deliberate re-add advances beyond a known deletion.
  commit(next => { next.recipes.unshift(recipe); });
  return {recipeId, added: true};
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

function updateLog(logId, input) {
  const existing = getLog(logId);
  if (!existing) fail('这条用餐记录已经不存在了。');
  if (!isObject(input)) fail('请填写用餐记录。');
  if (input.recipeId && input.recipeId !== existing.recipeId) fail('不能更换这条记录对应的菜谱。');
  const updated = Object.assign({}, existing, {
    rating: Number(input.rating), date: input.date,
    portion: input.portion == null ? '' : input.portion,
    note: input.note == null ? '' : input.note,
    updatedAt: timestamp(existing.updatedAt)
  });
  commit(next => { next.logs = next.logs.map(log => log.id === logId ? updated : log); });
  return logId;
}

function deleteLog(logId) {
  init();
  if (!state.logs.some(log => log.id === logId)) fail('这条用餐记录已经不存在了。');
  commit(next => { next.logs = next.logs.filter(log => log.id !== logId); });
  return true;
}

function setNickname(value) {
  const nickname = typeof value === 'string' ? value.trim() : '';
  if (!nickname || nickname.length > 20) fail('宝宝称呼请填写 1–20 个字。');
  commit(next => { next.nickname = nickname; next.profileUpdatedAt = timestamp(next.profileUpdatedAt); });
  return nickname;
}

function importBackup(text, options) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) fail('备份内容为空或超过 5 MB，请选择有效的备份。');
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { fail('这个文件不是有效的 JSON 备份。'); }
  const incoming = validateData(parsed);
  // Only the portable importer may request repair after a failed local-file read.
  // Re-check the exact recipe at commit time so asynchronous file work cannot
  // replace a photo or edit made since that availability check.
  const repairs = new Map(options && Array.isArray(options.repairMissingPhotos) ?
    options.repairMissingPhotos.map(item => [item.id, item.photo]) : []);
  const sameExceptPhoto = (a, b) => {
    const keys = Object.keys(a).filter(key => key !== 'photo').sort();
    return JSON.stringify(keys.map(key => [key, a[key]])) ===
      JSON.stringify(Object.keys(b).filter(key => key !== 'photo').sort().map(key => [key, b[key]]));
  };
  const summary = {addedRecipes: 0, updatedRecipes: 0, addedLogs: 0};
  commit(next => {
    const deletedRecipes = new Map(sync.deleted.recipes.map(item => [item.id, item]));
    const deletedLogs = new Map(sync.deleted.logs.map(item => [item.id, item]));
    const restoreKnownDeletion = (item, tombstones) => {
      const deletion = tombstones.get(item.id);
      if (!deletion) return item;
      // Import is an explicit restoration only for a deletion this device has
      // already observed. Keep its tombstone for older devices, and advance the
      // restored version so the next sync cannot immediately delete it again.
      return Object.assign({}, item, {updatedAt: timestamp(Math.max(deletion.updatedAt, item.updatedAt || item.createdAt || 0))});
    };
    const recipes = new Map(next.recipes.map(recipe => [recipe.id, recipe]));
    incoming.recipes.forEach(recipe => {
      const local = recipes.get(recipe.id);
      if (!local) { recipes.set(recipe.id, restoreKnownDeletion(recipe, deletedRecipes)); summary.addedRecipes += 1; }
      else if (recipe.updatedAt > local.updatedAt) { recipes.set(recipe.id, recipe); summary.updatedRecipes += 1; }
      else if (recipe.photo && recipe.photo !== local.photo && local.photo && local.photo.indexOf('cloud://') !== 0 &&
        repairs.get(recipe.id) === local.photo && recipe.updatedAt === local.updatedAt && sameExceptPhoto(recipe, local)) {
        recipes.set(recipe.id, Object.assign({}, local, {photo: recipe.photo, updatedAt: timestamp(local.updatedAt)}));
        summary.updatedRecipes += 1;
      }
    });
    next.recipes = Array.from(recipes.values());
    const logs = new Map(next.logs.map(log => [log.id, log]));
    incoming.logs.forEach(log => {
      const local = logs.get(log.id);
      if (!local) { logs.set(log.id, restoreKnownDeletion(log, deletedLogs)); summary.addedLogs += 1; }
      else if (log.recipeId === local.recipeId && log.updatedAt > local.updatedAt) logs.set(log.id, log);
    });
    next.logs = Array.from(logs.values());
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
  STORAGE_KEY, init, getState, getWarning, getRecipe, getLog, saveRecipe, deleteRecipe, addPublicRecipe,
  toggleFavorite, addLog, updateLog, deleteLog, setNickname, importBackup, exportBackup,
  ACTIVE_OWNER_KEY, ACCOUNT_PREFIX, bindAccount, getSyncSnapshot, getSyncInfo, applySyncedSnapshot,
  subscribe, validateData, validateSnapshot
};
