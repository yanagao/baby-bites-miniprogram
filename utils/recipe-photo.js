'use strict';

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const TARGET_BYTES = 512 * 1024;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const MAX_EDGE = 1600;
const PASSES = [{edge: 1600, quality: 80}, {edge: 1280, quality: 65}, {edge: 960, quality: 50}];

function fail(message, code) {
  const error = Error(message);
  error.code = code;
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
function fileSystem() {
  try { return wx.getFileSystemManager(); }
  catch (_) { return null; }
}

async function prepareRecipePhoto(filePath, {assertCurrent = () => {}} = {}) {
  const temporary = new Set();
  let cleaning;
  // Cleanup must also run after the account changes or the page closes.
  // Never unlink the input, including when compressImage returns it unchanged.
  // Some WeChat temporary paths deny unlink and are reclaimed by the runtime.
  const cleanup = () => {
    if (!cleaning) cleaning = Promise.all([...temporary].map(path =>
      call(fileSystem(), 'unlink', {filePath: path}).catch(() => {}))).then(() => { temporary.clear(); });
    return cleaning;
  };
  async function guardedCall(target, method, options, message, code, capture) {
    assertCurrent();
    let result;
    try { result = await call(target, method, options); }
    catch (_) { assertCurrent(); throw fail(message, code); }
    // Capture new files before the guard can throw, so late results are reclaimed.
    if (capture) capture(result);
    assertCurrent();
    return result;
  }
  async function inspect(path, input) {
    const message = input ? '照片无法读取，请重新选择照片。' : '照片压缩未完成，请重新选择照片。';
    const code = input ? 'PHOTO_UNREADABLE' : 'PHOTO_COMPRESSION_FAILED';
    const info = await guardedCall(fileSystem(), 'getFileInfo', {filePath: path}, message, code);
    assertCurrent();
    if (!info || !Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_SOURCE_BYTES) {
      throw fail(input ? '请选择不超过 20 MB 的照片。' : '照片压缩结果无效，请换一张照片。',
        input ? 'INVALID_RECIPE_PHOTO' : 'PHOTO_COMPRESSION_FAILED');
    }
    const dimensions = await guardedCall(wx, 'getImageInfo', {src: path}, message, code);
    assertCurrent();
    if (!dimensions || !Number.isSafeInteger(dimensions.width) || dimensions.width <= 0 ||
      !Number.isSafeInteger(dimensions.height) || dimensions.height <= 0) {
      throw fail('照片尺寸无法读取，请重新选择照片。', input ? 'INVALID_RECIPE_PHOTO' : 'PHOTO_COMPRESSION_FAILED');
    }
    return {filePath: path, size: info.size, width: dimensions.width, height: dimensions.height};
  }
  const fits = photo => photo.size <= MAX_PHOTO_BYTES && Math.max(photo.width, photo.height) <= MAX_EDGE;
  try {
    assertCurrent();
    if (typeof filePath !== 'string' || !filePath || filePath.length > 2000 || /[\u0000-\u001f]/.test(filePath)) {
      throw fail('照片路径无效，请重新选择照片。', 'INVALID_RECIPE_PHOTO');
    }
    const original = await inspect(filePath, true);
    assertCurrent();
    const candidates = new Map([[filePath, original]]);
    let best = fits(original) ? original : null;
    if (best && best.size <= TARGET_BYTES) return {filePath, cleanup};
    for (const pass of PASSES) {
      const scale = Math.min(1, pass.edge / Math.max(original.width, original.height));
      const result = await guardedCall(wx, 'compressImage', {
        src: filePath, quality: pass.quality,
        compressedWidth: Math.max(1, Math.floor(original.width * scale)),
        compressedHeight: Math.max(1, Math.floor(original.height * scale))
      }, '照片压缩失败，请重新选择照片后重试。', 'PHOTO_COMPRESSION_FAILED', value => {
        if (value && typeof value.tempFilePath === 'string' && value.tempFilePath && value.tempFilePath !== filePath) {
          temporary.add(value.tempFilePath);
        }
      });
      assertCurrent();
      if (!result || typeof result.tempFilePath !== 'string' || !result.tempFilePath ||
        result.tempFilePath.length > 2000 || /[\u0000-\u001f]/.test(result.tempFilePath)) {
        throw fail('照片压缩未完成，请重新选择照片。', 'PHOTO_COMPRESSION_FAILED');
      }
      // Check what the runtime actually produced: some clients ignore resize
      // options, and PNG quality changes alone need not reduce the file size.
      const candidate = await inspect(result.tempFilePath, false);
      assertCurrent();
      // A runtime may reuse a temporary path across passes. Replace its old
      // metadata so an overwritten larger file cannot retain an earlier size.
      candidates.set(candidate.filePath, candidate);
      best = null;
      for (const photo of candidates.values()) {
        if (fits(photo) && (!best || photo.size < best.size)) best = photo;
      }
      if (best && best.size <= TARGET_BYTES) break;
    }
    if (!best) throw fail('照片压缩后仍超过 2 MB 或尺寸过大，请换一张照片。', 'PHOTO_COMPRESSION_FAILED');
    assertCurrent();
    return {filePath: best.filePath, cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {prepareRecipePhoto};
