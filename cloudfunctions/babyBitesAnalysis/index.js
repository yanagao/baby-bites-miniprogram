'use strict';

const crypto = require('crypto');
const {createReader, sameScope, reject} = require('./scope');
const {buildFeedingData} = require('./data');
const GRANTS = 'baby_bites_analysis_grants';
const GRANT_TTL = 7 * 24 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const grantId = owner => hash('feeding-analysis-grant:' + owner).slice(0, 32);
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const ERRORS = {
  UNAUTHENTICATED: '请先在微信中登录并同步数据。', INVALID_ENV: '云端环境尚未配置。',
  INVALID_REQUEST: '请求参数不正确。', ACCOUNT_CHANGED: '微信账号已切换，请重新打开。', FAMILY_CHANGED: '家庭已变化，请重新打开并授权。',
  SCOPE_CHANGED: '账号或家庭已变化，请重新打开并授权。', INVALID_FILE: '云端记录文件暂时无法读取。',
  INVALID_FAMILY: '家庭资料暂时无法读取。', INVALID_ACCOUNT: '云端资料暂时无法读取。',
  SYNC_REQUIRED: '请先在设置中同步辅食记录。', INVALID_SNAPSHOT: '云端记录暂时无法读取。', STORAGE_FAILED: '云端记录暂时无法读取。',
  INVALID_TOKEN: '授权已失效，请在小程序中重新生成。', API_NOT_CONFIGURED: '外部分析接口尚未配置。',
  RATE_LIMITED: '调用较频繁，请稍后再试。',
  REVISION_REQUIRED: '读取后续记录需要提供首次返回的版本号。', REVISION_CHANGED: '记录已有更新，请从第一页重新读取。',
  RESPONSE_TOO_LARGE: '返回记录较多，请减少每页数量。', NOT_FOUND: '接口不存在。', METHOD_NOT_ALLOWED: '此接口仅支持 GET。'
};
function safeError(error) {
  const code = error && Object.hasOwn(ERRORS, error.code) ? error.code : 'ANALYSIS_FAILED';
  return {error: {code, message: ERRORS[code] || '辅食记录服务暂时不可用，请稍后重试。'}};
}
function validGrant(record, state, time) {
  return record && record.revoked !== true && id64(record.tokenHash) && id64(record.owner) &&
    Number.isSafeInteger(record.expiresAt) && record.expiresAt > time && sameScope(record.scope, state.scope) &&
    typeof record.accessVersion === 'string' && record.accessVersion === state.accessVersion;
}
function matchesToken(record, digest) {
  return record && id64(record.tokenHash) && crypto.timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(digest, 'hex'));
}
function httpsURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch (_) { return null; }
}
function createHandler({cloud, now = Date.now, random = crypto.randomBytes, env = {}, toolsOnly = false}) {
  const db = cloud.database({throwOnNotFound: false});
  const reader = createReader({cloud, db, now});
  const base = httpsURL(env.ANALYSIS_API_BASE_URL);
  const apiBaseUrl = base ? base.href.replace(/\/$/, '') : '';
  const apiPath = base ? base.pathname.replace(/\/$/, '') + '/v1/feeding-context' : '';
  const get = async (database, collection, id) => (await database.collection(collection).doc(id).get()).data;
  const put = (database, collection, id, data) => database.collection(collection).doc(id).set({data});
  const currentReader = database => createReader({cloud, db: database, now});
  function environment() {
    const context = cloud.getWXContext() || {};
    // HTTP invocations may have no WX_CONTEXT_KEYS. These runtime variables
    // are the same environment identifiers used internally by wx-server-sdk.
    const ENV = context.ENV || env.TCB_ENV || env.SCF_NAMESPACE;
    if (typeof ENV !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ENV)) reject('', 'INVALID_ENV');
    return {ENV, OPENID: context.OPENID, APPID: context.APPID};
  }
  async function checkedGrant(database, id, digest, cloudEnv) {
    const record = await get(database, GRANTS, id);
    if (!record || !id64(record.owner) || grantId(record.owner) !== id || !matchesToken(record, digest)) reject('', 'INVALID_TOKEN');
    let state;
    try { state = await currentReader(database).resolve(record.owner, cloudEnv); }
    catch (_) { reject('', 'INVALID_TOKEN'); }
    if (!validGrant(record, state, now())) reject('', 'INVALID_TOKEN');
    return {record, state};
  }
  async function external(event) {
    if (!apiBaseUrl) reject('', 'API_NOT_CONFIGURED');
    // A gateway mounted at the complete endpoint may strip that path before forwarding.
    if (![apiPath, '/', ''].includes(event.path)) reject('', 'NOT_FOUND');
    if (event.httpMethod !== 'GET') reject('', 'METHOD_NOT_ALLOWED');
    return readFeedingContext({headers: event.headers, query: event.queryStringParameters || {}});
  }
  async function readFeedingContext({headers: requestHeaders, query}) {
    if (!apiBaseUrl) reject('', 'API_NOT_CONFIGURED');
    if (!object(query) || Object.keys(query).some(key => !['days', 'startDate', 'endDate', 'limit', 'offset', 'revision'].includes(key))) reject('', 'INVALID_REQUEST');
    const headers = object(requestHeaders) ? Object.entries(requestHeaders).filter(([key]) => key.toLowerCase() === 'authorization') : [];
    const match = headers.length === 1 && typeof headers[0][1] === 'string' && /^Bearer (bbai_[a-f0-9]{32}\.[a-f0-9]{64})$/.exec(headers[0][1]);
    if (!match) reject('', 'INVALID_TOKEN');
    const token = match[1], id = token.slice(5, 37), digest = hash(token), {ENV} = environment();
    const {record, state} = await db.runTransaction(async tx => {
      const result = await checkedGrant(tx, id, digest, ENV), grant = result.record, time = now();
      const minute = Math.floor(time / 60000), day = Math.floor(time / 86400000);
      const minuteCount = grant.minute === minute ? grant.minuteCount || 0 : 0;
      const dayCount = grant.day === day ? grant.dayCount || 0 : 0;
      if (minuteCount >= 60 || dayCount >= 1000) reject('', 'RATE_LIMITED');
      const {_id, ...saved} = grant;
      await put(tx, GRANTS, id, {...saved, minute, minuteCount: minuteCount + 1, day, dayCount: dayCount + 1});
      return result;
    });
    if (!state.revision) reject('', 'SYNC_REQUIRED');
    const snapshot = await reader.read(state, record.owner, ENV);
    const result = buildFeedingData(snapshot, {now: now(), source: state, query});
    // Recheck both consent and membership after downloading the private snapshot.
    await db.runTransaction(async tx => {
      const latest = await checkedGrant(tx, id, digest, ENV);
      if (latest.state.revision !== state.revision || latest.state.fileID !== state.fileID) reject('', 'REVISION_CHANGED');
    });
    return result;
  }
  async function internal(event) {
    const {OPENID, APPID, ENV} = environment();
    if (typeof OPENID !== 'string' || !OPENID || typeof APPID !== 'string' || !APPID) reject('', 'UNAUTHENTICATED');
    const owner = hash(APPID + ':' + OPENID);
    if (!object(event) || !['status', 'createGrant', 'revokeGrant'].includes(event.action) || event.protocolVersion !== 2) reject('', 'INVALID_REQUEST');
    if (event.expectedOwner !== owner) reject('', 'ACCOUNT_CHANGED');
    const state = await reader.resolve(owner, ENV);
    if (!sameScope(event.expectedScope, state.scope)) reject('', 'FAMILY_CHANGED');
    const identity = {owner, scope: state.scope};
    const id = grantId(owner);
    if (event.action === 'status') {
      const grant = await get(db, GRANTS, id);
      await reader.assertCurrent(state, owner, ENV);
      return {...identity, apiBaseUrl,
        grant: validGrant(grant, state, now()) ? {active: true, expiresAt: grant.expiresAt} : null};
    }
    if (event.action === 'revokeGrant') {
      await db.runTransaction(async tx => {
        await currentReader(tx).assertCurrent(state, owner, ENV);
        await put(tx, GRANTS, id, {owner, scope: state.scope, revoked: true, revokedAt: now(), tokenHash: '', expiresAt: 0});
      });
      return {...identity, revoked: true};
    }
    if (!state.revision) reject('', 'SYNC_REQUIRED');
    if (!apiBaseUrl) reject('', 'API_NOT_CONFIGURED');
    const token = 'bbai_' + id + '.' + random(32).toString('hex'), tokenHash = hash(token), expiresAt = now() + GRANT_TTL;
    await db.runTransaction(async tx => {
      await currentReader(tx).assertCurrent(state, owner, ENV);
      const previous = await get(tx, GRANTS, id);
      if (previous && Number.isSafeInteger(previous.createdAt) && now() - previous.createdAt < 5000) reject('', 'RATE_LIMITED');
      await put(tx, GRANTS, id, {owner, scope: state.scope, accessVersion: state.accessVersion, tokenHash, createdAt: now(), expiresAt, revoked: false});
    });
    await checkedGrant(db, id, tokenHash, ENV);
    return {...identity, token, expiresAt, apiBaseUrl};
  }
  if (toolsOnly) {
    const {createToolsRouter} = require('./tools');
    return createToolsRouter({apiBaseUrl, readFeedingContext, safeError});
  }
  return async event => {
    // Never dispatch a gateway-shaped request to WeChat-only management actions.
    const http = object(event) && ['httpMethod', 'headers', 'path', 'requestContext', 'body'].some(key => Object.hasOwn(event, key));
    if (!http) { try { return await internal(event); } catch (error) { return safeError(error); } }
    let result, statusCode = 200;
    try { result = await external(event); }
    catch (error) {
      // Membership loss while the snapshot is in flight is a revoked grant,
      // not a transient service error. Do not reveal household state over HTTP.
      result = ['SCOPE_CHANGED', 'INVALID_FAMILY'].includes(error && error.code) ? safeError({code: 'INVALID_TOKEN'}) : safeError(error);
      const code = result.error.code;
      statusCode = code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED' ? 401 : code === 'NOT_FOUND' ? 404 : code === 'METHOD_NOT_ALLOWED' ? 405 :
        code === 'RATE_LIMITED' ? 429 : code === 'REVISION_CHANGED' || code === 'SYNC_REQUIRED' ? 409 :
          ['INVALID_REQUEST', 'REVISION_REQUIRED', 'RESPONSE_TOO_LARGE'].includes(code) ? 400 : 503;
    }
    return {statusCode, isBase64Encoded: false, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...(statusCode === 405 ? {Allow: 'GET'} : {})}, body: JSON.stringify(result)};
  };
}

function cloudEntry(toolsOnly) {
  let handler;
  return async event => {
    if (!handler) {
      const cloud = require('wx-server-sdk');
      cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
      handler = createHandler({cloud, env: process.env, toolsOnly});
    }
    return handler(event);
  };
}
exports.main = cloudEntry(false);
exports.tools = cloudEntry(true);
exports.createHandler = createHandler;
exports.GRANTS = GRANTS;
