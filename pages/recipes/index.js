const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const cloudConfig = require('../../config/cloud');
const social = require('../../utils/social');
const options = values => values.map(value => ({label: value, value}));
Page({
  data: {
    socialEnabled: cloudConfig.socialEnabled === true,
    warning: '', category: '全部', search: '', texture: '全部口感', sort: 'recent',
    categoryOptions: options(selectors.categories), textureOptions: options(['全部口感'].concat(selectors.textures)),
    sortOptions: [{label:'最近添加',value:'recent'}, {label:'用时最短',value:'quick'}, {label:'最近喜好',value:'liked'}],
    collection: 'all', visibility: 'all', onlyFavorites: false, recipes: [], hasFilters: false, filterSummary: '全部 · 最近添加',
    publicationReady: false, publicationLoading: false, publicationError: '', publicCount: 0, privateCount: 0,
    filtersVisible: false, advancedFilterCount: 0
  },
  onLoad(options = {}) {
    this._disposed = false;
    this._publicationRequest = 0;
    this._published = new Map();
    const collection = ['all', 'favorites', 'private', 'public'].includes(options.collection) ? options.collection : 'all';
    const allowed = this.data.socialEnabled || !['private', 'public'].includes(collection) ? collection : 'all';
    this.setData({collection: allowed, visibility: ['private', 'public'].includes(allowed) ? allowed : 'all',
      onlyFavorites: allowed === 'favorites', search: typeof options.search === 'string' ? options.search.slice(0, 60) : ''});
    if (this.data.socialEnabled) {
      this._publicationOwner = store.getSyncInfo().owner;
      this._unsubscribe = store.subscribe(() => {
        if (!this._disposed && this.syncAccount()) this.refresh();
      });
    }
  },
  onShow() { this.refresh(); if (this.data.socialEnabled) this.refreshPublication(); },
  onUnload() {
    this._disposed = true;
    this._publicationRequest = (this._publicationRequest || 0) + 1;
    if (this._unsubscribe) this._unsubscribe();
  },
  syncAccount() {
    if (!this.data.socialEnabled || this._disposed) return false;
    const owner = store.getSyncInfo().owner;
    if (!this._publicationOwner && owner) { this._publicationOwner = owner; return false; }
    if (this._publicationOwner === owner) return false;
    this._publicationOwner = owner;
    this._publicationRequest = (this._publicationRequest || 0) + 1;
    this._published = new Map();
    this.setData({publicationReady: false, publicationLoading: false, publicCount: 0, privateCount: 0,
      publicationError: '微信账号已切换，请重新读取公开状态。'});
    return true;
  },
  async refreshPublication() {
    if (!this.data.socialEnabled || this._disposed) return;
    this.syncAccount();
    const request = this._publicationRequest = (this._publicationRequest || 0) + 1;
    this._published = new Map();
    this.setData({publicationLoading: true, publicationReady: false, publicationError: ''});
    this.refresh();
    try {
      const result = await social.getMine();
      this.syncAccount();
      if (this._disposed || request !== this._publicationRequest) return;
      this._published = new Map(result.published.map(item => [item.sourceRecipeId, item]));
      this.setData({publicationReady: true, publicationLoading: false});
      this.refresh();
    } catch (error) {
      this.syncAccount();
      if (this._disposed || request !== this._publicationRequest) return;
      this.setData({publicationLoading: false, publicationReady: false,
        publicationError: error.message || '暂时无法确认公开状态，请联网后重试。'});
      this.refresh();
    }
  },
  refresh() {
    try {
      const {category, search, texture, sort, onlyFavorites, visibility} = this.data;
      if (this.data.socialEnabled) this.syncAccount();
      const state = store.getState();
      const known = this.data.socialEnabled && this.data.publicationReady;
      const published = this._published || new Map();
      const publicCount = known ? state.recipes.filter(recipe => published.has(recipe.id)).length : 0;
      const recipes = selectors.listRecipes(state, {category, search, texture, sort, onlyFavorites}).map(recipe => {
        const publication = known && published.get(recipe.id);
        const kind = known ? publication ? 'public' : 'private' : 'unknown';
        return Object.assign({}, recipe, {visibility: kind,
          visibilityLabel: kind === 'public' ? '公开菜谱' : kind === 'private' ? '私密菜谱 · 仅自己可见' : '公开状态待确认',
          publicChanged: Boolean(publication && publication.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))});
      }).filter(recipe => visibility === 'all' || recipe.visibility === visibility);
      const filterCount = Number(category !== '全部') + Number(texture !== '全部口感');
      const sortLabel = this.data.sortOptions.find(option => option.value === sort).label;
      this.setData({recipes, publicCount, privateCount: known ? state.recipes.length - publicCount : 0,
        warning: store.getWarning(), filterSummary: (filterCount ? filterCount + ' 项筛选' : '全部') + ' · ' + sortLabel,
        advancedFilterCount: filterCount + Number(!!search.trim()) + Number(sort !== 'recent'),
        hasFilters: Boolean(search.trim() || filterCount || onlyFavorites || visibility !== 'all' || sort !== 'recent')});
    } catch (error) { ui.error(error); }
  },
  searchInput(event) { this.setData({search: typeof event.detail.value === 'string' ? event.detail.value : ''}); this.refresh(); },
  chooseCategory(event) { const category = event.detail.value; if (selectors.categories.includes(category)) { this.setData({category}); this.refresh(); } },
  changeSort(event) { const sort = event.detail.value; if (this.data.sortOptions.some(option => option.value === sort)) { this.setData({sort}); this.refresh(); } },
  changeTexture(event) { const texture = event.detail.value; if (this.data.textureOptions.some(option => option.value === texture)) { this.setData({texture}); this.refresh(); } },
  changeCollection(event) {
    const value = event.detail.value;
    if (!['all', 'favorites', 'private', 'public'].includes(value)) return;
    if (['private', 'public'].includes(value) && !this.data.socialEnabled) return;
    this.setData({collection: value, visibility: ['private', 'public'].includes(value) ? value : 'all', onlyFavorites: value === 'favorites'}); this.refresh();
  },
  resetFilters() { this.setData({search: '', category: '全部', texture: '全部口感', collection: 'all', visibility: 'all', onlyFavorites: false, sort: 'recent'}); this.refresh(); },
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
