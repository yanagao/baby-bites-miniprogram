'use strict';

const catalog = require('../data/recipe-cover-catalog');
const config = require('../config/cloud');
const TIMEOUT_MS = 10000;
const MAX_URL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const entries = catalog.files;
const byKey = new Map(entries.map(item => [item.key, item]));
const local = new Map();
const remote = new Map();
const listeners = new Set();
let pending = null;

function runtime() { return typeof wx !== 'undefined'; }

function getSource(key) {
  if (!runtime() || !byKey.has(key)) return '';
  if (local.has(key)) return local.get(key);
  const item = remote.get(key);
  return item && item.verified && item.expiresAt > Date.now() ? item.url : '';
}

function isReady() {
  return runtime() && entries.length > 0 && entries.every(item => local.has(item.key));
}

function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(key, before) {
  const source = getSource(key);
  if (source === before) return;
  for (const listener of listeners) {
    try { listener({key, source}); } catch (_) { /* Presentation listeners are independent. */ }
  }
}

// This cache owns only content-addressed files below its dedicated directory.
// No private photos, storage keys, recipe objects or backup files are touched.
function paths() {
  const root = runtime() && wx.env && wx.env.USER_DATA_PATH;
  if (typeof root !== 'string' || !root || /[\u0000\r\n]/.test(root)) return null;
  return {root: root.replace(/\/$/, ''), directory: root.replace(/\/$/, '') + '/recipe-covers-v1'};
}

function fileSystem() {
  try { return runtime() && typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null; }
  catch (_) { return null; }
}

// Callback APIs and cloud promises both settle once. Timed-out downloads abort;
// any late callback or promise rejection is consumed without publishing state.
function call(target, method, options) {
  if (!target || typeof target[method] !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false, task;
    const timer = setTimeout(() => {
      finish(null);
      try { if (task && typeof task.abort === 'function') task.abort(); } catch (_) {}
    }, TIMEOUT_MS);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    try {
      task = target[method]({...options, success: value => finish(value || {}), fail: () => finish(null)});
      if (task && typeof task.then === 'function') task.then(value => finish(value || {}), () => finish(null));
    } catch (_) { finish(null); }
  });
}

function validURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\\u0000-\u001f]/.test(value)) return false;
  const match = /^https:\/\/([a-z0-9.-]+)(?::(443))?(\/[^#]*)?$/i.exec(value);
  if (!match) return false;
  const host = match[1].toLowerCase();
  if (!host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))) return false;
  return /(?:^|\.)tcb\.qcloud\.la$/.test(host) ||
    /^[a-z0-9-]+\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/.test(host) ||
    /^[a-z0-9-]+\.cos\.myqcloud\.com$/.test(host) ||
    /(?:^|\.)file\.myqcloud\.com$/.test(host) ||
    /(?:^|\.)tencentcdn\.cn$/.test(host);
}

function validInfo(info, item) {
  return info && info.size === item.bytes && typeof info.digest === 'string' &&
    info.digest.toLowerCase() === item.md5;
}

async function pool(items, action) {
  let index = 0;
  await Promise.all(Array.from({length: Math.min(3, items.length)}, async () => {
    while (index < items.length) {
      const item = items[index++];
      try { await action(item); } catch (_) { /* Other images can still become available. */ }
    }
  }));
}

async function readLocal(fs, locations) {
  await pool(entries, async item => {
    const before = getSource(item.key);
    const filePath = locations && locations.directory + '/' + item.sha256 + '.jpg';
    const info = filePath && await call(fs, 'getFileInfo', {filePath, digestAlgorithm: 'md5'});
    if (validInfo(info, item)) local.set(item.key, filePath);
    else local.delete(item.key);
    changed(item.key, before);
  });
}

async function readCatalog() {
  const response = await call(wx.cloud, 'callFunction', {
    name: 'babyBitesAssets', config: {env: config.env}, data: {action: 'catalog'}
  });
  const value = response && response.result;
  const now = Date.now();
  if (!value || value.version !== catalog.version || !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now || value.expiresAt > now + MAX_URL_LIFETIME_MS ||
    !Array.isArray(value.files) || value.files.length > entries.length) return;
  const seen = new Set();
  for (const item of value.files) {
    if (!item || typeof item !== 'object' || seen.has(item.key)) continue;
    seen.add(item.key);
    const expected = byKey.get(item.key);
    if (!expected || item.sha256 !== expected.sha256 || item.md5 !== expected.md5 ||
      item.bytes !== expected.bytes || !validURL(item.url)) continue;
    const before = getSource(item.key);
    remote.set(item.key, {url: item.url, expiresAt: value.expiresAt, verified: false});
    changed(item.key, before);
  }
}

function discardRemote(key) {
  const before = getSource(key);
  remote.delete(key);
  changed(key, before);
}

async function cacheImage(item, fs, locations) {
  const source = remote.get(item.key);
  if (!source || source.expiresAt <= Date.now()) return;
  const download = await call(wx, 'downloadFile', {url: source.url, timeout: TIMEOUT_MS});
  if (!download) { discardRemote(item.key); return; }
  const temporary = download.tempFilePath;
  if (download.statusCode !== 200 || typeof temporary !== 'string' || !temporary ||
    temporary === locations.root || temporary.startsWith(locations.root + '/')) {
    discardRemote(item.key); return;
  }
  const info = await call(fs, 'getFileInfo', {filePath: temporary, digestAlgorithm: 'md5'});
  if (!validInfo(info, item)) { discardRemote(item.key); return; }
  const beforeRemote = getSource(item.key);
  source.verified = true;
  changed(item.key, beforeRemote);
  const destination = locations.directory + '/' + item.sha256 + '.jpg';
  if (!await call(fs, 'copyFile', {srcPath: temporary, destPath: destination})) return;
  const saved = await call(fs, 'getFileInfo', {filePath: destination, digestAlgorithm: 'md5'});
  if (!validInfo(saved, item)) return;
  const before = getSource(item.key);
  local.set(item.key, destination);
  changed(item.key, before);
}

async function attempt() {
  if (!runtime()) return false;
  for (const [key, value] of remote) {
    if (value.expiresAt <= Date.now()) {
      const before = local.get(key) || (value.verified ? value.url : '');
      remote.delete(key);
      changed(key, before);
    }
  }
  const fs = fileSystem(), locations = paths();
  await readLocal(fs, locations);
  if (isReady()) return true;
  await readCatalog();
  // HTTPS remains usable when the device cannot persist a static cache.
  if (!locations || !fs || typeof fs.getFileInfo !== 'function' || typeof fs.copyFile !== 'function') return false;
  const missing = entries.filter(item => !local.has(item.key) && remote.has(item.key) &&
    remote.get(item.key).expiresAt > Date.now());
  if (!missing.length) return false;
  await call(fs, 'mkdir', {dirPath: locations.directory, recursive: true});
  await pool(missing, item => cacheImage(item, fs, locations));
  return isReady();
}

function prepare() {
  if (pending) return pending;
  pending = Promise.resolve().then(attempt).catch(() => false).then(ready => {
    pending = null;
    return ready;
  });
  return pending;
}

module.exports = {isReady, prepare, getSource, subscribe};
