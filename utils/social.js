'use strict';

const config = require('../config/cloud');
const store = require('./store');
const cloudSync = require('./cloud-sync');
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const imports = new Map();
let fileSequence = 0;
let observedOwner = store.getSyncInfo().owner;
let ownerEpoch = 0;
store.subscribe(info => {
  if (info.owner !== observedOwner) { observedOwner = info.owner; ownerEpoch += 1; }
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
  INVALID_INPUT: '信息不完整，请刷新页面后重试。',
  INVALID_REQUEST: '信息不完整，请刷新页面后重试。',
  INVALID_ACCOUNT: '暂时无法确认当前账号，请重新打开页面。',
  CONFLICT: '资料已发生变化，请刷新页面后重试。',
  SELF_FOLLOW: '这是你自己的主页，无需关注。',
  FOLLOW_LIMIT: '关注人数已达到上限，请整理后重试。',
  PROFILE_REQUIRED: '请先保存公开昵称，再公开菜谱。',
  SYNC_REQUIRED: '请先完成菜谱同步，再公开这道菜谱。',
  SOURCE_NOT_FOUND: '这道菜谱还未同步，或已被删除，请返回食谱后重试。',
  INVALID_SNAPSHOT: '菜谱尚未完整同步，请完成同步后重试。',
  INVALID_PHOTO: '这张照片暂时无法公开，请重新选择照片并同步后重试。',
  STORAGE_ERROR: '照片暂时无法读取，请稍后重试。',
  STORAGE_FAILED: '照片暂时无法读取，请稍后重试。'
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
    fail(errors[code] || '操作暂未完成，请稍后重试。', code);
  }
  return result;
}
async function readyIdentity() {
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
  let response;
  try {
    wx.cloud.init({env: config.env, traceUser: false});
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
    fail('未能确认当前微信账号，请联网重试。', 'SYNC_REQUIRED');
  }
  if (result.owner !== session.id) fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED');
  return session;
}
async function invoke(action, data) { return request(action, data, await readyIdentity()); }
function checkProfileId(value) { if (!profileId(value)) fail('主页地址不正确，请重新打开好友分享的主页。', 'INVALID_INPUT'); }
function checkRecipeId(value) { if (!publicId(value)) fail('菜谱地址不正确，请重新打开这道菜谱。', 'INVALID_INPUT'); }
function offset(value) {
  const result = value == null ? 0 : value;
  if (!Number.isSafeInteger(result) || result < 0) fail('分页信息不正确，请刷新页面。', 'INVALID_INPUT');
  return result;
}
function getMine() { return invoke('mine'); }
function saveProfile(input) {
  if (!object(input) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 20 ||
    typeof input.bio !== 'string' || input.bio.trim().length > 120 || /[\u0000-\u001f]/.test(input.name + input.bio)) {
    fail(errors.INVALID_PROFILE, 'INVALID_PROFILE');
  }
  return invoke('updateProfile', {name: input.name.trim(), bio: input.bio.trim()});
}
function getProfile(id, start) { checkProfileId(id); return invoke('profile', {profileId: id, offset: offset(start)}); }
function getRecipe(id) { checkRecipeId(id); return invoke('recipe', {recipeId: id}); }
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
  return request('publish', {sourceRecipeId}, owner);
}
function unpublishRecipe(sourceRecipeId) { return invoke('unpublish', {sourceRecipeId}); }
function setFollowing(id, following) {
  checkProfileId(id);
  if (typeof following !== 'boolean') fail('关注状态不正确，请重试。', 'INVALID_INPUT');
  return invoke('follow', {profileId: id, following});
}
function getFollowing(start) { return invoke('following', {offset: offset(start)}); }
function getFeed(cursor) { return invoke('feed', cursor == null ? {} : {cursor}); }
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
  let photo = '';
  let keepPhoto = false;
  try {
    photo = await copyPhoto(recipe.photoURL, owner);
    assertOwner(owner);
    const result = store.addPublicRecipe(Object.assign({}, recipe, {photo}), owner.id);
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

module.exports = {getMine, saveProfile, getProfile, getRecipe, publishRecipe, unpublishRecipe,
  setFollowing, getFollowing, getFeed, addToCookbook, findImportedRecipe};
