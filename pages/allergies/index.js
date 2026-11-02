const store = require('../../utils/store');
const {normalizeAllergies} = require('../../utils/allergies');
const ui = require('../../utils/ui');

const commonFoods = ['鸡蛋', '牛奶', '大豆', '小麦', '花生', '坚果', '鱼', '虾', '芝麻'];
const fields = values => ({allergies: values, options: commonFoods.map(name => ({name, selected: values.includes(name)}))});

Page({
  data: {...fields([]), input: '', error: '', saving: false, accountError: '', discardVisible: false},
  onLoad() {
    this._owner = store.getSyncInfo().owner || '';
    this._scope = store.getSyncInfo().scopeKey || this._owner;
    this._bound = Boolean(this._owner);
    this._unloaded = false;
    this._locked = false;
    this.initialAllergies = [];
    this.loadSaved();
    this._unsubscribe = store.subscribe(() => {
      if (this.accountOK() && !this.data.saving && !this.isDirty()) this.loadSaved();
    });
  },
  onShow() { if (this.accountOK() && !this.data.saving && !this.isDirty()) this.loadSaved(); },
  onUnload() {
    this._unloaded = true;
    if (this._unsubscribe) this._unsubscribe();
  },
  accountOK() {
    if (this._unloaded || this._locked) return false;
    const owner = store.getSyncInfo().owner || '';
    if (!this._bound && owner) { this._owner = owner; this._scope = store.getSyncInfo().scopeKey || owner; this._bound = true; }
    else if (this._bound && (owner !== this._owner || (store.getSyncInfo().scopeKey || owner) !== this._scope)) {
      this._locked = true;
      this.initialAllergies = [];
      this.setData({...fields([]), input: '', error: '', saving: false, discardVisible: false,
        accountError: '微信账号已切换，或家庭已变化，请返回后重新打开过敏食物记录。'});
      this.updateUnsavedAlert();
      return false;
    }
    return true;
  },
  loadSaved() {
    if (!this.accountOK()) return;
    try {
      const values = normalizeAllergies(store.getState().allergies) || [];
      this.initialAllergies = values.slice();
      this.setData({...fields(values), input: '', error: '', familyActive: Boolean(store.getSyncInfo().scope && store.getSyncInfo().scope.kind === 'family')});
      this.updateUnsavedAlert();
    } catch (error) { this.setData({error: error.message || '暂时无法读取过敏食物，请重新打开。'}); }
  },
  isDirty() {
    return Boolean(this.data.input.trim()) || JSON.stringify(this.data.allergies) !== JSON.stringify(this.initialAllergies || []);
  },
  updateUnsavedAlert() {
    const dirty = !this._locked && this.isDirty();
    if (dirty === Boolean(this._alertEnabled)) return;
    this._alertEnabled = dirty;
    if (dirty && typeof wx.enableAlertBeforeUnload === 'function') {
      wx.enableAlertBeforeUnload({message: '过敏食物尚未保存，返回将丢弃本次修改。', fail() {}});
    } else if (!dirty && typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload({fail() {}});
  },
  changeInput(event) {
    if (!this.accountOK() || this.data.saving) return;
    this.setData({input: typeof event.detail.value === 'string' ? event.detail.value : '', error: ''});
    this.updateUnsavedAlert();
  },
  changeList(values) {
    try {
      const allergies = normalizeAllergies(values);
      this.setData({...fields(allergies), error: ''});
      this.updateUnsavedAlert();
      return true;
    } catch (error) { this.setData({error: error.message}); return false; }
  },
  toggleFood(event) {
    if (!this.accountOK() || this.data.saving) return;
    const name = event.currentTarget.dataset.name;
    if (!commonFoods.includes(name)) return;
    this.changeList(this.data.allergies.includes(name)
      ? this.data.allergies.filter(item => item !== name) : this.data.allergies.concat(name));
  },
  addFood() {
    if (!this.accountOK() || this.data.saving) return;
    if (!this.data.input.trim()) { this.setData({error: '请填写一种需要避开的食物。'}); return; }
    if (this.changeList(this.data.allergies.concat(this.data.input))) {
      this.setData({input: ''}); this.updateUnsavedAlert();
    }
  },
  removeFood(event) {
    if (!this.accountOK() || this.data.saving) return;
    const name = event.currentTarget.dataset.name;
    this.changeList(this.data.allergies.filter(item => item !== name));
  },
  save() {
    if (!this.accountOK() || this.data.saving) return;
    if (!this.isDirty()) { this.leave(); return; }
    try {
      const draft = normalizeAllergies(this.data.allergies.concat(this.data.input.trim() ? [this.data.input] : []));
      const latest = normalizeAllergies(store.getState().allergies) || [];
      const removed = new Set(this.initialAllergies.filter(name => !draft.includes(name)));
      const added = draft.filter(name => !this.initialAllergies.includes(name));
      // Keep allergies synced from another device while this draft was open.
      // Only explicit changes to the displayed list may replace saved values.
      const values = normalizeAllergies(latest.filter(name => !removed.has(name)).concat(added));
      if (!this.accountOK()) return;
      this.setData({saving: true, error: ''});
      store.setAllergies(values);
      if (!this.accountOK()) return;
      this.initialAllergies = values.slice();
      this.setData({...fields(values), input: ''});
      wx.showToast({title: '过敏食物已保存', icon: 'success'});
      this.leave();
    } catch (error) {
      if (this.accountOK()) this.setData({error: error.message || '保存失败，修改已保留，请重试。'});
    } finally {
      if (!this._unloaded && !this._locked) this.setData({saving: false});
    }
  },
  cancel() {
    if (this.data.saving) return;
    if (this.accountOK() && this.isDirty()) this.setData({discardVisible: true});
    else this.leave();
  },
  continueEditing() { if (this.accountOK()) this.setData({discardVisible: false}); },
  discard() { if (!this.data.saving) { this.setData({discardVisible: false}); this.leave(); } },
  leave() {
    this._alertEnabled = false;
    if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload({complete: () => ui.back()});
    else ui.back();
  },
  onShareAppMessage() {
    return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  }
});
