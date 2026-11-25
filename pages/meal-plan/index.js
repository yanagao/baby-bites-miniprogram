'use strict';
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const calendar = require('../../utils/calendar');
const {MEALS, planId} = require('../../utils/meal-plans');
const scopeKey = info => info.scopeKey || info.owner || '';
const clone = value => JSON.parse(JSON.stringify(value));
const weekday = date => ['日', '一', '二', '三', '四', '五', '六'][calendar.parseDate(date).getDay()];
const dayLabel = date => calendar.dayLabel(date) + ' · 周' + weekday(date);
const choiceKey = entries => JSON.stringify(entries.map(({date, meal, recipeId}) => [date, meal, recipeId || '']));

Page({
  data: {start: '', end: '', today: '', rangeLabel: '', selectedDate: '', selectedLabel: '', days: [],
    visibleDays: [], wholeWeek: false, count: 0, familyActive: false, error: '', locked: false, saving: false,
    pickerVisible: false, pickerTitle: '', search: '', pickerRecipes: [], pickerDate: '', pickerMeal: '',
    discardVisible: false, discardTitle: '放弃本次安排？', discardText: '尚未确认的餐单不会保存。'},
  onLoad(options = {}) {
    const info = store.getSyncInfo();
    this._owner = info.owner || ''; this._scope = scopeKey(info); this._disposed = false; this._locked = false;
    this._unsubscribe = store.subscribe(next => this.checkScope(next));
    const today = selectors.today();
    const start = calendar.parseDate(options.start) && options.start >= today ? options.start : calendar.shiftDate(today, 1);
    this.setRange(start, options.date);
    if (MEALS.some(meal => meal.value === options.meal)) this._initialMeal = options.meal;
  },
  onReady() {
    if (this._initialMeal) {
      const meal = this._initialMeal; this._initialMeal = '';
      this.openPicker({currentTarget: {dataset: {date: this.data.selectedDate, meal}}});
    }
  },
  onShow() { if (this.checkScope()) this.render(); },
  onUnload() { this._disposed = true; if (this._unsubscribe) this._unsubscribe(); },
  checkScope(info = store.getSyncInfo()) {
    if (this._disposed || this._locked) return false;
    if (!this._owner && info.owner && (!info.scope || info.scope.kind === 'personal')) {
      this._owner = info.owner; this._scope = scopeKey(info);
    }
    if (this._owner !== (info.owner || '') || this._scope !== scopeKey(info)) {
      this._locked = true; this._draft = []; this._basePlans = []; this._pendingStart = '';
      this.setData({locked: true, saving: false, days: [], visibleDays: [], count: 0,
        pickerVisible: false, pickerRecipes: [], search: '', discardVisible: false,
        error: '家庭或账号已变化，请返回餐单重新安排。'});
      this.clearUnloadAlert(); return false;
    }
    return true;
  },
  editable() { return this.checkScope() && !this.data.saving && !this._saved; },
  setRange(start, selected) {
    if (!this.editable() || !calendar.parseDate(start)) return;
    const state = store.getState(), end = calendar.shiftDate(start, 6);
    this._basePlans = clone((state.mealPlans || []).filter(plan => plan.date >= start && plan.date <= end));
    this._draft = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = calendar.shiftDate(start, offset);
      for (const meal of MEALS) {
        const existing = this._basePlans.find(plan => plan.id === planId(date, meal.value));
        this._draft.push({date, meal: meal.value, recipeId: existing ? existing.recipeId : ''});
      }
    }
    this._initialChoices = choiceKey(this._draft);
    this.setData({start, end, today: selectors.today(), selectedDate: calendar.parseDate(selected) && selected >= start && selected <= end ? selected : start,
      rangeLabel: calendar.dayLabel(start) + ' — ' + calendar.dayLabel(end), error: '', pickerVisible: false, search: ''});
    this.render(); this.updateUnloadAlert();
  },
  isCompleted(state, item) {
    return !!item.recipeId && state.logs.some(log => log.date === item.date && log.meal === item.meal && log.recipeId === item.recipeId);
  },
  render() {
    if (!this.checkScope() || !this._draft) return;
    const state = store.getState(), recipes = selectors.listRecipes(state, {sort: 'recent'});
    const recipeMap = new Map(recipes.map(recipe => [recipe.id, recipe]));
    const days = Array.from({length: 7}, (_, offset) => {
      const date = calendar.shiftDate(this.data.start, offset);
      const meals = this._draft.filter(item => item.date === date).map(item => ({...item,
        id: planId(item.date, item.meal), label: MEALS.find(meal => meal.value === item.meal).label,
        recipe: recipeMap.get(item.recipeId) || null, missing: !!item.recipeId && !recipeMap.has(item.recipeId),
        completed: this.isCompleted(state, item)}));
      return {date, day: Number(date.slice(-2)), weekday: weekday(date), label: dayLabel(date),
        selected: date === this.data.selectedDate, meals, count: meals.filter(meal => meal.recipe).length};
    });
    const info = store.getSyncInfo();
    this.setData({today: selectors.today(), days, visibleDays: this.data.wholeWeek ? days : days.filter(day => day.selected),
      count: days.reduce((sum, day) => sum + day.count, 0), selectedLabel: dayLabel(this.data.selectedDate),
      familyActive: !!(info.scope && info.scope.kind === 'family')});
    if (this.data.pickerVisible) this.filterRecipes();
  },
  chooseDay(event) {
    if (!this.editable()) return;
    const date = event.currentTarget.dataset.date;
    if (!this.data.days.some(day => day.date === date)) return;
    this.setData({selectedDate: date, wholeWeek: false}); this.render();
  },
  toggleWeek() { if (this.editable()) { this.setData({wholeWeek: !this.data.wholeWeek}); this.render(); } },
  changeStart(event) {
    if (!this.editable()) return;
    const start = event.detail.value;
    if (!calendar.parseDate(start) || start < selectors.today() || start === this.data.start) return;
    if (this.dirty()) {
      this._pendingStart = start;
      this.setData({discardVisible: true, discardTitle: '更换安排日期？', discardText: '当前未确认的安排会丢弃，已确认的餐单会保留。'});
    } else this.setRange(start);
  },
  openPicker(event) {
    if (!this.editable()) return;
    const {date, meal} = event.currentTarget.dataset;
    const item = this._draft.find(entry => entry.date === date && entry.meal === meal);
    if (!item || this.isCompleted(store.getState(), item)) return;
    this.setData({pickerVisible: true, pickerDate: date, pickerMeal: meal, search: '', error: '',
      pickerTitle: dayLabel(date) + ' · ' + MEALS.find(entry => entry.value === meal).label});
    this.filterRecipes();
  },
  filterRecipes() {
    this.setData({pickerRecipes: selectors.listRecipes(store.getState(), {search: this.data.search, sort: 'recent'})});
  },
  searchRecipes(event) {
    if (!this.editable()) return;
    this.setData({search: typeof event.detail.value === 'string' ? event.detail.value.slice(0, 60) : ''}); this.filterRecipes();
  },
  closePicker() { if (!this.data.saving) this.setData({pickerVisible: false, search: '', pickerRecipes: []}); },
  pickerChange(event) { if (!event.detail.visible) this.closePicker(); },
  selectRecipe(event) {
    if (!this.editable() || !this.data.pickerVisible) return;
    const id = event.currentTarget.dataset.id, state = store.getState();
    if (!state.recipes.some(recipe => recipe.id === id)) { this.setData({error: '这道菜谱已被移除，请重新选择。'}); return; }
    const item = this._draft.find(entry => entry.date === this.data.pickerDate && entry.meal === this.data.pickerMeal);
    if (!item || this.isCompleted(state, item)) { this.closePicker(); this.render(); return; }
    item.recipeId = id;
    this.closePicker(); this.render(); this.updateUnloadAlert();
  },
  viewRecipe(event) {
    if (!this.editable()) return;
    const id = event.currentTarget.dataset.id;
    if (store.getRecipe(id)) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  dirty() { return !!this._draft && choiceKey(this._draft) !== this._initialChoices; },
  updateUnloadAlert() {
    const dirty = this.dirty();
    if (dirty === this._alertEnabled) return;
    this._alertEnabled = dirty;
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message: '餐单尚未确认，离开会丢弃本次安排。', fail() {}});
    else this.clearUnloadAlert();
  },
  clearUnloadAlert() { this._alertEnabled = false; if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload({fail() {}}); },
  save() {
    if (!this.editable()) return;
    const entries = this._draft.filter(item => item.recipeId);
    if (!entries.length) { this.setData({error: '先选择至少一餐，再确认餐单。'}); return; }
    this.setData({saving: true, error: ''});
    try {
      if (!this.checkScope()) return;
      store.saveMealPlans(clone(entries), {expected: clone(this._basePlans)});
      if (!this.checkScope()) return;
      this._saved = true; this._initialChoices = choiceKey(this._draft); this.clearUnloadAlert();
      const pages = getCurrentPages(), previous = pages[pages.length - 2];
      const confirmedDate = entries.some(entry => entry.date === this.data.selectedDate) ? this.data.selectedDate : entries[0].date;
      if (previous && previous.route === 'pages/records/index' && previous._scope === this._scope &&
        typeof previous.selectConfirmedDate === 'function') previous.selectConfirmedDate(confirmedDate, this._scope);
      wx.showToast({title: '餐单已确认', icon: 'success'}); this.leave();
    } catch (error) { if (this.checkScope()) this.setData({error: error.message || '餐单未保存，请重试。'}); }
    finally { if (!this._disposed && !this._locked) this.setData({saving: false}); }
  },
  back() {
    if (this._disposed || this.data.saving) return;
    if (this.dirty() && !this._locked) {
      this._pendingStart = '';
      this.setData({discardVisible: true, discardTitle: '放弃本次安排？', discardText: '尚未确认的餐单不会保存。'});
    } else this.leave();
  },
  cancelDiscard() { this._pendingStart = ''; this.setData({discardVisible: false}); },
  confirmDiscard() {
    if (!this.editable()) return;
    const start = this._pendingStart; this._pendingStart = '';
    this.setData({discardVisible: false});
    if (start) this.setRange(start); else this.leave();
  },
  leave() {
    this.clearUnloadAlert();
    if (getCurrentPages().length > 1) wx.navigateBack(); else wx.switchTab({url: '/pages/records/index'});
  },
  onShareAppMessage() { return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'}; }
});
