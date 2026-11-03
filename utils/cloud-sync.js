'use strict';

const config = require('../config/cloud');
const store = require('./store');
const {mergeSnapshots} = require('./sync-merge');
const publicationSync = require('./publication-sync');
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const FOREGROUND_CHECK_INTERVAL = 30 * 1000;
const listeners = new Set();
let initialized = false;
let started = false;
let inFlight = null;
let queued = false;
let timer = null;
let internalStoreChange = false;
let disconnected = false;
let fileSequence = 0;
let observedOwner = store.getSyncInfo().owner;
let observedScopeKey = store.getSyncInfo().scopeKey || observedOwner || '';
let synchronizingScopeKey = null;
let synchronizingEpoch = null;
let ownerEpoch = 0;
let lastSyncedEpoch = -1;
store.subscribe(info => {
  const nextScopeKey = info.scopeKey || info.owner || '';
  if (info.owner !== observedOwner || nextScopeKey !== observedScopeKey) {
    observedOwner = info.owner;
    observedScopeKey = nextScopeKey;
    ownerEpoch++;
    publish({identityCheckedAt: 0, identityInvalid: true, publicationPending: false, publicationMessage: '', publicationErrorCode: ''});
  }
});
let status = {state: configured() ? 'pending' : 'unconfigured',
  message: configured() ? '等待同步' : '云同步尚未配置', lastSyncedAt: 0, owner: '',
  identityCheckedAt: 0, identityInvalid: false, revision: 0, publicationVersion: 0,
  publicationPending: false, publicationMessage: '', publicationErrorCode: ''};

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
function fail(message, invalidIdentity = false) {
  const error = new Error(message);
  error.userMessage = message;
  if (invalidIdentity) error.invalidIdentity = true;
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
function sameScope(a, b) { return !!a && !!b && a.kind === b.kind && a.id === b.id && a.membershipId === b.membershipId; }
function normalizedScope(value, actor) {
  if (value == null || value.kind === 'personal' && value.id === actor) return {kind: 'personal', id: actor};
  if (value.kind === 'family' && /^[a-f0-9]{64}$/.test(value.id || '') && /^[a-f0-9]{32}$/.test(value.membershipId || '')) {
    return {kind: 'family', id: value.id, membershipId: value.membershipId};
  }
  fail('家庭数据归属无法确认，请重新同步。', true);
}
function familyFile(fileID, scope, kind) {
  const match = typeof fileID === 'string' && /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/families\/([a-f0-9]{64})\/(snapshots|photos)\/([A-Za-z0-9_-]{1,160}\.(?:json|jpg|png|webp))$/.exec(fileID);
  return !!match && match[1] === config.env && scope && scope.kind === 'family' && match[3] === scope.id && match[4] === kind &&
    (kind === 'snapshots' ? /\.json$/.test(match[5]) : /\.(?:jpg|png|webp)$/.test(match[5]));
}
function reconcileFamilyPhotos(snapshot, remote, scope) {
  const currentPhotos = new Map(remote.data.recipes.map(recipe => [recipe.id, recipe.photo]));
  const referenced = new Set(currentPhotos.values());
  for (const recipe of snapshot.data.recipes) {
    // A family ID comes from an earlier cloud snapshot. A freshly selected
    // photo is still a local file or the uploader's own staging file.
    if (!familyFile(recipe.photo, scope, 'photos')) continue;
    if (currentPhotos.has(recipe.id)) recipe.photo = currentPhotos.get(recipe.id);
    else if (!referenced.has(recipe.photo)) recipe.photo = '';
  }
}
function checkResult(result, expectedOwner, expectedScope) {
  if (result && result.error) {
    const messages = {
      UNAUTHENTICATED: '未能识别当前微信账号，请在微信中重试。',
      INVALID_ENV: '云开发环境尚未配置完成。',
      INVALID_ACCOUNT: '云端账号数据暂时无法读取，本机数据已保留。',
      INVALID_FILE: '同步文件的账号归属不正确，本机数据已保留。',
      INVALID_SNAPSHOT: '云端未接受这份同步数据，本机数据已保留。请检查菜谱和照片后重试。',
      CLIENT_UPDATE_REQUIRED: '请更新小程序后同步，已有家庭和宝宝资料已保留。',
      FAMILY_CHANGED: '家庭成员资格已变化，请重新同步后再操作。',
      FAMILY_FORBIDDEN: '当前已无法访问这个家庭，请重新同步。',
      FAMILY_REQUIRED: '请先加入家庭。',
      INVALID_FAMILY: '家庭信息暂时无法读取，请稍后重试。'
    };
    fail(messages[result.error.code] || '云端同步暂时失败，本机数据已保留，请稍后重试。',
      ['UNAUTHENTICATED', 'ACCOUNT_CHANGED', 'FAMILY_CHANGED', 'FAMILY_FORBIDDEN'].includes(result.error.code));
  }
  const scope = result && typeof result.owner === 'string' ? normalizedScope(result.scope, result.owner) : null;
  if (!result || typeof result.owner !== 'string' || !/^[a-f0-9]{64}$/.test(result.owner) ||
    !Number.isSafeInteger(result.revision) || result.revision < 0 ||
    (result.revision === 0 ? result.fileID !== '' : !(scope.kind === 'family' ? familyFile(result.fileID, scope, 'snapshots') : ownedFile(result.fileID, result.owner, 'snapshots')))) {
    fail('未能确认云端账号与数据版本，本机数据已保留。', true);
  }
  if (expectedOwner && result.owner !== expectedOwner) fail('微信账号已切换，请重新同步当前账号。', true);
  if (expectedScope && !sameScope(expectedScope, scope)) fail('家庭已切换，请重新同步。', true);
  return {...result, scope};
}
async function invoke(data, owner) {
  const response = await call(wx.cloud, 'callFunction', {name: config.functionName || 'babyBitesSync', data: {...data, protocolVersion: 2}});
  return checkResult(response && response.result, owner, data.expectedScope);
}
function assertOwner(owner) {
  if (store.getSyncInfo().owner !== owner) fail('微信账号已切换，请重新同步当前账号。');
  const key = store.getSyncInfo().scopeKey || owner || '';
  if (synchronizingScopeKey !== null && key !== synchronizingScopeKey) fail('家庭已切换，本次同步已停止，请重新同步。', true);
  if (synchronizingEpoch !== null && synchronizingEpoch !== ownerEpoch) fail('账号或家庭已变化，本次同步已停止，请重新同步。', true);
}
function normalizeSnapshot(snapshot, owner, allowLocalPhotos, scope) {
  let clean;
  try { clean = store.validateSnapshot(snapshot); }
  catch (_) { fail('同步数据格式不正确，本机数据已保留。'); }
  if (clean.deleted.recipes.length > 10000 || clean.deleted.logs.length > 100000) {
    fail('删除记录超过云同步限制，本机数据已保留。');
  }
  clean.data.recipes.forEach(recipe => {
    if (!recipe.photo) return;
    if (recipe.photo.indexOf('cloud://') === 0) {
      if (!(scope && scope.kind === 'family' && familyFile(recipe.photo, scope, 'photos')) && !ownedFile(recipe.photo, owner, 'photos')) fail('照片不属于当前微信账号或家庭，请重新选择这张照片后同步。');
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
async function readDownloadedSnapshot(download, owner, scope, requireStatus = false) {
  const filePath = download && download.tempFilePath;
  try {
    assertOwner(owner);
    if (!filePath || (requireStatus ? download.statusCode !== 200 : download.statusCode != null && download.statusCode !== 200)) fail('同步文件下载未完成，请重试。');
    await checkSize(filePath, MAX_SNAPSHOT_BYTES);
    const result = await call(fs(), 'readFile', {filePath, encoding: 'utf8'});
    if (typeof result.data !== 'string' || byteLength(result.data) > MAX_SNAPSHOT_BYTES) fail('同步文件超过 5 MB，本机数据已保留。');
    let parsed;
    try { parsed = JSON.parse(result.data); } catch (_) { fail('同步文件无法读取，本机数据已保留。'); }
    assertOwner(owner);
    return normalizeSnapshot(parsed, owner, false, scope);
  } finally { await removeLocal(filePath); }
}
async function downloadSnapshot(fileID, owner) {
  if (!ownedFile(fileID, owner, 'snapshots')) fail('云端文件不属于当前微信账号，本机数据已保留。');
  return readDownloadedSnapshot(await call(wx.cloud, 'downloadFile', {fileID}), owner);
}
async function readFamilySnapshot(result, owner, scope) {
  assertOwner(owner);
  if (result.snapshot !== undefined) return normalizeSnapshot(result.snapshot, owner, false, scope);
  if (typeof result.snapshotURL !== 'string' || result.snapshotURL.length > 8192 || !/^https:\/\/[^\s]+$/.test(result.snapshotURL)) {
    fail('家庭数据下载地址无效，请重新同步。');
  }
  // Large snapshots travel through an expiring authorized storage URL because
  // the mini-program cloud-function response is limited to 1 MiB.
  const download = await call(wx, 'downloadFile', {url: result.snapshotURL});
  return readDownloadedSnapshot(download, owner, scope, true);
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
    if (store.applySyncedSnapshot(snapshot, {owner, sequence, revision, scopeKey: synchronizingScopeKey}) === false) {
      fail('云端版本早于本机缓存，本机数据已保留，请稍后重试。');
    }
  }
  finally { internalStoreChange = false; }
}
async function synchronize() {
  publish({state: 'syncing', message: '正在同步当前微信账号的数据'});
  const identityEpoch = ownerEpoch;
  let remoteInfo = await invoke({action: 'identity'});
  if (identityEpoch !== ownerEpoch) fail('账号或家庭已切换，请重新同步。', true);
  const identityCheckedAt = Date.now();
  const owner = remoteInfo.owner;
  internalStoreChange = true;
  synchronizingScopeKey = null;
  synchronizingEpoch = null;
  try { store.bindAccount(owner); if (typeof store.bindScope === 'function') store.bindScope(owner, remoteInfo.scope); } finally { internalStoreChange = false; }
  synchronizingScopeKey = store.getSyncInfo().scopeKey || owner;
  synchronizingEpoch = ownerEpoch;
  const scope = remoteInfo.scope;
  publish({owner, scope, scopeKey: synchronizingScopeKey, identityCheckedAt, identityInvalid: false, revision: store.getSyncInfo().revision,
    lastSyncedAt: status.owner === owner ? status.lastSyncedAt : 0});
  const uploadedPhotos = new Map();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertOwner(owner);
    const localInfo = store.getSyncInfo();
    if (remoteInfo.revision < localInfo.revision) fail('云端版本早于本机缓存，本机数据已保留，请稍后重试。');
    if (!remoteInfo.fileID && !localInfo.hasLocalData) return;
    // An older parser may have discarded fields while saving this same revision.
    // Only skip a snapshot fully applied by the current parser and persisted with
    // its schema marker; upgrades must restore the complete remote data first.
    if (remoteInfo.fileID && !localInfo.dirty && localInfo.hasLocalData && localInfo.snapshotCurrent &&
      remoteInfo.revision === localInfo.revision) return;
    // Capture this sequence before any download or upload. applySyncedSnapshot
    // merges edits made during these awaits and leaves them pending for another pass.
    const local = normalizeSnapshot(store.getSyncSnapshot(), owner, true, scope);
    let remote;
    if (scope.kind === 'family' && remoteInfo.fileID) {
      remoteInfo = await invoke({action: 'familyRead', expectedOwner: owner, expectedScope: scope}, owner);
      assertOwner(owner);
      remote = await readFamilySnapshot(remoteInfo, owner, scope);
      assertOwner(owner);
      require('./family-photos').install(remoteInfo.photoURLs, synchronizingScopeKey);
    } else remote = remoteInfo.fileID ? await downloadSnapshot(remoteInfo.fileID, owner) : emptySnapshot();
    const snapshot = mergeSnapshots(local, remote, scope.kind === 'family');
    if (scope.kind === 'family') reconcileFamilyPhotos(snapshot, remote, scope);
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
      result = await invoke({action: 'commit', expectedOwner: owner, expectedScope: scope, baseRevision: remoteInfo.revision, fileID}, owner);
      if (!result.conflict && (result.revision !== remoteInfo.revision + 1 || scope.kind !== 'family' && result.fileID !== fileID)) {
        fail('云端尚未确认本次保存，本机数据已保留，请重试同步。');
      }
    } finally {
      // A timed-out commit may already have succeeded. Never delete its cloud file,
      // nor previously committed files that another device may still be reading.
      await removeLocal(filePath);
    }
    if (result.conflict) { remoteInfo = result; continue; }
    if (scope.kind === 'family') {
      if (result.snapshot === undefined && result.snapshotURL === undefined) result = await invoke({action: 'familyRead', expectedOwner: owner, expectedScope: scope}, owner);
      assertOwner(owner);
      const canonical = await readFamilySnapshot(result, owner, scope);
      assertOwner(owner);
      require('./family-photos').install(result.photoURLs, synchronizingScopeKey);
      apply(canonical, owner, localInfo.sequence, result.revision);
    } else apply(snapshot, owner, localInfo.sequence, result.revision);
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
  publish({publicationPending: false, publicationMessage: '', publicationErrorCode: ''});
  if (error && (error.invalidIdentity || error.code === 'ACCOUNT_CHANGED')) {
    publish({identityCheckedAt: 0, identityInvalid: true});
  }
  const networkError = disconnected || /network|timeout|timed out|offline|网络/i.test(error && (error.errMsg || error.message) || '');
  publish({state: networkError ? 'pending' : 'error', message: error && error.userMessage ||
    (networkError ? '等待联网同步，本机修改已保留。' : '同步暂未完成，本机数据已保留，请重试。')});
}
function syncNow(options = {}) {
  if (!configured()) {
    publish({state: 'unconfigured', message: '云同步尚未配置'});
    return Promise.resolve(getStatus());
  }
  const localInfo = store.getSyncInfo();
  const age = Date.now() - status.identityCheckedAt;
  if (options && options.ifNeeded === true && status.state === 'synced' &&
    lastSyncedEpoch === ownerEpoch && localInfo.owner && status.owner === localInfo.owner &&
    (!localInfo.hasLocalData || localInfo.snapshotCurrent) &&
    !localInfo.dirty && !localInfo.blocked && !disconnected && !status.identityInvalid &&
    age >= 0 && age < FOREGROUND_CHECK_INTERVAL) return Promise.resolve(getStatus());
  if (timer) { clearTimeout(timer); timer = null; }
  // Joining the current check does not request another one. Store changes still
  // queue a pass, and edits made without start() are detected by the dirty check.
  if (inFlight) return inFlight;
  if (disconnected) {
    publish({state: 'pending', message: '等待联网同步，本机修改已保留。'});
    return Promise.resolve(getStatus());
  }
  inFlight = Promise.resolve().then(async () => {
    initialize();
    let publicationError = null;
    do {
      queued = false;
      await synchronize();
      publish({revision: store.getSyncInfo().revision});
      if (!publicationError && config.socialEnabled === true && !store.getSyncInfo().dirty && !disconnected) {
        const owner = store.getSyncInfo().owner;
        const epoch = ownerEpoch;
        publish({message: '记录已保存，正在更新公开菜谱'});
        try {
          await publicationSync.syncPublished({owner, isCurrent: () =>
            store.getSyncInfo().owner === owner && ownerEpoch === epoch,
          onUpdated: () => publish({publicationVersion: status.publicationVersion + 1})});
        } catch (error) {
          if (!error || !error.publicationPending) throw error;
          // Finish private edits queued during a failed public update, without
          // retrying the same public failure in a loop. A later sync retries it.
          publicationError = error;
        }
      }
      // A change made before the captured snapshot may already be committed by
      // this pass. Only edits still pending need another private check.
      queued = store.getSyncInfo().dirty;
    } while (queued && !disconnected);
    lastSyncedEpoch = ownerEpoch;
    // Public discovery is a separate projection of the committed data. Its
    // failure must not block family reads or imply that baby records were lost.
    publish({state: store.getSyncInfo().dirty ? 'pending' : 'synced',
      message: store.getSyncInfo().dirty ? '本机修改等待同步' : publicationError ? publicationError.userMessage : '已同步当前微信账号',
      publicationPending: Boolean(publicationError), publicationMessage: publicationError ? publicationError.userMessage : '',
      publicationErrorCode: publicationError ? publicationError.code : '', lastSyncedAt: Date.now()});
  }).catch(error => {
    // A failing request never triggers its own retry loop. A later edit, reconnect,
    // foreground event or explicit retry can start a new attempt.
    queued = false;
    onFailure(error);
  }).then(() => { synchronizingScopeKey = null; synchronizingEpoch = null; inFlight = null; return getStatus(); });
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
      if (!disconnected) syncNow({ifNeeded: true});
      else if (!inFlight) publish({state: 'pending', message: '等待联网同步，本机修改已保留。'});
    });
  }
  return syncNow({ifNeeded: true});
}

module.exports = {start, syncNow, getStatus, subscribe};
