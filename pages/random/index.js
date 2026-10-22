const store = require('../../utils/store');
const { categories, randomRecipe, enrichRecipe } = require('../../utils/selectors');
const ui = require('../../utils/ui');

Page({
  data: { categories, categoryIndex: 0, skipDisliked: true, result: null },
  onLoad() { this.draw(); },
  onShow() {
    try {
      const state = store.getState();
      const current = this.data.result && state.recipes.find(recipe => recipe.id === this.data.result.id);
      const result = current && enrichRecipe(state, current);
      const category = categories[this.data.categoryIndex];
      if (!result || (category !== '全部' && result.category !== category) || (this.data.skipDisliked && result.rating === 1)) {
        this.draw();
      } else {
        this.setData({ result });
      }
    } catch (error) { ui.error(error); }
  },
  category(event) { this.setData({ categoryIndex: Number(event.detail.value) }); this.draw(); },
  skip(event) { this.setData({ skipDisliked: event.detail.value }); this.draw(); },
  draw() {
    try {
      const result = randomRecipe(store.getState(), { category: categories[this.data.categoryIndex], skipDisliked: this.data.skipDisliked, lastId: this.lastId });
      this.lastId = result ? result.id : null;
      this.setData({ result });
    } catch (error) { ui.error(error); }
  },
  detail() { if (this.data.result) wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(this.data.result.id) }); },
  add() { wx.navigateTo({ url: '/pages/editor/index' }); }
});
