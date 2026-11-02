const store = require('../../utils/store');
const social = require('../../utils/social');
const ui = require('../../utils/ui');
const {ageGroups} = require('../../utils/recipe-ages');

const homeShare = () => ({title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'});

Page({
  data: {
    recipe: null, author: null, previewToken: '', alreadyPublished: false,
    loading: false, confirming: false, published: false, error: '',
    photoSrc: '', photoReady: false, photoFailed: false, ageLabels: '', shareRecipe: null
  },
  onLoad(options = {}) {
    this.recipeId = typeof options.id === 'string' ? options.id : '';
    this._owner = store.getSyncInfo().owner;
    this._scope = store.getSyncInfo().scopeKey || this._owner;
    this._bound = Boolean(this._owner);
    this._request = 0;
    this._disposed = false;
    this._locked = false;
    this._loaded = false;
    this._unsubscribe = store.subscribe(info => {
      if (!this.accountOK()) return;
      if (this._previewSequence !== undefined && info.sequence !== this._previewSequence &&
        !this.data.loading && !this.data.confirming && !this.data.published) {
        this.invalidatePreview('菜谱已有更新，请重新查看预览后再确认。');
      }
    });
    if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
  },
  onShow() { if (!this._loaded && this.accountOK()) return this.reload(); },
  onUnload() {
    this._disposed = true;
    this._request++;
    if (this._unsubscribe) this._unsubscribe();
  },
  accountOK() {
    if (this._disposed) return false;
    const owner = store.getSyncInfo().owner;
    if (!this._bound && owner) { this._owner = owner; this._scope = store.getSyncInfo().scopeKey || owner; this._bound = true; }
    else if (this._bound && (owner !== this._owner || (store.getSyncInfo().scopeKey || owner) !== this._scope)) this._locked = true;
    if (!this._locked) return true;
    if (!this._cleared) {
      this._cleared = true;
      this._request++;
      this.setData({recipe: null, author: null, previewToken: '', loading: false, confirming: false,
        published: false, shareRecipe: null, photoSrc: '', photoReady: false,
        error: '微信账号已切换，或家庭已变化，请返回后重新打开分享预览。'});
      if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
    }
    return false;
  },
  current(request) { return this.accountOK() && request === this._request; },
  invalidatePreview(message) {
    this.setData({previewToken: '', photoReady: false, error: message});
  },
  async reload() {
    if (!this.accountOK() || this.data.loading || this.data.confirming || this.data.published) return;
    this._loaded = true;
    const request = ++this._request;
    this._previewSequence = undefined;
    this.setData({loading: true, error: '', recipe: null, author: null, previewToken: '', photoSrc: '', photoReady: false, photoFailed: false});
    try {
      if (!this.recipeId) throw Error('没有找到要分享的菜谱，请返回后重试。');
      const preview = await social.previewPublication(this.recipeId);
      if (!this.current(request)) return;
      if (!preview || !preview.recipe || !preview.author || !/^[a-f0-9]{64}$/.test(preview.previewToken || '') ||
        typeof preview.alreadyPublished !== 'boolean') throw Error('分享预览暂时无法读取，请重试。');
      const photoSrc = preview.recipe.photoURL || preview.recipe.displayPhoto || '';
      this._previewSequence = store.getSyncInfo().sequence;
      this.setData({recipe: preview.recipe, author: preview.author, previewToken: preview.previewToken,
        alreadyPublished: preview.alreadyPublished, photoSrc, photoReady: !photoSrc,
        ageLabels: (preview.recipe.ageGroups || []).map(value => {
          const group = ageGroups.find(item => item.value === value); return group ? group.label : '';
        }).filter(Boolean).join('、') || '不限月龄'});
    } catch (error) {
      if (this.current(request)) {
        if (error.code === 'ACCOUNT_CHANGED') { this._locked = true; this.accountOK(); }
        else this.setData({error: error.message || '暂时无法生成预览，请联网后重试。'});
      }
    } finally { if (this.current(request)) this.setData({loading: false}); }
  },
  imageLoaded(event) {
    if (!this.accountOK() || !this.data.previewToken ||
      !event || !event.currentTarget || event.currentTarget.dataset.token !== this.data.previewToken) return;
    this.setData({photoReady: true, photoFailed: false});
  },
  imageError(event) {
    if (!this.accountOK() || !this.data.previewToken ||
      !event || !event.currentTarget || event.currentTarget.dataset.token !== this.data.previewToken) return;
    this.setData({photoFailed: true});
    this.invalidatePreview('照片未能完整显示，请重新加载预览后再确认。');
  },
  async confirmPublish() {
    if (!this.accountOK() || this.data.loading || this.data.confirming || this.data.published ||
      !this.data.recipe || !this.data.previewToken || !this.data.photoReady) return;
    if (store.getSyncInfo().sequence !== this._previewSequence) {
      this.invalidatePreview('菜谱已有更新，请重新查看预览后再确认。'); return;
    }
    const request = this._request, token = this.data.previewToken, id = this.data.recipe.id;
    this.setData({confirming: true, error: ''});
    try {
      const result = await social.publishRecipe(this.recipeId, token);
      if (!this.current(request)) return;
      const recipe = result && result.recipe;
      if (!recipe || recipe.id !== id || typeof recipe.name !== 'string' || !recipe.name.trim()) {
        throw Error('暂时无法确认分享结果，请重新查看预览。');
      }
      this.setData({published: true, previewToken: '', shareRecipe: {id: recipe.id, name: recipe.name}});
      if (wx.showShareMenu) wx.showShareMenu({menus: ['shareAppMessage']});
      wx.showToast({title: '已公开分享', icon: 'success'});
    } catch (error) {
      if (this.current(request)) {
        if (error.code === 'ACCOUNT_CHANGED') { this._locked = true; this.accountOK(); }
        else this.invalidatePreview(error.message || '分享暂未完成，请重新查看预览后重试。');
      }
    } finally { if (this.current(request)) this.setData({confirming: false}); }
  },
  back() { if (!this.data.confirming) ui.back(); },
  onShareAppMessage() {
    if (!this.accountOK() || !this.data.published || !this.data.shareRecipe) return homeShare();
    return {title: this.data.shareRecipe.name + ' · 口袋食谱',
      path: '/pages/public-recipe/index?id=' + encodeURIComponent(this.data.shareRecipe.id), imageUrl: '/assets/cute/pocket-mascot.png'};
  }
});
