const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
Page({
  data: {category: '全部', categoryOptions: selectors.categories.map(value => ({label: value, value})), skipDisliked: false, result: null, candidateCount: 0, hasRecipes: false},
  onShow() {
    try {
      const state = store.getState();
      const pool = this.candidates(state);
      const current = this.data.result && pool.find(recipe => recipe.id === this.data.result.id);
      if (!current) this.draw();
      else this.setData({result: current, candidateCount: pool.length, hasRecipes: Boolean(state.recipes.length)});
    } catch (error) { ui.error(error); }
  },
  candidates(state) { return selectors.listRecipes(state, {category: this.data.category}).filter(recipe => !this.data.skipDisliked || recipe.rating !== 1); },
  changeCategory(event) { const category = event.detail.value; if (selectors.categories.includes(category)) { this.setData({category}); this.draw(); } },
  skip(event) { this.setData({skipDisliked: event.detail.value === true}); this.draw(); },
  resetFilters() { this.setData({category: '全部', skipDisliked: false}); this.draw(); },
  draw() {
    try {
      const state = store.getState();
      const result = selectors.randomRecipe(state, {category: this.data.category, skipDisliked: this.data.skipDisliked, lastId: this.lastId});
      this.lastId = result ? result.id : null;
      this.setData({result, candidateCount: this.candidates(state).length, hasRecipes: Boolean(state.recipes.length)});
    } catch (error) { ui.error(error); }
  },
  detail() { if (this.data.result) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.result.id)}); },
  add() { wx.navigateTo({url: '/pages/editor/index'}); }
});
