'use strict';

const config = require('../config/cloud');
const store = require('./store');
const {isBuiltInRecipe} = require('./recipe-origin');
const cloudSync = require('./cloud-sync');
const {withCover} = require('./recipe-covers');
const coverLoader = require('./cover-loader');
const {isValidBirthDate} = require('./baby-age');
const {normalizeAgeGroups} = require('./recipe-ages');
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const imports = new Map();
const COOKSNAP_PHOTO_BYTES = 1024 * 1024;
const SAVE_RECEIPT_PREFIX = 'baby-bites-save-receipts:';
const saveReceiptMemory = new Map();
const saveReceiptFlights = new Map();
const cooksnapUploads = new Map();
const cooksnapFlights = new Map();
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
const scopeKey = () => store.getSyncInfo().scopeKey || store.getSyncInfo().owner || '';
const currentScope = () => store.getSyncInfo().scope;
let observedScope = scopeKey();
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
  if (info.owner !== observedOwner || (info.scopeKey || info.owner || '') !== observedScope) {
    observedScope = info.scopeKey || info.owner || '';
    observedOwner = info.owner; ownerEpoch += 1;
    observedRevision = info.revision; observedPublication = 0; observedIdentityInvalid = false;
    cooksnapUploads.clear();
    forgetIdentity();
  }
});
if (typeof cloudSync.subscribe === 'function') cloudSync.subscribe(status => {
  if (status.owner !== observedOwner || status.scopeKey && status.scopeKey !== observedScope) return;
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
  if (status.state === 'synced' && !status.identityInvalid) flushSaveReceipts(false).catch(() => {});
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
async function ready(options) {
  requireEnabled();
  const previous = store.getSyncInfo().owner;
  const previousEpoch = ownerEpoch;
  const status = await cloudSync.syncNow(options);
  const current = store.getSyncInfo();
  if ((previous && (current.owner !== previous || ownerEpoch !== previousEpoch)) ||
    (!previous && ownerEpoch > previousEpoch + 1)) fail('微信账号已切换，请重新打开当前页面。', 'ACCOUNT_CHANGED');
  if (!status || status.state !== 'synced' || !current.owner || status.owner !== current.owner || current.blocked) {
    fail(status && status.message || '请先联网同步当前微信账号，再使用好友功能。', 'SYNC_REQUIRED');
  }
  return {id: current.owner, epoch: ownerEpoch, scope: current.scope, scopeKey: scopeKey()};
}
const errors = {
  ACCOUNT_CHANGED: '微信账号已切换，请重新打开当前页面。',
  FAMILY_CHANGED: '家庭已变化，请等待同步后重新打开当前页面。',
  FAMILY_NOT_FOUND: '家庭暂时不可用，请重新同步。',
  RECIPE_AUTHOR_REQUIRED: '请等待添加这道菜的家人完成同步。',
  UNAUTHENTICATED: '未能识别当前微信账号，请在微信中重试。',
  INVALID_ENV: '好友功能暂未配置完成，请稍后重试。',
  NOT_FOUND: '这份内容已移除，或暂时无法查看。',
  PROFILE_NOT_FOUND: '这个主页暂时无法查看。',
  RECIPE_NOT_FOUND: '这道菜谱已移除，或暂时无法查看。',
  NOT_PUBLIC: '这道菜谱已移除，或暂时无法查看。',
  BUILTIN_RECIPE: '内置菜谱仅供自己使用，可以将小程序分享给朋友。',
  CLIENT_UPDATE_REQUIRED: '请更新小程序后重新打开分享预览。',
  PREVIEW_REQUIRED: '请先查看分享预览，再确认公开。',
  PREVIEW_STALE: '菜谱或作者资料已有更新，请重新查看预览后再确认。',
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
  PROFILE_REQUIRED: '请先保存主页资料，再生成主页分享码。',
  SYNC_REQUIRED: '请先完成菜谱同步，再分享这道菜谱。',
  SOURCE_NOT_FOUND: '这道菜谱还未同步，或已被删除，请返回食谱后重试。',
  INVALID_SNAPSHOT: '菜谱尚未完整同步，请完成同步后重试。',
  INVALID_PHOTO: '这张照片暂时无法同步，请重新选择照片后重试。',
  STORAGE_ERROR: '照片暂时无法读取，请稍后重试。',
  STORAGE_FAILED: '照片暂时无法读取，请稍后重试。',
  SHARE_CODE_UNAVAILABLE: '分享码暂不可用，可以先发送主页给朋友。',
  SHARE_CODE_FAILED: '分享码暂时生成失败，可以重试或先发送主页给朋友。',
  SHARE_CODE_NOT_PUBLISHED: '正式版主页尚未发布，暂时无法生成正式版分享码。',
  SELF_FEEDBACK: '这是你自己的菜谱，无需记录跟做。',
  INVALID_COOKSNAP: '请添加一张成品照和 1–120 字的做后反馈。',
  INVALID_COOKSNAP_PHOTO: '请使用不超过 1 MB 的 JPG 或 PNG 成品照。',
  COOKSNAP_TEXT_REJECTED: '这句话未通过内容审核，请修改后重试。',
  COOKSNAP_PHOTO_REJECTED: '这张照片未通过内容审核，请更换成品照后重试。',
  COOKSNAP_MODERATION_UNAVAILABLE: '内容审核暂时不可用，跟做尚未发布，请稍后重试。',
  FEEDBACK_NOT_SAVED: '菜谱保存记录正在同步，请稍后重试。'
};
async function request(action, data, owner) {
  assertOwner(owner);
  let response;
  try {
    response = await call(wx.cloud, 'callFunction', {name: 'babyBitesSocial',
      config: {env: config.env}, data: Object.assign({}, data, {action, expectedOwner: owner.id}, owner.scope ? {expectedScope: owner.scope, protocolVersion: 2} : {})});
  } catch (_) {
    assertOwner(owner);
    fail('好友功能暂时连接不上，请检查网络后重试。', 'NETWORK');
  }
  assertOwner(owner);
  const result = response && response.result;
  if (!object(result)) fail('好友功能返回的信息不完整，请稍后重试。');
  if (result.error) {
    const code = result.error.code;
    if (code === 'ACCOUNT_CHANGED' || code === 'UNAUTHENTICATED' || code === 'FAMILY_CHANGED') {
      forgetIdentity(true);
      if (code === 'FAMILY_CHANGED') Promise.resolve().then(() => cloudSync.syncNow()).catch(() => {});
    }
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
  const session = {id: info.owner, epoch: ownerEpoch, scope: info.scope, scopeKey: scopeKey()};
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
      config: {env: config.env}, data: {action: 'identity', protocolVersion: 2}});
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
  const expectedScope = session.scope || {kind: 'personal', id: session.id};
  if ((!result.scope && expectedScope.kind === 'family') || (result.scope &&
    (result.scope.kind !== expectedScope.kind || result.scope.id !== expectedScope.id || result.scope.membershipId !== expectedScope.membershipId))) {
    forgetIdentity(true);
    Promise.resolve().then(() => cloudSync.syncNow()).catch(() => {});
    fail('家庭已变化，请等待同步后重新打开页面。', 'FAMILY_CHANGED');
  }
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
async function getFamilyRecipeLink(sourceRecipeId, options) {
  const value = await read('familyRecipeLink', {sourceRecipeId}, options);
  const p = value && value.publication;
  if (!value || p !== null && (!object(p) || !publicId(p.id) || p.sourceRecipeId !== sourceRecipeId || !publicId(p.createdBy) || !Number.isFinite(p.sourceUpdatedAt))) fail('家庭菜谱分享信息暂时无法读取。');
  return {publication: p ? {id: p.id, sourceRecipeId: p.sourceRecipeId, sourceUpdatedAt: p.sourceUpdatedAt, createdBy: p.createdBy} : null};
}

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
async function getRecipeShareLink(sourceRecipeId, options = {}) {
  const owner = await ready({ifNeeded: !options.force});
  const local = store.getRecipe(sourceRecipeId);
  if (!local || store.getSyncInfo().dirty) fail(errors.SYNC_REQUIRED, 'SYNC_REQUIRED');
  if (isBuiltInRecipe(local)) fail(errors.BUILTIN_RECIPE, 'BUILTIN_RECIPE');
  const localVersion = JSON.stringify(local);
  const check = () => {
    assertOwner(owner);
    if (store.getSyncInfo().dirty || JSON.stringify(store.getRecipe(sourceRecipeId)) !== localVersion) {
      fail('菜谱已有更新，请同步后重新分享。', 'SYNC_REQUIRED');
    }
  };
  let id;
  if (local.source && publicId(local.source.recipeId)) {
    id = local.source.recipeId;
  } else {
    const value = owner.scope && owner.scope.kind === 'family'
      ? await getFamilyRecipeLink(sourceRecipeId, {force: true}) : await getMine({force: true});
    check();
    const publication = owner.scope && owner.scope.kind === 'family' ? value.publication
      : Array.isArray(value.published) && value.published.find(item => item.sourceRecipeId === sourceRecipeId);
    if (!publication || !publicId(publication.id) || publication.sourceUpdatedAt !== (local.updatedAt || local.createdAt || 0)) {
      const status = cloudSync.getStatus();
      fail(status && status.publicationMessage || '菜谱正在同步公开，请稍后重试。', 'PUBLICATION_PENDING');
    }
    id = publication.id;
  }
  const value = await getRecipe(id);
  check();
  const recipe = value && value.recipe;
  if (!object(recipe) || recipe.id !== id || typeof recipe.name !== 'string' || !recipe.name.trim() || recipe.name.length > 60 ||
    (recipe.photoURL && (typeof recipe.photoURL !== 'string' || recipe.photoURL.length > 8000 || !/^https:\/\//.test(recipe.photoURL)))) {
    fail('菜谱分享信息暂时无法读取，请重试。', 'INVALID_RECIPE');
  }
  // The share card needs only server-verified public fields, never local notes.
  return {recipe: {id, name: recipe.name, photoURL: recipe.photoURL || ''}, localVersion};
}
async function shareReady(sourceRecipeId) {
  const owner = await ready();
  const recipe = store.getRecipe(sourceRecipeId);
  if (isBuiltInRecipe(recipe)) fail('内置菜谱仅供自己使用，可以将小程序分享给朋友。', 'BUILTIN_RECIPE');
  const info = store.getSyncInfo();
  if (recipe && recipe.createdBy && recipe.createdBy !== owner.id) fail(errors.RECIPE_AUTHOR_REQUIRED, 'RECIPE_AUTHOR_REQUIRED');
  if (info.dirty || !recipe) fail('请先保存并同步这道菜谱，再分享。', 'SYNC_REQUIRED');
  return owner;
}
function normalizeSharePreview(result) {
  const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max &&
    (empty || value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
  const recipe = result && result.recipe, author = result && result.author;
  if (!object(result) || !publicId(result.previewToken) || typeof result.alreadyPublished !== 'boolean' ||
    !object(recipe) || !publicId(recipe.id) || !object(author) || !profileId(author.id) ||
    recipe.profileId !== author.id || !text(author.name, 20) || !text(author.bio || '', 120, true) ||
    !(author.babyAgeMonths == null || Number.isInteger(author.babyAgeMonths) && author.babyAgeMonths >= 0 && author.babyAgeMonths <= 120) ||
    !text(recipe.name, 60) || !text(recipe.category, 40) || !text(recipe.texture, 40) ||
    !Number.isFinite(recipe.minutes) || recipe.minutes < 1 || recipe.minutes > 480 ||
    !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 50 ||
    !recipe.ingredients.every(item => object(item) && text(item.name, 80) && text(item.amount, 80, true)) ||
    !Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 30 ||
    !recipe.steps.every(step => typeof step === 'string' && step.trim() && step.length <= 2000) ||
    (recipe.photoURL && (typeof recipe.photoURL !== 'string' || recipe.photoURL.length > 8000 || !/^https:\/\//.test(recipe.photoURL)))) {
    fail('暂时无法读取分享预览，请重试。', 'INVALID_PREVIEW');
  }
  const ageGroups = normalizeAgeGroups(recipe.ageGroups);
  const source = recipe.source;
  if (source && (!object(source) || !profileId(source.profileId) || !publicId(source.recipeId) || !text(source.authorName, 30))) {
    fail('菜谱来源暂时无法确认，请重试。', 'INVALID_PREVIEW');
  }
  return {previewToken: result.previewToken, alreadyPublished: result.alreadyPublished,
    author: {id: author.id, name: author.name, bio: author.bio || '', babyAgeMonths: author.babyAgeMonths == null ? null : author.babyAgeMonths},
    recipe: withCover({id: recipe.id, profileId: author.id, authorName: author.name,
      name: recipe.name, category: recipe.category, texture: recipe.texture, minutes: recipe.minutes,
      ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})), steps: recipe.steps.slice(),
      imageKey: typeof recipe.imageKey === 'string' ? recipe.imageKey : '', photoURL: recipe.photoURL || '',
      ...(ageGroups === undefined ? {} : {ageGroups}),
      ...(source ? {source: {profileId: source.profileId, recipeId: source.recipeId, authorName: source.authorName}} : {})})};
}
async function previewPublication(sourceRecipeId) {
  const owner = await shareReady(sourceRecipeId);
  return normalizeSharePreview(await request('previewPublication', {sourceRecipeId}, owner));
}
async function publishRecipe(sourceRecipeId, previewToken) {
  const owner = await shareReady(sourceRecipeId);
  return mutate('publish', {sourceRecipeId, ...(publicId(previewToken) ? {previewToken} : {})}, owner);
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
  if (existing) { queueSaveReceipt(owner, id, existing.id); return {recipeId: existing.id, added: false}; }
  const response = await request('recipe', {recipeId: id}, owner);
  const recipe = response.recipe;
  if (!object(recipe) || recipe.id !== id || !profileId(recipe.profileId)) fail('这道菜谱的信息不完整，请重新打开。');
  const ageGroups = normalizeAgeGroups(recipe.ageGroups);
  let photo = '';
  let keepPhoto = false;
  try {
    photo = await copyPhoto(recipe.photoURL, owner);
    assertOwner(owner);
    const result = store.addPublicRecipe(Object.assign({}, recipe, {photo}, ageGroups === undefined ? {} : {ageGroups}), owner.id);
    keepPhoto = result.added;
    queueSaveReceipt(owner, id, result.recipeId);
    return result;
  } finally {
    if (!keepPhoto) await removeLocal(photo);
  }
}
function addToCookbook(id) {
  checkRecipeId(id);
  const key = scopeKey() + ':' + id;
  if (imports.has(key)) return imports.get(key);
  const work = importRecipe(id).then(result => { imports.delete(key); return result; }, error => { imports.delete(key); throw error; });
  imports.set(key, work);
  return work;
}

// A receipt is only an intent to report a completed local save. The server
// verifies the committed snapshot before it creates the unique author event.
function saveReceipts(owner) {
  if (saveReceiptMemory.has(owner)) return saveReceiptMemory.get(owner);
  let stored;
  try { stored = wx.getStorageSync(SAVE_RECEIPT_PREFIX + owner); } catch (_) {}
  const result = Array.isArray(stored) ? stored.filter(item => object(item) && publicId(item.recipeId) &&
    typeof item.localRecipeId === 'string' && item.localRecipeId.length <= 100).slice(0, 2000)
    .map(item => ({recipeId: item.recipeId, localRecipeId: item.localRecipeId})) : [];
  saveReceiptMemory.set(owner, result);
  return result;
}
function writeSaveReceipts(owner, receipts) {
  saveReceiptMemory.set(owner, receipts);
  try { wx.setStorageSync(SAVE_RECEIPT_PREFIX + owner, receipts); } catch (_) {
    // Quota errors must not turn a successfully saved recipe into a failed save.
    // The in-memory queue still retries while this app session remains open.
  }
}
function queueSaveReceipt(owner, recipeId, localRecipeId) {
  assertOwner(owner);
  const receipts = saveReceipts(owner.scope && owner.scope.kind === 'family' ? owner.scopeKey : owner.id);
  if (!receipts.some(item => item.recipeId === recipeId)) {
    writeSaveReceipts(owner.scope && owner.scope.kind === 'family' ? owner.scopeKey : owner.id, receipts.concat({recipeId, localRecipeId}).slice(-2000));
  }
  flushSaveReceipts(true).catch(() => {});
}
function flushSaveReceipts(syncFirst) {
  const owner = {id: store.getSyncInfo().owner, epoch: ownerEpoch, scope: currentScope(), scopeKey: scopeKey()};
  const receiptKey = owner.scope && owner.scope.kind === 'family' ? owner.scopeKey : owner.id;
  if (!owner.id || !saveReceipts(receiptKey).length) return Promise.resolve();
  const key = owner.epoch + ':' + owner.id;
  if (saveReceiptFlights.has(key)) return saveReceiptFlights.get(key);
  const work = Promise.resolve().then(async () => {
    assertOwner(owner);
    const session = syncFirst ? await ready() : await readyIdentity(true);
    assertOwner(owner);
    // Bounded work prevents an old imported library delaying foreground work.
    for (const item of saveReceipts(receiptKey).slice(0, 20)) {
      assertOwner(owner);
      const local = store.getRecipe(item.localRecipeId);
      if (local && local.source && local.source.recipeId === item.recipeId) {
        try {
          const result = await request('recordSave', item, session);
          if (!result || typeof result.recorded !== 'boolean') return;
          invalidateReads();
        } catch (error) {
          // Removed originals and self-saves can never become an author receipt.
          // A temporary sync/network failure retains the queue for another run.
          if (!['NOT_FOUND', 'RECIPE_NOT_FOUND', 'NOT_PUBLIC', 'SELF_FEEDBACK'].includes(error.code)) throw error;
        }
      }
      assertOwner(owner);
      writeSaveReceipts(receiptKey, saveReceipts(receiptKey).filter(receipt => receipt.recipeId !== item.recipeId));
    }
  }).finally(() => { if (saveReceiptFlights.get(key) === work) saveReceiptFlights.delete(key); });
  saveReceiptFlights.set(key, work);
  return work;
}
function feedbackText(value, max, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
}
function feedbackPhoto(value) {
  return typeof value === 'string' && value.length <= 8000 && /^https:\/\/[^\s/@]+(?:\/|$)/.test(value);
}
function invalidFeedback() { fail('反馈信息暂时无法读取，请刷新重试。', 'INVALID_FEEDBACK'); }
function normalizeCooksnap(item) {
  if (!object(item) || !publicId(item.id) || !publicId(item.recipeId) || !object(item.author) ||
    !profileId(item.author.id) || !feedbackText(item.author.name, 30) || !feedbackText(item.text, 120) ||
    !feedbackPhoto(item.photoURL) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || typeof item.isSelf !== 'boolean') invalidFeedback();
  return {id: item.id, recipeId: item.recipeId, author: {id: item.author.id, name: item.author.name},
    photoURL: item.photoURL, text: item.text, createdAt: item.createdAt, isSelf: item.isSelf};
}
function feedbackPage(result, field, normalize) {
  if (!object(result) || !Number.isSafeInteger(result.saveCount) || result.saveCount < 0 ||
    !Number.isSafeInteger(result.cooksnapCount) || result.cooksnapCount < 0 || !Array.isArray(result[field]) ||
    result[field].length > 20 || !(result.nextOffset === null || Number.isSafeInteger(result.nextOffset) && result.nextOffset >= 0)) invalidFeedback();
  return {saveCount: result.saveCount, cooksnapCount: result.cooksnapCount,
    [field]: result[field].map(normalize), nextOffset: result.nextOffset};
}
async function getRecipeFeedback(id, start = 0, options) {
  checkRecipeId(id);
  const result = feedbackPage(await read('recipeFeedback', {recipeId: id, offset: offset(start)}, options), 'cooksnaps', normalizeCooksnap);
  if (result.cooksnaps.some(item => item.recipeId !== id) || result.nextOffset !== null && result.nextOffset <= offset(start)) invalidFeedback();
  return result;
}
async function getFeedbackInbox(start = 0, options) {
  const result = feedbackPage(await read('feedbackInbox', {offset: offset(start)}, options), 'items', item => {
    if (!object(item) || !publicId(item.id) || !['save', 'cooksnap'].includes(item.type) || !publicId(item.recipeId) ||
      !feedbackText(item.recipeName, 60) || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 ||
      (item.type === 'cooksnap' && (!feedbackText(item.actorName, 30) || !feedbackText(item.text, 120) || !feedbackPhoto(item.photoURL)))) invalidFeedback();
    return {id: item.id, type: item.type, recipeId: item.recipeId, recipeName: item.recipeName, createdAt: item.createdAt,
      ...(item.type === 'cooksnap' ? {actorName: item.actorName, photoURL: item.photoURL, text: item.text} : {photoURL: '', text: ''})};
  });
  if (result.nextOffset !== null && result.nextOffset <= offset(start)) invalidFeedback();
  return result;
}
function ownsCooksnapPhoto(fileID, owner, cloudPath) {
  const match = typeof fileID === 'string' && /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  return !!match && match[1] === config.env && match[3] === cloudPath &&
    cloudPath.indexOf('users/' + owner.id + '/photos/') === 0;
}
async function prepareCooksnapPhoto(photoPath, owner) {
  let temporary = '';
  try {
    let info = await call(fs(), 'getFileInfo', {filePath: photoPath});
    assertOwner(owner);
    if (!Number.isFinite(info.size) || info.size <= 0 || info.size > 10 * 1024 * 1024) fail('请选择不超过 10 MB 的成品照片。', 'INVALID_COOKSNAP_PHOTO');
    let dimensions = await call(wx, 'getImageInfo', {src: photoPath});
    assertOwner(owner);
    const validSize = value => Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0;
    if (!validSize(dimensions)) fail('照片尺寸无法读取，请重新选择。', 'INVALID_COOKSNAP_PHOTO');
    if (info.size > COOKSNAP_PHOTO_BYTES || Math.max(dimensions.width, dimensions.height) > 750) {
      const scale = Math.min(1, 750 / Math.max(dimensions.width, dimensions.height));
      const compressed = await call(wx, 'compressImage', {src: photoPath, quality: 70,
        compressedWidth: Math.max(1, Math.floor(dimensions.width * scale)),
        compressedHeight: Math.max(1, Math.floor(dimensions.height * scale))});
      if (compressed && typeof compressed.tempFilePath === 'string' && compressed.tempFilePath && compressed.tempFilePath !== photoPath) temporary = compressed.tempFilePath;
      assertOwner(owner);
      if (!compressed || typeof compressed.tempFilePath !== 'string' || !compressed.tempFilePath) fail('照片压缩未完成，请换一张较小的照片。', 'INVALID_COOKSNAP_PHOTO');
      photoPath = compressed.tempFilePath;
      info = await call(fs(), 'getFileInfo', {filePath: photoPath});
      assertOwner(owner);
      dimensions = await call(wx, 'getImageInfo', {src: photoPath});
      assertOwner(owner);
    }
    if (!validSize(dimensions) || Math.max(dimensions.width, dimensions.height) > 750 ||
      !Number.isFinite(info.size) || info.size <= 0 || info.size > COOKSNAP_PHOTO_BYTES) {
      fail('照片压缩后仍然过大，请换一张较小的 JPG 或 PNG 成品照。', 'INVALID_COOKSNAP_PHOTO');
    }
    const bytes = await call(fs(), 'readFile', {filePath: photoPath});
    assertOwner(owner);
    const extension = photoType(bytes && bytes.data);
    if (!['png', 'jpg'].includes(extension) || bytes.data.byteLength > COOKSNAP_PHOTO_BYTES) fail(errors.INVALID_COOKSNAP_PHOTO, 'INVALID_COOKSNAP_PHOTO');
    fileSequence++;
    const cloudPath = 'users/' + owner.id + '/photos/cooksnap-' + Date.now() + '-' + fileSequence + '-' + Math.random().toString(36).slice(2, 12) + '.' + extension;
    const upload = await call(wx.cloud, 'uploadFile', {cloudPath, filePath: photoPath, config: {env: config.env}});
    assertOwner(owner);
    if (!upload || !ownsCooksnapPhoto(upload.fileID, owner, cloudPath)) fail('照片上传归属无法确认，请重试。', 'INVALID_COOKSNAP_PHOTO');
    return upload.fileID;
  } catch (error) {
    if (error && error.userMessage) throw error;
    fail('成品照未能上传，请检查网络后重试。', 'COOKSNAP_UPLOAD_FAILED');
  } finally { if (temporary) await removeLocal(temporary); }
}
function addCooksnap(id, input) {
  checkRecipeId(id);
  if (!object(input) || !feedbackText(input.text, 120) || typeof input.photoPath !== 'string' || !input.photoPath ||
    input.photoPath.length > 2000 || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.requestId)) {
    fail(errors.INVALID_COOKSNAP, 'INVALID_COOKSNAP');
  }
  input = {photoPath: input.photoPath, text: input.text.trim(), requestId: input.requestId};
  const key = ownerEpoch + ':' + (store.getSyncInfo().owner || '') + ':' + input.requestId;
  const fingerprint = JSON.stringify([id, input.photoPath, input.text.trim()]);
  const existing = cooksnapUploads.get(key);
  if (existing && existing.fingerprint !== fingerprint) fail('这次跟做内容已变化，请重新确认后发布。', 'CONFLICT');
  if (cooksnapFlights.has(key)) return cooksnapFlights.get(key);
  const upload = existing || {fingerprint, fileID: ''};
  // Limit retry metadata retained during a long-lived mini program session.
  if (!existing && cooksnapUploads.size >= MAX_CACHE_ENTRIES) {
    for (const oldKey of cooksnapUploads.keys()) {
      if (!cooksnapFlights.has(oldKey)) { cooksnapUploads.delete(oldKey); break; }
    }
  }
  cooksnapUploads.set(key, upload);
  const work = Promise.resolve().then(async () => {
    const owner = await readyIdentity();
    if (key !== owner.epoch + ':' + owner.id + ':' + input.requestId) fail(errors.ACCOUNT_CHANGED, 'ACCOUNT_CHANGED');
    if (!upload.fileID) upload.fileID = await prepareCooksnapPhoto(input.photoPath, owner);
    assertOwner(owner);
    const result = await mutate('addCooksnap', {recipeId: id, requestId: input.requestId, photoFileID: upload.fileID, text: input.text.trim()}, owner);
    const cooksnap = normalizeCooksnap(result && result.cooksnap);
    if (cooksnap.recipeId !== id || !cooksnap.isSelf) invalidFeedback();
    // Keep the original upload for safe retries after a lost response. Never
    // remove a cloud file when the server's commit outcome may be unknown.
    return {cooksnap};
  }).finally(() => { if (cooksnapFlights.get(key) === work) cooksnapFlights.delete(key); });
  cooksnapFlights.set(key, work);
  return work;
}
async function deleteCooksnap(id) {
  checkRecipeId(id);
  const result = await mutate('deleteCooksnap', {id});
  if (!result || result.deleted !== true) invalidFeedback();
  return {deleted: true};
}

module.exports = {getMine, getFamilyRecipeLink, getRecipeShareLink, saveProfile, getProfile, getProfileSummary, getReadVersion, getRecipe, previewPublication, publishRecipe, unpublishRecipe,
  setFollowing, getFollowing, getFollowers, getFeed, getDiscover, getShareCode, addToCookbook, findImportedRecipe,
  getRecipeFeedback, getFeedbackInbox, addCooksnap, deleteCooksnap};
