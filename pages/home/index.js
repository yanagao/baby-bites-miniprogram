const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
Page({
  data: {
    nickname: '宝宝', warning: '', result: null, candidateCount: 0, recipeCount: 0,
    category: '全部', categoryOptions: selectors.categories.map(value => ({label: value, value})), categoryScrollTarget: 'category-0',
    skipDisliked: false, recentLogs: []
  },
  onShow() { syncTabBar(this); this.refresh(!this._didInitialDraw); },
  onReady() { syncTabBar(this); },
  candidates(state) {
    return selectors.listRecipes(state, {category: this.data.category})
      .filter(recipe => !this.data.skipDisliked || recipe.rating !== 1);
  },
  refresh(selectInitial = false) {
    try {
      const state = store.getState();
      const pool = this.candidates(state);
      const current = this.data.result && pool.find(recipe => recipe.id === this.data.result.id);
      const result = current || (selectInitial ? selectors.randomRecipe(state, {
        category: this.data.category, skipDisliked: this.data.skipDisliked
      }) : null);
      this.setData({nickname: state.nickname || '宝宝', warning: store.getWarning(),
        recipeCount: state.recipes.length, candidateCount: pool.length,
        result: result || null, recentLogs: selectors.listLogs(state).slice(0, 2)});
      if (selectInitial && result) this._didInitialDraw = true;
    } catch (error) { ui.error(error); }
  },
  draw() {
    try {
      const state = store.getState();
      const result = selectors.randomRecipe(state, {category: this.data.category,
        skipDisliked: this.data.skipDisliked, lastId: this.data.result && this.data.result.id});
      this.setData({result, candidateCount: this.candidates(state).length, recipeCount: state.recipes.length});
    } catch (error) { ui.error(error); }
  },
  tapCategory(event) { this.changeCategory({detail: {value: event.currentTarget.dataset.value}}); },
  changeCategory(event) {
    if (!selectors.categories.includes(event.detail.value)) return;
    this.setData({category: event.detail.value, categoryScrollTarget: 'category-' + selectors.categories.indexOf(event.detail.value)}); this.refresh();
  },
  skip(event) { this.setData({skipDisliked: event.detail.value === true}); this.refresh(); },
  resetFilters() { this.setData({category: '全部', categoryScrollTarget: 'category-0', skipDisliked: false}); this.refresh(); },
  detail() {
    if (this.data.result) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.result.id)});
  },
  openRecipe(event) {
    const id = event.currentTarget.dataset.id;
    if (id) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  openSettings() { wx.navigateTo({url: '/pages/settings/index'}); },
  goIngredients() { wx.switchTab({url: '/pages/ingredients/index'}); },
  goRecipes() { wx.switchTab({url: '/pages/recipes/index'}); },
  addRecipe() { wx.navigateTo({url: '/pages/editor/index'}); }
});
