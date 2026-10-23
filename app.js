const store = require('./utils/store');
const cloudSync = require('./utils/cloud-sync');
const pocketFont = require('./assets/fonts/pocket-brush');
const {loadTDesignIcons} = require('./utils/tdesign-font');

App({
  globalData: {pantry: [], iconFontState: 'loading'},
  onLaunch() {
    store.init();
    // Refresh only read views. Background sync must never replace a form draft.
    store.subscribe(() => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page) return;
      if (/^pages\/(home|recipes|ingredients|records|detail)\/index$/.test(page.route) && page.refresh) {
        page.refresh(page.route === 'pages/home/index');
      } else if (page.route === 'pages/random/index' && page.onShow) page.onShow();
    });
    cloudSync.start();
    if (typeof wx.loadFontFace === 'function') {
      wx.loadFontFace({family: pocketFont.family, global: true, scopes: ['webview'],
        source: 'url("' + pocketFont.dataUrl + '")', fail() {}});
    }
    loadTDesignIcons().then(state => {
      this.globalData.iconFontState = state;
      if (state === 'unavailable') console.warn('TDesign icon font could not be loaded.');
    });
  },
  onShow() {
    if (cloudSync.getStatus().state !== 'syncing') cloudSync.syncNow();
  }
});
