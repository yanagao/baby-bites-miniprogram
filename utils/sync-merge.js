'use strict';

// This module is shared with the cloud function. It deliberately has no wx or SDK dependency.
const copy = value => JSON.parse(JSON.stringify(value));
const timeOf = value => {
  // Unedited starter recipes must not overrule a cloud edit or deletion merely
  // because this device initialized its examples more recently.
  if (value && value.isExample === true && !value.updatedAt) return 0;
  return Number(value && (value.updatedAt || value.createdAt)) || 0;
};

function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prefer(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (timeOf(a) !== timeOf(b)) return timeOf(a) > timeOf(b) ? a : b;
  // Uploading a local image changes only its location, never the edit timestamp.
  const cloudA = typeof a.photo === 'string' && a.photo.indexOf('cloud://') === 0;
  const cloudB = typeof b.photo === 'string' && b.photo.indexOf('cloud://') === 0;
  if (cloudA !== cloudB) return cloudA ? a : b;
  return stableJSON(a) >= stableJSON(b) ? a : b;
}

function mergeTombstones(a, b) {
  const deleted = new Map();
  (a || []).concat(b || []).forEach(item => deleted.set(item.id, prefer(deleted.get(item.id), item)));
  return deleted;
}

function mergeItems(a, b, deleted) {
  const entries = new Map();
  (a || []).concat(b || []).forEach(item => entries.set(item.id, prefer(entries.get(item.id), item)));
  deleted.forEach((tombstone, id) => {
    const current = entries.get(id);
    if (current && timeOf(tombstone) >= timeOf(current)) entries.delete(id);
  });
  return entries;
}

function sorted(values) { return Array.from(values).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

function mergeSnapshots(local, remote) {
  const deletedRecipes = mergeTombstones(local.deleted.recipes, remote.deleted.recipes);
  const deletedLogs = mergeTombstones(local.deleted.logs, remote.deleted.logs);
  const recipes = mergeItems(local.data.recipes, remote.data.recipes, deletedRecipes);
  const logs = mergeItems(local.data.logs, remote.data.logs, deletedLogs);
  // A record cannot survive removal of the recipe it belongs to, even when the
  // record was added offline after the recipe was deleted on another device.
  logs.forEach((log, id) => {
    if (!recipes.has(log.recipeId)) {
      logs.delete(id);
      const recipeDeletion = deletedRecipes.get(log.recipeId);
      deletedLogs.set(id, {id, updatedAt: Math.max(timeOf(log), timeOf(deletedLogs.get(id)), timeOf(recipeDeletion))});
    }
  });
  const localProfile = {nickname: local.data.nickname, updatedAt: local.data.profileUpdatedAt || 0};
  const remoteProfile = {nickname: remote.data.nickname, updatedAt: remote.data.profileUpdatedAt || 0};
  let profile = prefer(localProfile, remoteProfile);
  if (!localProfile.updatedAt && !remoteProfile.updatedAt) {
    if (localProfile.nickname === '宝宝' && remoteProfile.nickname !== '宝宝') profile = remoteProfile;
    else if (remoteProfile.nickname === '宝宝' && localProfile.nickname !== '宝宝') profile = localProfile;
  }
  return copy({version: 1, data: {version: 1, nickname: profile.nickname,
    profileUpdatedAt: profile.updatedAt, recipes: sorted(recipes.values()), logs: sorted(logs.values())},
  deleted: {recipes: sorted(deletedRecipes.values()), logs: sorted(deletedLogs.values())}});
}

module.exports = {mergeSnapshots};
