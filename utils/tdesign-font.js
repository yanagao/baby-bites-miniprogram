'use strict';

const REMOTE_SOURCE = 'url("https://tdesign.gtimg.com/icon/0.4.5/fonts/t.woff")';
const LOAD_TIMEOUT_MS = 10000;
let pending = null;
let loaded = null;

function supportsDataURL(version) {
  const current = String(version || '0').split('.').map(Number);
  const minimum = [3, 7, 9];
  for (let index = 0; index < minimum.length; index++) {
    const value = current[index] || 0;
    if (value !== minimum[index]) return value > minimum[index];
  }
  return true;
}

function sdkVersion() {
  try {
    const info = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
    return info.SDKVersion;
  } catch (error) {
    return '';
  }
}

// A timed-out package or font request cannot change a completed attempt.
function boundedLoad(start) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(null), LOAD_TIMEOUT_MS);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    try { start(finish); }
    catch (_) { finish(null); }
  });
}

function loadPackagedFont() {
  return boundedLoad(finish => {
    Promise.resolve(require.async('../recipe-media/fonts/tdesign-icons-0.4.5.js'))
      .then(font => finish(font), () => finish(null));
  });
}

function loadFont(source) {
  return boundedLoad(finish => {
    wx.loadFontFace({
      family: 't', global: true, scopes: ['webview'], source,
      success() { finish(true); },
      fail() { finish(false); }
    });
  });
}

// Data URL support starts at 3.7.9. Font data stays in the resource package;
// older runtimes use TDesign's original network font with the same family.
async function prepare() {
  if (typeof wx === 'undefined' || typeof wx.loadFontFace !== 'function') return 'unavailable';
  if (supportsDataURL(sdkVersion()) && typeof require.async === 'function') {
    const font = await loadPackagedFont();
    if (font && font.family === 't' && typeof font.base64 === 'string' && font.base64 &&
      await loadFont('url("data:font/woff;base64,' + font.base64 + '")')) return 'offline';
  }
  return await loadFont(REMOTE_SOURCE) ? 'network' : 'unavailable';
}

function loadTDesignIcons() {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  pending = Promise.resolve().then(prepare).then(result => {
    if (result !== 'unavailable') loaded = result;
    pending = null;
    return result;
  }, () => {
    pending = null;
    return 'unavailable';
  });
  return pending;
}

module.exports = {loadTDesignIcons, supportsDataURL};
