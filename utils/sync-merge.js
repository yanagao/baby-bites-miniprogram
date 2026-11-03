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

function mergeAllergies(local, remote) {
  const entry = data => data.allergies === undefined ? null :
    {allergies: data.allergies, updatedAt: data.allergiesUpdatedAt || 0};
  const a = entry(local), b = entry(remote);
  let selected = !a ? b : !b ? a : a.updatedAt > b.updatedAt ? a : b;
  if (a && b && a.updatedAt === b.updatedAt && stableJSON(a.allergies) !== stableJSON(b.allergies)) {
    // Two devices can save different settings in the same millisecond. Keep
    // every recorded food on a tie; only a strictly newer edit can remove one.
    // Never truncate an oversized union: callers retain their original data
    // when this throws, so the user can reconcile the records explicitly.
    const allergies = [...new Set(a.allergies.concat(b.allergies))].sort();
    if (allergies.length > 50) {
      const error = Error('过敏食物合并后超过 50 项，请先整理记录后重试。');
      error.userMessage = error.message;
      throw error;
    }
    selected = {allergies, updatedAt: a.updatedAt};
  }
  return selected ? copy({allergies: selected.allergies, allergiesUpdatedAt: selected.updatedAt}) : {};
}

function keepRemoteAttribution(merged, remote, field, family) {
  for (const item of remote) {
    const current = merged.get(item.id);
    if (!current || current[field] === item[field] || (!family && item[field] === undefined)) continue;
    const updated = {...current};
    if (item[field] === undefined) delete updated[field];
    else updated[field] = item[field];
    merged.set(item.id, updated);
  }
}

function mergeFamilyPhotos(recipes, local, remote, editedPhotoIds) {
  const edits = new Map(local.filter(recipe => editedPhotoIds.has(recipe.id)).map(recipe => [recipe.id, recipe.photo]));
  const remoteRecipes = new Map(remote.map(recipe => [recipe.id, recipe]));
  const referenced = new Set(remote.map(recipe => recipe.photo));
  for (const recipe of recipes.values()) {
    const current = remoteRecipes.get(recipe.id);
    let photo = current ? current.photo : recipe.photo;
    if (edits.has(recipe.id)) photo = edits.get(recipe.id);
    // A restore can bring back a no-longer-readable family file. The cloud
    // accepts only currently referenced family files or caller-owned uploads.
    if (/^cloud:\/\/[^/]+\/families\//.test(photo) && !referenced.has(photo)) photo = current ? current.photo : '';
    // Publishing compares the recipe timestamp. A photo edit merged into a
    // newer remote title must still produce a new public revision.
    const updatedAt = current && photo !== current.photo && timeOf(recipe) <= timeOf(current) ? timeOf(current) + 1 : recipe.updatedAt;
    if (recipe.photo !== photo || recipe.updatedAt !== updatedAt) recipes.set(recipe.id, {...recipe, photo, updatedAt});
  }
}

function mergeSnapshots(local, remote, family = false, editedPhotoIds) {
  const deletedRecipes = mergeTombstones(local.deleted.recipes, remote.deleted.recipes);
  const deletedLogs = mergeTombstones(local.deleted.logs, remote.deleted.logs);
  const recipes = mergeItems(local.data.recipes, remote.data.recipes, deletedRecipes);
  const logs = mergeItems(local.data.logs, remote.data.logs, deletedLogs);
  // Upload acknowledgements may add authoritative provenance while another
  // local edit is still pending. Keep that provenance even when content wins
  // a same-timestamp merge on the client.
  // On a family snapshot an absent field also carries information: the
  // historical attribution cannot be verified. Drop any cached backup claim.
  keepRemoteAttribution(recipes, remote.data.recipes, 'createdBy', family);
  keepRemoteAttribution(logs, remote.data.logs, 'recordedBy', family);
  if (family && editedPhotoIds) mergeFamilyPhotos(recipes, local.data.recipes, remote.data.recipes, editedPhotoIds);
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
  const birthday = data => data.babyBirthDate === undefined ? null :
    {babyBirthDate: data.babyBirthDate, updatedAt: data.babyBirthDateUpdatedAt || 0};
  const chosenBirthday = prefer(birthday(local.data), birthday(remote.data));
  return copy({version: 1, data: {version: 1, nickname: profile.nickname,
    profileUpdatedAt: profile.updatedAt, ...mergeAllergies(local.data, remote.data),
    ...(chosenBirthday ? {babyBirthDate: chosenBirthday.babyBirthDate, babyBirthDateUpdatedAt: chosenBirthday.updatedAt} : {}),
    recipes: sorted(recipes.values()), logs: sorted(logs.values())},
  deleted: {recipes: sorted(deletedRecipes.values()), logs: sorted(deletedLogs.values())}});
}

module.exports = {mergeSnapshots, mergeAllergies};
