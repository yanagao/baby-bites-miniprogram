'use strict';

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_EDGE = 750;
const PASSES = [{edge: 750, quality: 80}, {edge: 512, quality: 65}, {edge: 384, quality: 50}];

function validProfilePhotoPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 2000 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    /^(?:wxfile:\/\/[^/]|https?:\/\/(?:tmp|usr)\/[^/]|\/(?!\/)[^/])/.test(path);
}
function invalid(message) {
  const error = Error(message);
  error.code = 'INVALID_PROFILE_AVATAR';
  error.userMessage = message;
  return error;
}
function call(target, method, options) {
  return new Promise((resolve, reject) => {
    try {
      if (!target || typeof target[method] !== 'function') throw Error('API unavailable');
      target[method]({...options, success: resolve, fail: reject});
    } catch (error) { reject(error); }
  });
}

async function prepareProfilePhoto(api, source, {assertCurrent = () => {}} = {}) {
  const temporary = new Set();
  let cleaning;
  const fs = () => api.getFileSystemManager();
  const cleanup = () => {
    if (!cleaning) cleaning = Promise.all([...temporary].map(filePath =>
      Promise.resolve().then(() => call(fs(), 'unlink', {filePath})).catch(() => {}))).then(() => temporary.clear());
    return cleaning;
  };
  async function guarded(target, method, options, capture) {
    assertCurrent();
    let result;
    try { result = await call(target, method, options); }
    catch (_) { assertCurrent(); throw invalid('头像照片处理失败，请重新选择照片后重试。'); }
    if (capture) capture(result);
    assertCurrent();
    return result;
  }
  async function inspect(filePath) {
    const info = await guarded(fs(), 'getFileInfo', {filePath});
    if (!info || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_SOURCE_BYTES) {
      throw invalid('请选择不超过 10 MB 的头像照片。');
    }
    const image = await guarded(api, 'getImageInfo', {src: filePath});
    if (!image || !Number.isSafeInteger(image.width) || image.width <= 0 ||
      !Number.isSafeInteger(image.height) || image.height <= 0) throw invalid('头像尺寸无法读取，请重新选择照片。');
    return {size: info.size, width: image.width, height: image.height};
  }
  const fits = info => info.size <= MAX_AVATAR_BYTES && Math.max(info.width, info.height) <= MAX_EDGE;
  try {
    assertCurrent();
    if (!validProfilePhotoPath(source)) throw invalid('请重新选择本机头像照片。');
    const original = await inspect(source);
    let filePath = source, info = original;
    if (!fits(info)) {
      for (const pass of PASSES) {
        const scale = Math.min(1, pass.edge / Math.max(original.width, original.height));
        const result = await guarded(api, 'compressImage', {src: source, quality: pass.quality,
          compressedWidth: Math.max(1, Math.floor(original.width * scale)),
          compressedHeight: Math.max(1, Math.floor(original.height * scale))}, value => {
          if (value && validProfilePhotoPath(value.tempFilePath) && value.tempFilePath !== source) temporary.add(value.tempFilePath);
        });
        if (!result || !validProfilePhotoPath(result.tempFilePath)) throw invalid('头像压缩未完成，请重新选择照片。');
        filePath = result.tempFilePath;
        info = await inspect(filePath);
        if (fits(info)) break;
      }
    }
    if (!fits(info)) throw invalid('头像压缩后仍然过大，请换一张较小的照片。');
    const result = await guarded(fs(), 'readFile', {filePath});
    const data = result && result.data;
    let bytes;
    if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') bytes = new Uint8Array(data);
    if (!bytes || !bytes.length || bytes.length > MAX_AVATAR_BYTES) throw invalid('头像文件无效，请重新选择照片。');
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    const jpg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpg) throw invalid('请选择 JPG 或 PNG 格式的头像照片。');
    assertCurrent();
    return {filePath, extension: png ? 'png' : 'jpg', cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {validProfilePhotoPath, prepareProfilePhoto};
