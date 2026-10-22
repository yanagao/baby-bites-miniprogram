const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');

Page({
  data: { warning: '', items: [], pantry: [], ingredient: '', completeOnly: false, matches: [] },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const pantry = getApp().globalData.pantry || [];
      const known = selectors.pantryItems;
      const custom = pantry.filter(name => !known.some(item => item[0] === name)).map(name => [name, 'leaf']);
      const items = known.concat(custom).map(([name, icon]) => ({ name, icon, selected: pantry.includes(name) }));
      this.setData({ pantry, items, matches: selectors.matchRecipes(store.getState(), pantry, this.data.completeOnly), warning: store.getWarning() });
    } catch (error) { wx.showToast({ title: error.message || '暂时无法读取菜谱', icon: 'none' }); }
  },
  toggleIngredient(event) {
    const name = event.currentTarget.dataset.name;
    const pantry = getApp().globalData.pantry || [];
    const checked = event.detail.checked;
    if (typeof checked !== 'boolean') return;
    getApp().globalData.pantry = checked ? (pantry.includes(name) ? pantry : pantry.concat(name)) : pantry.filter(item => item !== name);
    this.refresh();
  },
  inputIngredient(event) { this.setData({ ingredient: event.detail.value }); },
  addIngredient() {
    const entered = this.data.ingredient.trim();
    if (!entered) { wx.showToast({ title: '先输入一种食材', icon: 'none' }); return; }
    const name = selectors.normalizeIngredient(entered);
    const pantry = getApp().globalData.pantry || [];
    if (!pantry.includes(name)) getApp().globalData.pantry = pantry.concat(name);
    this.setData({ ingredient: '' });
    this.refresh();
    wx.hideKeyboard();
  },
  clearPantry() { getApp().globalData.pantry = []; this.refresh(); },
  changeComplete(event) { this.setData({ completeOnly: event.detail.value === true }); this.refresh(); },
  addRecipe() { wx.navigateTo({ url: '/pages/editor/index' }); },
  openRecipe(event) { wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(event.detail.id) }); },
  recordRecipe(event) { wx.navigateTo({ url: '/pages/record-editor/index?id=' + encodeURIComponent(event.detail.id) }); },
  toggleFavorite(event) {
    try { store.toggleFavorite(event.detail.id); this.refresh(); }
    catch (error) { wx.showToast({ title: error.message || '收藏失败，请重试', icon: 'none' }); }
  }
});
