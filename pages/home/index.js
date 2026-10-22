const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const quickItems = [['胡萝卜', 'carrot'], ['南瓜', 'pumpkin'], ['鸡蛋', 'egg'], ['西兰花', 'broccoli']];

Page({
  data: { nickname: '宝宝', warning: '', quickIngredients: [], recipes: [], stats: {} },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const state = store.getState();
      const pantry = getApp().globalData.pantry || [];
      this.setData({
        nickname: state.nickname || '宝宝',
        warning: store.getWarning(),
        stats: selectors.stats(state),
        recipes: selectors.listRecipes(state, { sort: 'recent' }).slice(0, 3),
        quickIngredients: quickItems.map(([name, icon]) => ({ name, icon, selected: pantry.includes(name) }))
      });
    } catch (error) { wx.showToast({ title: error.message || '暂时无法读取菜谱', icon: 'none' }); }
  },
  toggleIngredient(event) {
    const name = event.currentTarget.dataset.name;
    const pantry = getApp().globalData.pantry || [];
    const checked = event.detail.checked;
    getApp().globalData.pantry = checked ? Array.from(new Set(pantry.concat(name))) : pantry.filter(item => item !== name);
    this.refresh();
  },
  openRandom() { wx.navigateTo({ url: '/pages/random/index' }); },
  openSettings() { wx.navigateTo({ url: '/pages/settings/index' }); },
  goIngredients() { wx.switchTab({ url: '/pages/ingredients/index' }); },
  goRecipes() { wx.switchTab({ url: '/pages/recipes/index' }); },
  addRecipe() { wx.navigateTo({ url: '/pages/editor/index' }); },
  openRecipe(event) { wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(event.detail.id) }); },
  recordRecipe(event) { wx.navigateTo({ url: '/pages/record-editor/index?id=' + encodeURIComponent(event.detail.id) }); },
  toggleFavorite(event) {
    try { store.toggleFavorite(event.detail.id); this.refresh(); }
    catch (error) { wx.showToast({ title: error.message || '收藏失败，请重试', icon: 'none' }); }
  }
});
