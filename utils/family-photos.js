'use strict';

// This module is loaded by selectors while store itself is initializing.
// Store access must remain lazy to avoid a circular-module partial export.
const config = require('../config/cloud');
const TTL = 4 * 60 * 1000;
const cache = new Map(), flights = new Map(), failures = new Map(), listeners = new Set(), pending = new Set();
let scheduled = false;
let watched = false, currentKey = '', epoch = 0;
function context() {
  const store = require('./store');
  if (!watched) {
    watched = true;
    store.subscribe(info => {
      const key = info.scopeKey || info.owner || '';
      if (key !== currentKey) { currentKey = key; epoch++; cache.clear(); flights.clear(); failures.clear(); pending.clear(); notify(); }
    });
  }
  const info = store.getSyncInfo(), key = info.scopeKey || info.owner || '';
  if (key !== currentKey) { currentKey = key; epoch++; cache.clear(); flights.clear(); failures.clear(); pending.clear(); }
  return {owner: info.owner, scope: info.scope, key, epoch};
}
function validFile(fileID, scope) {
  if (!scope || scope.kind !== 'family' || typeof fileID !== 'string') return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/families\/([a-f0-9]{64})\/photos\/([A-Za-z0-9_-]{1,160}\.(?:jpg|png|webp))$/.exec(fileID);
  return !!match && match[1] === config.env && match[3] === scope.id;
}
function familyFile(value) { return typeof value === 'string' && /^cloud:\/\/[^/]+\/families\//.test(value); }
function isCurrent(session) { const now = context(); return session.key === now.key && session.epoch === now.epoch; }
function notify() { listeners.forEach(listener => {try { listener({scopeKey: currentKey}); } catch (_) {}}); }
function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function clear() { epoch++; cache.clear(); flights.clear(); failures.clear(); pending.clear(); notify(); }
function install(photoURLs, expectedScopeKey) {
  const session = context();
  if (expectedScopeKey && expectedScopeKey !== session.key || !photoURLs || typeof photoURLs !== 'object' || Array.isArray(photoURLs)) return;
  let changed = false;
  for (const [id, url] of Object.entries(photoURLs)) {
    if (!validFile(id, session.scope) || typeof url !== 'string' || url.length > 8000 || !/^https:\/\/[^\s/@]+(?:\/|$)/.test(url)) continue;
    cache.set(id, {url, expiresAt: Date.now() + TTL}); failures.delete(id); changed = true;
  }
  if (changed) notify();
}
async function ensure(fileIDs, options = {}) {
  const session = context();
  if (!session.scope || session.scope.kind !== 'family') return {};
  const ids = [...new Set((Array.isArray(fileIDs) ? fileIDs : []).filter(id => validFile(id, session.scope)))];
  const needed = ids.filter(id => options.force || (!failures.has(id) || failures.get(id) <= Date.now()) && (!cache.has(id) || cache.get(id).expiresAt <= Date.now()));
  for (let start = 0; start < needed.length; start += 20) {
    const batch = needed.slice(start, start + 20).sort(), key = session.key + ':' + batch.join('|');
    let work = flights.get(key);
    if (!work) {
      work = new Promise((resolve, reject) => {
        wx.cloud.callFunction({name: config.functionName || 'babyBitesSync', config: {env: config.env},
          data: {action: 'familyPhotos', protocolVersion: 2, expectedOwner: session.owner, expectedScope: session.scope, fileIDs: batch},
          success: resolve, fail: reject});
      }).then(response => {
        if (!isCurrent(session)) return;
        const result = response && response.result;
        if (!result || result.error || result.owner !== session.owner || !result.scope ||
          result.scope.id !== session.scope.id || result.scope.membershipId !== session.scope.membershipId || result.scope.kind !== 'family') {
          const error = Error('家庭照片暂时无法读取，请重新同步后重试。'); error.code = result && result.error && result.error.code; throw error;
        }
        install(result.photoURLs, session.key);
      }).catch(error => {
        if (isCurrent(session)) batch.forEach(id => failures.set(id, Date.now() + 30000));
        throw error;
      }).finally(() => { if (flights.get(key) === work) flights.delete(key); });
      flights.set(key, work);
    }
    await work;
    if (!isCurrent(session)) return {};
  }
  const result = {};
  for (const id of ids) { const entry = cache.get(id); if (entry && entry.expiresAt > Date.now()) result[id] = entry.url; }
  return result;
}
function photoURL(fileID) {
  if (!familyFile(fileID)) return fileID || '';
  const session = context();
  if (!validFile(fileID, session.scope)) return '';
  const entry = cache.get(fileID);
  if (entry && entry.expiresAt > Date.now()) return entry.url;
  if (entry) cache.delete(fileID);
  if (!failures.has(fileID) || failures.get(fileID) <= Date.now()) {
    pending.add(fileID);
    if (!scheduled) {
      scheduled = true;
      Promise.resolve().then(() => { scheduled = false; const ids = [...pending]; pending.clear(); return ensure(ids); }).catch(() => {});
    }
  }
  return '';
}
module.exports = {photoURL, ensure, refresh: ids => ensure(ids, {force: true}), subscribe, install, clear};
