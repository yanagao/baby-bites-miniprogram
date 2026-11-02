const store = require('../../utils/store');
const {enrichRecipe, listLogs} = require('../../utils/selectors');
const ui = require('../../utils/ui');
const social = require('../../utils/social');
const cloudSync = require('../../utils/cloud-sync');
const config = require('../../config/cloud');
const {isBuiltInRecipe} = require('../../utils/recipe-origin');
const syncVersion = status => status && Number.isSafeInteger(status.revision) && Number.isSafeInteger(status.publicationVersion) ?
  status.owner + ':' + status.revision + ':' + status.publicationVersion : '';

Page({
  data: {
    recipe: null, lastLog: null, socialEnabled: config.socialEnabled === true,
    deleteVisible: false,
    deleteContent: '',
    deleteConfirmButton: {content: '删除菜谱', theme: 'danger'},
    deleting: false,
    familyRecipe: false, publicInfo: null, publicReady: false, publicError: '', publicBusy: false, publicLoading: false,
    builtIn: false, publicChanged: false,
    shareRecipe: null, shareVisible: false, shareLoading: false, shareError: ''
  },
  onLoad(options) {
    this.recipeId = options.id;
    this._unloaded = false;
    this._visible = false;
    this._syncRefreshPending = false;
    this._lastSyncedKey = typeof cloudSync.getStatus === 'function' ? syncVersion(cloudSync.getStatus()) : '';
    this._sessionOwner = store.getSyncInfo().owner;
    this._sessionScope = store.getSyncInfo().scopeKey || this._sessionOwner;
    this._accountBound = Boolean(this._sessionOwner);
    this._accountLocked = false;
    this._unsubscribeAccount = store.subscribe(() => { this.accountOK(false); });
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
    this._visible = true;
    this._openingPreview = false;
    this.setData({shareVisible: false});
    this.refresh();
    if (this.data.socialEnabled) await this.refreshPublication();
  },
  onHide() { this._visible = false; },
  onUnload() {
    this._unloaded = true;
    this._visible = false;
    this._syncRefreshPending = false;
    this._publicRequest = (this._publicRequest || 0) + 1;
    this._shareRequest = (this._shareRequest || 0) + 1;
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
      this._syncRefreshPending = false;
      this._publicRequest = (this._publicRequest || 0) + 1;
      this._shareRequest = (this._shareRequest || 0) + 1;
      this.setData({recipe: null, lastLog: null, publicInfo: null, publicReady: false,
        publicError: message, publicChanged: false, builtIn: false,
        deleteVisible: false, publicBusy: false, publicLoading: false, deleting: false,
        shareRecipe: null, shareVisible: false, shareLoading: false, shareError: ''});
      this.updateShareMenu();
    }
    if (report) ui.error(new Error(message));
    return false;
  },
  actionAllowed() {
    return this.accountOK(true) && !this.data.publicBusy && !this.data.deleting &&
      !this.data.deleteVisible && !this.data.shareVisible && Boolean(this.data.recipe);
  },
  refresh() {
    if (!this.accountOK(false)) return;
    try {
      const state = store.getState();
      const recipe = state.recipes.find(item => item.id === this.recipeId);
      this.setData({familyRecipe: Boolean(recipe && recipe.createdBy && recipe.createdBy !== store.getSyncInfo().owner), recipe: recipe ? enrichRecipe(state, recipe) : null, builtIn: isBuiltInRecipe(recipe), lastLog: listLogs(state).find(log => log.recipeId === this.recipeId) || null,
        publicChanged: !!(recipe && this.data.publicInfo && this.data.publicInfo.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))});
      if (!recipe) this.setData({shareRecipe: null, shareVisible: false});
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
      this.data.deleteVisible || this.data.shareVisible) return;
    return this.refreshPublication(true);
  },
  async refreshPublication(fromOperation) {
    if (!this.data.socialEnabled || !this.accountOK(false) || this.data.deleting || (this.data.publicBusy && fromOperation !== true)) return;
    this._syncRefreshPending = false;
    if (this.data.builtIn) {
      this.setData({publicInfo: null, publicReady: true, publicLoading: false, publicError: '', shareRecipe: null, shareError: ''});
      this.updateShareMenu();
      return true;
    }
    const request = this._publicRequest = (this._publicRequest || 0) + 1;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.setData({publicReady: false, publicError: '', publicLoading: true,
      shareRecipe: null, shareVisible: false, shareLoading: false, shareError: ''});
    this.updateShareMenu();
    try {
      if (this.data.familyRecipe) {
        const link = await social.getFamilyRecipeLink(this.recipeId, fromOperation ? {force: true} : undefined);
        if (!this.accountOK(false) || request !== this._publicRequest) return;
        this.setData({publicInfo: link.publication, publicReady: true, publicLoading: false});
        if (link.publication) await this.refreshShareRecipe(request);
        return this.data.publicReady;
      }
      const mine = await social.getMine(fromOperation ? {force: true} : undefined);
      if (!this.accountOK(false) || request !== this._publicRequest) return;
      if (!mine || !mine.profile || typeof mine.profile.exists !== 'boolean' || !Array.isArray(mine.published) ||
        !mine.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim())) {
        throw Error('暂时无法确认同步状态，请重试。');
      }
      const publicInfo = mine.published.find(item => item.sourceRecipeId === this.recipeId) || null;
      this.setData({publicInfo, publicReady: true, publicLoading: false});
      this.refresh();
      if (publicInfo && this.data.recipe) await this.refreshShareRecipe(request);
      if (!this.accountOK(false) || request !== this._publicRequest) return false;
      return this.data.publicReady;
    } catch (error) {
      if (this.accountOK(false) && request === this._publicRequest) {
        if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
        else this.setData({publicError: error.message || '暂时无法读取同步状态', publicLoading: false});
      }
      return false;
    } finally {
      if (request === this._publicRequest) this.refreshAfterSync();
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
      (data.builtIn || (data.publicReady && !data.publicLoading && !data.shareLoading &&
      !!data.publicInfo && !!data.shareRecipe && data.shareRecipe.id === data.publicInfo.id));
  },
  updateShareMenu() {
    const available = this.shareAvailable();
    if (available === this._shareMenuShown) return;
    this._shareMenuShown = available;
    const method = available ? 'showShareMenu' : 'hideShareMenu';
    if (wx[method]) wx[method]({menus: ['shareAppMessage']});
  },
  async refreshShareRecipe(publicRequest) {
    if (!this.accountOK(false) || !this.data.publicReady || !this.data.publicInfo || !this.data.recipe) return;
    const id = this.data.publicInfo.id;
    const request = this._shareRequest = (this._shareRequest || 0) + 1;
    const current = () => this.accountOK(false) && request === this._shareRequest &&
      publicRequest === this._publicRequest && this.data.publicInfo && this.data.publicInfo.id === id;
    this.setData({shareRecipe: null, shareLoading: true, shareError: ''});
    this.updateShareMenu();
    try {
      const result = await social.getRecipe(id);
      if (!current()) return;
      const recipe = result && result.recipe;
      if (!recipe || recipe.id !== id || !/^[a-f0-9]{64}$/.test(id) || typeof recipe.name !== 'string' || !recipe.name.trim()) {
        throw Error('暂时无法读取可分享的菜谱，请重试。');
      }
      // Only the public snapshot may supply share metadata. Local edits and
      // automatic page screenshots can contain information the user kept private.
      this.setData({shareRecipe: {id, name: recipe.name}});
    } catch (error) {
      if (!current()) return;
      if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
      else {
        const unavailable = ['NOT_FOUND', 'RECIPE_NOT_FOUND', 'NOT_PUBLIC'].includes(error.code);
        this.setData({shareError: error.message || '分享暂时不可用，请重试。',
          ...(unavailable ? {publicInfo: null, publicReady: false, publicChanged: false} : {})});
      }
    } finally {
      if (this.accountOK(false) && request === this._shareRequest && publicRequest === this._publicRequest) {
        this.setData({shareLoading: false});
        this.updateShareMenu();
      }
    }
  },
  async requestShare() {
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.publicLoading || this.data.shareLoading || this.data.builtIn || this._openingPreview) return;
    if (!this.data.publicReady && !(await this.refreshPublication())) return;
    if (!this.accountOK(false) || !this.data.recipe || this.data.builtIn || this.data.deleting || this.data.deleteVisible) return;
    if (!this.data.publicInfo && this.data.familyRecipe) {
      ui.error(Error('请由添加这道菜的家人选择公开分享。')); return;
    }
    if (!this.data.publicInfo) {
      this._openingPreview = true;
      wx.navigateTo({url: '/pages/share-preview/index?id=' + encodeURIComponent(this.recipeId),
        fail: () => {
          this._openingPreview = false;
          if (this.accountOK(false)) this.setData({shareError: '暂时无法打开分享预览，请重试。'});
        }});
      return;
    } else if (!this.data.shareRecipe) await this.refreshShareRecipe(this._publicRequest);
    if (this.accountOK(false) && this.shareAvailable()) this.setData({shareVisible: true});
  },
  closeShare() {
    if (this.accountOK(false)) { this.setData({shareVisible: false}); this.refreshAfterSync(); }
  },
  onShareAppMessage() {
    if (this.accountOK(false) && !this.data.builtIn && this.shareAvailable()) {
      const recipe = this.data.shareRecipe;
      return {title: recipe.name + ' · 口袋食谱', path: '/pages/public-recipe/index?id=' + encodeURIComponent(recipe.id),
        imageUrl: '/assets/cute/pocket-mascot.png'};
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
  async confirmDelete() {
    if (!this.accountOK(true) || this.data.deleting || this.data.publicBusy || !this.data.deleteVisible) return;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.setData({deleting: true, deleteVisible: false, shareRecipe: null, shareVisible: false, shareLoading: false});
    this.updateShareMenu();
    let deleted = false;
    try {
      store.deleteRecipe(this.recipeId);
      deleted = true;
      this.setData({recipe: null, publicInfo: null, publicChanged: false, publicReady: true});
      if (this.data.socialEnabled) {
        const status = await cloudSync.syncNow();
        if (!this.accountOK(false)) return;
        if (!status || status.state !== 'synced') wx.showToast({title: '已删除，联网后同步', icon: 'none'});
      }
      if (this.accountOK(false)) ui.back();
    }
    catch (error) {
      if (this.accountOK(false)) {
        if (deleted) { wx.showToast({title: '已删除，联网后同步', icon: 'none'}); ui.back(); }
        else ui.error(error);
      }
    }
    finally { if (this.accountOK(false)) { this.setData({deleting: false}); this.refreshAfterSync(); } }
  },
  back() { if (!this.data.publicBusy && !this.data.deleting) ui.back(); }
});
