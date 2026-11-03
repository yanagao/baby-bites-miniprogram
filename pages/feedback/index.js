const social = require('../../utils/social');
const account = require('../profile/account');
const ui = require('../../utils/ui');
const version = () => typeof social.getReadVersion === 'function' ? social.getReadVersion() : null;
const dateLabel = timestamp => {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日` : '';
};
const present = items => items.map(item => ({...item, dateLabel: dateLabel(item.createdAt), photoFailed: false}));

Page({
  data: {loading: true, error: '', items: [], saveCount: null, cooksnapCount: null,
    nextOffset: null, loadingMore: false, moreError: ''},
  onLoad() { this.request = 0; this.visible = false; account.bind(this); if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage', 'shareTimeline']}); },
  onShow() {
    this.visible = true;
    if (!account.check(this)) return;
    if (this.loadedAt && Date.now() - this.loadedAt < 30000 && this.loadedVersion === version() && !this.data.error) return;
    return this.load();
  },
  onHide() { this.visible = false; this.request++; this.setData({loading: false, loadingMore: false}); },
  onUnload() { this.visible = false; this.request++; account.dispose(this); },
  disposeLocalContent() { this.loadedAt = 0; this.setData({items: [], saveCount: null, cooksnapCount: null, nextOffset: null, loadingMore: false, moreError: ''}); },
  reload() { return account.reload(this, {force: true}); },
  async onPullDownRefresh() { try { await this.reload(); } finally { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); } },
  async load(options) {
    if (!this.visible || !account.check(this)) return;
    const request = ++this.request;
    const readVersion = version();
    this.setData({loading: true, error: '', loadingMore: false, moreError: ''});
    try {
      const result = await social.getFeedbackInbox(0, options);
      if (!this.visible || !account.check(this) || request !== this.request) return;
      this.loadedAt = Date.now(); this.loadedVersion = readVersion;
      this.setData({items: present(result.items), saveCount: result.saveCount, cooksnapCount: result.cooksnapCount,
        nextOffset: result.nextOffset, loading: false});
    } catch (error) {
      if (!this.visible || !account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      this.setData({loading: false, error: error.message || '暂时无法读取反馈，请稍后重试。'});
    }
  },
  async loadMore() {
    if (!this.visible || !account.check(this) || this.data.loading || this.data.loadingMore || this.data.error || this.data.nextOffset === null) return;
    const request = this.request;
    const offset = this.data.nextOffset;
    this.setData({loadingMore: true, moreError: ''});
    try {
      const result = await social.getFeedbackInbox(offset);
      if (!this.visible || !account.check(this) || request !== this.request) return;
      const known = new Set(this.data.items.map(item => item.id));
      this.setData({items: this.data.items.concat(present(result.items.filter(item => !known.has(item.id)))),
        nextOffset: result.nextOffset, saveCount: result.saveCount, cooksnapCount: result.cooksnapCount});
    } catch (error) {
      if (!this.visible || !account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      this.setData({moreError: error.message || '后续反馈暂时无法读取，请重试。'});
    } finally { if (this.visible && account.check(this) && request === this.request) this.setData({loadingMore: false}); }
  },
  onReachBottom() { return this.loadMore(); },
  openRecipe(event) {
    if (!this.visible || !account.check(this) || this.data.loading || this.data.error) return;
    const item = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (item) wx.navigateTo({url: '/pages/public-recipe/index?id=' + encodeURIComponent(item.recipeId)});
  },
  previewPhoto(event) {
    if (!this.visible || !account.check(this) || this.data.loading || this.data.error) return;
    const item = this.data.items.find(item => item.id === event.currentTarget.dataset.id);
    if (item && item.photoURL && !item.photoFailed) wx.previewImage({current: item.photoURL, urls: [item.photoURL]});
  },
  photoError(event) {
    if (!account.check(this)) return;
    const id = event.currentTarget.dataset.id;
    this.setData({items: this.data.items.map(item => item.id === id ? {...item, photoFailed: true} : item)});
  },
  back: ui.back
});
