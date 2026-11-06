const social = require('../../utils/social');
const store = require('../../utils/store');
const {findRecipeAllergens} = require('../../utils/allergies');
const ui = require('../../utils/ui');
const account = require('../profile/account');
const {getProfileAvatar} = require('../../utils/profile-avatar');
const {createShareReturn} = require('../../utils/native-share-return');
const {createSharePhoto} = require('../../utils/recipe-share-photo');
const readVersion = () => typeof social.getReadVersion === 'function' ? social.getReadVersion() : null;

Page({
  data: {
    loading: true, error: '', recipe: null, author: null, adding: false, importedId: '', photoFailed: false,
    authorKnown: false, authorIsSelf: false, following: false, followedBy: false, relationReady: false, relationLoading: false,
    relationError: '', followBusy: false, allergyWarning: '',
    feedbackLoading: false, feedbackError: '', feedbackReady: false, saveCount: 0, cooksnapCount: 0,
    cooksnaps: [], feedbackOffset: null, feedbackMore: false, deletingCooksnap: ''
  },
  onLoad(options = {}) { this.recipeId = options.id || ''; this.request = 0; this.relationRequest = 0; this._shareReturn = createShareReturn(wx); this._sharePhoto = createSharePhoto(wx); this._recipeReadVersion = null; account.bind(this); },
  onShow() {
    if (!account.check(this)) return;
    const shareReturn = this._shareReturn.show();
    if (this.data.adding || this.data.followBusy || this.data.deletingCooksnap) return;
    if (shareReturn && shareReturn.recipeId === this.recipeId && shareReturn.request === this.request &&
      shareReturn.version === readVersion() && !this.data.loading && !this.data.error &&
      this.data.recipe && this.data.recipe.id === this.recipeId) {
      this.refreshAllergies();
      const imported = social.findImportedRecipe(this.recipeId);
      const importedId = imported ? imported.id : '';
      if (importedId !== this.data.importedId) this.setData({importedId});
      return;
    }
    return this.load();
  },
  onUnload() { this._shareReturn.dispose(); this._sharePhoto.clear(); this.request++; this.relationRequest++; account.dispose(this); },
  reload() { this._shareReturn.clear(); return account.reload(this, {force: true}); },
  disposeLocalContent() {
    this._shareReturn.clear();
    this._sharePhoto.clear();
    this._recipeReadVersion = null;
    this.feedbackRequest = (this.feedbackRequest || 0) + 1;
    this.setData({allergyWarning: '', feedbackLoading: false, feedbackMore: false, feedbackReady: false,
      feedbackError: '', saveCount: 0, cooksnapCount: 0, cooksnaps: [], feedbackOffset: null, deletingCooksnap: ''});
  },
  refreshAllergies() {
    if (!account.check(this)) return;
    const allergies = store.getState().allergies || [];
    const matched = this.data.recipe && allergies.length ? findRecipeAllergens(this.data.recipe, allergies) : [];
    const allergyWarning = matched.length ? '含已记录的过敏食材：' + matched.join('、') + '，请勿给宝宝食用。' : '';
    if (allergyWarning !== this.data.allergyWarning) this.setData({allergyWarning});
  },
  async load(options) {
    this._shareReturn.clear();
    if (!account.check(this) || this.data.adding || this.data.followBusy || this.data.deletingCooksnap) return;
    const request = ++this.request;
    this.relationRequest++;
    this.disposeLocalContent();
    this.setData({loading: true, error: '', photoFailed: false, authorKnown: false, authorIsSelf: false, following: false, followedBy: false,
      relationReady: false, relationLoading: false, relationError: '', allergyWarning: ''});
    if (wx.showShareMenu) wx.showShareMenu({menus: ['shareAppMessage']});
    try {
      const result = await social.getRecipe(this.recipeId, options);
      if (!account.check(this) || request !== this.request) return;
      // Only a completed recipe read can make this displayed recipe current.
      // Later relationship/feedback reads and opening a share sheet cannot.
      this._recipeReadVersion = readVersion();
      this._sharePhoto.prepare(result.recipe && result.recipe.photoURL);
      const imported = social.findImportedRecipe(this.recipeId);
      const author = result.author ? {...result.author, avatar: getProfileAvatar(result.author.id)} : result.author;
      this.setData({recipe: result.recipe, author, importedId: imported ? imported.id : '', loading: false});
      this.refreshAllergies();
      if (wx.showShareMenu) wx.showShareMenu({menus: ['shareAppMessage']});
      await Promise.all([this.refreshAuthorRelationship(request, options), this.loadFeedback(false, options)]);
    } catch (error) { if (account.check(this) && request === this.request) this.setData({loading: false, recipe: null, author: null, importedId: '', error: error.message || '这道菜谱暂时无法查看，可能已被删除'}); }
  },
  async loadFeedback(more = false, options) {
    if (!account.check(this) || !this.data.recipe || this.data.loading || this.data.error || this.data.deletingCooksnap ||
      this.data.feedbackLoading || this.data.feedbackMore || (more && this.data.feedbackOffset === null)) return;
    const request = this.request, feedbackRequest = (this.feedbackRequest || 0) + 1;
    this.feedbackRequest = feedbackRequest;
    const offset = more ? this.data.feedbackOffset : 0;
    this.setData({feedbackLoading: !more, feedbackMore: more, feedbackError: ''});
    try {
      const result = await social.getRecipeFeedback(this.recipeId, offset, options);
      if (!account.check(this) || request !== this.request || feedbackRequest !== this.feedbackRequest) return;
      const items = result.cooksnaps.map(item => ({...item,
        dateLabel: new Date(item.createdAt).toLocaleDateString('zh-CN'), photoFailed: false}));
      const previous = more ? this.data.cooksnaps : [];
      const ids = new Set(previous.map(item => item.id));
      this.setData({feedbackReady: true, saveCount: result.saveCount, cooksnapCount: result.cooksnapCount,
        cooksnaps: previous.concat(items.filter(item => !ids.has(item.id))), feedbackOffset: result.nextOffset});
    } catch (error) {
      if (!account.check(this) || request !== this.request || feedbackRequest !== this.feedbackRequest) return;
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
      else this.setData({feedbackError: error.message || '跟做反馈暂时无法读取，请重试。'});
    } finally {
      if (account.check(this) && request === this.request && feedbackRequest === this.feedbackRequest) {
        this.setData({feedbackLoading: false, feedbackMore: false});
      }
    }
  },
  retryFeedback() { return this.loadFeedback(false, {force: true}); },
  moreFeedback() { return this.loadFeedback(true); },
  openCooksnap() {
    if (!account.check(this) || !this.data.recipe || this.data.loading || this.data.error ||
      !this.data.authorKnown || this.data.authorIsSelf || this._openingCooksnap) return;
    this._shareReturn.clear();
    this._openingCooksnap = true;
    wx.navigateTo({url: '/pages/cooksnap-editor/index?id=' + encodeURIComponent(this.recipeId),
      complete: () => { this._openingCooksnap = false; }});
  },
  previewCooksnap(event) {
    if (!account.check(this) || this.data.loading || this.data.error) return;
    this._shareReturn.clear();
    const item = this.data.cooksnaps.find(item => item.id === event.currentTarget.dataset.id);
    if (item && item.photoURL && !item.photoFailed) wx.previewImage({current: item.photoURL, urls: [item.photoURL]});
  },
  cooksnapPhotoError(event) {
    if (!account.check(this)) return;
    const id = event.currentTarget.dataset.id;
    this.setData({cooksnaps: this.data.cooksnaps.map(item => item.id === id ? {...item, photoFailed: true} : item)});
  },
  deleteCooksnap(event) {
    if (!account.check(this) || this.data.loading || this.data.error || this.data.deletingCooksnap) return;
    const item = this.data.cooksnaps.find(item => item.id === event.currentTarget.dataset.id && item.isSelf);
    if (!item) return;
    this._shareReturn.clear();
    const request = this.request;
    // A page response requested before deletion must not restore the removed row.
    this.feedbackRequest = (this.feedbackRequest || 0) + 1;
    this.setData({deletingCooksnap: item.id, feedbackLoading: false, feedbackMore: false});
    wx.showModal({title: '删除这条跟做？', content: '成品照和反馈会从菜谱与作者反馈中移除。',
      confirmText: '删除', confirmColor: '#b36f55',
      success: async result => {
        if (!account.check(this) || request !== this.request) return;
        if (!result.confirm) { this.setData({deletingCooksnap: ''}); return; }
        try {
          await social.deleteCooksnap(item.id);
          if (!account.check(this) || request !== this.request) return;
          this.setData({deletingCooksnap: '', feedbackReady: false, cooksnaps: this.data.cooksnaps.filter(value => value.id !== item.id)});
          wx.showToast({title: '跟做已删除', icon: 'none'});
          await this.loadFeedback(false, {force: true});
        } catch (error) {
          if (!account.check(this) || request !== this.request) return;
          this.setData({deletingCooksnap: ''});
          if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); else ui.error(error);
        }
      },
      fail: () => { if (account.check(this) && request === this.request) this.setData({deletingCooksnap: ''}); }
    });
  },
  async refreshAuthorRelationship(pageRequest, options) {
    if (!account.check(this) || this.data.loading || this.data.error || this.data.followBusy || !this.data.author) return;
    const request = typeof pageRequest === 'number' ? pageRequest : this.request;
    const relationRequest = ++this.relationRequest;
    const authorId = this.data.author.id;
    this.setData({relationLoading: true, relationReady: false, relationError: ''});
    try {
      const result = await social.getProfileSummary(authorId, typeof pageRequest === 'number' ? options : {force: true});
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest ||
        !this.data.author || this.data.author.id !== authorId) return;
      if (!result || typeof result.isSelf !== 'boolean') throw Error('暂时无法确认菜谱作者，请重试。');
      this.setData({authorKnown: true, authorIsSelf: result.isSelf, following: !!result.following, followedBy: !!result.followedBy,
        relationReady: true, relationLoading: false});
    } catch (error) {
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      // Reading and sharing stay available. Saving requires a known other author;
      // a later relationship refresh failure does not erase confirmed ownership.
      this.setData({relationLoading: false, relationReady: false,
        relationError: error.message || '关注状态暂时无法读取，请重试。'});
    }
  },
  async toggleFollow() {
    if (!account.check(this) || this.data.loading || this.data.error || !this.data.author ||
      !this.data.relationReady || this.data.authorIsSelf || this.data.followBusy) return;
    this._shareReturn.clear();
    const request = this.request;
    const relationRequest = ++this.relationRequest;
    const authorId = this.data.author.id;
    this.setData({followBusy: true, relationLoading: false, relationError: ''});
    try {
      const result = await social.setFollowing(authorId, !this.data.following);
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest) return;
      const following = !!result.following;
      const followedBy = typeof result.followedBy === 'boolean' ? result.followedBy : this.data.followedBy;
      this.setData({following, followedBy});
      wx.showToast({title: following ? followedBy ? '已互相关注' : '已关注' : '已取消关注', icon: 'none'});
    } catch (error) {
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest) return;
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
      else this.setData({relationError: error.message || '关注操作未完成，请重试。'});
    } finally {
      if (account.check(this) && request === this.request && relationRequest === this.relationRequest) this.setData({followBusy: false});
    }
  },
  async add() {
    if (!account.check(this)) return;
    if (this.data.loading || this.data.adding || this.data.error || !this.data.recipe || !this.data.authorKnown || this.data.authorIsSelf) return;
    this._shareReturn.clear();
    if (this.data.importedId) { this.openOwn(); return; }
    const request = this.request;
    this.setData({adding: true});
    try {
      const result = await social.addToCookbook(this.recipeId);
      if (!account.check(this) || request !== this.request) return;
      this.setData({importedId: result.recipeId});
      wx.showToast({title: result.added ? '已保存到我的食谱' : '已在我的食谱中', icon: 'none'});
    } catch (error) { if (!account.check(this) || request !== this.request) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (account.check(this) && request === this.request) this.setData({adding: false}); }
  },
  openOwn() {
    if (account.check(this) && !this.data.loading && !this.data.error && this.data.recipe &&
      this.data.authorKnown && !this.data.authorIsSelf && this.data.importedId) {
      this._shareReturn.clear();
      wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.importedId)});
    }
  },
  openAuthor() { if (account.check(this) && this.data.author) { this._shareReturn.clear(); wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(this.data.author.id)}); } },
  openSource() { if (!account.check(this)) return; const source = this.data.recipe && this.data.recipe.source; if (source) { this._shareReturn.clear(); wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(source.profileId)}); } },
  photoError() { this.setData({photoFailed: true}); },
  previewPhoto() { this._shareReturn.clear(); if (account.check(this) && this.data.recipe && this.data.recipe.photoURL && !this.data.photoFailed) wx.previewImage({current: this.data.recipe.photoURL, urls: [this.data.recipe.photoURL]}); },
  onShareAppMessage() {
    const recipe = account.check(this) && !this.data.loading && !this.data.error && this.data.recipe;
    // The native share sheet can hide the page before or after this callback.
    // Reuse this view only for its next return, unless another action changes it.
    this._shareReturn.clear();
    if (recipe) this._shareReturn.share({recipeId: this.recipeId, request: this.request, version: this._recipeReadVersion});
    // displayPhoto can alias photoURL; use it only for recipes without an upload.
    return recipe ? {title: recipe.name + ' · 口袋食谱',
      path: '/pages/public-recipe/index?id=' + encodeURIComponent(recipe.id),
      imageUrl: (recipe.photoURL ? this._sharePhoto.get(recipe.photoURL) : recipe.displayPhoto) || '/assets/cute/pocket-mascot.png'} :
      {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  back() { this._shareReturn.clear(); ui.back(); }
});
