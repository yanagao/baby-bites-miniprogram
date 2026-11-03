const store = require('../../utils/store');
const ui = require('../../utils/ui');

// Older in-app routes continue to work through the normal recipe share entry.
Page({
  data: {loading: false, error: ''},
  onLoad(options = {}) {
    this.recipeId = typeof options.id === 'string' ? options.id : '';
    const info = store.getSyncInfo();
    this.owner = info.owner; this.scope = info.scopeKey || info.owner;
    this.disposed = false; this.locked = false;
    this.unsubscribe = store.subscribe(() => this.current());
  },
  onShow() { if (!this.opened) return this.openRecipe(); },
  current() {
    if (this.disposed || this.locked) return false;
    const info = store.getSyncInfo();
    if (!this.owner && info.owner) { this.owner = info.owner; this.scope = info.scopeKey || info.owner; }
    if (info.owner !== this.owner || (info.scopeKey || info.owner) !== this.scope) {
      this.locked = true;
      this.setData({loading: false, error: '微信账号已切换，或家庭已变化，请返回后重新打开菜谱。'});
      return false;
    }
    return true;
  },
  openRecipe() {
    if (!this.current() || this.data.loading) return;
    if (!this.recipeId || !store.getRecipe(this.recipeId)) {
      this.setData({error: '没有找到这道菜谱，请返回食谱重新打开。'}); return;
    }
    this.opened = true;
    this.setData({loading: true, error: ''});
    const fail = () => { if (this.current()) this.setData({loading: false, error: '菜谱暂时无法打开，请重试。'}); };
    try { wx.redirectTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.recipeId), fail}); }
    catch (_) { fail(); }
  },
  onUnload() { this.disposed = true; if (this.unsubscribe) this.unsubscribe(); },
  back() { ui.back(); },
  onShareAppMessage() { return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'}; }
});
