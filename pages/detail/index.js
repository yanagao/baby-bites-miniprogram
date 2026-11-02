const store = require('../../utils/store');
const {enrichRecipe, listLogs} = require('../../utils/selectors');
const ui = require('../../utils/ui');
const social = require('../../utils/social');
const cloudSync = require('../../utils/cloud-sync');
const config = require('../../config/cloud');
const syncVersion = status => status && Number.isSafeInteger(status.revision) && Number.isSafeInteger(status.publicationVersion) ?
  status.owner + ':' + status.revision + ':' + status.publicationVersion : '';

Page({
  data: {
    recipe: null, lastLog: null, socialEnabled: config.socialEnabled === true,
    deleteVisible: false,
    deleteContent: '',
    deleteConfirmButton: {content: '删除菜谱', theme: 'danger'},
    deleting: false,
    publicInfo: null, publicReady: false, publicError: '', publicBusy: false, publicLoading: false,
    profileExists: false, publicChanged: false, publishVisible: false,
    shareRecipe: null, shareVisible: false, shareAfterPublish: false, shareLoading: false, shareError: ''
  },
  onLoad(options) {
    this.recipeId = options.id;
    this._unloaded = false;
    this._visible = false;
    this._syncRefreshPending = false;
    this._lastSyncedKey = typeof cloudSync.getStatus === 'function' ? syncVersion(cloudSync.getStatus()) : '';
    this._sessionOwner = store.getSyncInfo().owner;
    this._accountBound = Boolean(this._sessionOwner);
    this._accountLocked = false;
    this._publishAfterSetup = false;
    this._profileSetupRequest = 0;
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
    const resumePublish = this._publishAfterSetup;
    const resumeConfirmation = this.data.publishVisible;
    const resumeShare = (resumePublish || resumeConfirmation) && this.data.shareAfterPublish;
    this._publishAfterSetup = false;
    this._profileSetupRequest++;
    this._openingProfile = false;
    this.setData({publishVisible: false, shareAfterPublish: false, shareVisible: false});
    this.refresh();
    if (!this.data.socialEnabled) return;
    const ready = await this.refreshPublication();
    if (ready && !this.data.publicInfo && (resumePublish || resumeConfirmation) && this.actionAllowed() && (this.data.profileExists || resumeShare)) {
      this.setData({publishVisible: true, shareAfterPublish: resumeShare});
      this.updateShareMenu();
    }
  },
  onHide() { this._visible = false; },
  onUnload() {
    this._unloaded = true;
    this._visible = false;
    this._syncRefreshPending = false;
    this._publishAfterSetup = false;
    this._profileSetupRequest++;
    this._publicRequest = (this._publicRequest || 0) + 1;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.updateShareMenu();
    if (this._unsubscribeAccount) this._unsubscribeAccount();
    if (this._unsubscribeSync) this._unsubscribeSync();
  },
  accountOK(report) {
    if (this._unloaded) return false;
    const current = store.getSyncInfo().owner;
    if (!this._accountBound && current) { this._sessionOwner = current; this._accountBound = true; }
    else if (this._accountBound && current !== this._sessionOwner) this._accountLocked = true;
    if (!this._accountLocked) return true;
    const message = '微信账号已切换，请返回后重新打开菜谱。';
    if (!this._accountCleared) {
      this._accountCleared = true;
      this._syncRefreshPending = false;
      this._publishAfterSetup = false;
      this._profileSetupRequest++;
      this._publicRequest = (this._publicRequest || 0) + 1;
      this._shareRequest = (this._shareRequest || 0) + 1;
      this.setData({recipe: null, lastLog: null, publicInfo: null, publicReady: false,
        publicError: message, publicChanged: false, profileExists: false,
        publishVisible: false, deleteVisible: false, publicBusy: false, publicLoading: false, deleting: false,
        shareRecipe: null, shareVisible: false, shareAfterPublish: false, shareLoading: false, shareError: ''});
      this.updateShareMenu();
    }
    if (report) ui.error(new Error(message));
    return false;
  },
  actionAllowed() {
    return this.accountOK(true) && !this.data.publicBusy && !this.data.deleting &&
      !this.data.deleteVisible && !this.data.publishVisible && !this.data.shareVisible && Boolean(this.data.recipe);
  },
  refresh() {
    if (!this.accountOK(false)) return;
    try {
      const state = store.getState();
      const recipe = state.recipes.find(item => item.id === this.recipeId);
      this.setData({recipe: recipe ? enrichRecipe(state, recipe) : null, lastLog: listLogs(state).find(log => log.recipeId === this.recipeId) || null,
        publicChanged: !!(recipe && this.data.publicInfo && this.data.publicInfo.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))});
      if (!recipe) this.setData({shareRecipe: null, shareVisible: false, shareAfterPublish: false, publishVisible: false});
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
      this.data.publishVisible || this.data.deleteVisible || this.data.shareVisible || this._openingProfile) return;
    return this.refreshPublication(true);
  },
  async refreshPublication(fromOperation) {
    if (!this.data.socialEnabled || !this.accountOK(false) || this.data.deleting || (this.data.publicBusy && fromOperation !== true)) return;
    this._syncRefreshPending = false;
    const request = this._publicRequest = (this._publicRequest || 0) + 1;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.setData({publicReady: false, publicError: '', publicLoading: true,
      shareRecipe: null, shareVisible: false, shareLoading: false, shareError: ''});
    this.updateShareMenu();
    try {
      const mine = await social.getMine(fromOperation ? {force: true} : undefined);
      if (!this.accountOK(false) || request !== this._publicRequest) return;
      if (!mine || !mine.profile || typeof mine.profile.exists !== 'boolean' || !Array.isArray(mine.published) ||
        !mine.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim())) {
        throw Error('暂时无法确认公开状态，请重试。');
      }
      const publicInfo = mine.published.find(item => item.sourceRecipeId === this.recipeId) || null;
      this.setData({publicInfo, profileExists: mine.profile.exists, publicReady: true, publicLoading: false});
      this.refresh();
      if (publicInfo && this.data.recipe) await this.refreshShareRecipe(request);
      if (!this.accountOK(false) || request !== this._publicRequest) return false;
      return this.data.publicReady;
    } catch (error) {
      if (this.accountOK(false) && request === this._publicRequest) {
        if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
        else this.setData({publicError: error.message || '暂时无法读取公开状态', publicLoading: false});
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
  requestPublish() {
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.publicLoading || this._openingProfile) return;
    this.setData({shareAfterPublish: false});
    if (!this.data.publicReady) return this.refreshPublication().then(ready => {
      if (ready && this.accountOK(false)) this.requestPublish();
    });
    if (this.data.publicInfo) return;
    if (!this.data.profileExists) {
      this.openPublishProfile();
      return;
    }
    this.setData({publishVisible: true});
    this.updateShareMenu();
  },
  openPublishProfile() {
    const setupRequest = ++this._profileSetupRequest;
    this._publishAfterSetup = false; this._openingProfile = true;
    wx.navigateTo({url: '/pages/profile/index?edit=1&returnToRecipe=1',
      events: {profileSaved: () => {
        if (this.accountOK(false) && setupRequest === this._profileSetupRequest) this._publishAfterSetup = true;
      }},
      fail: () => {
        if (setupRequest !== this._profileSetupRequest) return;
        this._publishAfterSetup = false; this._openingProfile = false;
        if (this.accountOK(false)) {
          this.setData({shareAfterPublish: false});
          ui.error(Error('暂时无法打开主页设置，请重试。'));
        }
      }});
  },
  cancelPublish() {
    if (this.accountOK(false) && !this.data.publicBusy) {
      this.setData({publishVisible: false, shareAfterPublish: false});
      this.updateShareMenu();
      this.refreshAfterSync();
    }
  },
  shareAvailable() {
    const data = this.data;
    return !this._unloaded && !this._accountLocked && data.socialEnabled && !!data.recipe &&
      data.publicReady && !data.publicLoading && !data.publicBusy && !data.deleting &&
      !data.publishVisible && !data.deleteVisible && !data.shareLoading &&
      !!data.publicInfo && !!data.shareRecipe && data.shareRecipe.id === data.publicInfo.id;
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
        throw Error('暂时无法读取可分享的公开版本，请重试。');
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
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.publicLoading || this.data.shareLoading || this._openingProfile) return;
    if (!this.data.publicReady) {
      if (await this.refreshPublication()) return this.requestShare();
      return;
    }
    if (!this.data.publicInfo) {
      this.setData({publishVisible: true, shareAfterPublish: true, shareError: ''});
      this.updateShareMenu();
      return;
    }
    if (!this.data.shareRecipe) await this.refreshShareRecipe(this._publicRequest);
    if (this.accountOK(false) && this.shareAvailable()) this.setData({shareVisible: true});
  },
  closeShare() {
    if (this.accountOK(false)) { this.setData({shareVisible: false}); this.refreshAfterSync(); }
  },
  onShareAppMessage() {
    if (this.accountOK(false) && this.shareAvailable()) {
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
  async confirmPublish() {
    if (!this.data.socialEnabled || !this.accountOK(true) || !this.data.publishVisible || this.data.publicBusy || this.data.deleting) return;
    if (!this.data.recipe || this.data.publicInfo) { this.cancelPublish(); return; }
    if (!this.data.profileExists) {
      this.setData({publishVisible: false});
      this.openPublishProfile();
      return;
    }
    const shareAfterPublish = this.data.shareAfterPublish;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.setData({publicBusy: true, publishVisible: false, publicError: '',
      shareRecipe: null, shareVisible: false, shareAfterPublish: false, shareLoading: false, shareError: ''});
    this.updateShareMenu();
    try {
      await social.publishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      wx.showToast({title: '菜谱已公开', icon: 'success'});
      const ready = await this.refreshPublication(true);
      if (ready && shareAfterPublish && this.data.shareRecipe) this.setData({shareVisible: true});
    } catch (error) { if (this.accountOK(false)) this.publicationFailed(error, '公开失败，请重试'); }
    finally { if (this.accountOK(false)) { this.setData({publicBusy: false}); this.updateShareMenu(); this.refreshAfterSync(); } }
  },
  async unpublish() {
    if (!this.data.socialEnabled || !this.actionAllowed() || !this.data.publicInfo) return;
    this._shareRequest = (this._shareRequest || 0) + 1;
    this.setData({publicBusy: true, publicError: '', shareRecipe: null, shareVisible: false, shareLoading: false});
    this.updateShareMenu();
    try {
      await social.unpublishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      this.setData({publicInfo: null, publicChanged: false});
      wx.showToast({title: '已设为私密', icon: 'success'});
    } catch (error) { if (this.accountOK(false)) this.publicationFailed(error, '操作失败，请重试'); }
    finally { if (this.accountOK(false)) { this.setData({publicBusy: false}); this.updateShareMenu(); this.refreshAfterSync(); } }
  },
  remove() {
    if (!this.actionAllowed()) return;
    const state = store.getState();
    const count = state.logs.filter(log => log.recipeId === this.recipeId).length;
    this.setData({
      deleteVisible: true,
      deleteContent: `这道菜谱和关联的 ${count} 条用餐记录将被删除。${this.data.socialEnabled ? '公开版本也会撤下，好友已添加的副本会保留。' : ''}可先在「设置」中导出备份。`
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
    try {
      if (this.data.socialEnabled) await social.unpublishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      // Even if the local deletion fails, reflect the successful withdrawal.
      this.setData({publicInfo: null, publicChanged: false, publicReady: true});
      store.deleteRecipe(this.recipeId); ui.back();
    }
    catch (error) { if (this.accountOK(false)) ui.error(error); }
    finally { if (this.accountOK(false)) { this.setData({deleting: false}); this.refreshAfterSync(); } }
  },
  back() { if (!this.data.publicBusy && !this.data.deleting) ui.back(); }
});
