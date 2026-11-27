'use strict';

const config = require('../config/cloud');
const store = require('./store');
const scopeKey = info => JSON.stringify([info.owner || '', info.scope || null, info.scopeKey || '']);
let epoch = 0;
let observedKey = scopeKey(store.getSyncInfo());
store.subscribe(info => {
  const key = scopeKey(info);
  if (key !== observedKey) { observedKey = key; epoch++; }
});
const messages = {
  ACCOUNT_CHANGED: '微信账号已切换，请重新打开授权页面。',
  FAMILY_CHANGED: '家庭成员资格已变化，请重新打开授权页面。',
  SCOPE_CHANGED: '当前宝宝或家庭已变化，请重新打开授权页面。',
  REVISION_CHANGED: '云端记录已有更新，请重新获取授权状态。',
  UNAUTHENTICATED: '请先在设置中完成微信账号同步，再管理外部 AI 授权。',
  SYNC_REQUIRED: '还没有可读取的云端记录，请先在设置中同步。',
  API_NOT_CONFIGURED: '外部访问地址尚未配置，请稍后再试。',
  RATE_LIMITED: '请求较频繁，请稍后再试。'
};
function fail(message, code = 'ANALYSIS_FAILED') {
  const error = Error(message); error.code = code; throw error;
}
function session() {
  const info = store.getSyncInfo();
  return {owner: info.owner || '', scope: info.scope || {kind: 'personal', id: info.owner || ''}, key: scopeKey(info), epoch, blocked: info.blocked};
}
function assertCurrent(before) {
  const after = session();
  if (before.owner !== after.owner || before.key !== after.key || before.epoch !== after.epoch) fail(messages.ACCOUNT_CHANGED, 'ACCOUNT_CHANGED');
  if (after.blocked) fail(messages.SYNC_REQUIRED, 'SYNC_REQUIRED');
}
function sameScope(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id && a.membershipId === b.membershipId);
}
function httpsBase(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1000 || !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value)) fail('接口地址返回不正确，请稍后重试。');
  return value.replace(/\/+$/, '');
}
function statusResult(result) {
  const grant = result.grant;
  if (grant != null && (typeof grant !== 'object' || typeof grant.active !== 'boolean' || !Number.isSafeInteger(grant.expiresAt))) fail('授权状态返回不完整，请重试。');
  return {...result, apiBaseUrl: httpsBase(result.apiBaseUrl), grant: grant ? {active: grant.active, expiresAt: grant.expiresAt} : null};
}
async function request(action) {
  const before = session();
  if (!before.owner || !/^[a-f0-9]{64}$/.test(before.owner) || !config.env || typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.callFunction !== 'function') fail(messages.UNAUTHENTICATED, 'UNAUTHENTICATED');
  assertCurrent(before);
  let response;
  try {
    response = await new Promise((resolve, reject) => wx.cloud.callFunction({name: 'babyBitesAnalysis', config: {env: config.env},
      data: {action, protocolVersion: 2, expectedOwner: before.owner, expectedScope: before.scope}, success: resolve, fail: reject}));
  } catch (_) { assertCurrent(before); fail('暂时连接不上授权服务，请检查网络后重试。', 'NETWORK'); }
  assertCurrent(before);
  const result = response && response.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('授权服务返回不完整，请重试。');
  if (result.error) fail(messages[result.error.code] || '授权服务暂时不可用，请稍后重试。', result.error.code);
  if (result.owner !== before.owner) fail(messages.ACCOUNT_CHANGED, 'ACCOUNT_CHANGED');
  if (!sameScope(result.scope, before.scope)) fail(messages.FAMILY_CHANGED, 'FAMILY_CHANGED');
  return result;
}
async function status() { return statusResult(await request('status')); }
async function createGrant() {
  const result = await request('createGrant');
  if (typeof result.token !== 'string' || !/^[A-Za-z0-9_.-]{32,512}$/.test(result.token) ||
    !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) fail('授权信息返回不完整，请重试。');
  const apiBaseUrl = httpsBase(result.apiBaseUrl);
  if (!apiBaseUrl) fail(messages.API_NOT_CONFIGURED, 'API_NOT_CONFIGURED');
  return {...result, apiBaseUrl};
}
async function revokeGrant() {
  const result = await request('revokeGrant');
  if (result.revoked !== true) fail('授权撤销未确认，请重试。');
  return result;
}
module.exports = {status, createGrant, revokeGrant};
