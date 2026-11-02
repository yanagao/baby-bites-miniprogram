'use strict';

const {reject} = require('./private-snapshot');
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;
function invalidPhoto() { reject('请使用压缩后的 JPG 或 PNG 成品照，大小不超过 1 MB。', 'INVALID_COOKSNAP_PHOTO'); }
function photoInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) invalidPhoto();
  let width, height, type;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    type = 'png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    type = 'jpg';
    for (let pos = 2; pos + 4 < bytes.length;) {
      if (bytes[pos++] !== 255) invalidPhoto();
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (pos + 2 > bytes.length) invalidPhoto();
      const length = bytes.readUInt16BE(pos);
      if (length < 2 || pos + length > bytes.length) invalidPhoto();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) invalidPhoto();
        height = bytes.readUInt16BE(pos + 3); width = bytes.readUInt16BE(pos + 5); break;
      }
      pos += length;
    }
  }
  if (!type || !width || !height || width > 750 || height > 1334) invalidPhoto();
  return {type, contentType: type === 'jpg' ? 'image/jpeg' : 'image/png'};
}
function rejected(kind) {
  reject(kind === 'text' ? '这句反馈未通过内容审核，请修改后重试。' : '这张成品照未通过内容审核，请更换后重试。',
    kind === 'text' ? 'COOKSNAP_TEXT_REJECTED' : 'COOKSNAP_PHOTO_REJECTED');
}
async function moderate(work, kind) {
  let response, timer;
  try {
    response = await Promise.race([work(), new Promise((_, fail) => {
      timer = setTimeout(() => fail(Error('Moderation timeout')), TIMEOUT_MS);
    })]);
  } catch (error) {
    if (error && [error.errCode, error.errcode].some(code => String(code) === '87014')) rejected(kind);
    reject('内容审核暂时不可用，跟做尚未分享，请稍后重试。', 'COOKSNAP_MODERATION_UNAVAILABLE');
  } finally { clearTimeout(timer); }
  const codes = response && [response.errCode, response.errcode].filter(code => code !== undefined);
  if (codes && codes.some(code => String(code) === '87014')) rejected(kind);
  if (!codes || !codes.length || !codes.every(code => String(code) === '0')) {
    reject('内容审核暂时不可用，跟做尚未分享，请稍后重试。', 'COOKSNAP_MODERATION_UNAVAILABLE');
  }
  if (kind === 'text') {
    const verdict = response.result && response.result.suggest;
    if (verdict === 'review' || verdict === 'risky') rejected(kind);
    if (verdict !== 'pass') reject('内容审核暂时不可用，跟做尚未分享，请稍后重试。', 'COOKSNAP_MODERATION_UNAVAILABLE');
  }
}
async function checkCooksnap(cloud, openid, text, bytes, info) {
  const security = cloud.openapi && cloud.openapi.security;
  await moderate(() => security.msgSecCheck({openid, version: 2, scene: 2, content: text}), 'text');
  await moderate(() => security.imgSecCheck({media: {contentType: info.contentType, value: bytes}}), 'photo');
}
module.exports = {photoInfo, checkCooksnap};
