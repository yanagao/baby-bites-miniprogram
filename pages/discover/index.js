const social = require('../../utils/social');
const account = require('../profile/account');
const {syncTabBar} = require('../../utils/tab-bar');

function read(tab, search, cursor) {
  return tab === 'following' ? social.getFeed(cursor) : social.getDiscover({search, cursor});
}
function appendUnique(existing, incoming) {
  const known = new Set(existing.map(item => item.id));
  return existing.concat(incoming.filter(item => {
    if (known.has(item.id)) return false;
    known.add(item.id);
    return true;
  }));
}
function recommend(recipes) {
  // Offer a mix of real recipe categories; no popularity metrics are invented.
  const groups = new Map();
  recipes.forEach(recipe => {
    const category = recipe.category || '';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(recipe);
  });
  const result = [];
  while (result.length < recipes.length) groups.forEach(items => { if (items.length) result.push(items.shift()); });
  return result;
}

Page({
  data: {tab: 'recommended', search: '', query: '', loading: true, loadingMore: false,
    error: '', loadMoreError: '', recipes: [], nextCursor: null},
  onLoad() { this.request = 0; account.bind(this); },
  onShow() { syncTabBar(this); return this.load(); },
  onReady() { syncTabBar(this); },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this); },
  changeTab(event) {
    const tab = event.detail.value;
    if (!account.check(this) || !['recommended', 'latest', 'following'].includes(tab) || tab === this.data.tab) return;
    this.setData({tab, search: '', query: ''});
    return this.load();
  },
  searchInput(event) {
    if (!account.check(this)) return;
    this.setData({search: typeof event.detail.value === 'string' ? event.detail.value.slice(0, 60) : ''});
  },
  submitSearch(event) {
    if (!account.check(this)) return;
    const value = event && event.detail && event.detail.value;
    const query = (typeof value === 'string' ? value : this.data.search).trim().slice(0, 60);
    this.setData({search: query, query, tab: 'latest'});
    return this.load();
  },
  clearSearch() {
    if (!account.check(this)) return;
    this.setData({search: '', query: ''});
    return this.load();
  },
  async load() {
    if (!account.check(this)) return;
    const request = ++this.request;
    const {tab, query} = this.data;
    this.setData({loading: true, loadingMore: false, error: '', loadMoreError: '', recipes: [], nextCursor: null});
    try {
      const result = await read(tab, query);
      if (!account.check(this) || request !== this.request) return;
      const recipes = appendUnique([], result.recipes);
      this.setData({loading: false, recipes: tab === 'recommended' ? recommend(recipes) : recipes, nextCursor: result.nextCursor || null});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      this.setData({loading: false, error: error.message || '暂时无法加载菜谱，请重试。'});
    }
  },
  async loadMore() {
    if (!account.check(this) || this.data.loading || this.data.loadingMore || this.data.error || !this.data.nextCursor) return;
    const request = this.request;
    const {tab, query, nextCursor} = this.data;
    this.setData({loadingMore: true, loadMoreError: ''});
    try {
      const result = await read(tab, query, nextCursor);
      if (!account.check(this) || request !== this.request) return;
      const incoming = tab === 'recommended' ? recommend(result.recipes) : result.recipes;
      this.setData({recipes: appendUnique(this.data.recipes, incoming), nextCursor: result.nextCursor || null});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
      else this.setData({loadMoreError: error.message || '下一页未能加载，请重试。'});
    } finally {
      if (account.check(this) && request === this.request) this.setData({loadingMore: false});
    }
  },
  onReachBottom() { if (!this.data.loadMoreError) return this.loadMore(); },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  photoError(event) {
    if (!account.check(this)) return;
    const {id, url} = event.detail && event.detail.id ? event.detail : event.currentTarget.dataset;
    const index = this.data.recipes.findIndex(item => item.id === id && (item.displayPhoto || item.photoURL) === url);
    if (index >= 0) this.setData({[`recipes[${index}].photoURL`]: '', [`recipes[${index}].displayPhoto`]: ''});
  },
  openRecipe(event) {
    if (!account.check(this)) return;
    const id = event.detail && event.detail.id || event.currentTarget.dataset.id;
    if (this.data.recipes.some(item => item.id === id)) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(id)});
  },
  openProfile(event) {
    if (!account.check(this)) return;
    const id = event.detail && event.detail.id || event.currentTarget.dataset.id;
    if (this.data.recipes.some(item => item.profileId === id)) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(id)});
  },
  openFollowing() { if (account.check(this)) wx.navigateTo({url: '/pages/following/index?tab=people'}); },
  showLatest() { return this.changeTab({detail: {value: 'latest'}}); }
});
