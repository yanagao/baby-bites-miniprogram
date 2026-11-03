const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const cloudConfig = require('../../config/cloud');
const options = values => values.map(value => ({label: value, value}));
Page({
  onShareAppMessage() {
    return {title: '口袋食谱 · 今天辅食吃什么', path: '/pages/recipes/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  data: {
    socialEnabled: cloudConfig.socialEnabled === true,
    warning: '', category: '全部', search: '', texture: '全部口感', sort: 'recent',
    categoryOptions: options(selectors.categories), textureOptions: options(['全部口感'].concat(selectors.textures)),
    sortOptions: [{label:'最近添加',value:'recent'}, {label:'用时最短',value:'quick'}, {label:'最近喜好',value:'liked'}],
    collection: 'all', onlyFavorites: false, recipes: [], hasFilters: false, filterSummary: '全部 · 最近添加',
    filtersVisible: false, advancedFilterCount: 0
  },
  onLoad(options = {}) {
    this._disposed = false;
    const collection = ['all', 'favorites'].includes(options.collection) ? options.collection : 'all';
    this.setData({collection, onlyFavorites: collection === 'favorites',
      search: typeof options.search === 'string' ? options.search.slice(0, 60) : ''});
    this._unsubscribe = store.subscribe(() => { if (!this._disposed) this.refresh(); });
  },
  onShow() { this.refresh(); },
  onUnload() {
    this._disposed = true;
    if (this._unsubscribe) this._unsubscribe();
  },
  refresh() {
    try {
      const {category, search, texture, sort, onlyFavorites} = this.data;
      const state = store.getState();
      const recipes = selectors.listRecipes(state, {category, search, texture, sort, onlyFavorites});
      const filterCount = Number(category !== '全部') + Number(texture !== '全部口感');
      const sortLabel = this.data.sortOptions.find(option => option.value === sort).label;
      this.setData({recipes,
        warning: store.getWarning(), filterSummary: (filterCount ? filterCount + ' 项筛选' : '全部') + ' · ' + sortLabel,
        advancedFilterCount: filterCount + Number(!!search.trim()) + Number(sort !== 'recent'),
        hasFilters: Boolean(search.trim() || filterCount || onlyFavorites || sort !== 'recent')});
    } catch (error) { ui.error(error); }
  },
  searchInput(event) { this.setData({search: typeof event.detail.value === 'string' ? event.detail.value : ''}); this.refresh(); },
  chooseCategory(event) { const category = event.detail.value; if (selectors.categories.includes(category)) { this.setData({category}); this.refresh(); } },
  changeSort(event) { const sort = event.detail.value; if (this.data.sortOptions.some(option => option.value === sort)) { this.setData({sort}); this.refresh(); } },
  changeTexture(event) { const texture = event.detail.value; if (this.data.textureOptions.some(option => option.value === texture)) { this.setData({texture}); this.refresh(); } },
  changeCollection(event) {
    const value = event.detail.value;
    if (!['all', 'favorites'].includes(value)) return;
    this.setData({collection: value, onlyFavorites: value === 'favorites'}); this.refresh();
  },
  resetFilters() { this.setData({search: '', category: '全部', texture: '全部口感', collection: 'all', onlyFavorites: false, sort: 'recent'}); this.refresh(); },
  openFilters() { this.setData({filtersVisible: true}); },
  closeFilters() { this.setData({filtersVisible: false}); },
  filterVisibilityChange(event) { if (event.detail && event.detail.visible === false) this.closeFilters(); },
  clearAdvancedFilters() { this.setData({search: '', category: '全部', texture: '全部口感', sort: 'recent'}); this.refresh(); },
  pickCategory(event) { this.chooseCategory({detail: {value: event.currentTarget.dataset.value}}); },
  pickTexture(event) { this.changeTexture({detail: {value: event.currentTarget.dataset.value}}); },
  pickSort(event) { this.changeSort({detail: {value: event.currentTarget.dataset.value}}); },
  back: ui.back,
  addRecipe() { wx.navigateTo({url: '/pages/editor/index'}); },
  openProfile() { if (this.data.socialEnabled) wx.navigateTo({url: '/pages/profile/index'}); },
  openFollowing() { if (this.data.socialEnabled) wx.navigateTo({url: '/pages/following/index'}); },
  openRecipe(event) {
    const id = event.detail && event.detail.id || event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.id;
    if (id) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  }
});
