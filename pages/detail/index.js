const store = require('../../utils/store');
const {enrichRecipe, listLogs} = require('../../utils/selectors');
const ui = require('../../utils/ui');
const social = require('../../utils/social');
const config = require('../../config/cloud');

Page({
  data: {
    recipe: null, lastLog: null, socialEnabled: config.socialEnabled === true,
    deleteVisible: false,
    deleteContent: '',
    deleteConfirmButton: {content: '删除菜谱', theme: 'danger'},
    deleting: false,
    publicInfo: null, publicReady: false, publicError: '', publicBusy: false, publicLoading: false,
    profileExists: false, publicChanged: false, publishVisible: false
  },
  onLoad(options) {
    this.recipeId = options.id;
    this._unloaded = false;
    this._sessionOwner = store.getSyncInfo().owner;
    this._accountBound = Boolean(this._sessionOwner);
    this._accountLocked = false;
    this._publishAfterSetup = false;
    this._profileSetupRequest = 0;
    this._unsubscribeAccount = store.subscribe(() => { this.accountOK(false); });
  },
  async onShow() {
    if (!this.accountOK(false)) return;
    const resumePublish = this._publishAfterSetup;
    this._publishAfterSetup = false;
    this._profileSetupRequest++;
    this._openingProfile = false;
    this.refresh();
    if (!this.data.socialEnabled) return;
    const ready = await this.refreshPublication();
    if (ready && resumePublish && this.actionAllowed() && this.data.profileExists) this.setData({publishVisible: true});
  },
  onUnload() {
    this._unloaded = true;
    this._publishAfterSetup = false;
    this._profileSetupRequest++;
    this._publicRequest = (this._publicRequest || 0) + 1;
    if (this._unsubscribeAccount) this._unsubscribeAccount();
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
      this._publishAfterSetup = false;
      this._profileSetupRequest++;
      this._publicRequest = (this._publicRequest || 0) + 1;
      this.setData({recipe: null, lastLog: null, publicInfo: null, publicReady: false,
        publicError: message, publicChanged: false, profileExists: false,
        publishVisible: false, deleteVisible: false, publicBusy: false, publicLoading: false, deleting: false});
    }
    if (report) ui.error(new Error(message));
    return false;
  },
  actionAllowed() {
    return this.accountOK(true) && !this.data.publicBusy && !this.data.deleting &&
      !this.data.deleteVisible && !this.data.publishVisible && Boolean(this.data.recipe);
  },
  refresh() {
    if (!this.accountOK(false)) return;
    try {
      const state = store.getState();
      const recipe = state.recipes.find(item => item.id === this.recipeId);
      this.setData({recipe: recipe ? enrichRecipe(state, recipe) : null, lastLog: listLogs(state).find(log => log.recipeId === this.recipeId) || null,
        publicChanged: !!(recipe && this.data.publicInfo && this.data.publicInfo.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))});
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
  async refreshPublication(fromOperation) {
    if (!this.data.socialEnabled || !this.accountOK(false) || this.data.deleting || (this.data.publicBusy && fromOperation !== true)) return;
    const request = this._publicRequest = (this._publicRequest || 0) + 1;
    this.setData({publicReady: false, publicError: '', publicLoading: true});
    try {
      const mine = await social.getMine();
      if (!this.accountOK(false) || request !== this._publicRequest) return;
      if (!mine || !mine.profile || typeof mine.profile.exists !== 'boolean' || !Array.isArray(mine.published) ||
        !mine.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim())) {
        throw Error('暂时无法确认公开状态，请重试。');
      }
      const publicInfo = mine.published.find(item => item.sourceRecipeId === this.recipeId) || null;
      this.setData({publicInfo, profileExists: mine.profile.exists, publicReady: true, publicLoading: false});
      this.refresh();
      return true;
    } catch (error) {
      if (this.accountOK(false) && request === this._publicRequest) {
        if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
        else this.setData({publicError: error.message || '暂时无法读取公开状态', publicLoading: false});
      }
      return false;
    }
  },
  openProfile() { if (this.data.socialEnabled && this.actionAllowed()) wx.navigateTo({url: '/pages/profile/index'}); },
  openPublicRecipe() {
    if (this.data.socialEnabled && this.actionAllowed() && this.data.publicInfo) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(this.data.publicInfo.id)});
  },
  requestPublish() {
    if (!this.data.socialEnabled || !this.actionAllowed() || this.data.publicLoading || this._openingProfile) return;
    if (!this.data.publicReady) return this.refreshPublication().then(ready => {
      if (ready && this.accountOK(false)) this.requestPublish();
    });
    if (!this.data.profileExists) {
      const setupRequest = ++this._profileSetupRequest;
      this._publishAfterSetup = false; this._openingProfile = true;
      wx.navigateTo({url: '/pages/profile/index?edit=1&returnToRecipe=1',
        events: {profileSaved: () => {
          if (this.accountOK(false) && setupRequest === this._profileSetupRequest) this._publishAfterSetup = true;
        }},
        fail: () => {
          if (setupRequest !== this._profileSetupRequest) return;
          this._publishAfterSetup = false; this._openingProfile = false;
          if (this.accountOK(false)) ui.error(Error('暂时无法打开主页设置，请重试。'));
        }});
      return;
    }
    this.setData({publishVisible: true});
  },
  cancelPublish() { if (this.accountOK(false) && !this.data.publicBusy) this.setData({publishVisible: false}); },
  publicationFailed(error, fallback) {
    if (error.code === 'ACCOUNT_CHANGED') { this._accountLocked = true; this.accountOK(false); }
    else this.setData({publicError: error.message || fallback});
  },
  async confirmPublish() {
    if (!this.data.socialEnabled || !this.accountOK(true) || !this.data.publishVisible || this.data.publicBusy || this.data.deleting) return;
    this.setData({publicBusy: true, publishVisible: false, publicError: ''});
    try {
      await social.publishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      wx.showToast({title: '菜谱已公开', icon: 'success'});
      await this.refreshPublication(true);
    } catch (error) { if (this.accountOK(false)) this.publicationFailed(error, '公开失败，请重试'); }
    finally { if (this.accountOK(false)) this.setData({publicBusy: false}); }
  },
  async unpublish() {
    if (!this.data.socialEnabled || !this.actionAllowed() || !this.data.publicInfo) return;
    this.setData({publicBusy: true, publicError: ''});
    try {
      await social.unpublishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      this.setData({publicInfo: null, publicChanged: false});
      wx.showToast({title: '已设为私密', icon: 'success'});
    } catch (error) { if (this.accountOK(false)) this.publicationFailed(error, '操作失败，请重试'); }
    finally { if (this.accountOK(false)) this.setData({publicBusy: false}); }
  },
  remove() {
    if (!this.actionAllowed()) return;
    const state = store.getState();
    const count = state.logs.filter(log => log.recipeId === this.recipeId).length;
    this.setData({
      deleteVisible: true,
      deleteContent: `这道菜谱和关联的 ${count} 条用餐记录将被删除。${this.data.socialEnabled ? '公开版本也会撤下，好友已添加的副本会保留。' : ''}可先在「设置」中导出备份。`
    });
  },
  cancelDelete() { if (this.accountOK(false) && !this.data.deleting) this.setData({deleteVisible: false}); },
  async confirmDelete() {
    if (!this.accountOK(true) || this.data.deleting || this.data.publicBusy || !this.data.deleteVisible) return;
    this.setData({deleting: true, deleteVisible: false});
    try {
      if (this.data.socialEnabled) await social.unpublishRecipe(this.recipeId);
      if (!this.accountOK(false)) return;
      // Even if the local deletion fails, reflect the successful withdrawal.
      this.setData({publicInfo: null, publicChanged: false, publicReady: true});
      store.deleteRecipe(this.recipeId); ui.back();
    }
    catch (error) { if (this.accountOK(false)) ui.error(error); }
    finally { if (this.accountOK(false)) this.setData({deleting: false}); }
  },
  back() { if (!this.data.publicBusy && !this.data.deleting) ui.back(); }
});
