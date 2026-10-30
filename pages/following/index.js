const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('../profile/account');
const {getProfileAvatar} = require('../../utils/profile-avatar');
const tabs = ['recipes', 'people', 'followers'];

function relationships(profiles, tab) {
  return profiles.map(item => ({...item,
    avatar: getProfileAvatar(item.id),
    following: typeof item.following === 'boolean' ? item.following : tab === 'people',
    followedBy: typeof item.followedBy === 'boolean' ? item.followedBy : tab === 'followers'
  }));
}
function feedRecipes(recipes) {
  return recipes.map(recipe => ({...recipe, authorAvatar: getProfileAvatar(recipe.profileId)}));
}
function read(tab, cursor) {
  return tab === 'recipes' ? social.getFeed(cursor) : tab === 'followers' ? social.getFollowers(cursor) : social.getFollowing(cursor);
}

Page({
  data: {
    tab: 'recipes', loading: true, loadingMore: false, error: '', recipes: [], profiles: [],
    nextCursor: null, nextOffset: null, followBusyId: '', needsProfile: false
  },
  onLoad(options = {}) { this.request = 0; if (tabs.includes(options.tab)) this.setData({tab: options.tab}); account.bind(this); },
  onShow() { if (!this.data.followBusyId) return this.load(); },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this); },
  changeTab(event) {
    const tab = event.detail.value;
    if (account.check(this) && !this.data.followBusyId && tabs.includes(tab) && tab !== this.data.tab) {
      this.setData({tab}); return this.load();
    }
  },
  async load() {
    if (!account.check(this) || this.data.followBusyId) return;
    const request = ++this.request, tab = this.data.tab;
    this.setData({loading: true, loadingMore: false, error: '', needsProfile: false, recipes: [], profiles: [], nextCursor: null, nextOffset: null});
    try {
      const result = await read(tab, tab === 'recipes' ? undefined : 0);
      if (!account.check(this) || request !== this.request) return;
      this.setData(tab === 'recipes' ? {recipes: feedRecipes(result.recipes), nextCursor: result.nextCursor || null, loading: false} : {
        profiles: relationships(result.profiles, tab), nextOffset: result.nextOffset == null ? null : result.nextOffset, loading: false
      });
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      this.setData({loading: false, recipes: [], profiles: [], error: error.message || '暂时无法加载，请重试'});
    }
  },
  async loadMore() {
    if (!account.check(this)) return;
    const tab = this.data.tab, cursor = tab === 'recipes' ? this.data.nextCursor : this.data.nextOffset;
    if (this.data.loading || this.data.loadingMore || this.data.followBusyId || cursor === null) return;
    const request = this.request;
    this.setData({loadingMore: true});
    try {
      const result = await read(tab, cursor);
      if (!account.check(this) || request !== this.request) return;
      const key = tab === 'recipes' ? 'recipes' : 'profiles', known = new Set(this.data[key].map(item => item.id));
      const incoming = tab === 'recipes' ? feedRecipes(result.recipes) : relationships(result.profiles, tab);
      this.setData({[key]: this.data[key].concat(incoming.filter(item => !known.has(item.id))),
        ...(tab === 'recipes' ? {nextCursor: result.nextCursor || null} : {nextOffset: result.nextOffset == null ? null : result.nextOffset})});
    } catch (error) { if (!account.check(this) || request !== this.request) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (account.check(this) && request === this.request) this.setData({loadingMore: false}); }
  },
  async toggleFollow(event) {
    if (!account.check(this) || this.data.loading || this.data.loadingMore || this.data.followBusyId) return;
    const id = event.currentTarget.dataset.id;
    const person = this.data.profiles.find(item => item.id === id);
    if (!person) return;
    const request = this.request;
    const tab = this.data.tab;
    this.setData({followBusyId: id, needsProfile: false});
    try {
      const result = await social.setFollowing(id, !person.following);
      if (!account.check(this) || request !== this.request) return;
      const following = !!result.following;
      const followedBy = typeof result.followedBy === 'boolean' ? result.followedBy : person.followedBy;
      this.setData({profiles: this.data.profiles.map(item => item.id === id ? {...item, following, followedBy} : item)});
      wx.showToast({title: following ? followedBy ? '已互相关注' : '已关注' : '已取消关注', icon: 'none'});
      // Removing an outgoing relation shifts offset pagination. Reload before
      // another page can be requested so no remaining person is skipped.
      if (tab === 'people' && !following) { this.setData({followBusyId: ''}); await this.load(); }
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'PROFILE_REQUIRED') this.setData({needsProfile: true});
      else { ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    } finally { if (account.check(this) && request === this.request) this.setData({followBusyId: ''}); }
  },
  onReachBottom() { return this.loadMore(); },
  photoError(event) {
    if (!account.check(this)) return;
    const {id, url} = event.currentTarget.dataset;
    const index = this.data.recipes.findIndex(recipe => recipe.id === id && (recipe.photoURL || recipe.displayPhoto) === url);
    if (index >= 0) this.setData({[`recipes[${index}].photoURL`]: '', [`recipes[${index}].displayPhoto`]: ''});
  },
  openRecipe(event) { if (account.check(this)) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openProfile(event) { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openMine() { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index' + (this.data.needsProfile ? '?edit=1' : '')}); },
  showPeople() { return this.changeTab({detail: {value: 'people'}}); },
  back: ui.back
});
