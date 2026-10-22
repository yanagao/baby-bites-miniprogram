const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');

Page({
  data: {
    warning: '', categories: selectors.categories, category: '全部', search: '',
    sorts: ['最近添加', '用时最短', '宝宝最喜欢'], sortIndex: 0,
    textures: ['全部口感'].concat(selectors.textures), textureIndex: 0,
    onlyFavorites: false, recipes: []
  },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const recipes = selectors.listRecipes(store.getState(), {
        category: this.data.category,
        search: this.data.search.trim(),
        sort: ['recent', 'quick', 'liked'][this.data.sortIndex],
        texture: this.data.textures[this.data.textureIndex],
        onlyFavorites: this.data.onlyFavorites
      });
      this.setData({ recipes, warning: store.getWarning() });
    } catch (error) { wx.showToast({ title: error.message || '暂时无法读取菜谱', icon: 'none' }); }
  },
  searchInput(event) { this.setData({ search: typeof event.detail.value === 'string' ? event.detail.value : '' }); this.refresh(); },
  chooseCategory(event) { const category = event.detail.value; if (!this.data.categories.includes(category)) return; this.setData({ category }); this.refresh(); },
  changeSort(event) { this.setData({ sortIndex: Number(event.detail.value) }); this.refresh(); },
  changeTexture(event) { this.setData({ textureIndex: Number(event.detail.value) }); this.refresh(); },
  changeFavorites(event) { this.setData({ onlyFavorites: event.detail.value === true }); this.refresh(); },
  addRecipe() { wx.navigateTo({ url: '/pages/editor/index' }); },
  openRecipe(event) { wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(event.detail.id) }); },
  recordRecipe(event) { wx.navigateTo({ url: '/pages/record-editor/index?id=' + encodeURIComponent(event.detail.id) }); },
  toggleFavorite(event) {
    try { store.toggleFavorite(event.detail.id); this.refresh(); }
    catch (error) { wx.showToast({ title: error.message || '收藏失败，请重试', icon: 'none' }); }
  }
});
