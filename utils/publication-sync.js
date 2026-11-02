'use strict';

const config = require('../config/cloud');
const store = require('./store');
const PENDING_MESSAGE = '菜谱已保存，公开内容暂未同步，请联网后重试。';

function fail(code) {
  const error = Error(code === 'ACCOUNT_CHANGED' ? '微信账号已切换，请重新同步当前账号。' : PENDING_MESSAGE);
  error.code = code || 'PUBLICATION_SYNC_FAILED';
  error.userMessage = error.message;
  error.publicationPending = code !== 'ACCOUNT_CHANGED';
  throw error;
}

// Do not call social.js here: publishing there waits for private cloud sync.
// This helper runs after that sync, and only asks the server to update existing
// publications from its own committed snapshot. No recipe content is submitted.
async function syncPublished({owner, isCurrent, onUpdated}) {
  if (config.socialEnabled !== true) return {updated: 0};
  const check = () => {
    if (!owner || store.getSyncInfo().owner !== owner || !isCurrent()) fail('ACCOUNT_CHANGED');
  };
  async function request(action, data = {}) {
    check();
    let response;
    try {
      response = await new Promise((resolve, reject) => wx.cloud.callFunction({
        name: 'babyBitesSocial', config: {env: config.env},
        data: {...data, action, expectedOwner: owner}, success: resolve, fail: reject
      }));
    } catch (_) { check(); fail('NETWORK'); }
    check();
    const result = response && response.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) fail();
    if (result.error) fail(result.error.code);
    return result;
  }
  const mine = await request('mine');
  if (!mine.profile || typeof mine.profile.exists !== 'boolean' || !Array.isArray(mine.published) ||
    !mine.published.every(item => item && /^[a-f0-9]{64}$/.test(item.id || '') &&
      typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim() &&
      Number.isSafeInteger(item.sourceUpdatedAt) && item.sourceUpdatedAt >= 0)) fail();
  const visited = new Set();
  let updated = 0;
  for (const publication of mine.published) {
    check();
    const id = publication.sourceRecipeId;
    if (visited.has(id)) continue;
    visited.add(id);
    const recipe = store.getState().recipes.find(item => item.id === id);
    if (!recipe || publication.sourceUpdatedAt === (recipe.updatedAt || recipe.createdAt || 0)) continue;
    const result = await request('updatePublished', {sourceRecipeId: id});
    if (typeof result.updated !== 'boolean') fail();
    if (result.updated) {
      updated++;
      // Report each completed update even if a later publication fails.
      if (typeof onUpdated === 'function') onUpdated();
    }
  }
  return {updated};
}

module.exports = {syncPublished};
