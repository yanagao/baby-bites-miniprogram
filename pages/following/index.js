const social = require('../../utils/social');
const store = require('../../utils/store');
const {findRecipeAllergens} = require('../../utils/allergies');
const ui = require('../../utils/ui');
const account = require('../profile/account');
const {getProfileAvatar} = require('../../utils/profile-avatar');
const tabs = ['recipes', 'people', 'followers'];

function avatarFor(id, url, failed) {
  const avatar = getProfileAvatar(id, url);
  return failed && failed.has(id + ':' + avatar) ? getProfileAvatar(id) : avatar;
}
function relationships(profiles, tab, failed) {
  return profiles.map(item => ({...item,
    avatar: avatarFor(item.id, item.avatarURL, failed),
    following: typeof item.following === 'boolean' ? item.following : tab === 'people',
    followedBy: typeof item.followedBy === 'boolean' ? item.followedBy : tab === 'followers'
  }));
}
function feedRecipes(recipes, failed) {
  return recipes.map(recipe => ({...recipe, authorAvatar: avatarFor(recipe.profileId, recipe.authorAvatarURL, failed)}));
}
function read(tab, cursor, options) {
  return tab === 'recipes' ? social.getFeed(cursor, options) : tab === 'followers' ? social.getFollowers(cursor, options) : social.getFollowing(cursor, options);
}
const readVersion = () => typeof social.getReadVersion === 'function' ? social.getReadVersion() : null;

Page({
  onShareAppMessage() {
    return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  data: {
    tab: 'recipes', loading: true, loadingMore: false, error: '', recipes: [], profiles: [],
    nextCursor: null, nextOffset: null, followBusyId: '', hasAllergies: false, skippedAllergyCount: 0
  },
  onLoad(options = {}) { this.request = 0; this._allRecipes = []; this._failedAvatars = new Set(); if (tabs.includes(options.tab)) this.setData({tab: options.tab}); account.bind(this); },
  onShow() {
    if (!account.check(this) || this.data.followBusyId) return;
    if (this._loadFlight && this._loadFlight.request === this.request) return this._loadFlight.work;
    if (!this.data.error && !this.data.loading && this._loadedTab === this.data.tab &&
      this._loadedVersion === readVersion()) {
      this.refreshAllergies(); return;
    }
    return this.load();
  },
  onUnload() { this.request++; account.dispose(this); },
  reload() { return account.reload(this, {force: true}); },
  onPullDownRefresh() {
    if (this.data.followBusyId) {
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      return;
    }
    if (this._pullDownFlight) return this._pullDownFlight;
    const work = Promise.resolve(this.reload()).finally(() => {
      if (this._pullDownFlight === work) this._pullDownFlight = null;
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    });
    this._pullDownFlight = work;
    return work;
  },
  disposeLocalContent() { this._allRecipes = []; this._loadedTab = ''; this._loadFlight = null; if (this.accountSession && this.accountSession.changed) this._failedAvatars.clear(); this.setData({hasAllergies: false, skippedAllergyCount: 0}); },
  refreshAllergies() {
    if (!account.check(this) || this.data.tab !== 'recipes') return;
    const allergies = store.getAllergyFilterEnabled() ? store.getState().allergies || [] : [];
    const all = this._allRecipes || [];
    const recipes = allergies.length ? all.filter(recipe => !findRecipeAllergens(recipe, allergies).length) : all;
    this.setData({recipes, hasAllergies: Boolean(allergies.length), skippedAllergyCount: all.length - recipes.length});
  },
  changeTab(event) {
    const tab = event.detail.value;
    if (account.check(this) && !this.data.followBusyId && tabs.includes(tab) && tab !== this.data.tab) {
      this.setData({tab}); return this.load();
    }
  },
  load(options) {
    if (!account.check(this) || this.data.followBusyId) return;
    const work = this.loadList(options);
    const flight = {request: this.request, work};
    this._loadFlight = flight;
    const complete = () => { if (this._loadFlight === flight) this._loadFlight = null; };
    work.then(complete, complete);
    return work;
  },
  async loadList(options) {
    if (!account.check(this) || this.data.followBusyId) return;
    const request = ++this.request, tab = this.data.tab;
    const version = readVersion();
    this._allRecipes = [];
    this.refreshAllergies();
    this.setData({loading: true, loadingMore: false, error: '', recipes: [], profiles: [], nextCursor: null, nextOffset: null});
    try {
      const result = await read(tab, tab === 'recipes' ? undefined : 0, options);
      if (!account.check(this) || request !== this.request) return;
      if (tab === 'recipes') this._allRecipes = feedRecipes(result.recipes, this._failedAvatars);
      this._loadedTab = tab; this._loadedVersion = version;
      this.setData(tab === 'recipes' ? {nextCursor: result.nextCursor || null, loading: false} : {
        profiles: relationships(result.profiles, tab, this._failedAvatars), nextOffset: result.nextOffset == null ? null : result.nextOffset, loading: false
      });
      this.refreshAllergies();
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
      const key = tab === 'recipes' ? 'recipes' : 'profiles';
      const existing = tab === 'recipes' ? this._allRecipes || [] : this.data.profiles;
      const known = new Set(existing.map(item => item.id));
      const incoming = tab === 'recipes' ? feedRecipes(result.recipes, this._failedAvatars) : relationships(result.profiles, tab, this._failedAvatars);
      const combined = existing.concat(incoming.filter(item => { if (known.has(item.id)) return false; known.add(item.id); return true; }));
      if (tab === 'recipes') this._allRecipes = combined;
      this.setData(tab === 'recipes' ? {nextCursor: result.nextCursor || null} : {profiles: combined, nextOffset: result.nextOffset == null ? null : result.nextOffset});
      this.refreshAllergies();
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
    this.setData({followBusyId: id});
    try {
      const result = await social.setFollowing(id, !person.following);
      if (!account.check(this) || request !== this.request) return;
      const following = !!result.following;
      const followedBy = typeof result.followedBy === 'boolean' ? result.followedBy : person.followedBy;
      this.setData({profiles: this.data.profiles.map(item => item.id === id ? {...item, following, followedBy} : item)});
      wx.showToast({title: following ? followedBy ? '已互相关注' : '已关注' : '已取消关注', icon: 'none'});
      // Removing an outgoing relation shifts offset pagination. Reload before
      // another page can be requested so no remaining person is skipped.
      if (tab === 'people' && !following) { this.setData({followBusyId: ''}); await this.load({force: true}); }
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
    } finally { if (account.check(this) && request === this.request) this.setData({followBusyId: ''}); }
  },
  onReachBottom() { return this.loadMore(); },
  feedAvatarError(event) {
    if (!account.check(this)) return;
    const {id, url} = event.currentTarget.dataset;
    const fallback = getProfileAvatar(id);
    if (url === fallback || !(this._allRecipes || []).some(item => item.profileId === id && item.authorAvatar === url)) return;
    this._failedAvatars.add(id + ':' + url);
    this._allRecipes = this._allRecipes.map(item => item.profileId === id && item.authorAvatar === url ? {...item, authorAvatar: fallback} : item);
    this.refreshAllergies();
  },
  profileAvatarError(event) {
    if (!account.check(this)) return;
    const {id, url} = event.currentTarget.dataset;
    const fallback = getProfileAvatar(id);
    if (url === fallback || !this.data.profiles.some(item => item.id === id && item.avatar === url)) return;
    this._failedAvatars.add(id + ':' + url);
    this.setData({profiles: this.data.profiles.map(item => item.id === id && item.avatar === url ? {...item, avatar: fallback} : item)});
  },
  photoError(event) {
    if (!account.check(this)) return;
    const {id, url} = event.currentTarget.dataset;
    this._allRecipes = (this._allRecipes || []).map(recipe => recipe.id === id && (recipe.photoURL || recipe.displayPhoto) === url ? {...recipe, photoURL: '', displayPhoto: ''} : recipe);
    const index = this.data.recipes.findIndex(recipe => recipe.id === id && (recipe.photoURL || recipe.displayPhoto) === url);
    if (index >= 0) this.setData({[`recipes[${index}].photoURL`]: '', [`recipes[${index}].displayPhoto`]: ''});
  },
  openRecipe(event) {
    if (!account.check(this)) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.recipes.some(recipe => recipe.id === id)) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(id)});
  },
  openProfile(event) { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(event.currentTarget.dataset.id)}); },
  openMine() { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index'}); },
  showPeople() { return this.changeTab({detail: {value: 'people'}}); },
  back: ui.back
});
