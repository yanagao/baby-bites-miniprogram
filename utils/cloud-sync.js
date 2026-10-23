'use strict';

const config = require('../config/cloud');
const store = require('./store');
const {mergeSnapshots} = require('./sync-merge');
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const listeners = new Set();
let initialized = false;
let started = false;
let inFlight = null;
let queued = false;
let timer = null;
let internalStoreChange = false;
let disconnected = false;
let fileSequence = 0;
let status = {state: configured() ? 'pending' : 'unconfigured',
  message: configured() ? '等待同步' : '云同步尚未配置', lastSyncedAt: 0, owner: ''};

function configured() { return typeof config.env === 'string' && /^[A-Za-z0-9_-]+$/.test(config.env); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function getStatus() { return copy(status); }
function publish(next) {
  status = Object.assign({}, status, next);
  listeners.forEach(listener => { try { listener(getStatus()); } catch (_) { /* Observers cannot interrupt sync. */ } });
}
function subscribe(listener) {
  if (typeof listener !== 'function') throw Error('监听器必须是函数。');
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function fail(message) {
  const error = new Error(message);
  error.userMessage = message;
  throw error;
}
function call(target, method, options) {
  return new Promise((resolve, reject) => {
    try {
      if (!target || typeof target[method] !== 'function') return reject(Error('API unavailable'));
      target[method](Object.assign({}, options, {success: resolve, fail: reject}));
    } catch (error) { reject(error); }
  });
}
function fs() { return wx.getFileSystemManager(); }
async function removeLocal(filePath) {
  if (!filePath) return;
  try { await call(fs(), 'unlink', {filePath}); } catch (_) { /* Temporary files are also reclaimed by WeChat. */ }
}
function byteLength(text) {
  let size = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i += 1; }
    else size += 3;
  }
  return size;
}
function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function ownedFile(fileID, owner, kind) {
  if (typeof fileID !== 'string' || fileID.length > 2000 || !/^[a-f0-9]{64}$/.test(owner)) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  if (!match || match[1] !== config.env) return false;
  const prefix = 'users/' + owner + '/' + kind + '/';
  if (match[3].indexOf(prefix) !== 0) return false;
  const filename = match[3].slice(prefix.length);
  return kind === 'snapshots' ? /^[A-Za-z0-9_-]{1,160}\.json$/.test(filename) :
    kind === 'photos' && /^[A-Za-z0-9_-]{1,160}\.(?:jpg|jpeg|png|webp|gif|avif)$/i.test(filename);
}
function checkResult(result, expectedOwner) {
  if (result && result.error) {
    const messages = {
      UNAUTHENTICATED: '未能识别当前微信账号，请在微信中重试。',
      INVALID_ENV: '云开发环境尚未配置完成。',
      INVALID_ACCOUNT: '云端账号数据暂时无法读取，本机数据已保留。',
      INVALID_FILE: '同步文件的账号归属不正确，本机数据已保留。',
      INVALID_SNAPSHOT: '云端未接受这份同步数据，本机数据已保留。请检查菜谱和照片后重试。'
    };
    fail(messages[result.error.code] || '云端同步暂时失败，本机数据已保留，请稍后重试。');
  }
  if (!result || typeof result.owner !== 'string' || !/^[a-f0-9]{64}$/.test(result.owner) ||
    !Number.isSafeInteger(result.revision) || result.revision < 0 ||
    (result.revision === 0 ? result.fileID !== '' : !ownedFile(result.fileID, result.owner, 'snapshots'))) {
    fail('未能确认云端账号与数据版本，本机数据已保留。');
  }
  if (expectedOwner && result.owner !== expectedOwner) fail('微信账号已切换，请重新同步当前账号。');
  return result;
}
async function invoke(data, owner) {
  const response = await call(wx.cloud, 'callFunction', {name: config.functionName || 'babyBitesSync', data});
  return checkResult(response && response.result, owner);
}
function assertOwner(owner) {
  if (store.getSyncInfo().owner !== owner) fail('微信账号已切换，请重新同步当前账号。');
}
function normalizeSnapshot(snapshot, owner, allowLocalPhotos) {
  let clean;
  try { clean = store.validateSnapshot(snapshot); }
  catch (_) { fail('同步数据格式不正确，本机数据已保留。'); }
  if (clean.deleted.recipes.length > 10000 || clean.deleted.logs.length > 100000) {
    fail('删除记录超过云同步限制，本机数据已保留。');
  }
  clean.data.recipes.forEach(recipe => {
    if (!recipe.photo) return;
    if (recipe.photo.indexOf('cloud://') === 0) {
      if (!ownedFile(recipe.photo, owner, 'photos')) fail('照片不属于当前微信账号或云环境，请重新选择这张照片后同步。');
    } else if (!allowLocalPhotos) fail('云端照片信息不完整，本机数据已保留。');
  });
  return clean;
}
async function checkSize(filePath, maximum, unreadableMessage) {
  let info;
  try { info = await call(fs(), 'getFileInfo', {filePath}); }
  catch (error) {
    if (unreadableMessage) fail(unreadableMessage);
    throw error;
  }
  if (!Number.isFinite(info.size) || info.size <= 0 || info.size > maximum) {
    fail(maximum === MAX_PHOTO_BYTES ? '单张照片为空或超过 2 MB，请重新选择照片后同步。' : '同步文件为空或超过 5 MB，本机数据已保留。');
  }
}
async function downloadSnapshot(fileID, owner) {
  if (!ownedFile(fileID, owner, 'snapshots')) fail('云端文件不属于当前微信账号，本机数据已保留。');
  const download = await call(wx.cloud, 'downloadFile', {fileID});
  const filePath = download && download.tempFilePath;
  try {
    if (!filePath || (download.statusCode != null && download.statusCode !== 200)) fail('同步文件下载未完成，请重试。');
    await checkSize(filePath, MAX_SNAPSHOT_BYTES);
    const result = await call(fs(), 'readFile', {filePath, encoding: 'utf8'});
    if (typeof result.data !== 'string' || byteLength(result.data) > MAX_SNAPSHOT_BYTES) fail('同步文件超过 5 MB，本机数据已保留。');
    let parsed;
    try { parsed = JSON.parse(result.data); } catch (_) { fail('同步文件无法读取，本机数据已保留。'); }
    return normalizeSnapshot(parsed, owner, false);
  } finally { await removeLocal(filePath); }
}
function uniqueName() {
  fileSequence += 1;
  return Date.now() + '-' + fileSequence + '-' + Math.random().toString(36).slice(2, 12);
}
function photoType(data, unreadableMessage) {
  let bytes;
  const unreadable = unreadableMessage || '照片无法读取，请重新选择照片后同步。';
  try {
    // WeChat can return a genuine ArrayBuffer from another JS realm. Its native
    // tag and backing buffer remain valid even when instanceof is false.
    if (data && Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
      const length = data.byteLength;
      if (!Number.isSafeInteger(length) || length < 0) fail(unreadable);
      bytes = new Uint8Array(data);
      if (bytes.buffer !== data || bytes.byteOffset !== 0 || bytes.byteLength !== length) fail(unreadable);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else fail(unreadable);
  } catch (error) {
    if (error && error.userMessage) throw error;
    fail(unreadable);
  }
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) fail('单张照片为空或超过 2 MB，请重新选择照片后同步。');
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if ([82, 73, 70, 70].every((value, i) => bytes[i] === value) &&
    [87, 69, 66, 80].every((value, i) => bytes[i + 8] === value)) return 'webp';
  fail('照片格式不受支持，请选择 JPG、PNG 或 WebP 照片后同步。');
}
async function uploadOwned(filePath, owner, kind, extension) {
  assertOwner(owner);
  const cloudPath = 'users/' + owner + '/' + kind + '/' + uniqueName() + '.' + extension;
  const result = await call(wx.cloud, 'uploadFile', {cloudPath, filePath});
  if (!result || !ownedFile(result.fileID, owner, kind) || !result.fileID.endsWith('/' + cloudPath)) {
    fail('上传文件的账号归属未能确认，本机数据已保留。');
  }
  assertOwner(owner);
  return result.fileID;
}
async function uploadPhotos(snapshot, owner, uploadedPhotos) {
  for (const recipe of snapshot.data.recipes) {
    const localPath = recipe.photo;
    if (!localPath || localPath.indexOf('cloud://') === 0) continue;
    if (!uploadedPhotos.has(localPath)) {
      assertOwner(owner);
      const unreadableMessage = '「' + recipe.name + '」的本机照片已失效或无法读取。请重新选择照片，或导入含照片的备份后重试；菜谱和记录已保留。';
      await checkSize(localPath, MAX_PHOTO_BYTES, unreadableMessage);
      let result;
      try { result = await call(fs(), 'readFile', {filePath: localPath}); }
      catch (_) { fail(unreadableMessage); }
      const type = photoType(result && result.data, unreadableMessage);
      uploadedPhotos.set(localPath, await uploadOwned(localPath, owner, 'photos', type));
    }
    recipe.photo = uploadedPhotos.get(localPath);
  }
}
function emptySnapshot() {
  return {version: 1, data: {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []},
    deleted: {recipes: [], logs: []}};
}
function apply(snapshot, owner, sequence, revision) {
  assertOwner(owner);
  internalStoreChange = true;
  try {
    if (store.applySyncedSnapshot(snapshot, {owner, sequence, revision}) === false) {
      fail('云端版本早于本机缓存，本机数据已保留，请稍后重试。');
    }
  }
  finally { internalStoreChange = false; }
}
async function synchronize() {
  publish({state: 'syncing', message: '正在同步当前微信账号的数据'});
  let remoteInfo = await invoke({action: 'identity'});
  const owner = remoteInfo.owner;
  internalStoreChange = true;
  try { store.bindAccount(owner); } finally { internalStoreChange = false; }
  publish({owner, lastSyncedAt: status.owner === owner ? status.lastSyncedAt : 0});
  const uploadedPhotos = new Map();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertOwner(owner);
    const localInfo = store.getSyncInfo();
    if (remoteInfo.revision < localInfo.revision) fail('云端版本早于本机缓存，本机数据已保留，请稍后重试。');
    if (!remoteInfo.fileID && !localInfo.hasLocalData) return;
    // Capture this sequence before any download or upload. applySyncedSnapshot
    // merges edits made during these awaits and leaves them pending for another pass.
    const local = normalizeSnapshot(store.getSyncSnapshot(), owner, true);
    const remote = remoteInfo.fileID ? await downloadSnapshot(remoteInfo.fileID, owner) : emptySnapshot();
    const snapshot = mergeSnapshots(local, remote);
    await uploadPhotos(snapshot, owner, uploadedPhotos);
    assertOwner(owner);
    if (remoteInfo.fileID && stableJSON(snapshot) === stableJSON(mergeSnapshots(remote, remote))) {
      apply(snapshot, owner, localInfo.sequence, remoteInfo.revision);
      return;
    }
    const text = JSON.stringify(snapshot);
    if (byteLength(text) > MAX_SNAPSHOT_BYTES) fail('同步数据超过 5 MB，本机数据已保留，请导出备份后整理记录。');
    const filePath = wx.env.USER_DATA_PATH + '/sync-' + uniqueName() + '.json';
    let result;
    try {
      await call(fs(), 'writeFile', {filePath, data: text, encoding: 'utf8'});
      const fileID = await uploadOwned(filePath, owner, 'snapshots', 'json');
      result = await invoke({action: 'commit', baseRevision: remoteInfo.revision, fileID}, owner);
      if (!result.conflict && (result.revision !== remoteInfo.revision + 1 || result.fileID !== fileID)) {
        fail('云端尚未确认本次保存，本机数据已保留，请重试同步。');
      }
    } finally {
      // A timed-out commit may already have succeeded. Never delete its cloud file,
      // nor previously committed files that another device may still be reading.
      await removeLocal(filePath);
    }
    if (result.conflict) { remoteInfo = result; continue; }
    apply(snapshot, owner, localInfo.sequence, result.revision);
    return;
  }
  fail('其他设备正在更新数据，本机修改已保留，请稍后再同步。');
}
function initialize() {
  if (initialized) return;
  if (typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.init !== 'function') {
    fail('当前微信版本不支持云同步，请更新微信后重试。');
  }
  wx.cloud.init({env: config.env, traceUser: false});
  initialized = true;
}
function onFailure(error) {
  const networkError = disconnected || /network|timeout|timed out|offline|网络/i.test(error && (error.errMsg || error.message) || '');
  publish({state: networkError ? 'pending' : 'error', message: error && error.userMessage ||
    (networkError ? '等待联网同步，本机修改已保留。' : '同步暂未完成，本机数据已保留，请重试。')});
}
function syncNow() {
  if (!configured()) {
    publish({state: 'unconfigured', message: '云同步尚未配置'});
    return Promise.resolve(getStatus());
  }
  if (timer) { clearTimeout(timer); timer = null; }
  if (inFlight) { queued = true; return inFlight; }
  if (disconnected) {
    publish({state: 'pending', message: '等待联网同步，本机修改已保留。'});
    return Promise.resolve(getStatus());
  }
  inFlight = Promise.resolve().then(async () => {
    initialize();
    do {
      queued = false;
      await synchronize();
      if (store.getSyncInfo().dirty) queued = true;
    } while (queued && !disconnected);
    publish({state: store.getSyncInfo().dirty ? 'pending' : 'synced',
      message: store.getSyncInfo().dirty ? '本机修改等待同步' : '已同步当前微信账号', lastSyncedAt: Date.now()});
  }).catch(error => {
    // A failing request never triggers its own retry loop. A later edit, reconnect,
    // foreground event or explicit retry can start a new attempt.
    queued = false;
    onFailure(error);
  }).then(() => { inFlight = null; return getStatus(); });
  return inFlight;
}
function start() {
  if (!configured()) return syncNow();
  if (!started) {
    started = true;
    store.subscribe(info => {
      if (internalStoreChange || !info.dirty) return;
      if (inFlight) { queued = true; return; }
      publish({state: 'pending', message: '本机修改等待同步'});
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; syncNow(); }, 300);
    });
    if (typeof wx !== 'undefined' && typeof wx.onNetworkStatusChange === 'function') wx.onNetworkStatusChange(event => {
      disconnected = event.isConnected === false;
      if (!disconnected) syncNow();
      else if (!inFlight) publish({state: 'pending', message: '等待联网同步，本机修改已保留。'});
    });
  }
  return syncNow();
}

module.exports = {start, syncNow, getStatus, subscribe};
