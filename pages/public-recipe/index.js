const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('../profile/account');

Page({
  data: {loading: true, error: '', recipe: null, author: null, adding: false, importedId: '', photoFailed: false},
  onLoad(options) { this.recipeId = options.id || ''; this.request = 0; account.bind(this); },
  onShow() { this.load(); },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this); },
  async load() {
    if (!account.check(this)) return;
    const request = ++this.request;
    this.setData({loading: true, error: '', photoFailed: false});
    try {
      const result = await social.getRecipe(this.recipeId);
      if (request !== this.request) return;
      const imported = social.findImportedRecipe(this.recipeId);
      this.setData({recipe: result.recipe, author: result.author, importedId: imported ? imported.id : '', loading: false});
    } catch (error) { if (request === this.request) this.setData({loading: false, recipe: null, author: null, importedId: '', error: error.message || '这道菜谱暂时无法查看，可能已取消公开'}); }
  },
  async add() {
    if (!account.check(this)) return;
    if (this.data.adding || !this.data.recipe) return;
    if (this.data.importedId) { this.openOwn(); return; }
    this.setData({adding: true});
    try {
      const result = await social.addToCookbook(this.recipeId);
      if (!account.check(this)) return;
      this.setData({importedId: result.recipeId});
      wx.showToast({title: result.added ? '已添加到我的食谱' : '已在我的食谱中', icon: 'none'});
    } catch (error) { if (!account.check(this)) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (account.check(this)) this.setData({adding: false}); }
  },
  openOwn() { if (account.check(this) && this.data.importedId) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.importedId)}); },
  openAuthor() { if (this.data.author) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(this.data.author.id)}); },
  openSource() { const source = this.data.recipe && this.data.recipe.source; if (source) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(source.profileId)}); },
  photoError() { this.setData({photoFailed: true}); },
  previewPhoto() { if (this.data.recipe.photoURL && !this.data.photoFailed) wx.previewImage({current: this.data.recipe.photoURL, urls: [this.data.recipe.photoURL]}); },
  back: ui.back
});
