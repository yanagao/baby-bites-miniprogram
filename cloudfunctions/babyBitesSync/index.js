'use strict';

const crypto = require('crypto');
const {ownedFile, validateSnapshot, reject} = require('./validate');
const COLLECTION = 'baby_bites_accounts';

function createHandler({cloud, now = Date.now}) {
  const db = cloud.database({throwOnNotFound: false});

  function accountResult(owner, record, env) {
    if (!record) return {owner, revision: 0, fileID: ''};
    if (!Number.isSafeInteger(record.revision) || record.revision < 1 ||
      !ownedFile(record.fileID, env, owner, 'snapshots')) reject('账号的云端索引无效，请联系开发者。', 'INVALID_ACCOUNT');
    return {owner, revision: record.revision, fileID: record.fileID};
  }

  return async function handle(event) {
    try {
      const context = cloud.getWXContext();
      const {OPENID, APPID, ENV} = context || {};
      if (typeof OPENID !== 'string' || !OPENID || typeof APPID !== 'string' || !APPID) {
        reject('未能识别当前微信账号，请在微信中重试。', 'UNAUTHENTICATED');
      }
      if (typeof ENV !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ENV)) reject('云开发环境尚未配置完成。', 'INVALID_ENV');
      const owner = crypto.createHash('sha256').update(`${APPID}:${OPENID}`).digest('hex');
      if (!event || typeof event !== 'object' || Array.isArray(event)) reject('同步请求不正确。', 'INVALID_REQUEST');
      if (event.action === 'identity') {
        const record = await db.collection(COLLECTION).doc(owner).get();
        return accountResult(owner, record.data, ENV);
      }
      if (event.action !== 'commit') reject('不支持的同步操作。', 'INVALID_REQUEST');
      if (!Number.isSafeInteger(event.baseRevision) || event.baseRevision < 0 || event.baseRevision >= Number.MAX_SAFE_INTEGER) {
        reject('同步版本号不正确。', 'INVALID_REQUEST');
      }
      if (!ownedFile(event.fileID, ENV, owner, 'snapshots')) reject('同步文件不属于当前微信账号。', 'INVALID_FILE');

      // Validate before opening a transaction: downloads must not hold database locks.
      const downloaded = await cloud.downloadFile({fileID: event.fileID});
      if (downloaded.statusCode != null && downloaded.statusCode !== 200) reject('未能读取同步文件，请重试。', 'STORAGE_FAILED');
      validateSnapshot(downloaded.fileContent, {env: ENV, owner, now: now()});
      const transactionResult = await db.runTransaction(async transaction => {
        const reference = transaction.collection(COLLECTION).doc(owner);
        const record = await reference.get();
        const current = accountResult(owner, record.data, ENV);
        if (current.revision !== event.baseRevision) return Object.assign({conflict: true}, current);
        const revision = current.revision + 1;
        await reference.set({data: {revision, fileID: event.fileID, updatedAt: now()}});
        return {owner, revision, fileID: event.fileID};
      });
      // wx-server-sdk 4.0.2 returns the transaction callback value directly.
      return transactionResult;
    } catch (error) {
      const exposedCodes = new Set(['UNAUTHENTICATED', 'INVALID_ENV', 'INVALID_REQUEST', 'INVALID_FILE',
        'INVALID_SNAPSHOT', 'INVALID_ACCOUNT', 'STORAGE_FAILED']);
      if (exposedCodes.has(error && error.code)) return {error: {code: error.code, message: error.message}};
      // Do not return upstream diagnostics containing another resource's identifiers.
      return {error: {code: 'SYNC_FAILED', message: '云端同步暂时失败，请稍后重试。'}};
    }
  };
}

let handler;
exports.main = async event => {
  if (!handler) {
    const cloud = require('wx-server-sdk');
    cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
    handler = createHandler({cloud});
  }
  return handler(event);
};
exports.createHandler = createHandler;
