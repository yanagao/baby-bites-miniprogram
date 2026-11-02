'use strict';

const config = require('../config/cloud');
const store = require('./store');
const PENDING_MESSAGE = '本机修改已保存，菜谱暂未同步完成，请联网后重试。';
const MAX_BATCHES = 250;

function fail(code) {
  const error = Error(code === 'ACCOUNT_CHANGED' ? '微信账号已切换，请重新同步当前账号。' : PENDING_MESSAGE);
  error.code = code || 'PUBLICATION_SYNC_FAILED';
  error.userMessage = error.message;
  error.publicationPending = code !== 'ACCOUNT_CHANGED';
  throw error;
}

// Do not call social.js here: publishing there waits for private cloud sync.
// This helper runs after that sync. The server updates only recipes previously
// shared by explicit confirmation and removes deleted ones. It must never turn
// a private save/import/meal record into a new publication.
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
