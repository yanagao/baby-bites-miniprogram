'use strict';
const config = require('../config/cloud');
const store = require('./store');
const cloudSync = require('./cloud-sync');
const TTL = 30000;
const transitions = new Map();
// These errors are returned before family creation commits. Network errors
// and generic backend failures can also occur after a successful commit.
const createRejections = new Set(['SYNC_REQUIRED', 'FAMILY_CONFLICT', 'FAMILY_CHANGED', 'ALREADY_IN_FAMILY',
  'INVALID_REQUEST', 'INVALID_SNAPSHOT', 'INVALID_FILE', 'CLIENT_UPDATE_REQUIRED']);
let cached = null, flight = null, epoch = 0;
let observedKey = store.getSyncInfo().scopeKey || store.getSyncInfo().owner || '';
store.subscribe(info => {
  const key = info.scopeKey || info.owner || '';
  if (key !== observedKey) { observedKey = key; epoch++; cached = null; flight = null; }
});
const messages = {
  FAMILY_CHANGED: '家庭成员资格已变化，请重新加载。', FAMILY_CONFLICT: '家庭信息已有更新，请重试。',
  FAMILY_REQUIRED: '请先创建或加入一个家庭。', FAMILY_FORBIDDEN: '你已无法操作这个家庭，请重新加载。',
  FAMILY_TRANSFER_REQUIRED: '请先转交家庭管理权限，再退出家庭。', FAMILY_MEMBER_LIMIT: '家庭成员已达到上限。',
  ALREADY_IN_FAMILY: '你已经加入家庭，请先退出当前家庭。', INVITE_INVALID: '邀请已失效或已被使用，请家人重新邀请。',
  SYNC_REQUIRED: '请先完成当前数据同步，再切换家庭。', ACCOUNT_CHANGED: '微信账号已切换，请重新打开。',
  CLIENT_UPDATE_REQUIRED: '请更新小程序后再使用家庭共享。', INVALID_REQUEST: '家庭信息不完整，请检查后重试。'
};
function fail(message, code) { const error = Error(message); error.code = code || 'FAMILY_ERROR'; error.userMessage = message; throw error; }
function session() { const info = store.getSyncInfo(); return {owner: info.owner, scope: info.scope || {kind: 'personal', id: info.owner}, key: info.scopeKey || info.owner, epoch, revision: info.revision, sequence: info.sequence}; }
function current(before) { const after = session(); return before.owner === after.owner && before.key === after.key && before.epoch === after.epoch; }
function assertCurrent(before) { if (!current(before)) fail('账号或家庭已切换，请重新打开。', 'ACCOUNT_CHANGED'); }
function sameScope(a, b) { return a && b && a.kind === b.kind && a.id === b.id && a.membershipId === b.membershipId; }
function cleanScope(value, owner) {
  if (value && value.kind === 'personal' && value.id === owner) return {kind: 'personal', id: owner};
  if (value && value.kind === 'family' && /^[a-f0-9]{64}$/.test(value.id || '') && /^[a-f0-9]{32}$/.test(value.membershipId || '')) {
    return {kind: 'family', id: value.id, membershipId: value.membershipId};
  }
  fail('家庭信息返回不完整，请重新加载。');
}
async function syncReady(force = false) {
  const previous = session();
  const result = await cloudSync.syncNow(force ? {} : {ifNeeded: true});
  const info = store.getSyncInfo();
  if (previous.owner && previous.owner !== info.owner) fail(messages.ACCOUNT_CHANGED, 'ACCOUNT_CHANGED');
  if (!result || result.state !== 'synced' || !info.owner || info.dirty || info.blocked || result.owner !== info.owner) fail(result && result.message || messages.SYNC_REQUIRED, 'SYNC_REQUIRED');
  return session();
}
function lockSynced(before) {
  const release = typeof store.beginScopeChange === 'function' ? store.beginScopeChange() : () => {};
  try {
    assertCurrent(before);
    const info = store.getSyncInfo();
    // A queued edit can finish after syncReady's check but before this lock.
    // Recheck inside the lock so no pending local data is left behind on exit.
    if (info.dirty || info.blocked || info.sequence !== before.sequence || info.revision !== before.revision) {
      fail(messages.SYNC_REQUIRED, 'SYNC_REQUIRED');
    }
    return release;
  } catch (error) { release(); throw error; }
}
async function request(action, input, before, allowScopeChange = false) {
  assertCurrent(before);
  let response;
  try {
    response = await new Promise((resolve, reject) => wx.cloud.callFunction({name: config.functionName || 'babyBitesSync', config: {env: config.env},
      data: {...input, action, protocolVersion: 2, expectedOwner: before.owner, expectedScope: input.expectedScope || before.scope},
      success: resolve, fail: reject}));
  } catch (_) { assertCurrent(before); fail('家庭共享暂时连接不上，请检查网络后重试。', 'NETWORK'); }
  assertCurrent(before);
  const result = response && response.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('家庭信息返回不完整，请重试。');
  if (result.error) fail(messages[result.error.code] || result.error.message || '家庭操作暂未完成，请稍后重试。', result.error.code);
  if (result.owner !== before.owner) fail(messages.ACCOUNT_CHANGED, 'ACCOUNT_CHANGED');
  const scope = cleanScope(result.scope, before.owner);
  if (!allowScopeChange && !sameScope(scope, before.scope)) fail(messages.FAMILY_CHANGED, 'FAMILY_CHANGED');
  return {...result, scope};
}
async function info(options = {}) {
  const before = await syncReady(false);
  if (!options.force && cached && cached.key === before.key && cached.expiresAt > Date.now()) return JSON.parse(cached.json);
  if (!options.force && flight && flight.key === before.key) return flight.work;
  const work = request('familyState', {}, before).then(result => {
    assertCurrent(before); cached = {key: before.key, json: JSON.stringify(result), expiresAt: Date.now() + TTL}; return result;
  }).finally(() => { if (flight && flight.work === work) flight = null; });
  flight = {key: before.key, work};
  return work;
}
const newId = () => 'family-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
let mutation = null;
async function mutate(action, input = {}, transition = false) {
  const initial = session(), signature = initial.owner + ':' + action + ':' + JSON.stringify(input);
  if (mutation) {
    if (mutation.signature === signature) return mutation.work;
    fail('另一项家庭操作还未完成，请稍后重试。', 'FAMILY_BUSY');
  }
  const priorAttempt = transitions.get(signature);
  const work = (async () => {
    const before = await syncReady(true);
    // A same-account family change is not consent to apply an old page action
    // to the newly selected family. Only a known idempotent retry may retain its
    // old expectedScope and let the server resolve the exact earlier request.
    if (initial.owner && !current(initial) && !priorAttempt) fail(messages.FAMILY_CHANGED, 'FAMILY_CHANGED');
    const release = lockSynced(before);
    const key = signature;
    let attempt = transitions.get(key);
    if (transition && !attempt) {
      attempt = {requestId: input.requestId || newId(), expectedScope: before.scope, baseRevision: before.revision};
      if (transitions.size >= 32) transitions.delete(transitions.keys().next().value);
      transitions.set(key, attempt);
    }
    try {
      const result = await request(action, {...input, ...(attempt || {})}, before, transition).catch(error => {
        if (action === 'familyCreate' && createRejections.has(error.code)) transitions.delete(key);
        throw error;
      });
      cached = null;
      // The backend has committed the transition. Only a new trusted identity
      // read selects the local scope; never merge data from the previous one.
      let synced = await cloudSync.syncNow();
      // A foreground sync may have started before the management transaction
      // finished. Joining it is safe, but it may still describe the old scope.
      // Once it finishes, perform one fresh identity check for the known result.
      if (store.getSyncInfo().owner === before.owner && !sameScope(store.getSyncInfo().scope, result.scope)) synced = await cloudSync.syncNow();
      if (!synced || synced.state !== 'synced' || store.getSyncInfo().owner !== before.owner ||
        !sameScope(store.getSyncInfo().scope, result.scope)) fail('家庭操作已完成，数据尚未同步，请重新加载。', 'SYNC_REQUIRED');
      transitions.delete(key);
      return result;
    } finally { release(); }
  })();
  mutation = {signature, work};
  try { return await work; } finally { if (mutation && mutation.work === work) mutation = null; }
}
function create(input = {}) { return mutate('familyCreate', {name: input.name, roleLabel: input.roleLabel || input.label,
  ...(input.requestId ? {requestId: input.requestId} : {})}, true); }
async function invite() {
  const initial = session(), before = await syncReady();
  if (initial.owner) assertCurrent(initial);
  const release = lockSynced(before);
  try { return await request('familyInvite', {}, before); } finally { release(); }
}
async function preview(token) { const before = await syncReady(); return request('familyPreview', {token}, before); }
function join(input = {}) { return mutate('familyJoin', {token: input.token, roleLabel: input.roleLabel || input.label,
  ...(input.requestId ? {requestId: input.requestId} : {})}, true); }
function changeRole(input = {}) { return mutate('familyRole', {roleLabel: input.roleLabel || input.label}); }
function remove(memberId) { return mutate('familyRemove', {memberId}); }
function transfer(memberId) { return mutate('familyTransfer', {memberId}); }
function leave() { return mutate('familyLeave', {}, true); }
module.exports = {info, getState: info, create, invite, createInvite: invite, preview, join, changeRole, setRole: changeRole, remove, transfer, leave, syncReady};
