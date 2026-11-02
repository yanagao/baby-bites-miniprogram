const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('../profile/account');
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const requestId = () => 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2).padEnd(10, '0') + '-' + Math.random().toString(36).slice(2).padEnd(10, '0');

Page({
  data: {
    loading: true, error: '', recipe: null, author: null, isSelf: false, photo: '', text: '',
    choosingPhoto: false, saving: false, submitted: false, arranging: false, importedId: '',
    submitError: '', photoError: '', textError: '', discardVisible: false
  },
  onLoad(options = {}) {
    this.recipeId = options.id || '';
    this.request = 0;
    account.bind(this);
    if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
  },
  onShow() {
    if (!this._loaded) { this._loaded = true; return this.load(); }
  },
  onUnload() { this.request++; account.dispose(this); this.disableDraftAlert(); },
  disposeLocalContent() {
    this._submission = null;
    this.setData({photo: '', text: '', submitError: '', photoError: '', textError: '', submitted: false,
      choosingPhoto: false, saving: false, arranging: false, importedId: '', discardVisible: false});
    this.disableDraftAlert();
  },
  reload() { return account.reload(this, {force: true}); },
  async load(options) {
    if (!account.check(this) || this.data.saving || this.data.arranging) return;
    const request = ++this.request;
    this.setData({loading: true, error: ''});
    try {
      const result = await social.getRecipe(this.recipeId, options);
      if (!account.check(this) || request !== this.request) return;
      const relation = await social.getProfileSummary(result.author.id, options);
      if (!account.check(this) || request !== this.request) return;
      if (!relation || typeof relation.isSelf !== 'boolean') throw Error('暂时无法确认菜谱作者，请重试。');
      const imported = social.findImportedRecipe(this.recipeId);
      this.setData({recipe: result.recipe, author: result.author, isSelf: relation.isSelf,
        importedId: imported ? imported.id : '', loading: false,
        error: relation.isSelf ? '这是你自己的菜谱，期待其他家长带来跟做反馈。' : ''});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
      else this.setData({loading: false, recipe: null, author: null, error: error.message || '菜谱暂时无法查看，请稍后重试。'});
    }
  },
  editable() {
    return account.check(this) && !this.data.loading && !this.data.error && this.data.recipe &&
      !this.data.isSelf && !this.data.saving && !this.data.submitted;
  },
  changeText(event) {
    if (!this.editable()) return;
    const text = typeof event.detail.value === 'string' ? event.detail.value.replace(/[\r\n\t]+/g, ' ').slice(0, 120) : '';
    this.setData({text, textError: '', submitError: ''});
    this.updateDraftAlert();
  },
  choosePhoto() {
    if (!this.editable() || this.data.choosingPhoto) return;
    const request = this.request;
    this.setData({choosingPhoto: true});
    wx.chooseMedia({count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: result => {
        if (!this.editable() || request !== this.request) return;
        const file = result.tempFiles && result.tempFiles[0];
        if (!file || typeof file.tempFilePath !== 'string') return;
        if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_SOURCE_BYTES) {
          this.setData({photoError: '请选择小于 10 MB 的成品照。'}); return;
        }
        // The client validates JPEG/PNG bytes and compresses to the upload limit.
        this.setData({photo: file.tempFilePath, photoError: '', submitError: ''});
        this.updateDraftAlert();
      },
      fail: error => {
        if (!account.check(this) || request !== this.request || String(error.errMsg).includes('cancel')) return;
        this.setData({photoError: '未能选择照片，请检查相册权限后重试。'});
      },
      complete: () => { if (account.check(this) && request === this.request) this.setData({choosingPhoto: false}); }
    });
  },
  previewPhoto() {
    if (account.check(this) && this.data.photo) wx.previewImage({current: this.data.photo, urls: [this.data.photo]});
  },
  clearPhoto() {
    if (!this.editable() || this.data.choosingPhoto) return;
    this.setData({photo: '', photoError: '', submitError: ''}); this.updateDraftAlert();
  },
  async submit() {
    if (!this.editable() || this.data.choosingPhoto) return;
    const text = this.data.text.trim(), photoPath = this.data.photo;
    this.setData({textError: text ? '' : '留一句做后的反馈吧。', photoError: photoPath ? '' : '请添加一张自己的成品照。', submitError: ''});
    if (!text || !photoPath) return;
    const signature = JSON.stringify([this.recipeId, photoPath, text]);
    if (!this._submission || this._submission.signature !== signature) this._submission = {signature, id: requestId()};
    const request = this.request;
    this.setData({saving: true});
    try {
      const result = await social.addCooksnap(this.recipeId, {photoPath, text, requestId: this._submission.id});
      if (!account.check(this) || request !== this.request) return;
      if (!result || !result.cooksnap || result.cooksnap.recipeId !== this.recipeId) throw Error('暂时无法确认提交结果，请重试。');
      this.setData({submitted: true, submitError: ''});
      this.disableDraftAlert();
      wx.showToast({title: '跟做已分享给作者', icon: 'none'});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
      else this.setData({submitError: error.message || '跟做尚未确认提交，照片和文字已保留，请重试。'});
    } finally { if (account.check(this) && request === this.request) this.setData({saving: false}); }
  },
  async arrangeRecipe() {
    if (!account.check(this) || !this.data.submitted || this.data.arranging || this.data.saving) return;
    const request = this.request;
    this.setData({arranging: true, submitError: ''});
    try {
      const existing = social.findImportedRecipe(this.recipeId);
      const imported = existing ? {recipeId: existing.id} : await social.addToCookbook(this.recipeId);
      if (!account.check(this) || request !== this.request) return;
      this.setData({importedId: imported.recipeId});
      wx.redirectTo({url: '/pages/editor/index?id=' + encodeURIComponent(imported.recipeId),
        fail: () => { if (account.check(this) && request === this.request) this.setData({arranging: false, submitError: '菜谱已保存，暂时无法打开编辑页，请重试。'}); }});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      this.setData({arranging: false, submitError: error.message || '暂时无法整理做法，请稍后重试。'});
      if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this);
    }
  },
  updateDraftAlert() {
    const dirty = Boolean(this.data.photo || this.data.text.trim());
    if (this._alertEnabled === dirty) return;
    this._alertEnabled = dirty;
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message: '跟做还未分享，离开后会丢弃照片和文字。', fail() {}});
    else if (!dirty && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload({fail() {}});
  },
  disableDraftAlert() {
    this._alertEnabled = false;
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload({fail() {}});
  },
  back() {
    if (this.data.saving || this.data.arranging) return;
    if (account.check(this) && !this.data.submitted && (this.data.photo || this.data.text.trim())) {
      this.setData({discardVisible: true}); return;
    }
    this.disableDraftAlert(); ui.back();
  },
  continueEditing() { this.setData({discardVisible: false}); },
  discard() {
    if (this.data.saving || this.data.arranging) return;
    this.setData({discardVisible: false}); this.disableDraftAlert(); ui.back();
  }
});
