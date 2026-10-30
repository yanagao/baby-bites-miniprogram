'use strict';

const APPID = 'wxc6c61fbebebe3340';
const ENV = 'cloud1-5gxmasdl05652531';
const VERSION = 'recipe-covers-v1';
const URL_TTL_SECONDS = 3600;
const RESULT_TTL_MS = 55 * 60 * 1000;
const CACHE_TTL_MS = 50 * 60 * 1000;
const RECIPE_IDS = Object.freeze([
  'pumpkin-millet', 'tomato-beef-noodle', 'broccoli-potato', 'carrot-chicken',
  'yam-red-date', 'spinach-egg-pancake', 'salmon-vegetable', 'banana-oat-pancake',
  'chicken-tofu-patty', 'carrot-beef-steamed-patty', 'cabbage-pork-soft-meatball',
  'pumpkin-oat-steamed-cake', 'apple-yam-steamed-cake', 'sweet-potato-soft-bun',
  'pumpkin-steamed-egg', 'spinach-tofu-steamed-egg', 'salmon-tofu-steamed-patty',
  'potato-beef-thick-soup', 'tomato-egg-tofu-soup', 'winter-melon-chicken-stew',
  'broccoli-carrot-soft-fingers'
]);
const KEYS = new Set(RECIPE_IDS.map(id => 'dish:' + id));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = code => ({error: {code, message: code === 'INVALID_REQUEST' ? '不支持的图片请求。' :
  code === 'UNAUTHENTICATED' ? '暂时无法确认当前微信账号。' :
    code === 'INVALID_ENV' ? '图片服务环境不正确。' : '默认菜谱图片暂时无法加载，请稍后重试。'}});

function readManifest(manifest) {
  if (!object(manifest) || manifest.version !== VERSION || manifest.env !== ENV ||
    !Array.isArray(manifest.files) || manifest.files.length !== RECIPE_IDS.length) throw Error('Invalid catalog');
  const seen = new Set();
  const entries = manifest.files.map(file => {
    if (!object(file) || !KEYS.has(file.key) || seen.has(file.key) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(file.md5) ||
      !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 200 * 1024 ||
      typeof file.fileID !== 'string' || file.fileID.length > 1000) throw Error('Invalid catalog item');
    const cloudPath = 'public/recipe-covers/v1/' + file.key.slice(5) + '-' + file.sha256.slice(0, 16) + '.jpg';
    const match = /^cloud:\/\/([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\/(.+)$/.exec(file.fileID);
    if (!match || match[1] !== ENV || match[3] !== cloudPath) throw Error('Invalid catalog path');
    seen.add(file.key);
    return Object.freeze({key: file.key, sha256: file.sha256, md5: file.md5,
      bytes: file.bytes, fileID: file.fileID, cloudPath});
  });
  return Object.freeze(entries);
}

function safeAssetURL(value, cloudPath) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash &&
      (!url.port || url.port === '443') &&
      (/^[a-z0-9-]+\.tcb\.qcloud\.la$/i.test(host) ||
        /^[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com(?:\.cn)?$/i.test(host)) &&
      decodeURIComponent(url.pathname) === '/' + cloudPath;
  } catch (_) { return false; }
}

const cloneResult = value => ({version: value.version, expiresAt: value.expiresAt,
  files: value.files.map(file => Object.assign({}, file))});

function createHandler({cloud, manifest, now = Date.now}) {
  let entries;
  try { entries = readManifest(manifest); } catch (_) { /* Fail closed until the deployment catalog is complete. */ }
  let cached = null;
  let pending = null;

  async function signCatalog() {
    const startedAt = now();
    const response = await cloud.getTempFileURL({fileList: entries.map(file => ({fileID: file.fileID, maxAge: URL_TTL_SECONDS}))});
    if (!response || !Array.isArray(response.fileList) || response.fileList.length !== entries.length) throw Error('Incomplete catalog');
    const received = new Map();
    for (const file of response.fileList) {
      if (!object(file) || typeof file.fileID !== 'string' || received.has(file.fileID)) throw Error('Duplicate catalog response');
      received.set(file.fileID, file);
    }
    const files = entries.map(entry => {
      const file = received.get(entry.fileID);
      if (!file || file.status !== 0 || !safeAssetURL(file.tempFileURL, entry.cloudPath) ||
        (file.maxAge !== undefined && (!Number.isFinite(file.maxAge) || file.maxAge < RESULT_TTL_MS / 1000))) {
        throw Error('Invalid catalog response');
      }
      return {key: entry.key, url: file.tempFileURL, sha256: entry.sha256, md5: entry.md5, bytes: entry.bytes};
    });
    // Keep the original expiry on cache hits; never extend a signed URL's lifetime.
    const result = {version: VERSION, expiresAt: startedAt + RESULT_TTL_MS, files};
    if (now() >= startedAt + CACHE_TTL_MS) throw Error('Expired catalog response');
    cached = {result, refreshAt: startedAt + CACHE_TTL_MS};
    return result;
  }

  return async event => {
    try {
      const context = cloud.getWXContext();
      if (!context || context.APPID !== APPID || typeof context.OPENID !== 'string' || !context.OPENID.trim()) {
        return failure('UNAUTHENTICATED');
      }
      if (context.ENV !== ENV) return failure('INVALID_ENV');
      // WeChat appends userInfo and tcbContext. Both are deliberately ignored:
      // only getWXContext above can authorize this request.
      if (!object(event) || event.action !== 'catalog' || !Object.prototype.hasOwnProperty.call(event, 'action') ||
        Object.keys(event).some(key => key !== 'action' && key !== 'userInfo' && key !== 'tcbContext')) {
        return failure('INVALID_REQUEST');
      }
      if (!entries) return failure('ASSETS_UNAVAILABLE');
      if (cached && now() < cached.refreshAt) return cloneResult(cached.result);
      if (!pending) pending = signCatalog().finally(() => { pending = null; });
      return cloneResult(await pending);
    } catch (_) {
      return failure('ASSETS_UNAVAILABLE');
    }
  };
}

let handler;
exports.main = async event => {
  try {
    if (!handler) {
      const cloud = require('wx-server-sdk');
      cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
      handler = createHandler({cloud, manifest: require('./manifest.json')});
    }
    return await handler(event);
  } catch (_) { return failure('ASSETS_UNAVAILABLE'); }
};
exports.createHandler = createHandler;
