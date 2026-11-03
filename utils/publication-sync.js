'use strict';

const config = require('../config/cloud');
const store = require('./store');
const PENDING_MESSAGE = '记录已同步，公开菜谱暂未更新，请稍后重试。';
const MAX_BATCHES = 250;

function fail(code) {
  const identityMessages = {ACCOUNT_CHANGED: '微信账号已切换，请重新同步当前账号。',
    FAMILY_CHANGED: '家庭已变化，请重新同步后重试。', UNAUTHENTICATED: '未能确认微信账号，请重新同步。'};
  const error = Error(identityMessages[code] || (code === 'INVALID_REQUEST'
    ? '记录已同步，公开菜谱服务需要更新，请稍后重试。' : PENDING_MESSAGE));
  error.code = code || 'PUBLICATION_SYNC_FAILED';
  error.userMessage = error.message;
  error.invalidIdentity = Boolean(identityMessages[code]);
  error.publicationPending = !error.invalidIdentity;
  throw error;
}

// Do not call social.js here: publishing there waits for private cloud sync.
// This helper runs after that sync. The server automatically publishes the
// actor's user-created recipes, updates existing publications and removes deleted
// ones. Built-ins, copied sources and private baby records stay out of the feed.
async function syncPublished({owner, isCurrent, onUpdated}) {
  if (config.socialEnabled !== true) return {updated: 0, removed: 0};
  const scope = store.getSyncInfo().scope;
  const scopeKey = store.getSyncInfo().scopeKey;
  let updated = 0, removed = 0;
  const invalidate = () => { if (typeof onUpdated === 'function') onUpdated(); };
  const check = () => {
    if (!owner || store.getSyncInfo().owner !== owner || store.getSyncInfo().scopeKey !== scopeKey || !isCurrent()) fail('ACCOUNT_CHANGED');
  };
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    check();
    // Finish a new local edit first. cloud-sync will commit it and start another
    // reconciliation pass, instead of continuing to share an older snapshot.
    if (store.getSyncInfo().dirty) return {updated, removed};
    let response;
    try {
      response = await new Promise((resolve, reject) => wx.cloud.callFunction({
        name: 'babyBitesSocial', config: {env: config.env},
        data: {action: 'syncPublications', expectedOwner: owner, ...(scope ? {expectedScope: scope, protocolVersion: 2} : {})}, success: resolve, fail: reject
      }));
    } catch (_) {
      check();
      // A lost response can follow a successful server write.
      invalidate();
      fail('NETWORK');
    }
    check();
    const result = response && response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail();
    const countsValid = Number.isSafeInteger(result.updated) && result.updated >= 0 &&
      Number.isSafeInteger(result.removed) && result.removed >= 0 && result.updated + result.removed <= 8;
    if (countsValid && result.updated + result.removed) {
      updated += result.updated;
      removed += result.removed;
      invalidate();
    }
    if (result.error) fail(result.error.code);
    if (!countsValid || typeof result.hasMore !== 'boolean') fail();
    if (!result.hasMore) return {updated, removed};
    if (!result.updated && !result.removed) fail();
  }
  // Bound work even if other devices continuously change the snapshot. Completed
  // batches remain saved and the next foreground/reconnect retries the rest.
  fail();
}

module.exports = {syncPublished};
