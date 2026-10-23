const store = require('../../utils/store');
const { today } = require('../../utils/selectors');
const ui = require('../../utils/ui');

const portions = ['暂不记录', '吃了一点', '吃了约一半', '吃了大部分', '全部吃完'];
const previousPortions = { '尝了几口': 1, '吃了一半': 2, '吃了大半': 3, '光盘啦': 4 };

Page({
  data: {
    recipe: null, editing: false, missingMessage: '没有找到这道菜谱，可能已经被删除。',
    rating: 0,
    ratingOptions: [{ label: '不太喜欢', value: 1 }, { label: '还不错', value: 2 }, { label: '很喜欢', value: 3 }],
    date: today(), maxDate: today(), minDate: '', dateVisible: false,
    portions, portionOptions: portions.map((label, value) => ({ label, value })), portionIndex: 0,
    note: '', error: '', ratingError: '', dateError: '', saving: false,
    discardVisible: false,
    deleteVisible: false, deleteContent: '', deleting: false,
    deleteConfirmButton: { content: '删除记录', theme: 'danger' }
  },
  onLoad(options) {
    this._draftOwner = store.getSyncInfo().owner;
    this._unsubscribeAccount = store.subscribe(info => {
      if (!this._draftOwner && info.owner) this._draftOwner = info.owner;
    });
    const now = today();
    const minDate = String(Number(now.slice(0, 4)) - 10) + '-01-01';
    const requested = typeof options.date === 'string' ? options.date : '';
    const parts = requested.split('-').map(Number);
    const parsed = new Date(parts[0], parts[1] - 1, parts[2]);
    const validRequested = /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested <= now && requested >= minDate &&
      parsed.getFullYear() === parts[0] && parsed.getMonth() === parts[1] - 1 && parsed.getDate() === parts[2];
    this.setData({ date: !options.logId && validRequested ? requested : now, maxDate: now, minDate });
    if (options.logId) {
      const log = store.getLog(options.logId);
      if (!log) {
        this.setData({ missingMessage: '没有找到这条用餐记录，可能已经被删除。' });
        return;
      }
      this.logId = log.id;
      this.originalLog = log;
      this.recipeId = log.recipeId;
      const values = portions.slice();
      let portionIndex = log.portion ? values.indexOf(log.portion) : 0;
      if (portionIndex < 0 && Object.prototype.hasOwnProperty.call(previousPortions, log.portion)) portionIndex = previousPortions[log.portion];
      if (portionIndex < 0) { values.push(log.portion); portionIndex = values.length - 1; }
      this.initialPortionIndex = portionIndex;
      wx.setNavigationBarTitle({ title: '编辑用餐记录' });
      this.setData({
        editing: true, rating: log.rating, date: log.date, minDate: log.date < minDate ? log.date : minDate,
        portions: values, portionOptions: values.map((label, value) => ({ label, value })),
        portionIndex, note: log.note || ''
      });
    } else this.recipeId = options.id;
    this.setData({ recipe: this.recipeId ? store.getRecipe(this.recipeId) : null });
    this.initialDraft = this.draftSnapshot();
  },
  onUnload() { if (this._unsubscribeAccount) this._unsubscribeAccount(); },
  assertDraftAccount() {
    const owner = store.getSyncInfo().owner;
    if (this._draftOwner && this._draftOwner !== owner) throw Error('微信账号已切换，请重新打开用餐记录页后再操作。');
    if (!this._draftOwner && owner) this._draftOwner = owner;
  },
  draftSnapshot() {
    return JSON.stringify({ rating: this.data.rating, date: this.data.date, portionIndex: this.data.portionIndex, note: this.data.note });
  },
  updateUnsavedAlert() {
    const dirty = this.initialDraft !== undefined && this.draftSnapshot() !== this.initialDraft;
    if (dirty === Boolean(this.alertEnabled)) return;
    this.alertEnabled = dirty;
    if (dirty && typeof wx.enableAlertBeforeUnload === 'function') {
      wx.enableAlertBeforeUnload({ message: '用餐记录尚未保存，返回将丢弃本次修改。', fail() {} });
    } else if (!dirty && typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload({ fail() {} });
    }
  },
  leave() {
    this.alertEnabled = false;
    if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload({ complete: () => ui.back() });
    else ui.back();
  },
  rate(event) {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    const rating = Number(event.detail.value);
    if (![1, 2, 3].includes(rating)) return;
    this.setData({ rating, ratingError: '', error: '' });
    this.updateUnsavedAlert();
  },
  openDate() {
    if (!this.data.saving && !this.data.deleting && !this.data.deleteVisible) this.setData({ dateVisible: true, maxDate: today() });
  },
  changeDate(event) {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    this.setData({ date: event.detail.value, dateVisible: false, dateError: '', error: '' });
    this.updateUnsavedAlert();
  },
  closeDate() { this.setData({ dateVisible: false }); },
  portion(event) {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    const portionIndex = Number(event.detail.value);
    if (!Number.isInteger(portionIndex) || portionIndex < 0 || portionIndex >= this.data.portions.length) return;
    this.setData({ portionIndex, error: '' });
    this.updateUnsavedAlert();
  },
  note(event) {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    this.setData({ note: event.detail.value, error: '' });
    this.updateUnsavedAlert();
  },
  save() {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible || !this.data.recipe) return;
    const date = this.data.date;
    const parts = typeof date === 'string' ? date.split('-').map(Number) : [];
    const parsed = new Date(parts[0], parts[1] - 1, parts[2]);
    const validDate = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today() &&
      parsed.getFullYear() === parts[0] && parsed.getMonth() === parts[1] - 1 && parsed.getDate() === parts[2];
    this.setData({
      ratingError: [1, 2, 3].includes(this.data.rating) ? '' : '请选择本次喜好',
      dateError: validDate ? '' : '请选择今天或之前的有效日期', error: ''
    });
    if (this.data.ratingError || this.data.dateError) return;
    this.setData({ saving: true });
    try {
      this.assertDraftAccount();
      const portion = this.originalLog && this.data.portionIndex === this.initialPortionIndex
        ? this.originalLog.portion || '' : this.data.portionIndex ? this.data.portions[this.data.portionIndex] : '';
      const input = { recipeId: this.recipeId, rating: this.data.rating, date,
        portion, note: this.data.note.trim() };
      if (this.logId) store.updateLog(this.logId, input);
      else store.addLog(input);
      this.initialDraft = this.draftSnapshot();
      wx.showToast({ title: '记录已保存', icon: 'success' });
      this.leave();
    } catch (error) {
      this.setData({ error: error.message || '记录未保存，请重试' });
    } finally { this.setData({ saving: false }); }
  },
  back() {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    if (this.initialDraft !== undefined && this.draftSnapshot() !== this.initialDraft) this.setData({ discardVisible: true });
    else this.leave();
  },
  continueEditing() { this.setData({ discardVisible: false }); },
  discard() {
    if (this.data.saving || this.data.deleting || this.data.deleteVisible) return;
    this.setData({ discardVisible: false }); this.leave();
  },
  deleteLog() {
    if (!this.data.editing || !this.logId || !this.data.recipe || this.data.saving || this.data.deleting || this.data.discardVisible) return;
    const dirty = this.initialDraft !== undefined && this.draftSnapshot() !== this.initialDraft;
    this.setData({
      deleteVisible: true,
      deleteContent: `${this.originalLog.date} 的「${this.data.recipe.name}」用餐记录将被删除，无法恢复。菜谱会保留。${dirty ? '本次未保存的修改也会丢弃。' : ''}`
    });
  },
  cancelDelete() {
    if (this.data.deleting) return;
    this.setData({ deleteVisible: false });
  },
  confirmDelete() {
    if (!this.data.deleteVisible || !this.data.editing || !this.logId || this.data.saving || this.data.deleting) return;
    this.setData({ deleting: true, deleteVisible: false });
    try {
      this.assertDraftAccount();
      store.deleteLog(this.logId);
      this.initialDraft = this.draftSnapshot();
      wx.showToast({ title: '记录已删除', icon: 'none' });
      this.leave();
    } catch (error) {
      this.setData({ deleting: false });
      ui.error(error);
    }
  }
});
