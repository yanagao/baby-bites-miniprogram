'use strict';

// Public photo URLs expire after five minutes. Keep a page-local reference to
// the image downloaded by WeChat; never hand the signed URL to native sharing.
function createSharePhoto(api) {
  let current = null;
  function clear() { current = null; }
  function prepare(source) {
    clear();
    if (typeof source !== 'string' || !/^https:\/\//.test(source) || source.length > 8000 ||
      /[\u0000-\u001f\u007f]/.test(source) || !api || typeof api.getImageInfo !== 'function') return;
    const entry = {source, path: ''};
    current = entry;
    try {
      api.getImageInfo({src: source, success(result) {
        // Identity, not URL equality: even the same URL can be loaded again in
        // a different request or account session before an old callback arrives.
        if (current !== entry) return;
        const path = result && result.path;
        if (typeof path === 'string' && path !== source && path.length <= 2000 &&
          !/[\u0000-\u001f\u007f]/.test(path) && /^(?:wxfile:\/\/|https?:\/\/(?:tmp|usr)\/|\/)/.test(path)) {
          entry.path = path;
        }
      }, fail() { /* Sharing can use its default image without blocking the page. */ }});
    } catch (_) { if (current === entry) clear(); }
  }
  function get(source) { return current && current.source === source ? current.path : ''; }
  // WeChat owns these temporary files; unlinking them could break other views.
  return {prepare, get, clear};
}

module.exports = {createSharePhoto};
