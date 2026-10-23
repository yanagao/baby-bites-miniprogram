'use strict';

const store = require('./store');
const {today} = require('./selectors');
const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const fs = () => wx.getFileSystemManager();
const read = (filePath, encoding) => new Promise((resolve, reject) => {
  fs().readFile({filePath, encoding, success: result => resolve(result.data), fail: reject});
});
const write = (filePath, data, encoding) => new Promise((resolve, reject) => {
  fs().writeFile({filePath, data, encoding, success: resolve, fail: reject});
});
const removeFile = filePath => new Promise(resolve => {
  if (typeof filePath !== 'string' || !filePath || filePath.indexOf('cloud://') === 0) { resolve(); return; }
  try { fs().unlink({filePath, success: resolve, fail: resolve}); }
  catch (error) { resolve(); }
});

function isTemporaryPath(filePath) {
  // downloadFile returns a temporary local path, never a saved USER_DATA_PATH
  // photo or a cloud file ID. Be conservative before unlinking a returned path.
  return typeof filePath === 'string' && !/[\u0000-\u001f]/.test(filePath) &&
    (/^wxfile:\/\/tmp(?:_|-|\/)/.test(filePath) || /^https?:\/\/tmp(?:_|-|\/)/.test(filePath) ||
      /^\/(?:private\/)?tmp\//.test(filePath));
}
async function readPhoto(filePath) {
  if (filePath.indexOf('cloud://') !== 0) return read(filePath, 'base64');
  const result = await new Promise((resolve, reject) => {
    if (!wx.cloud || typeof wx.cloud.downloadFile !== 'function') { reject(Error('云照片下载暂不可用。')); return; }
    try { wx.cloud.downloadFile({fileID: filePath, success: resolve, fail: reject}); }
    catch (error) { reject(error); }
  });
  const temporary = result && result.tempFilePath;
  const canRemove = isTemporaryPath(temporary);
  try {
    if (!canRemove || (result.statusCode != null && result.statusCode !== 200)) throw Error('云照片下载未完成。');
    return await read(temporary, 'base64');
  } finally {
    if (canRemove) await removeFile(temporary);
  }
}

function byteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}

function checkBase64(base64) {
  if (typeof base64 !== 'string' || !base64.length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw Error('备份照片编码不完整，请重新导出备份后重试。');
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if (base64.length / 4 * 3 - padding > MAX_PHOTO_BYTES) throw Error('备份中单张照片超过 2 MB，请缩小照片后重试。');
}

function imageType(base64) {
  // Inspect the signature because wx.saveFile paths need not preserve file extensions.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let value = 0;
  let bits = 0;
  for (let i = 0; i < Math.min(24, base64.length) && base64[i] !== '='; i += 1) {
    value = (value << 6) | alphabet.indexOf(base64[i]);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if ([82, 73, 70, 70].every((n, i) => bytes[i] === n) &&
    [87, 69, 66, 80].every((n, i) => bytes[i + 8] === n)) return 'webp';
  throw Error('照片格式不受支持，请使用 JPG、PNG 或 WebP 照片。');
}

async function exportText() {
  const data = JSON.parse(store.exportBackup());
  for (const recipe of data.recipes) {
    if (!recipe.photo) continue;
    let base64;
    try { base64 = await readPhoto(recipe.photo); }
    catch (error) { throw Error('照片无法读取，请先检查「' + recipe.name + '」的成品照后再导出。'); }
    checkBase64(base64);
    recipe.photo = 'data:image/' + imageType(base64) + ';base64,' + base64;
  }
  const text = JSON.stringify(data, null, 2);
  if (byteLength(text) > MAX_BACKUP_BYTES) throw Error('含照片的备份超过 20 MB，请减少照片后再导出。');
  return text;
}

async function exportFile() {
  const text = await exportText();
  const filename = 'xiaokoudai-' + today() + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
  const filePath = wx.env.USER_DATA_PATH + '/' + filename;
  try { await write(filePath, text, 'utf8'); }
  catch (error) { await removeFile(filePath); throw Error('备份文件写入失败，请检查剩余存储空间后重试。'); }
  return filePath;
}

async function importText(text, beforeCommit) {
  function assertCanCommit() {
    if (beforeCommit == null) return;
    if (typeof beforeCommit !== 'function') throw Error('导入校验必须是同步函数。');
    const result = beforeCommit();
    if (result && typeof result.then === 'function') {
      // Account ownership must be checked synchronously beside the store commit.
      // An asynchronous guard would create another account-switch window.
      if (typeof result.catch === 'function') result.catch(() => {});
      throw Error('导入校验必须是同步函数。');
    }
  }
  if (typeof text !== 'string' || byteLength(text) > MAX_BACKUP_BYTES) throw Error('备份文件过大，请选择 20 MB 以内的 JSON 文件。');
  let data;
  try { data = JSON.parse(text); } catch (error) { throw Error('备份内容不是有效的 JSON 文件。'); }
  if (!data || data.version !== 1 || !Array.isArray(data.recipes) || !Array.isArray(data.logs)) throw Error('请选择小口袋导出的备份。');
  if (data.recipes.length > 1000 || data.logs.length > 20000) throw Error('备份最多支持 1000 道菜谱和 20000 条记录。');

  const photos = [];
  // Validate all image encodings before creating any files.
  data.recipes.forEach((recipe, index) => {
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw Error('备份中的菜谱信息不完整。');
    if (recipe.photo == null || recipe.photo === '') return;
    if (typeof recipe.photo !== 'string') throw Error('备份中的照片信息不正确。');
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(recipe.photo);
    if (!match) throw Error('备份照片不完整，请使用「导出备份文件」生成可迁移的文件。');
    checkBase64(match[2]);
    photos.push({index, base64: match[2], type: imageType(match[2])});
  });

  assertCanCommit();
  const currentRecipes = store.getState().recipes;
  const currentById = new Map(currentRecipes.map(recipe => [recipe.id, recipe]));
  const repairMissingPhotos = [];
  const oldPhotos = new Set(currentRecipes.map(recipe => recipe.photo)
    .filter(photo => photo && photo.indexOf('cloud://') !== 0));
  const createdPaths = [];
  let committed = false;
  try {
    for (const photo of photos) {
      const incoming = data.recipes[photo.index];
      const local = currentById.get(incoming.id);
      if (local && local.photo && local.photo.indexOf('cloud://') !== 0 &&
        (incoming.updatedAt || 0) === (local.updatedAt || 0)) {
        try { await read(local.photo, 'base64'); }
        catch (error) { repairMissingPhotos.push({id: local.id, photo: local.photo}); }
      }
      const filePath = wx.env.USER_DATA_PATH + '/import-' + Date.now() + '-' + photo.index + '-' +
        Math.random().toString(36).slice(2, 8) + '.' + (photo.type === 'jpeg' ? 'jpg' : photo.type);
      createdPaths.push(filePath);
      await write(filePath, photo.base64, 'base64');
      data.recipes[photo.index].photo = filePath;
    }
    assertCanCommit();
    const result = store.importBackup(JSON.stringify(data), {repairMissingPhotos});
    committed = true;
    const used = new Set(store.getState().recipes.map(recipe => recipe.photo).filter(Boolean));
    for (const filePath of createdPaths) if (!used.has(filePath)) await removeFile(filePath);
    for (const filePath of oldPhotos) if (!used.has(filePath)) await removeFile(filePath);
    return result;
  } catch (error) {
    if (!committed) for (const filePath of createdPaths) await removeFile(filePath);
    throw error;
  }
}

module.exports = {exportText, exportFile, importText, read, removeFile};
