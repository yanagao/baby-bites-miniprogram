const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('./account');

Page({
  data: {loading: true, error: '', profile: null, isSelf: false, following: false, recipes: [], nextOffset: null, loadingMore: false, editing: false, name: '', bio: '', saving: false, followBusy: false},
  onLoad(options) { this.profileId = options.id || ''; this.request = 0; account.bind(this); },
  onShow() { if (!this.data.editing) this.load(); },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this); },
  async load() {
    if (!account.check(this)) return;
    const request = ++this.request;
    this.setData({loading: true, error: '', loadingMore: false});
    try {
      let result;
      if (this.profileId) result = await social.getProfile(this.profileId, 0);
      else {
        const mine = await social.getMine();
        result = mine.profile.exists ? await social.getProfile(mine.profile.id, 0) : {profile: mine.profile, isSelf: true, following: false, recipes: [], nextOffset: null};
      }
      if (request !== this.request) return;
      const profile = result.profile;
      this.setData({profile, isSelf: result.isSelf, following: !!result.following, recipes: result.recipes || [], nextOffset: result.nextOffset == null ? null : result.nextOffset, name: profile.name, bio: profile.bio || '', loading: false});
      if (profile.exists !== false) wx.showShareMenu({menus: ['shareAppMessage']});
      else wx.hideShareMenu({menus: ['shareAppMessage']});
    } catch (error) {
      if (request === this.request) this.setData({loading: false, profile: null, recipes: [], error: error.message || '主页暂时无法加载'});
    }
  },
  edit() { if (account.check(this) && this.data.profile) this.setData({editing: true, name: this.data.profile.name, bio: this.data.profile.bio || ''}); },
  cancelEdit() { if (!this.data.saving) this.setData({editing: false}); },
  changeName(event) { this.setData({name: event.detail.value}); },
  changeBio(event) { this.setData({bio: event.detail.value}); },
  async save() {
    if (!account.check(this)) return;
    if (this.data.saving) return;
    const name = this.data.name.trim(), bio = this.data.bio.trim();
    if (!name) { ui.error(new Error('请填写公开昵称')); return; }
    this.setData({saving: true});
    try {
      await social.saveProfile({name, bio});
      if (!account.check(this)) return;
      this.setData({editing: false});
      wx.showToast({title: '主页已保存', icon: 'success'});
      await this.load();
    } catch (error) {
      if (!account.check(this)) return;
      ui.error(error);
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
    } finally { if (account.check(this)) this.setData({saving: false}); }
  },
  async toggleFollow() {
    if (!account.check(this)) return;
    if (this.data.followBusy || !this.data.profile) return;
    this.setData({followBusy: true});
    try {
      const result = await social.setFollowing(this.data.profile.id, !this.data.following);
      if (!account.check(this)) return;
      this.setData({following: result.following});
      wx.showToast({title: result.following ? '已关注' : '已取消关注', icon: 'none'});
    } catch (error) { if (!account.check(this)) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (account.check(this)) this.setData({followBusy: false}); }
  },
  async loadMore() {
    if (!account.check(this)) return;
    if (this.data.loadingMore || this.data.nextOffset === null || !this.data.profile) return;
    const request = this.request;
    this.setData({loadingMore: true});
    try {
      const result = await social.getProfile(this.data.profile.id, this.data.nextOffset);
      if (request !== this.request) return;
      const known = new Set(this.data.recipes.map(item => item.id));
      this.setData({recipes: this.data.recipes.concat(result.recipes.filter(item => !known.has(item.id))), nextOffset: result.nextOffset == null ? null : result.nextOffset});
    } catch (error) { if (!account.check(this)) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (request === this.request) this.setData({loadingMore: false}); }
  },
  onReachBottom() { this.loadMore(); },
  photoError(event) {
    const index = Number(event.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.recipes[index]) this.setData({[`recipes[${index}].photoURL`]: ''});
  },
  openRecipe(event) { wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openCookbook() { wx.switchTab({url: '/pages/recipes/index'}); },
  openFollowing() { wx.navigateTo({url: '/pages/following/index'}); },
  onShareAppMessage() {
    const profile = account.check(this) ? this.data.profile : null;
    return profile && profile.exists !== false ? {title: profile.name + '的口袋食谱', path: '/pages/profile/index?id=' + encodeURIComponent(profile.id), imageUrl: '/assets/cute/pocket-mascot.png'} : {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index'};
  },
  back: ui.back
});
