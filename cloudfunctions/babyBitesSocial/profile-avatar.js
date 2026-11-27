'use strict';

const {ownedFile, reject} = require('./private-snapshot');
const {photoInfo} = require('./feedback-moderation');
const TIMEOUT_MS = 8000;
const PHOTO_TTL = 300;

function invalidAvatar() {
  reject('请选择 JPG 或 PNG 头像，压缩后不超过 1 MB，宽高不超过 750 像素。', 'INVALID_PROFILE_AVATAR');
}

function validateAvatarFile(fileID, env, owner) {
  if (!ownedFile(fileID, env, owner, 'photos') || !/\/avatar-[A-Za-z0-9_-]+\.(?:jpg|png)$/.test(fileID)) {
    reject('头像文件不属于当前账号，请重新选择。', 'INVALID_PROFILE_AVATAR');
  }
}

function publicAvatar(fileID, env, profileId) {
  if (typeof fileID !== 'string' || fileID.length > 2000 || !/^[a-f0-9]{32}$/.test(profileId || '')) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  const prefix = `social/${profileId}/avatars/`;
  return Boolean(match && match[1] === env && match[3].startsWith(prefix) &&
    /^[A-Za-z0-9_-]{1,160}\.(?:jpg|png)$/.test(match[3].slice(prefix.length)));
}

function avatarFields(record, env) {
  return record && publicAvatar(record.avatarFileID, env, record._id) ? {avatarFileID: record.avatarFileID} : {};
}

function rejectedAvatar() { reject('头像未通过内容审核，请更换后重试。', 'PROFILE_AVATAR_REJECTED'); }
function unavailable() { reject('头像审核暂时不可用，资料尚未保存，请稍后重试。', 'PROFILE_AVATAR_MODERATION_UNAVAILABLE'); }

async function readCheckedAvatar(cloud, fileID, env, owner) {
  validateAvatarFile(fileID, env, owner);
  let photo;
  try { photo = await cloud.downloadFile({fileID}); }
  catch (_) { reject('头像暂时无法读取，请重新选择后重试。', 'STORAGE_FAILED'); }
  if (!photo || photo.statusCode != null && photo.statusCode !== 200) {
    reject('头像暂时无法读取，请重新选择后重试。', 'STORAGE_FAILED');
  }
  const bytes = photo.fileContent;
  const info = photoInfo(bytes, {invalid: invalidAvatar, maxWidth: 750, maxHeight: 750});
  let response, timer;
  try {
    const security = cloud.openapi && cloud.openapi.security;
    response = await Promise.race([
      security.imgSecCheck({media: {contentType: info.contentType, value: bytes}}),
      new Promise((_, fail) => { timer = setTimeout(() => fail(Error('Moderation timeout')), TIMEOUT_MS); })
    ]);
  } catch (error) {
    if (error && [error.errCode, error.errcode].some(code => String(code) === '87014')) rejectedAvatar();
    unavailable();
  } finally { clearTimeout(timer); }
  const codes = response && [response.errCode, response.errcode].filter(code => code !== undefined);
  if (codes && codes.some(code => String(code) === '87014')) rejectedAvatar();
  if (!codes || !codes.length || !codes.every(code => String(code) === '0')) unavailable();
  // Some SDK responses include a verdict in addition to the v1 result code.
  // A review/risky verdict is never sufficient to publish a public avatar.
  const verdict = response.result && response.result.suggest;
  if (verdict === 'review' || verdict === 'risky') rejectedAvatar();
  if (verdict !== undefined && verdict !== 'pass') unavailable();
  return {bytes, extension: info.type};
}

async function copyAvatar(cloud, checked, env, profileId, unique) {
  const suffix = unique();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(suffix)) throw Error('Invalid random token');
  let uploaded;
  try {
    uploaded = await cloud.uploadFile({cloudPath: `social/${profileId}/avatars/${suffix}.${checked.extension}`,
      fileContent: checked.bytes});
  } catch (_) { reject('头像尚未保存，请稍后重试。', 'STORAGE_FAILED'); }
  if (!uploaded || !publicAvatar(uploaded.fileID, env, profileId)) reject('头像尚未保存，请稍后重试。', 'STORAGE_FAILED');
  return uploaded.fileID;
}

function createAvatarReader(cloud, env) {
  // This cache belongs to one request, including concurrent recipe/list rows.
  // Never retain temporary URLs or another account's results across requests.
  const pending = new Map();
  return async record => {
    if (!record || !publicAvatar(record.avatarFileID, env, record._id)) return '';
    const fileID = record.avatarFileID;
    if (!pending.has(fileID)) pending.set(fileID, (async () => {
      try {
        const response = await cloud.getTempFileURL({fileList: [{fileID, maxAge: PHOTO_TTL}]});
        const file = response && response.fileList && response.fileList[0];
        return file && file.fileID === fileID && (file.status == null || file.status === 0) &&
          typeof file.tempFileURL === 'string' && /^https:\/\//.test(file.tempFileURL) ? file.tempFileURL : '';
      } catch (_) { return ''; }
    })());
    return pending.get(fileID);
  };
}

module.exports = {validateAvatarFile, publicAvatar, avatarFields, readCheckedAvatar, copyAvatar, createAvatarReader};
