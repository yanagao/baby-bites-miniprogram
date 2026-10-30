const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');

Page({
  data: {warning: '', pantry: [], selectedText: '', completeOnly: false, matches: [], completeMatches: [], partialMatches: []},
  onShow() { this.refresh(); },
  refresh() {
    try {
      const pantry = getApp().globalData.pantry || [];
      const matches = selectors.matchRecipes(store.getState(), pantry, this.data.completeOnly);
      this.setData({pantry, selectedText: pantry.join('、'), matches,
        completeMatches: matches.filter(recipe => recipe.complete),
        partialMatches: matches.filter(recipe => !recipe.complete), warning: store.getWarning()});
    } catch (error) { ui.error(error); }
  },
  changeComplete(event) { this.setData({completeOnly: event.detail.value === true}); this.refresh(); },
  selectIngredients() {
    const pages = getCurrentPages();
    if (pages.length > 1 && pages[pages.length - 2].route === 'pages/ingredients/index') wx.navigateBack();
    else wx.redirectTo({url: '/pages/ingredients/index'});
  },
  openRecipe(event) {
    const id = event.detail && event.detail.id || event.currentTarget && event.currentTarget.dataset.id;
    if (this.data.matches.some(recipe => recipe.id === id)) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  back() { ui.back(); }
});
