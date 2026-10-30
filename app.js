const store = require('./utils/store');
const cloudSync = require('./utils/cloud-sync');
const {loadTDesignIcons} = require('./utils/tdesign-font');
const coverLoader = require('./utils/cover-loader');
const {getCoverKey, getCover, withCover} = require('./utils/recipe-covers');

function coverPageAllowed(page, owner) {
  if (!page || page._disposed || page._unloaded || page._accountLocked || !page.data ||
    typeof page.setData !== 'function') return false;
  const session = page.accountSession;
  if (session && (session.changed || session.disposed || session.owner && session.owner !== owner)) return false;
  if (page._draftOwner && page._draftOwner !== owner) return false;
  if (page._sessionOwner && page._sessionOwner !== owner) return false;
  if (page.data.recommendationOwner && page.data.recommendationOwner !== owner) return false;
  return /^pages\/(home|recipes|ingredients|ingredient-results|records|detail|random|record-editor|mine|profile|discover|following|public-recipe)\/index$/.test(page.route);
}

function refreshCoverView(event) {
  const pages = getCurrentPages();
  const page = pages[pages.length - 1];
  if (!page) return;
  const owner = store.getSyncInfo().owner || '';
  if (!coverPageAllowed(page, owner)) return;
  const changedKey = event && event.key;

  // Re-read only the current view and patch presentation fields. In particular,
  // image events never redraw random meals, replace drafts or reload social data.
  const changes = {};
  function decorate(recipe, key) {
    if (!recipe || typeof recipe !== 'object' || changedKey && getCoverKey(recipe) !== changedKey) return;
    const decorated = withCover(recipe);
    if (decorated && typeof decorated.displayPhoto === 'string' && decorated.displayPhoto !== recipe.displayPhoto) {
      changes[key + '.displayPhoto'] = decorated.displayPhoto;
      if (page.route === 'pages/public-recipe/index' && key === 'recipe' && decorated.displayPhoto &&
        !recipe.photoURL && !recipe.photo && getCoverKey(recipe) && page.data.photoFailed) changes.photoFailed = false;
    }
  }
  decorate(page.data.recipe, 'recipe');
  decorate(page.data.result, 'result');
  for (const name of ['recommendations', 'recipes', 'matches', 'previewMatches', 'completeMatches', 'partialMatches']) {
    if (Array.isArray(page.data[name])) page.data[name].forEach((recipe, index) => decorate(recipe, `${name}[${index}]`));
  }
  if (Array.isArray(page.data.logs) && typeof store.getRecipe === 'function' &&
    (page.route === 'pages/records/index' || page.data.isSelf)) {
    page.data.logs.forEach((log, index) => {
      if (!log || log.photoSrc || typeof log.recipeId !== 'string') return;
      const recipe = store.getRecipe(log.recipeId);
      // Never project another copy of private photo data from the store. These
      // notifications concern fixed public artwork only, including its expiry.
      if (!recipe || recipe.photo || recipe.photoURL || !getCoverKey(recipe) ||
        changedKey && getCoverKey(recipe) !== changedKey) return;
      const source = getCover(recipe);
      if (source !== log.displayPhoto) changes[`logs[${index}].displayPhoto`] = source;
    });
  }
  const currentPages = getCurrentPages();
  if (currentPages[currentPages.length - 1] !== page || (store.getSyncInfo().owner || '') !== owner ||
    !coverPageAllowed(page, owner)) return;
  if (Object.keys(changes).length) page.setData(changes);
}

App({
  globalData: {pantry: [], iconFontState: 'loading'},
  onLaunch() {
    store.init();
    // Refresh only read views. Background sync must never replace a form draft.
    store.subscribe(() => {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (!page) return;
      if (/^pages\/(home|recipes|ingredients|ingredient-results|records|detail|mine|profile)\/index$/.test(page.route) && page.refresh) {
        page.refresh();
      } else if (page.route === 'pages/random/index' && page.onShow) page.onShow();
    });
    cloudSync.start();
    if (!this._unsubscribeCovers) this._unsubscribeCovers = coverLoader.subscribe(refreshCoverView);
    this.prepareIcons();
    this.prepareCovers();
  },
  onShow() {
    this.prepareCovers();
    if (this.globalData.iconFontState === 'unavailable') this.prepareIcons();
    if (cloudSync.getStatus().state !== 'syncing') cloudSync.syncNow();
  },
  prepareIcons() {
    if (this._iconFontPromise) return this._iconFontPromise;
    if (this.globalData.iconFontState === 'offline' || this.globalData.iconFontState === 'network') {
      return Promise.resolve(this.globalData.iconFontState);
    }
    this.globalData.iconFontState = 'loading';
    this._iconFontPromise = Promise.resolve().then(loadTDesignIcons).catch(() => 'unavailable').then(state => {
      this.globalData.iconFontState = state;
      this._iconFontPromise = null;
      if (state === 'unavailable') console.warn('TDesign icon font could not be loaded.');
      return state;
    });
    return this._iconFontPromise;
  },
  prepareCovers() {
    if (this._coverPromise) return this._coverPromise;
    this._coverPromise = Promise.resolve().then(() => coverLoader.prepare()).catch(() => false).then(ready => {
      this._coverPromise = null;
      try { refreshCoverView(); } catch (_) { /* A disposed view must not prevent later retries. */ }
      return ready;
    });
    return this._coverPromise;
  }
});
