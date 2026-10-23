const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const commonIngredients = ['南瓜', '小米', '鸡蛋', '鸡肉', '土豆', '西兰花', '胡萝卜', '面条', '豆腐'];
Page({
  data: {warning: '', options: [], pantry: [], selectedText: '', ingredient: '', search: '', showAllIngredients: false, ingredientCount: 0, completeOnly: false, matches: [], completeMatches: [], partialMatches: [], panels: ['pantry'], customPanels: []},
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const pantry = getApp().globalData.pantry || [];
      const names = Array.from(new Set(commonIngredients.concat(selectors.pantryItems.map(item => item[0]), pantry)));
      const search = selectors.normalizeIngredient(this.data.search);
      const visibleNames = search ? names.filter(name => name.includes(search)) : this.data.showAllIngredients ? names : commonIngredients;
      const options = visibleNames.map(name => ({label: name, value: name, icon: 'rectangle', selected: pantry.includes(name)}));
      const matches = selectors.matchRecipes(store.getState(), pantry, this.data.completeOnly);
      this.setData({pantry, selectedText: pantry.join('、'), options, ingredientCount: names.length,
        matches, completeMatches: matches.filter(recipe => recipe.complete),
        partialMatches: matches.filter(recipe => !recipe.complete), warning: store.getWarning()});
    } catch (error) { ui.error(error); }
  },
  changePanels(event) { this.setData({panels: event.detail.value}); },
  changeCustomPanels(event) { this.setData({customPanels: event.detail.value}); },
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
  inputIngredient(event) { this.setData({ingredient: event.detail.value}); },
  addIngredient() {
    const name = selectors.normalizeIngredient(this.data.ingredient);
    if (!name) { wx.showToast({title: '请输入一种食材', icon: 'none'}); return; }
    const pantry = getApp().globalData.pantry || [];
    getApp().globalData.pantry = Array.from(new Set(pantry.concat(name)));
    this.setData({ingredient: '', search: ''}); this.refresh(); wx.hideKeyboard();
  },
  clearPantry() { getApp().globalData.pantry = []; this.refresh(); },
  showMatches() { this.setData({panels: []}); wx.hideKeyboard(); },
  selectIngredients() { this.setData({panels: ['pantry']}); wx.pageScrollTo({scrollTop: 0}); },
  changeComplete(event) { this.setData({completeOnly: event.detail.value === true}); this.refresh(); },
  openRecipe(event) { wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(event.detail.id)}); }
});
