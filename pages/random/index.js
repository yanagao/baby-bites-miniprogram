const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const ui = require('../../utils/ui');
const social = require('../../utils/social');
const config = require('../../config/cloud');
const babyAge = require('../../utils/baby-age');
const {ageGroupForMonths} = require('../../utils/recipe-ages');
function ageFields(selectedAgeGroups) {
  return {
    selectedAgeGroups,
    ageOptions: [{value: '全部', label: '不限月龄', selected: !selectedAgeGroups.length}].concat(
      selectors.ageGroups.map(group => ({...group, selected: selectedAgeGroups.includes(group.value)})))
  };
}
function categoryFields(selectedCategories) {
  return {
    selectedCategories,
    category: selectedCategories.length === 1 ? selectedCategories[0] : '全部',
    categoryOptions: selectors.categories.map(value => ({
      label: value === '全部' ? '不限分类' : value,
      value,
      selected: value === '全部' ? !selectedCategories.length : selectedCategories.includes(value)
    }))
  };
}
Page({
  data: {...categoryFields([]), ...ageFields([]), skipDisliked: false, result: null, candidateCount: 0, hasRecipes: false, accountError: '', filtersVisible: false, ageDefaultLoading: false, defaultAgeHint: ''},
  onLoad() {
    this._sessionOwner = store.getSyncInfo().owner;
    this._accountBound = Boolean(this._sessionOwner);
    this._accountLocked = false;
    this._unloaded = false;
    this._ageDefaultRequest = 0;
    this._ageDefaultPending = false;
    this._ageDefaultDone = false;
    this._ageManuallySelected = false;
    this._unsubscribeAccount = store.subscribe(() => { this.accountOK(false); });
  },
  onUnload() {
    this._unloaded = true;
    this._ageDefaultRequest++;
    if (this._unsubscribeAccount) this._unsubscribeAccount();
  },
  accountOK(report) {
    if (this._unloaded) return false;
    const current = store.getSyncInfo().owner;
    if (!this._accountBound && current) { this._sessionOwner = current; this._accountBound = true; }
    else if (this._accountBound && current !== this._sessionOwner) this._accountLocked = true;
    if (!this._accountLocked) return true;
    const message = '微信账号已切换，请返回后重新打开随机选餐。';
    if (!this.data.accountError) {
      this.lastId = null;
      this._ageDefaultRequest++;
      this._ageDefaultPending = false;
      this.setData({...categoryFields([]), ...ageFields([]), skipDisliked: false, result: null, candidateCount: 0, hasRecipes: false, filtersVisible: false, ageDefaultLoading: false, defaultAgeHint: '', accountError: message});
    }
    if (report) ui.error(new Error(message));
    return false;
  },
  onShow() { this.refresh(); return this.loadDefaultAge(); },
  async loadDefaultAge() {
    if (!this.accountOK(false) || config.socialEnabled !== true || !store.getSyncInfo().owner ||
      this._ageDefaultDone || this._ageDefaultPending || this._ageManuallySelected) return;
    const request = ++this._ageDefaultRequest;
    this._ageDefaultPending = true;
    this.setData({ageDefaultLoading: true});
    try {
      const mine = await social.getMine();
      if (!this.accountOK(false) || request !== this._ageDefaultRequest || this._ageManuallySelected) return;
      if (!mine || !mine.profile || typeof mine.profile !== 'object' || Array.isArray(mine.profile) ||
        typeof mine.profile.exists !== 'boolean') {
        throw new Error('暂时无法读取宝宝生日。');
      }
      const months = babyAge.ageInMonths(mine.profile.exists ? mine.profile.babyBirthDate : null);
      const group = ageGroupForMonths(months);
      this._ageDefaultDone = true;
      this.setData({...ageFields(group ? [group] : []),
        defaultAgeHint: group ? '已按' + babyAge.ageLabel(months) + '选中，可调整' : ''});
      this.refresh();
    } catch (error) {
      if (!this._unloaded && request === this._ageDefaultRequest && error && error.code === 'ACCOUNT_CHANGED') {
        this._accountLocked = true;
        this.accountOK(false);
      }
      // Birthday lookup is optional: local recipes and manual filters remain
      // usable offline. A later onShow can retry unless the user chose an age.
    } finally {
      if (!this._unloaded && request === this._ageDefaultRequest) {
        this._ageDefaultPending = false;
        if (this.accountOK(false)) this.setData({ageDefaultLoading: false});
      }
    }
  },
  refresh() {
    if (!this.accountOK(false)) return;
    try {
      const state = store.getState();
      const pool = this.candidates(state);
      const current = this.data.result && pool.find(recipe => recipe.id === this.data.result.id);
      if (!current) this.draw();
      else this.setData({result: current, candidateCount: pool.length, hasRecipes: Boolean(state.recipes.length)});
    } catch (error) { ui.error(error); }
  },
  toggleFilters() { if (this.accountOK(false)) this.setData({filtersVisible: !this.data.filtersVisible}); },
  candidates(state) { return selectors.randomCandidates(state, {categories: this.data.selectedCategories, ageGroups: this.data.selectedAgeGroups, skipDisliked: this.data.skipDisliked}); },
  toggleAgeGroup(event) {
    if (!this.accountOK(false)) return;
    const ageGroup = event.currentTarget.dataset.ageGroup;
    if (ageGroup !== '全部' && !selectors.ageGroups.some(group => group.value === ageGroup)) return;
    this._ageManuallySelected = true;
    const current = this.data.selectedAgeGroups;
    const selected = ageGroup === '全部' ? [] : current.includes(ageGroup)
      ? current.filter(value => value !== ageGroup) : current.concat(ageGroup);
    this.setData({...ageFields(selectors.ageGroups.filter(group => selected.includes(group.value)).map(group => group.value)),
      ageDefaultLoading: false, defaultAgeHint: ''});
    this.draw();
  },
  changeCategory(event) {
    if (!this.accountOK(false)) return;
    const category = event.detail && event.detail.value;
    if (selectors.categories.includes(category)) {
      this.setData(categoryFields(category === '全部' ? [] : [category]));
      this.draw();
    }
  },
  toggleCategory(event) {
    if (!this.accountOK(false)) return;
    const category = event.currentTarget.dataset.category;
    if (!selectors.categories.includes(category)) return;
    const current = this.data.selectedCategories;
    const selected = category === '全部' ? [] : current.includes(category)
      ? current.filter(value => value !== category) : current.concat(category);
    this.setData(categoryFields(selected));
    this.draw();
  },
  skip(event) { if (this.accountOK(false)) { this.setData({skipDisliked: event.detail.value === true}); this.draw(); } },
  resetFilters() {
    if (!this.accountOK(false)) return;
    this._ageManuallySelected = true;
    this.setData({...categoryFields([]), ...ageFields([]), skipDisliked: false, ageDefaultLoading: false, defaultAgeHint: ''});
    this.draw();
  },
  draw() {
    if (!this.accountOK(false)) return;
    try {
      const state = store.getState();
      const result = selectors.randomRecipe(state, {categories: this.data.selectedCategories, ageGroups: this.data.selectedAgeGroups, skipDisliked: this.data.skipDisliked, lastId: this.lastId});
      this.lastId = result ? result.id : null;
      this.setData({result, candidateCount: this.candidates(state).length, hasRecipes: Boolean(state.recipes.length)});
    } catch (error) { ui.error(error); }
  },
  favorite() {
    if (!this.accountOK(true) || !this.data.result) return;
    try {
      store.toggleFavorite(this.data.result.id);
      this.refresh();
    } catch (error) { ui.error(error); }
  },
  detail() { if (this.accountOK(true) && this.data.result) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(this.data.result.id)}); },
  add() { if (this.accountOK(true)) wx.navigateTo({url: '/pages/editor/index'}); },
  back() { ui.back(); }
});
