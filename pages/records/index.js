const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const calendar = require('../../utils/calendar');
const {MEALS, validMeal, planId} = require('../../utils/meal-plans');

const dataset = event => event && event.currentTarget && event.currentTarget.dataset || {};
const scopeOf = () => { const info = store.getSyncInfo(); return info.scopeKey || info.owner || ''; };

Page({
  onShareAppMessage() {
    return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  data: {
    warning: '', error: '', stats: {logCount: 0, triedCount: 0}, logs: [], legacyLogs: [], recipes: [],
    filter: 'all', selectedDate: '', today: '', weekStart: '', days: [], rows: [],
    monthLabel: '', selectedLabel: '', latestDate: '', canNextWeek: true, scope: '',
    familyActive: false, nickname: '宝宝', plannedCount: 0, planStatus: '', future: false,
    recordPickerVisible: false, pickerMode: 'record', pickerMeal: 'breakfast', pickerMealLabel: '早餐',
    pickerSearch: '', pickerRecipes: [], pickerSelected: '', pickerDate: '', savingPlan: false, mealOptions: MEALS,
    completeVisible: false, completion: null, completionRating: 0, completionPortion: '', completing: false,
    completionRatings: [{value: 1, label: '不太喜欢'}, {value: 2, label: '还不错'}, {value: 3, label: '很喜欢'}],
    completionPortions: ['尝了几口', '吃了一些', '光盘啦'],
    filters: [{value: 'all', name: '全部'}, {value: '3', name: '很喜欢'}, {value: '2', name: '还不错'}, {value: '1', name: '不太喜欢'}]
  },
  onLoad() {
    this._disposed = false; this._scope = scopeOf();
    this._unsubscribe = store.subscribe(() => this.checkScope());
  },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  onUnload() { this._disposed = true; if (this._unsubscribe) this._unsubscribe(); },
  checkScope() {
    if (this._disposed) return false;
    const scope = scopeOf();
    if (this._scope === undefined) this._scope = scope;
    if (scope !== this._scope) {
      this._scope = scope; this._pickerBase = null; this._pendingScope = null;
      this.setData({recordPickerVisible: false, completeVisible: false, completion: null,
        pickerRecipes: [], pickerSearch: '', pickerSelected: '', selectedDate: '', filter: 'all',
        error: '', savingPlan: false, completing: false});
      return false;
    }
    return true;
  },
  currentEvent(event) {
    if (!this.checkScope()) { this.refresh(); return false; }
    const displayed = dataset(event).scope;
    return displayed === undefined || displayed === scopeOf();
  },
  refresh() {
    if (this._disposed) return;
    try {
      this.checkScope();
      const state = store.getState(), info = store.getSyncInfo(), today = selectors.today();
      const followToday = !this.data.selectedDate || this.data.selectedDate === this.data.today;
      const selectedDate = followToday ? today : this.data.selectedDate;
      const start = calendar.weekStart(selectedDate);
      const allLogs = selectors.listLogs(state, 'all');
      const dayLogs = allLogs.filter(log => log.date === selectedDate);
      const logs = dayLogs.filter(log => this.data.filter === 'all' || log.rating === Number(this.data.filter));
      const recipes = selectors.listRecipes(state, {sort: 'recent'});
      const recipeMap = new Map(recipes.map(recipe => [recipe.id, recipe]));
      const plans = (state.mealPlans || []).filter(plan => plan.date === selectedDate);
      const rows = MEALS.map(meal => {
        const plan = plans.find(item => item.meal === meal.value);
        const matching = dayLogs.filter(log => log.meal === meal.value);
        const done = plan && matching.find(log => log.recipeId === plan.recipeId);
        const cards = [];
        if (plan && recipeMap.has(plan.recipeId)) cards.push({key: plan.id, planId: plan.id,
          recipe: recipeMap.get(plan.recipeId), log: done || null});
        matching.filter(log => !done || log.id !== done.id).forEach(log => {
          if (recipeMap.has(log.recipeId)) cards.push({key: log.id, recipe: recipeMap.get(log.recipeId), log});
        });
        return {...meal, cards};
      });
      const familyActive = !!(info.scope && info.scope.kind === 'family');
      this.setData({today, selectedDate, weekStart: start,
        days: calendar.weekDays(start, selectedDate, today, allLogs.map(log => log.date).concat((state.mealPlans || []).map(plan => plan.date))),
        monthLabel: start.slice(0, 4) + ' 年 ' + calendar.monthLabel(start), selectedLabel: calendar.dayLabel(selectedDate),
        canNextWeek: !!calendar.shiftDate(start, 7), latestDate: allLogs.length ? allLogs[0].date : '',
        future: selectedDate > today, logs, legacyLogs: logs.filter(log => !validMeal(log.meal)), rows,
        stats: calendar.weeklyStats(allLogs, today), recipes, warning: store.getWarning(),
        familyActive, nickname: state.nickname || '宝宝', plannedCount: plans.length, scope: this._scope,
        planStatus: plans.length ? (familyActive ? '家庭餐单' : '我的餐单') + (info.dirty ? ' · 待同步' : ' · 已确认') : ''});
      if (this.data.recordPickerVisible) this.filterPicker();
    } catch (error) { wx.showToast({title: error.message || '暂时无法读取餐单', icon: 'none'}); }
  },
  chooseFilter(event) {
    const filter = String(dataset(event).value === undefined ? event.detail.value : dataset(event).value);
    if (!this.data.filters.some(item => item.value === filter)) return;
    this.setData({filter}); this.refresh();
  },
  chooseDay(event) {
    const date = dataset(event).date;
    if (!calendar.parseDate(date) || !this.currentEvent(event)) return;
    this.closeRecordPicker(); this.closeCompletion();
    this.setData({selectedDate: date, filter: 'all', error: ''}); this.refresh();
  },
  changeCalendarDate(event) { this.chooseDay({currentTarget: {dataset: {date: event.detail.value}}}); },
  moveWeek(event) {
    const direction = Number(dataset(event).direction);
    if (![1, -1].includes(direction)) return;
    const date = calendar.shiftDate(this.data.selectedDate, direction * 7);
    if (date) this.chooseDay({currentTarget: {dataset: {date}}});
  },
  previousDay() { this.chooseDay({currentTarget: {dataset: {date: calendar.shiftDate(this.data.selectedDate, -1)}}}); },
  viewLatest() {
    if (this.data.latestDate) this.chooseDay({currentTarget: {dataset: {date: this.data.latestDate}}});
  },
  resetFilter() { this.setData({filter: 'all'}); this.refresh(); },
  goToday() { this.chooseDay({currentTarget: {dataset: {date: selectors.today()}}}); },
  selectConfirmedDate(date, scope) {
    if (this.checkScope() && scope === scopeOf() && calendar.parseDate(date)) {
      this.setData({selectedDate: date, filter: 'all', error: ''}); this.refresh();
    }
  },
  editWeek() {
    if (!this.checkScope()) return;
    const start = this.data.selectedDate < selectors.today() ? selectors.today() : this.data.selectedDate;
    wx.navigateTo({url: '/pages/meal-plan/index?start=' + start});
  },
  openRecordPicker(event) {
    if (!this.currentEvent(event) || this.data.selectedDate > selectors.today()) return;
    const meal = validMeal(dataset(event).meal) ? dataset(event).meal : 'breakfast';
    this.openPicker('record', meal);
  },
  choosePlan(event) {
    if (!this.currentEvent(event) || !validMeal(dataset(event).meal)) return;
    this.openPicker('plan', dataset(event).meal);
  },
  openPicker(mode, meal) {
    this._pendingScope = scopeOf();
    const id = planId(this.data.selectedDate, meal);
    this._pickerBase = (store.getState().mealPlans || []).filter(plan => plan.id === id);
    this.setData({recordPickerVisible: true, pickerMode: mode, pickerMeal: meal,
      pickerMealLabel: MEALS.find(item => item.value === meal).label, pickerDate: this.data.selectedDate,
      pickerSelected: '', pickerSearch: '', error: ''});
    this.filterPicker();
  },
  filterPicker() {
    const query = this.data.pickerSearch.trim().toLowerCase();
    this.setData({pickerRecipes: this.data.recipes.filter(recipe => !query ||
      (recipe.name + ' ' + recipe.ingredientText).toLowerCase().includes(query))});
  },
  changePickerSearch(event) { this.setData({pickerSearch: event.detail.value}); this.filterPicker(); },
  choosePickerMeal(event) {
    const meal = dataset(event).meal;
    if (!validMeal(meal) || this.data.pickerMode !== 'record') return;
    this.setData({pickerMeal: meal, pickerMealLabel: MEALS.find(item => item.value === meal).label});
  },
  closeRecordPicker() { if (!this.data.savingPlan) this.setData({recordPickerVisible: false, pickerSelected: '', pickerSearch: ''}); },
  recordPickerChange(event) { if (!event.detail.visible) this.closeRecordPicker(); },
  selectRecipe(event) {
    if (!this.currentEvent(event) || !this.data.recordPickerVisible || this._pendingScope !== scopeOf()) return;
    const id = dataset(event).id;
    if (!this.data.pickerRecipes.some(recipe => recipe.id === id)) return;
    if (this.data.pickerMode === 'plan') { this.setData({pickerSelected: id}); return; }
    const date = this.data.pickerDate, meal = this.data.pickerMeal;
    if (date > selectors.today()) return;
    this.closeRecordPicker();
    wx.navigateTo({url: '/pages/record-editor/index?id=' + encodeURIComponent(id) + '&date=' + date + '&meal=' + meal});
  },
  savePickedPlan() {
    if (!this.checkScope() || this.data.savingPlan || !this.data.recordPickerVisible || this.data.pickerMode !== 'plan' ||
      this._pendingScope !== scopeOf() || !this.data.pickerSelected) return;
    this.setData({savingPlan: true, error: ''});
    try {
      store.saveMealPlans([{date: this.data.pickerDate, meal: this.data.pickerMeal, recipeId: this.data.pickerSelected}], {expected: this._pickerBase});
      this.setData({recordPickerVisible: false, pickerSelected: ''}); this.refresh();
      wx.showToast({title: '已安排', icon: 'success'});
    } catch (error) { this.setData({error: error.message || '安排未保存，请重试。'}); }
    finally { this.setData({savingPlan: false}); }
  },
  openCompletion(event) {
    if (!this.currentEvent(event) || this.data.future) return;
    const id = dataset(event).id;
    const card = this.data.rows.reduce((all, row) => all.concat(row.cards), []).find(item => item.planId === id && !item.log);
    const plan = (store.getState().mealPlans || []).find(item => item.id === id);
    if (!card || !plan || plan.recipeId !== card.recipe.id) return;
    this._pendingScope = scopeOf();
    this.setData({completeVisible: true, completion: {planId: id, recipe: card.recipe, date: plan.date,
      mealLabel: MEALS.find(item => item.value === plan.meal).label}, completionRating: 0, completionPortion: '', error: ''});
  },
  rateCompletion(event) {
    const value = Number(dataset(event).value);
    if (this.data.completing || ![1, 2, 3].includes(value)) return;
    this.setData({completionRating: this.data.completionRating === value ? 0 : value});
  },
  portionCompletion(event) {
    const value = dataset(event).value;
    if (this.data.completing || !this.data.completionPortions.includes(value)) return;
    this.setData({completionPortion: this.data.completionPortion === value ? '' : value});
  },
  closeCompletion() { if (!this.data.completing) this.setData({completeVisible: false, completion: null}); },
  completionChange(event) { if (!event.detail.visible) this.closeCompletion(); },
  completeMeal() {
    if (!this.checkScope() || this._pendingScope !== scopeOf() || this.data.completing || !this.data.completeVisible || !this.data.completion) return;
    this.setData({completing: true, error: ''});
    try {
      const current = this.data.completion;
      store.completeMeal({planId: current.planId, recipeId: current.recipe.id,
        rating: this.data.completionRating, portion: this.data.completionPortion, note: ''});
      this.setData({completeVisible: false, completion: null}); this.refresh();
      wx.showToast({title: '这一餐已完成', icon: 'success'});
    } catch (error) { this.setData({error: error.message || '暂未完成，请重试。'}); }
    finally { this.setData({completing: false}); }
  },
  viewRecipe(event) {
    const id = dataset(event).id;
    if (this.currentEvent(event) && this.data.recipes.some(recipe => recipe.id === id)) wx.navigateTo({url: '/pages/detail/index?id=' + encodeURIComponent(id)});
  },
  addRecipe() { this.closeRecordPicker(); wx.navigateTo({url: '/pages/editor/index'}); },
  goRecipes() { wx.navigateTo({url: '/pages/recipes/index'}); },
  editLog(event) {
    const id = dataset(event).id;
    if (this.currentEvent(event) && store.getState().logs.some(log => log.id === id && log.date === this.data.selectedDate)) {
      wx.navigateTo({url: '/pages/record-editor/index?logId=' + encodeURIComponent(id)});
    }
  }
});
