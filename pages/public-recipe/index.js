const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('../profile/account');
const {getProfileAvatar} = require('../../utils/profile-avatar');

Page({
  data: {
    loading: true, error: '', recipe: null, author: null, adding: false, importedId: '', photoFailed: false,
    authorIsSelf: false, following: false, followedBy: false, relationReady: false, relationLoading: false,
    relationError: '', followBusy: false, needsProfile: false
  },
  onLoad(options = {}) { this.recipeId = options.id || ''; this.request = 0; this.relationRequest = 0; account.bind(this); },
  onShow() { if (!this.data.adding && !this.data.followBusy) return this.load(); },
  onUnload() { this.request++; this.relationRequest++; account.dispose(this); },
  reload() { return account.reload(this); },
  async load() {
    if (!account.check(this) || this.data.adding || this.data.followBusy) return;
    const request = ++this.request;
    this.relationRequest++;
    this.setData({loading: true, error: '', photoFailed: false, authorIsSelf: false, following: false, followedBy: false,
      relationReady: false, relationLoading: false, relationError: '', needsProfile: false});
    if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
    try {
      const result = await social.getRecipe(this.recipeId);
      if (!account.check(this) || request !== this.request) return;
      const imported = social.findImportedRecipe(this.recipeId);
      const author = result.author ? {...result.author, avatar: getProfileAvatar(result.author.id)} : result.author;
      this.setData({recipe: result.recipe, author, importedId: imported ? imported.id : '', loading: false});
      if (wx.showShareMenu) wx.showShareMenu({menus: ['shareAppMessage']});
      await this.refreshAuthorRelationship(request);
    } catch (error) { if (account.check(this) && request === this.request) this.setData({loading: false, recipe: null, author: null, importedId: '', error: error.message || '这道菜谱暂时无法查看，可能已取消公开'}); }
  },
  async refreshAuthorRelationship(pageRequest) {
    if (!account.check(this) || this.data.loading || this.data.error || this.data.followBusy || !this.data.author) return;
    const request = typeof pageRequest === 'number' ? pageRequest : this.request;
    const relationRequest = ++this.relationRequest;
    const authorId = this.data.author.id;
    this.setData({relationLoading: true, relationReady: false, relationError: '', needsProfile: false});
    try {
      const result = await social.getProfile(authorId, 0);
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest ||
        !this.data.author || this.data.author.id !== authorId) return;
      this.setData({authorIsSelf: !!result.isSelf, following: !!result.following, followedBy: !!result.followedBy,
        relationReady: true, relationLoading: false});
    } catch (error) {
      if (!account.check(this) || request !== this.request || relationRequest !== this.relationRequest) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      // Relationship lookup is independent: recipe, save, and share stay usable.
      this.setData({relationLoading: false, relationReady: false,
        relationError: error.message || '关注状态暂时无法读取，请重试。'});
    }
  },
  async toggleFollow() {
    if (!account.check(this) || this.data.loading || this.data.error || !this.data.author ||
      !this.data.relationReady || this.data.authorIsSelf || this.data.followBusy) return;
    const request = this.request;
    const relationRequest = ++this.relationRequest;
    const authorId = this.data.author.id;
    this.setData({followBusy: true, relationLoading: false, relationError: '', needsProfile: false});
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
      else if (error.code === 'PROFILE_REQUIRED') this.setData({needsProfile: true});
      else this.setData({relationError: error.message || '关注操作未完成，请重试。'});
    } finally {
      if (account.check(this) && request === this.request && relationRequest === this.relationRequest) this.setData({followBusy: false});
    }
  },
  openProfileSetup() { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index?edit=1'}); },
  async add() {
    if (!account.check(this)) return;
    if (this.data.adding || this.data.error || !this.data.recipe) return;
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
  openOwn() { if (account.check(this) && this.data.importedId) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.importedId)}); },
  openAuthor() { if (account.check(this) && this.data.author) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(this.data.author.id)}); },
  openSource() { if (!account.check(this)) return; const source = this.data.recipe && this.data.recipe.source; if (source) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(source.profileId)}); },
  photoError() { this.setData({photoFailed: true}); },
  previewPhoto() { if (account.check(this) && this.data.recipe && this.data.recipe.photoURL && !this.data.photoFailed) wx.previewImage({current: this.data.recipe.photoURL, urls: [this.data.recipe.photoURL]}); },
  onShareAppMessage() {
    const recipe = account.check(this) && !this.data.loading && !this.data.error && this.data.recipe;
    return recipe ? {title: recipe.name + ' · 口袋食谱',
      path: '/pages/public-recipe/index?id=' + encodeURIComponent(recipe.id), imageUrl: '/assets/cute/pocket-mascot.png'} :
      {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index'};
  },
  back: ui.back
});
