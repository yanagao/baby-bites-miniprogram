const font = require('../assets/fonts/tdesign-icons-0.4.5.js');

const REMOTE_SOURCE = 'url("https://tdesign.gtimg.com/icon/0.4.5/fonts/t.woff")';
let pending;

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

// Data URL support is documented from base library 3.7.9. The original
// TDesign font supplies its existing family "t"; no CSS overrides are added.
function loadTDesignIcons() {
  if (pending) return pending;
  if (typeof wx.loadFontFace !== 'function') return Promise.resolve('unavailable');
  pending = new Promise(resolve => {
    function load(source, mode, retry) {
      try {
        wx.loadFontFace({
          family: font.family,
          global: true,
          scopes: ['webview'],
          source,
          success() { resolve(mode); },
          fail() {
            if (retry) load(REMOTE_SOURCE, 'network', false);
            else resolve('unavailable');
          }
        });
      } catch (error) {
        if (retry) load(REMOTE_SOURCE, 'network', false);
        else resolve('unavailable');
      }
    }
    if (supportsDataURL(sdkVersion())) {
      load('url("data:font/woff;base64,' + font.base64 + '")', 'offline', true);
    } else {
      load(REMOTE_SOURCE, 'network', false);
    }
  });
  return pending;
}

module.exports = {loadTDesignIcons, supportsDataURL};
