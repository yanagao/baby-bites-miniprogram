'use strict';

const {ownedFile, validateSnapshot, reject} = require('./validate');
const hash = value => require('crypto').createHash('sha256').update(value).digest('hex');
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id32 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const sameScope = (left, right) => Boolean(left && right && left.kind === right.kind && left.id === right.id &&
  (left.kind !== 'family' || left.membershipId === right.membershipId));

function familyFile(fileID, env, familyId, kind) {
  if (!id64(familyId) || typeof fileID !== 'string' || fileID.length > 2000) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  const prefix = `families/${familyId}/${kind}/`;
  if (!match || match[1] !== env || !match[3].startsWith(prefix)) return false;
  const filename = match[3].slice(prefix.length);
  return kind === 'snapshots' ? /^[A-Za-z0-9_-]{1,160}\.json$/.test(filename) :
    kind === 'photos' && /^[A-Za-z0-9_-]{1,160}\.(?:jpg|png|webp)$/.test(filename);
}

function createReader({cloud, db = cloud.database({throwOnNotFound: false}), now = Date.now}) {
  const get = async (name, id) => (await db.collection(name).doc(id).get()).data;
  function identity(owner, env) {
    if (!id64(owner)) reject('分析授权的账号无效。', 'UNAUTHENTICATED');
    if (typeof env !== 'string' || !/^[A-Za-z0-9_-]+$/.test(env)) reject('云开发环境尚未配置完成。', 'INVALID_ENV');
  }
  async function resolve(owner, env) {
    identity(owner, env);
    const membership = await get('baby_bites_family_memberships', owner);
    if (!membership || membership.active === false) {
      if (membership && (membership._id !== undefined && membership._id !== owner ||
        !id64(membership.previousFamilyId) || !timestamp(membership.updatedAt))) {
        reject('家庭变更记录暂时无法验证，请重新同步。', 'INVALID_FAMILY');
      }
      // An initial personal grant must not revive after a join/leave cycle.
      const accessVersion = hash(JSON.stringify([owner, 'personal', membership ? membership.previousFamilyId : null,
        membership ? membership.updatedAt : null]));
      const account = await get('baby_bites_accounts', owner);
      const scope = {kind: 'personal', id: owner};
      if (!account) return {scope, accessVersion, revision: 0, fileID: '', updatedAt: 0};
      if (account._id !== undefined && account._id !== owner || !Number.isSafeInteger(account.revision) || account.revision < 1 ||
        !ownedFile(account.fileID, env, owner, 'snapshots') || account.updatedAt !== undefined && !timestamp(account.updatedAt)) {
        reject('账号的云端数据暂时无法读取。', 'INVALID_ACCOUNT');
      }
      return {scope, accessVersion, revision: account.revision, fileID: account.fileID, updatedAt: account.updatedAt || 0};
    }
    if (membership._id !== undefined && membership._id !== owner || !id64(membership.familyId) || !id32(membership.membershipId)) {
      reject('家庭成员资料暂时无法读取。', 'INVALID_FAMILY');
    }
    const family = await get('baby_bites_families', membership.familyId);
    if (!family || family._id !== membership.familyId || family.closed || !Array.isArray(family.members) ||
      !family.members.length || family.members.length > 20 ||
      !family.members.every(member => member && id64(member.owner) && id32(member.id) && id32(member.membershipId)) ||
      new Set(family.members.map(member => member.owner)).size !== family.members.length ||
      new Set(family.members.map(member => member.id)).size !== family.members.length ||
      !family.members.some(member => member.owner === family.managerOwner) ||
      !Number.isSafeInteger(family.revision) || family.revision < 1 ||
      !familyFile(family.fileID, env, family._id, 'snapshots') || family.updatedAt !== undefined && !timestamp(family.updatedAt)) {
      reject('家庭资料暂时无法读取。', 'INVALID_FAMILY');
    }
    const member = family.members.find(item => item.owner === owner && item.membershipId === membership.membershipId);
    if (!member) reject('家庭已发生变化，请重新授权。', 'SCOPE_CHANGED');
    // This resolver intentionally never invokes attribution upgrades or writes.
    return {scope: {kind: 'family', id: family._id, membershipId: member.membershipId},
      accessVersion: hash(JSON.stringify([owner, 'family', family._id, member.membershipId])),
      // family.updatedAt also changes for invitations and member settings. No
      // independent snapshot commit time is stored, so report it as unknown.
      revision: family.revision, fileID: family.fileID, updatedAt: 0};
  }
  async function assertCurrent(state, owner, env) {
    const current = await resolve(owner, env);
    if (!state || !sameScope(state.scope, current.scope) || state.accessVersion !== current.accessVersion) {
      reject('账号或家庭已变化，请重新授权。', 'SCOPE_CHANGED');
    }
    if (state.revision !== current.revision || state.fileID !== current.fileID) {
      reject('云端记录已有更新，请从第一页重新读取。', 'REVISION_CHANGED');
    }
    return current;
  }
  async function read(state, owner, env) {
    await assertCurrent(state, owner, env);
    if (state.revision === 0) return {version: 1, data: {version: 1, nickname: '宝宝', profileUpdatedAt: 0,
      recipes: [], logs: []}, deleted: {recipes: [], logs: []}};
    const family = state.scope.kind === 'family';
    if (!(family ? familyFile(state.fileID, env, state.scope.id, 'snapshots') : ownedFile(state.fileID, env, owner, 'snapshots'))) {
      reject('数据文件归属不正确。', 'INVALID_FILE');
    }
    const downloaded = await cloud.downloadFile({fileID: state.fileID});
    if (!downloaded || downloaded.statusCode != null && downloaded.statusCode !== 200) reject('云端记录暂时无法读取。', 'STORAGE_FAILED');
    const snapshot = validateSnapshot(downloaded.fileContent, {env, owner, now: now(), familyTombstones: family,
      ...(family ? {photoAllowed: fileID => familyFile(fileID, env, state.scope.id, 'photos')} : {})});
    await assertCurrent(state, owner, env);
    return snapshot;
  }
  return {resolve, read, assertCurrent};
}

module.exports = {createReader, sameScope, reject, ownedFile, familyFile};
