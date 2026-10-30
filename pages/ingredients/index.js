const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const commonIngredients = ['南瓜', '鸡蛋', '西兰花', '小米', '土豆', '豆腐', '胡萝卜', '番茄'];
Page({
  data: {warning: '', options: [], pantry: [], ingredient: '', search: '', showAllIngredients: false, ingredientCount: 0, matchCount: 0, matches: [], previewMatches: [], completeMatches: [], partialMatches: [], customPanels: []},
  onShow() { this.refresh(); },
  refresh() {
    try {
      const pantry = getApp().globalData.pantry || [];
      const names = Array.from(new Set(commonIngredients.concat(selectors.pantryItems.map(item => item[0]), pantry)));
      const search = selectors.normalizeIngredient(this.data.search);
      const visibleNames = search ? names.filter(name => name.includes(search)) : this.data.showAllIngredients ? names : commonIngredients;
      const options = visibleNames.map(name => ({label: name, value: name, icon: 'rectangle', selected: pantry.includes(name)}));
      const matches = selectors.matchRecipes(store.getState(), pantry, false);
      this.setData({pantry, options, ingredientCount: names.length,
        matchCount: matches.length, matches, previewMatches: matches.slice(0, 4),
        completeMatches: matches.filter(recipe => recipe.complete),
        partialMatches: matches.filter(recipe => !recipe.complete), warning: store.getWarning()});
    } catch (error) { ui.error(error); }
  },
  toggleCustomIngredients() { this.setData({customPanels: this.data.customPanels.length ? [] : ['custom']}); },
  toggleAllIngredients() { this.setData({showAllIngredients: !this.data.showAllIngredients}); this.refresh(); },
  searchIngredient(event) { this.setData({search: typeof event.detail.value === 'string' ? event.detail.value : ''}); this.refresh(); },
  changeIngredients(event) {
    if (!Array.isArray(event.detail.value)) return;
    const visible = new Set(this.data.options.map(option => option.value));
    const hidden = (getApp().globalData.pantry || []).filter(name => !visible.has(name));
    const selected = event.detail.value.filter(name => visible.has(name));
    getApp().globalData.pantry = Array.from(new Set(hidden.concat(selected)));
    this.refresh();
  },
  toggleIngredient(event) {
    const name = event.currentTarget.dataset.name;
    if (!this.data.options.some(option => option.value === name)) return;
    const pantry = getApp().globalData.pantry || [];
    getApp().globalData.pantry = pantry.includes(name) ? pantry.filter(item => item !== name) : pantry.concat(name);
    this.refresh();
  },
  removeIngredient(event) {
    const name = event.currentTarget.dataset.name;
    getApp().globalData.pantry = (getApp().globalData.pantry || []).filter(item => item !== name);
    this.refresh();
  },
  inputIngredient(event) { this.setData({ingredient: event.detail.value}); },
  addIngredient() {
    const name = selectors.normalizeIngredient(this.data.ingredient);
    if (!name) { wx.showToast({title: '请输入一种食材', icon: 'none'}); return; }
    const pantry = getApp().globalData.pantry || [];
    getApp().globalData.pantry = Array.from(new Set(pantry.concat(name)));
    this.setData({ingredient: '', search: ''}); this.refresh(); wx.hideKeyboard();
  },
  clearPantry() { getApp().globalData.pantry = []; this.refresh(); },
  showMatches() {
    if (!(getApp().globalData.pantry || []).length) return;
    wx.hideKeyboard();
    wx.navigateTo({url: '/pages/ingredient-results/index'});
  },
  openRecipe(event) {
    const id = event.detail && event.detail.id || event.currentTarget && event.currentTarget.dataset.id;
    if (this.data.matches.some(recipe => recipe.id === id)) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  back() { ui.back(); }
});
