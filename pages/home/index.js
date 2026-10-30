const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const defaultPantryPreview = ['南瓜', '鸡蛋', '西兰花', '小米'];

function homeRecipes(state) {
  const all = selectors.listRecipes(state);
  const today = selectors.today();
  const day = 24 * 60 * 60 * 1000;
  const end = Date.parse(today + 'T00:00:00Z');
  const start = new Date(end - 29 * day).toISOString().slice(0, 10);
  const counts = new Map();
  for (const log of selectors.listLogs(state)) {
    if (log.date < start || log.date > today) continue;
    const entry = counts.get(log.recipeId) || {count: 0, date: log.date, createdAt: log.createdAt || 0};
    entry.count += 1;
    counts.set(log.recipeId, entry);
  }
  if (!counts.size) return {recommendationTitle: '今日推荐', recommendations: all.slice(0, 6)};
  const frequent = all.filter(recipe => counts.has(recipe.id)).sort((a, b) => {
    const first = counts.get(a.id), second = counts.get(b.id);
    return second.count - first.count || second.date.localeCompare(first.date) || second.createdAt - first.createdAt;
  });
  return {recommendationTitle: '最近常做', recommendations: frequent.slice(0, 4).map(recipe =>
    Object.assign({}, recipe, {recentMealCount: counts.get(recipe.id).count}))};
}

Page({
  data: {
    nickname: '宝宝', greeting: '你好', warning: '', search: '', recommendations: [],
    recommendationTitle: '今日推荐', recommendationOwner: '', pantryCount: 0, pantryPreview: defaultPantryPreview
  },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const state = store.getState();
      const pantry = typeof getApp === 'function' ? getApp().globalData.pantry || [] : [];
      const hour = new Date().getHours();
      const greeting = hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
      this.setData({greeting, nickname: state.nickname || '宝宝', warning: store.getWarning(),
        recommendationOwner: store.getSyncInfo().owner || '',
        pantryCount: pantry.length, pantryPreview: pantry.length ? pantry.slice(0, 4) : defaultPantryPreview,
        ...homeRecipes(state)});
    } catch (error) { ui.error(error); }
  },
  search(event) { this.setData({search: typeof event.detail.value === 'string' ? event.detail.value : ''}); },
  submitSearch(event) {
    const value = event && event.detail && typeof event.detail.value === 'string' ? event.detail.value : this.data.search;
    const search = value.trim();
    if (!search) return;
    this.setData({search});
    wx.hideKeyboard();
    wx.navigateTo({url: '/pages/recipes/index?search=' + encodeURIComponent(search)});
  },
  openRecipe(event) {
    const id = event.detail && event.detail.id || event.currentTarget && event.currentTarget.dataset.id;
    if (id) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  toggleFavorite(event) {
    const id = event.currentTarget && event.currentTarget.dataset.id;
    if (!id) return;
    try {
      if (event.currentTarget.dataset.owner !== (store.getSyncInfo().owner || '')) return this.refresh();
      if (!store.getState().recipes.some(recipe => recipe.id === id)) return this.refresh();
      store.toggleFavorite(id);
      this.refresh();
    } catch (error) { ui.error(error); }
  },
  goRandom() { wx.navigateTo({url: '/pages/random/index'}); },
  goIngredients() { wx.navigateTo({url: '/pages/ingredients/index'}); },
  goRecipes() { wx.navigateTo({url: '/pages/recipes/index'}); },
  addRecipe() { wx.navigateTo({url: '/pages/editor/index'}); }
});
