'use strict';

const config = require('../config/cloud');
const store = require('./store');
const cloudSync = require('./cloud-sync');
const {withCover} = require('./recipe-covers');
const coverLoader = require('./cover-loader');
const {isValidBirthDate} = require('./baby-age');
const {normalizeAgeGroups} = require('./recipe-ages');
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const imports = new Map();
const READ_TTL = 30 * 1000;
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const readCache = new Map();
const readFlights = new Map();
let cacheBytes = 0;
let readVersion = 0;
let identity = null;
let identityFlight = null;
let identityRejected = false;
let fileSequence = 0;
let observedOwner = store.getSyncInfo().owner;
let observedRevision = store.getSyncInfo().revision;
let observedPublication = 0;
let observedIdentityInvalid = false;
let ownerEpoch = 0;
function invalidateReads() {
  readVersion += 1;
  readCache.clear();
  cacheBytes = 0;
}
function forgetIdentity(rejected = false) { identity = null; identityFlight = null; identityRejected = rejected; invalidateReads(); }
store.subscribe(info => {
  if (info.owner !== observedOwner) {
    observedOwner = info.owner; ownerEpoch += 1;
    observedRevision = info.revision; observedPublication = 0; observedIdentityInvalid = false;
    forgetIdentity();
  }
});
if (typeof cloudSync.subscribe === 'function') cloudSync.subscribe(status => {
  if (status.owner !== observedOwner) return;
  if (status.identityInvalid === true && !observedIdentityInvalid) forgetIdentity(true);
  observedIdentityInvalid = status.identityInvalid === true;
  let changed = false;
  if (Number.isSafeInteger(status.revision) && status.revision !== observedRevision) {
    observedRevision = status.revision; changed = true;
  }
  if (Number.isSafeInteger(status.publicationVersion) && status.publicationVersion !== observedPublication) {
    observedPublication = status.publicationVersion; changed = true;
  }
  if (changed) invalidateReads();
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const profileId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function fail(message, code) {
  const error = new Error(message);
  error.code = code || 'SOCIAL_ERROR';
  error.userMessage = message;
  throw error;
}
function requireEnabled() {
  if (config.socialEnabled !== true) fail('好友功能正在准备中，请稍后再试。', 'SOCIAL_UNAVAILABLE');
}
function assertOwner(session) {
  if (!session || !session.id || store.getSyncInfo().owner !== session.id || ownerEpoch !== session.epoch) {
    fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED');
  }
}
function call(target, method, options) {
  return new Promise((resolve, reject) => {
    try {
      if (!target || typeof target[method] !== 'function') return reject(Error('API unavailable'));
      target[method](Object.assign({}, options, {success: resolve, fail: reject}));
    } catch (error) { reject(error); }
  });
}
async function ready() {
  requireEnabled();
  const previous = store.getSyncInfo().owner;
  const previousEpoch = ownerEpoch;
  const status = await cloudSync.syncNow();
  const current = store.getSyncInfo();
  if ((previous && (current.owner !== previous || ownerEpoch !== previousEpoch)) ||
    (!previous && ownerEpoch > previousEpoch + 1)) fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED');
  if (!status || status.state !== 'synced' || !current.owner || status.owner !== current.owner || current.blocked) {
    fail(status && status.message || '请先联网同步当前微信账号，再使用好友功能。', 'SYNC_REQUIRED');
  }
  return {id: current.owner, epoch: ownerEpoch};
}
const errors = {
  ACCOUNT_CHANGED: '微信账号已切换，请重新打开当前页面。',
  UNAUTHENTICATED: '未能识别当前微信账号，请在微信中重试。',
  INVALID_ENV: '好友功能暂未配置完成，请稍后重试。',
  NOT_FOUND: '这份内容已取消公开，或暂时无法查看。',
  PROFILE_NOT_FOUND: '这个主页暂时无法查看。',
  RECIPE_NOT_FOUND: '这道菜谱已取消公开，或暂时无法查看。',
  NOT_PUBLIC: '这道菜谱已取消公开，或暂时无法查看。',
  INVALID_PROFILE: '公开昵称请填写 1–20 个字，简介不超过 120 个字。',
  PROFILE_NAME_REJECTED: '昵称未通过内容审核，请修改后重试。',
  PROFILE_BIO_REJECTED: '简介未通过内容审核，请修改后重试。',
  PROFILE_MODERATION_UNAVAILABLE: '内容审核暂时不可用，资料尚未保存，请稍后重试。',
  INVALID_BABY_AGE: '宝宝月龄请填写 0–120 之间的整数，留空可取消展示。',
  INVALID_BABY_BIRTH_DATE: '请选择有效的宝宝生日，不能晚于今天。',
  INVALID_INPUT: '信息不完整，请刷新页面后重试。',
  INVALID_REQUEST: '信息不完整，请刷新页面后重试。',
  INVALID_ACCOUNT: '暂时无法确认当前账号，请重新打开页面。',
  CONFLICT: '资料已发生变化，请刷新页面后重试。',
  SELF_FOLLOW: '这是你自己的主页，无需关注。',
  FOLLOW_LIMIT: '关注人数已达到上限，请整理后重试。',
  PROFILE_REQUIRED: '请先设置公开主页，再公开菜谱或分享主页。',
  SYNC_REQUIRED: '请先完成菜谱同步，再公开这道菜谱。',
  SOURCE_NOT_FOUND: '这道菜谱还未同步，或已被删除，请返回食谱后重试。',
  INVALID_SNAPSHOT: '菜谱尚未完整同步，请完成同步后重试。',
  INVALID_PHOTO: '这张照片暂时无法公开，请重新选择照片并同步后重试。',
  STORAGE_ERROR: '照片暂时无法读取，请稍后重试。',
  STORAGE_FAILED: '照片暂时无法读取，请稍后重试。',
  SHARE_CODE_UNAVAILABLE: '分享码暂不可用，可以先发送主页给朋友。',
  SHARE_CODE_FAILED: '分享码暂时生成失败，可以重试或先发送主页给朋友。',
  SHARE_CODE_NOT_PUBLISHED: '正式版主页尚未发布，暂时无法生成正式版分享码。'
};
async function request(action, data, owner) {
  assertOwner(owner);
  let response;
  try {
    response = await call(wx.cloud, 'callFunction', {name: 'babyBitesSocial',
      config: {env: config.env}, data: Object.assign({}, data, {action, expectedOwner: owner.id})});
  } catch (_) {
    assertOwner(owner);
    fail('好友功能暂时连接不上，请检查网络后重试。', 'NETWORK');
  }
  assertOwner(owner);
  const result = response && response.result;
  if (!object(result)) fail('好友功能返回的信息不完整，请稍后重试。');
  if (result.error) {
    const code = result.error.code;
    if (code === 'ACCOUNT_CHANGED' || code === 'UNAUTHENTICATED') forgetIdentity(true);
    else if (['NOT_FOUND', 'RECIPE_NOT_FOUND', 'NOT_PUBLIC', 'PROFILE_NOT_FOUND'].includes(code)) invalidateReads();
    const message = action === 'follow' && code === 'PROFILE_REQUIRED'
      ? '关注暂时未完成，请稍后重试。' : errors[code] || '操作暂未完成，请稍后重试。';
    fail(message, code);
  }
  // Public artwork sources are presentation-only. Individual ready sources can
  // render while other covers load; copying still reads only the author's photoURL.
  if (object(result.recipe) || Array.isArray(result.recipes)) {
    Promise.resolve().then(() => coverLoader.prepare()).catch(() => {});
    if (object(result.recipe)) result.recipe = withCover(result.recipe);
    if (Array.isArray(result.recipes)) result.recipes = result.recipes.map(withCover);
  }
  return result;
}
async function readyIdentity(reuse = false) {
  requireEnabled();
  // Existing account caches can withdraw a public recipe even if an unrelated
  // private photo blocks snapshot upload. Identity still comes from WeChat.
  if (!store.getSyncInfo().owner) {
    const startEpoch = ownerEpoch;
    await cloudSync.syncNow();
    if (ownerEpoch > startEpoch + 1) fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED');
  }
  const info = store.getSyncInfo();
  const session = {id: info.owner, epoch: ownerEpoch};
  if (!session.id || info.blocked) fail('请先联网确认当前微信账号，再使用好友功能。', 'SYNC_REQUIRED');
  if (!config.env || !wx.cloud || typeof wx.cloud.init !== 'function') fail('好友功能暂未配置完成，请稍后重试。');
  wx.cloud.init({env: config.env, traceUser: false});
  if (reuse) {
    const status = typeof cloudSync.getStatus === 'function' ? cloudSync.getStatus() : null;
    const checkedAt = Math.max(identity && identity.id === session.id && identity.epoch === session.epoch ? identity.checkedAt : 0,
      status && status.owner === session.id ? status.identityCheckedAt || 0 : 0);
    const age = Date.now() - checkedAt;
    if (!identityRejected && !(status && status.identityInvalid) && checkedAt > 0 && age >= 0 && age < READ_TTL) return session;
    if (identityFlight && identityFlight.id === session.id && identityFlight.epoch === session.epoch) {
      await identityFlight.work;
      assertOwner(session);
      return session;
    }
  }
  const work = verifyIdentity(session);
  const flight = {id: session.id, epoch: session.epoch, work};
  if (reuse) identityFlight = flight;
  try { await work; return session; }
  finally { if (identityFlight === flight) identityFlight = null; }
}
async function verifyIdentity(session) {
  let response;
  try {
    assertOwner(session);
    response = await call(wx.cloud, 'callFunction', {name: config.functionName || 'babyBitesSync',
      config: {env: config.env}, data: {action: 'identity'}});
  } catch (error) {
    assertOwner(session);
    fail('未能确认当前微信账号，请检查网络后重试。', 'NETWORK');
  }
  assertOwner(session);
  const result = response && response.result;
  if (!result || result.error || typeof result.owner !== 'string' || !/^[a-f0-9]{64}$/.test(result.owner)) {
    forgetIdentity(true);
    fail('未能确认当前微信账号，请联网重试。', 'SYNC_REQUIRED');
  }
  if (result.owner !== session.id) { forgetIdentity(true); fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED'); }
  identity = {id: session.id, epoch: session.epoch, checkedAt: Date.now()};
  identityRejected = false;
}
async function invoke(action, data) { return request(action, data, await readyIdentity()); }
function removeCached(key) {
  const entry = readCache.get(key);
  if (entry) { cacheBytes -= entry.bytes; readCache.delete(key); }
}
function cacheResult(key, result) {
  const json = JSON.stringify(result), bytes = json.length * 2;
  removeCached(key);
  if (bytes > MAX_CACHE_BYTES) return;
  const now = Date.now();
  for (const [oldKey, entry] of readCache) {
    if (now >= entry.expiresAt) removeCached(oldKey);
  }
  while (readCache.size >= MAX_CACHE_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) {
    removeCached(readCache.keys().next().value);
  }
  readCache.set(key, {json, bytes, expiresAt: now + READ_TTL});
  cacheBytes += bytes;
}
function readCopy(result) {
  // Each caller owns its view data; cover sources can become ready independently.
  const value = JSON.parse(JSON.stringify(result));
  if (object(value.recipe)) value.recipe = withCover(value.recipe);
  if (Array.isArray(value.recipes)) value.recipes = value.recipes.map(withCover);
  return value;
}
async function read(action, data, options = {}, cacheable = true) {
  const owner = await readyIdentity(true);
  assertOwner(owner);
  const version = readVersion;
  const key = owner.epoch + ':' + version + ':' + action + ':' + JSON.stringify(data || {});
  const entry = readCache.get(key);
  if (cacheable && !options.force && entry && Date.now() < entry.expiresAt) return readCopy(JSON.parse(entry.json));
  if (entry && Date.now() >= entry.expiresAt) removeCached(key);
  let work = readFlights.get(key);
  if (!work) {
    work = request(action, data, owner);
    readFlights.set(key, work);
  }
  let result;
  try { result = await work; }
  finally { if (readFlights.get(key) === work) readFlights.delete(key); }
  assertOwner(owner);
  // A write or automatic publication completed while this read was in flight.
  // Never let the older response repopulate the cache or overwrite the new view.
  if (version !== readVersion) return read(action, data, options, cacheable);
  if (cacheable) cacheResult(key, result);
  return readCopy(result);
}
async function mutate(action, data, owner) {
  invalidateReads();
  try { return await (owner ? request(action, data, owner) : invoke(action, data)); }
  finally { invalidateReads(); }
}
function getReadVersion() { return readVersion; }
function checkProfileId(value) { if (!profileId(value)) fail('主页地址不正确，请重新打开好友分享的主页。', 'INVALID_INPUT'); }
function checkRecipeId(value) { if (!publicId(value)) fail('菜谱地址不正确，请重新打开这道菜谱。', 'INVALID_INPUT'); }
function offset(value) {
  const result = value == null ? 0 : value;
  if (!Number.isSafeInteger(result) || result < 0) fail('分页信息不正确，请刷新页面。', 'INVALID_INPUT');
  return result;
}
function getMine(options) { return read('mine', undefined, options); }
function saveProfile(input) {
  if (!object(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 20 ||
    typeof input.bio !== 'string' || input.bio.trim().length > 120 || /[\u0000-\u001f]/.test(input.name + input.bio)) {
    fail(errors.INVALID_PROFILE, 'INVALID_PROFILE');
  }
  const profile = {name: input.name.trim(), bio: input.bio.trim()};
  if (Object.prototype.hasOwnProperty.call(input, 'babyAgeMonths')) {
    const age = input.babyAgeMonths;
    if (age !== null && (!Number.isSafeInteger(age) || age < 0 || age > 120)) {
      fail(errors.INVALID_BABY_AGE, 'INVALID_BABY_AGE');
    }
    profile.babyAgeMonths = age;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'babyBirthDate')) {
    const birthDate = input.babyBirthDate;
    if (birthDate !== null && !isValidBirthDate(birthDate)) {
      fail(errors.INVALID_BABY_BIRTH_DATE, 'INVALID_BABY_BIRTH_DATE');
    }
    profile.babyBirthDate = birthDate;
  }
  return mutate('updateProfile', profile);
}
function getProfile(id, start, options) { checkProfileId(id); return read('profile', {profileId: id, offset: offset(start)}, options); }
function getProfileSummary(id, options) { checkProfileId(id); return read('profileSummary', {profileId: id}, options); }
function getRecipe(id) { checkRecipeId(id); return read('recipe', {recipeId: id}, {}, false); }
async function publishRecipe(sourceRecipeId) {
  let owner = await ready();
  const recipe = store.getRecipe(sourceRecipeId);
  if (recipe && recipe.isExample) {
    // Publishing is an explicit action: make this selected example a personal
    // recipe so its authoritative snapshot exists before publishing it.
    store.saveRecipe(recipe);
    assertOwner(owner);
    const synced = await ready();
    assertOwner(owner);
    owner = synced;
  }
  const info = store.getSyncInfo();
  if (info.dirty || !store.getRecipe(sourceRecipeId)) fail('请先保存并同步这道菜谱，再公开。', 'SYNC_REQUIRED');
  return mutate('publish', {sourceRecipeId}, owner);
}
function unpublishRecipe(sourceRecipeId) { return mutate('unpublish', {sourceRecipeId}); }
function setFollowing(id, following) {
  checkProfileId(id);
  if (typeof following !== 'boolean') fail('关注状态不正确，请重试。', 'INVALID_INPUT');
  return mutate('follow', {profileId: id, following});
}
function getFollowing(start, options) { return read('following', {offset: offset(start)}, options); }
function getFollowers(start, options) { return read('followers', {offset: offset(start)}, options); }
function getFeed(cursor, options) { return read('feed', cursor == null ? {} : {cursor}, options); }
function getDiscover(input = {}) {
  if (!object(input) || (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 60)) ||
    (input.cursor != null && (typeof input.cursor !== 'string' || input.cursor.length > 4000))) {
    fail('搜索或分页信息不正确，请重试。', 'INVALID_INPUT');
  }
  return read('discover', {search: (input.search || '').trim(), ...(input.cursor == null ? {} : {cursor: input.cursor})}, {force: input.force === true});
}
function getShareCode(id, envVersion) {
  checkProfileId(id);
  if (!['develop', 'trial', 'release'].includes(envVersion)) fail('暂时无法确认小程序版本，请重新打开后重试。', 'INVALID_INPUT');
  return invoke('shareCode', {profileId: id, envVersion});
}
function findImportedRecipe(id) { return publicId(id) ? store.getRecipe('shared-' + id) : null; }
function fs() { return wx.getFileSystemManager(); }
async function removeLocal(filePath) {
  if (!filePath) return;
  try { await call(fs(), 'unlink', {filePath}); } catch (_) { /* WeChat reclaims temporary downloads too. */ }
}
function photoType(data) {
  let bytes;
  try {
    if (data && Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
      bytes = new Uint8Array(data);
      if (bytes.buffer !== data || bytes.byteLength !== data.byteLength) throw Error('Invalid buffer');
    } else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw Error('Invalid buffer');
  } catch (_) { fail('菜谱照片无法读取，请稍后重试。'); }
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) fail('菜谱照片为空或超过 2 MB，暂时无法添加。');
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if ([82, 73, 70, 70].every((n, i) => bytes[i] === n) && [87, 69, 66, 80].every((n, i) => bytes[i + 8] === n)) return 'webp';
  fail('菜谱照片格式暂不支持，请稍后重试。');
}
async function copyPhoto(url, owner) {
  if (!url) return '';
  if (typeof url !== 'string' || url.length > 8000 || !/^https:\/\/[^\s/@]+(?:\/|$)/.test(url)) fail('菜谱照片链接无效，请重新打开这道菜谱。');
  let temporary = '';
  let saved = '';
  let complete = false;
  try {
    const result = await call(wx, 'downloadFile', {url, timeout: 20000});
    temporary = result && result.tempFilePath;
    assertOwner(owner);
    if (!temporary || result.statusCode !== 200) fail('菜谱照片下载未完成，请重试。');
    const info = await call(fs(), 'getFileInfo', {filePath: temporary});
    assertOwner(owner);
    if (!Number.isFinite(info.size) || info.size <= 0 || info.size > MAX_PHOTO_BYTES) fail('菜谱照片为空或超过 2 MB，暂时无法添加。');
    const read = await call(fs(), 'readFile', {filePath: temporary});
    assertOwner(owner);
    const extension = photoType(read && read.data);
    fileSequence += 1;
    saved = wx.env.USER_DATA_PATH + '/shared-' + Date.now() + '-' + fileSequence + '-' + Math.random().toString(36).slice(2, 10) + '.' + extension;
    await call(fs(), 'copyFile', {srcPath: temporary, destPath: saved});
    assertOwner(owner);
    complete = true;
    return saved;
  } catch (error) {
    if (error && error.userMessage) throw error;
    fail('菜谱照片未能保存，请检查网络和本机存储空间后重试。');
  } finally {
    await removeLocal(temporary);
    if (!complete) await removeLocal(saved);
  }
}
async function importRecipe(id) {
  const owner = await ready();
  const existing = findImportedRecipe(id);
  if (existing) return {recipeId: existing.id, added: false};
  const response = await request('recipe', {recipeId: id}, owner);
  const recipe = response.recipe;
  if (!object(recipe) || recipe.id !== id || !profileId(recipe.profileId)) fail('这道公开菜谱的信息不完整，请重新打开。');
  const ageGroups = normalizeAgeGroups(recipe.ageGroups);
  let photo = '';
  let keepPhoto = false;
  try {
    photo = await copyPhoto(recipe.photoURL, owner);
    assertOwner(owner);
    const result = store.addPublicRecipe(Object.assign({}, recipe, {photo}, ageGroups === undefined ? {} : {ageGroups}), owner.id);
    keepPhoto = result.added;
    return result;
  } finally {
    if (!keepPhoto) await removeLocal(photo);
  }
}
function addToCookbook(id) {
  checkRecipeId(id);
  const key = (store.getSyncInfo().owner || '') + ':' + id;
  if (imports.has(key)) return imports.get(key);
  const work = importRecipe(id).then(result => { imports.delete(key); return result; }, error => { imports.delete(key); throw error; });
  imports.set(key, work);
  return work;
}

module.exports = {getMine, saveProfile, getProfile, getProfileSummary, getReadVersion, getRecipe, publishRecipe, unpublishRecipe,
  setFollowing, getFollowing, getFollowers, getFeed, getDiscover, getShareCode, addToCookbook, findImportedRecipe};
