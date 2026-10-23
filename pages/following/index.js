const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('../profile/account');

Page({
  data: {tab: 'recipes', loading: true, loadingMore: false, error: '', recipes: [], profiles: [], nextCursor: null, nextOffset: null},
  onLoad() { this.request = 0; account.bind(this); },
  onShow() { this.load(); },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this); },
  changeTab(event) { if (event.detail.value !== this.data.tab) { this.setData({tab: event.detail.value}); this.load(); } },
  async load() {
    if (!account.check(this)) return;
    const request = ++this.request, tab = this.data.tab;
    this.setData({loading: true, loadingMore: false, error: ''});
    try {
      const result = tab === 'recipes' ? await social.getFeed() : await social.getFollowing(0);
      if (request !== this.request) return;
      this.setData(tab === 'recipes' ? {recipes: result.recipes, nextCursor: result.nextCursor || null, loading: false} : {profiles: result.profiles, nextOffset: result.nextOffset == null ? null : result.nextOffset, loading: false});
    } catch (error) { if (request === this.request) this.setData({loading: false, recipes: [], profiles: [], error: error.message || '暂时无法加载，请重试'}); }
  },
  async loadMore() {
    if (!account.check(this)) return;
    const tab = this.data.tab, cursor = tab === 'recipes' ? this.data.nextCursor : this.data.nextOffset;
    if (this.data.loading || this.data.loadingMore || cursor === null) return;
    const request = this.request;
    this.setData({loadingMore: true});
    try {
      const result = tab === 'recipes' ? await social.getFeed(cursor) : await social.getFollowing(cursor);
      if (request !== this.request) return;
      const key = tab === 'recipes' ? 'recipes' : 'profiles', known = new Set(this.data[key].map(item => item.id));
      this.setData({[key]: this.data[key].concat(result[key].filter(item => !known.has(item.id))), ...(tab === 'recipes' ? {nextCursor: result.nextCursor || null} : {nextOffset: result.nextOffset == null ? null : result.nextOffset})});
    } catch (error) { if (!account.check(this)) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (request === this.request) this.setData({loadingMore: false}); }
  },
  onReachBottom() { this.loadMore(); },
  photoError(event) { const index = Number(event.currentTarget.dataset.index); if (Number.isInteger(index) && this.data.recipes[index]) this.setData({[`recipes[${index}].photoURL`]: ''}); },
  openRecipe(event) { wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openProfile(event) { wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openMine() { wx.navigateTo({url: '/pages/profile/index'}); },
  showPeople() { this.setData({tab: 'people'}); this.load(); },
  back: ui.back
});
