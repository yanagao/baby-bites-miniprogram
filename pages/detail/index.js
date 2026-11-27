const store = require('../../utils/store');
const {enrichRecipe, listLogs} = require('../../utils/selectors');
const ui = require('../../utils/ui');
const social = require('../../utils/social');
const cloudSync = require('../../utils/cloud-sync');
const config = require('../../config/cloud');
const {isBuiltInRecipe, getBuiltInRecipe} = require('../../utils/recipe-origin');
const {getCover} = require('../../utils/recipe-covers');
const {createSharePhoto} = require('../../utils/recipe-share-photo');
const {createShareReturn} = require('../../utils/native-share-return');
const syncVersion = status => status && Number.isSafeInteger(status.publicationVersion) ?
  status.owner + ':' + status.publicationVersion : '';
const shareIdentity = recipe => {
  if (!recipe) return '';
  const info = store.getSyncInfo();
  return JSON.stringify([recipe.id, isBuiltInRecipe(recipe), recipe.source ? recipe.source.recipeId : '',
    recipe.source ? '' : info.scope && info.scope.kind === 'family' ? recipe.createdBy || '' : info.owner || '']);
};

Page({
  data: {
    recipe: null, lastLog: null, socialEnabled: config.socialEnabled === true,
    deleteVisible: false,
    deleteContent: '',
    deleteConfirmButton: {content: '删除菜谱', theme: 'danger'},
    deleting: false,
    familyRecipe: false, publicInfo: null, publicReady: false, publicError: '', publicBusy: false, publicLoading: false,
    builtIn: false,
    shareRecipe: null, shareReady: false, shareLoading: false, shareError: ''
  },
  onLoad(options) {
    this.recipeId = options.id;
    this._unloaded = false;
    this._visible = false;
    this._shareReturn = createShareReturn(wx);
    this._sharePhoto = createSharePhoto(wx);
    this._syncRefreshPending = false;
    this._lastSyncedKey = typeof cloudSync.getStatus === 'function' ? syncVersion(cloudSync.getStatus()) : '';
    this._sessionOwner = store.getSyncInfo().owner;
    this._sessionScope = store.getSyncInfo().scopeKey || this._sessionOwner;
    this._accountBound = Boolean(this._sessionOwner);
    this._accountLocked = false;
    this._unsubscribeAccount = store.subscribe(() => { if (this.accountOK(false) && this.data.recipe) this.refresh(); });
    if (this.data.socialEnabled) this._unsubscribeSync = cloudSync.subscribe(status => {
      if (!status || !this.accountOK(false) || status.owner !== this._sessionOwner) return;
      const key = syncVersion(status);
      if (!key || key === this._lastSyncedKey) return;
      this._lastSyncedKey = key;
      this._syncRefreshPending = true;
      this.refreshAfterSync();
    });
    this.updateShareMenu();
  },
  async onShow() {
    if (!this.accountOK(false)) return;
    this._shareReturn.show();
    this._visible = true;
    this.refresh();
    if (!this.data.socialEnabled) return;
    const identity = shareIdentity(store.getRecipe(this.recipeId));
    if (this._publicFlight && this._publicFlight.request === this._publicRequest &&
      this._publicFlight.identity === identity) return this._publicFlight.work;
    // Local edits and private sync revisions do not invalidate the public card.
    if (this.data.publicReady && !this.data.publicError && !this.data.shareError &&
      this.shareAvailable() && !this._syncRefreshPending) return;
    await this.refreshPublication();
  },
  onHide() { this._visible = false; },
  onUnload() {
    this._unloaded = true;
    this._visible = false;
    this._shareReturn.dispose();
    this._sharePhoto.clear();
    this._syncRefreshPending = false;
    this._publicRequest = (this._publicRequest || 0) + 1;
    this.updateShareMenu();
    if (this._unsubscribeAccount) this._unsubscribeAccount();
    if (this._unsubscribeSync) this._unsubscribeSync();
  },
  accountOK(report) {
    if (this._unloaded) return false;
    const info = store.getSyncInfo();
    const current = info.owner;
    const scope = info.scopeKey || current;
    if (!this._accountBound && current) { this._sessionOwner = current; this._sessionScope = scope; this._accountBound = true; }
    else if (this._accountBound && (current !== this._sessionOwner || scope !== this._sessionScope)) this._accountLocked = true;
    if (!this._accountLocked) return true;
    const message = '微信账号已切换，或家庭已变化，请返回后重新打开菜谱。';
    if (!this._accountCleared) {
      this._accountCleared = true;
      this._shareReturn.clear();
      this._sharePhoto.clear();
      this._syncRefreshPending = false;
      this._publicRequest = (this._publicRequest || 0) + 1;
      this.setData({recipe: null, lastLog: null, publicInfo: null, publicReady: false,
        publicError: message, builtIn: false,
        deleteVisible: false, publicBusy: false, publicLoading: false, deleting: false,
        shareRecipe: null, shareReady: false, shareLoading: false, shareError: ''});
      this.updateShareMenu();
    }
    if (report) ui.error(new Error(message));
    return false;
  },
  actionAllowed() {
    const allowed = this.accountOK(true) && !this.data.publicBusy && !this.data.deleting &&
      !this.data.deleteVisible && Boolean(this.data.recipe);
    // A canceled native share may not hide the page. A later action must not
    // leave its one-return exemption attached to normal navigation or editing.
    if (allowed) this._shareReturn.clear();
    return allowed;
  },
  refresh() {
    if (!this.accountOK(false) || this.data.deleting) return;
    try {
      const state = store.getState();
      const recipe = state.recipes.find(item => item.id === this.recipeId);
      const update = {familyRecipe: Boolean(recipe && recipe.createdBy && recipe.createdBy !== store.getSyncInfo().owner), recipe: recipe ? enrichRecipe(state, recipe) : null, builtIn: isBuiltInRecipe(recipe), lastLog: listLogs(state).find(log => log.recipeId === this.recipeId) || null};
      const changed = {};
      Object.keys(update).forEach(key => {
        if (JSON.stringify(this.data[key]) !== JSON.stringify(update[key])) changed[key] = update[key];
      });
      if (Object.keys(changed).length) this.setData(changed);
      if (!recipe || this._shareIdentity && this._shareIdentity !== shareIdentity(recipe)) {
        this._shareReturn.clear();
        this._sharePhoto.clear();
        this._shareIdentity = '';
        this._publicRequest = (this._publicRequest || 0) + 1;
        this.setData({shareRecipe: null, shareReady: false, publicReady: false, shareLoading: false, publicLoading: false});
      }
      this.updateShareMenu();
    } catch (error) { ui.error(error); }
  },
  previewPhoto() {
    if (!this.actionAllowed()) return;
    const src = this.data.recipe && this.data.recipe.photoSrc;
    if (src) wx.previewImage({current: src, urls: [src]});
  },
  edit() { if (this.actionAllowed()) wx.navigateTo({url: '/pages/editor/index?id=' + encodeURIComponent(this.recipeId)}); },
  openLastLog() {
    if (!this.actionAllowed()) return;
    if (this.data.lastLog) wx.navigateTo({url: '/pages/record-editor/index?logId=' + encodeURIComponent(this.data.lastLog.id)});
    else this.record();
  },
  record() { if (this.actionAllowed()) wx.navigateTo({url: '/pages/record-editor/index?id=' + encodeURIComponent(this.recipeId)}); },
  favorite() {
    if (!this.actionAllowed()) return;
    try { store.toggleFavorite(this.recipeId); this.refresh(); }
    catch (error) { ui.error(error); }
  },
  refreshAfterSync() {
    if (!this._syncRefreshPending || !this._visible || !this.accountOK(false) || !this.data.recipe ||
      this.data.publicBusy || this.data.deleting || this.data.publicLoading || this.data.shareLoading ||
      this.data.deleteVisible) return;
    return this.refreshPublication();
  },
  refreshPublication(fromOperation) {
    this._shareReturn.clear();
    const identity = shareIdentity(store.getRecipe(this.recipeId));
    const work = this.loadPublication(fromOperation);
    const flight = {request: this._publicRequest, identity, work};
    this._publicFlight = flight;
    const complete = () => { if (this._publicFlight === flight) this._publicFlight = null; };
    work.then(complete, complete);
    return work;
  },
  async loadPublication(fromOperation) {
    if (!this.data.socialEnabled || !this.accountOK(false) || !this.data.recipe || this.data.deleting || this.data.publicBusy) return false;
    const identity = shareIdentity(store.getRecipe(this.recipeId));
    const retained = this.shareAvailable();
    if (!retained) this._sharePhoto.clear();
    this._syncRefreshPending = false;
    if (this.data.builtIn) {
      this.setData({publicInfo: null, publicReady: true, publicLoading: false, publicError: '', shareRecipe: null, shareError: ''});
      this.updateShareMenu(); return true;
    }
    const request = this._publicRequest = (this._publicRequest || 0) + 1;
    this._shareIdentity = identity;
    this.setData({publicReady: retained, publicError: '', publicLoading: true,
      ...(!retained ? {shareRecipe: null, shareReady: false} : {}), shareLoading: true, shareError: ''});
    this.updateShareMenu();
    try {
      const result = await social.getRecipeShareLink(this.recipeId, {force: fromOperation === true});
      if (!this.accountOK(false) || request !== this._publicRequest) return false;
      const local = store.getRecipe(this.recipeId), recipe = result && result.recipe;
      if (!local || identity !== shareIdentity(local)) throw Error('菜谱来源已变化，请重新读取分享信息。');
      if (!recipe || !/^[a-f0-9]{64}$/.test(recipe.id || '') || typeof recipe.name !== 'string' || !recipe.name.trim()) {
        throw Error('暂时无法读取可分享的菜谱，请重试。');
      }
      // Use the existing public card even if local edits have not synced yet.
      if (!this._sharePhoto.get(recipe.photoURL)) this._sharePhoto.prepare(recipe.photoURL);
      this.setData({publicInfo: {id: recipe.id},
        publicReady: true, shareRecipe: {id: recipe.id, name: recipe.name, photoURL: recipe.photoURL || ''}});
      return true;
    } catch (error) {
      if (this.accountOK(false) && request === this._publicRequest) {
        if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
        else {
          this._sharePhoto.clear();
          this.setData({publicInfo: null, publicReady: false, shareRecipe: null, shareError: error.message || '分享信息暂时无法读取，请重试。'});
        }
      }
      return false;
    } finally {
      if (this.accountOK(false) && request === this._publicRequest) {
        this.setData({publicLoading: false, shareLoading: false}); this.updateShareMenu();
        this.refreshAfterSync();
      }
    }
  },
  openProfile() { if (this.data.socialEnabled && this.actionAllowed()) wx.navigateTo({url: '/pages/profile/index'}); },
  openPublicRecipe() {
    if (this.data.socialEnabled && this.actionAllowed() && this.data.publicInfo) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(this.data.publicInfo.id)});
  },
  openCooksnap() {
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.builtIn) return;
    const source = this.data.recipe && this.data.recipe.source;
    if (source && /^[a-f0-9]{64}$/.test(source.recipeId)) wx.navigateTo({url: '/pages/cooksnap-editor/index?id=' + encodeURIComponent(source.recipeId)});
  },
  shareAvailable() {
    const data = this.data;
    return !this._unloaded && !this._accountLocked && data.socialEnabled && !!data.recipe &&
      !data.publicBusy && !data.deleting && !data.deleteVisible &&
      (data.builtIn ? Boolean(getBuiltInRecipe(this.recipeId)) : (data.publicReady &&
      !!data.publicInfo && !!data.shareRecipe && data.shareRecipe.id === data.publicInfo.id &&
      this._shareIdentity === shareIdentity(store.getRecipe(this.recipeId))));
  },
  updateShareMenu() {
    const available = this.shareAvailable();
    if (available !== this.data.shareReady) this.setData({shareReady: available});
    if (available === this._shareMenuShown) return;
    this._shareMenuShown = available;
    const method = available ? 'showShareMenu' : 'hideShareMenu';
    if (wx[method]) wx[method]({menus: ['shareAppMessage']});
  },
  requestShare() {
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.publicLoading || this.data.shareLoading || this.data.builtIn) return;
    return this.refreshPublication(true);
  },
  onShareAppMessage() {
    this._shareReturn.clear();
    if (this.accountOK(false) && this.shareAvailable()) {
      // The card uses the public metadata already read for this recipe.
      this._shareReturn.share({recipeId: this.recipeId, request: this._publicRequest,
        identity: this._shareIdentity});
      if (this.data.builtIn) {
        const recipe = getBuiltInRecipe(this.recipeId);
        return {title: recipe.name + ' · 口袋食谱', path: '/pages/builtin-recipe/index?id=' + encodeURIComponent(recipe.id),
          imageUrl: getCover(recipe) || '/assets/cute/pocket-mascot.png'};
      }
      const recipe = this.data.shareRecipe;
      return {title: recipe.name + ' · 口袋食谱', path: '/pages/public-recipe/index?id=' + encodeURIComponent(recipe.id),
        imageUrl: this._sharePhoto.get(recipe.photoURL) || '/assets/cute/pocket-mascot.png'};
    }
    return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  publicationFailed(error, fallback) {
    if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
    else this.setData({publicError: error.message || fallback});
  },
  remove() {
    if (!this.actionAllowed()) return;
    const state = store.getState();
    const count = state.logs.filter(log => log.recipeId === this.recipeId).length;
    this.setData({
      deleteVisible: true,
      deleteContent: `这道菜谱和关联的 ${count} 条用餐记录将被删除。${this.data.socialEnabled ? '同步后会从推荐和主页移除，好友已添加的副本会保留。' : ''}可先在「设置」中导出备份。`
    });
    this.updateShareMenu();
  },
  cancelDelete() {
    if (this.accountOK(false) && !this.data.deleting) {
      this.setData({deleteVisible: false}); this.updateShareMenu(); this.refreshAfterSync();
    }
  },
  confirmDelete() {
    if (!this.accountOK(true) || this.data.deleting || this.data.publicBusy || !this.data.deleteVisible) return;
    this._publicRequest = (this._publicRequest || 0) + 1;
    this.setData({deleting: true, deleteVisible: false, shareRecipe: null, shareReady: false, shareLoading: false, publicLoading: false});
    this.updateShareMenu();
    try {
      store.deleteRecipe(this.recipeId);
    }
    catch (error) {
      if (this.accountOK(false)) {
        this.setData({deleting: false});
        ui.error(error);
        this.updateShareMenu();
        this.refreshAfterSync();
      }
      return;
    }
    // Keep the current view during the back animation. Store notifications and
    // late share responses must not render a missing recipe before unload.
    if (this.accountOK(false)) ui.back();
    if (this.data.socialEnabled) {
      // The tombstone is already persisted. Connectivity must not delay leaving;
      // cloud-sync owns retry/status, without callbacks into this departing page.
      Promise.resolve().then(() => cloudSync.syncNow()).catch(() => {});
    }
  },
  back() { if (!this.data.publicBusy && !this.data.deleting) { this._shareReturn.clear(); ui.back(); } }
});
