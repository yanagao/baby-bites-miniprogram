const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const calendar = require('../../utils/calendar');

Page({
  data: {
    warning: '', stats: {logCount: 0, triedCount: 0}, logs: [], recipes: [],
    filter: 'all', selectedDate: '', today: '', weekStart: '', days: [],
    monthLabel: '', selectedLabel: '', latestDate: '', canNextWeek: false,
    recordPickerVisible: false,
    filters: [
      {value: 'all', name: '全部'},
      {value: '3', name: '很喜欢'},
      {value: '2', name: '还不错'},
      {value: '1', name: '不太喜欢'}
    ]
  },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const state = store.getState();
      const today = selectors.today();
      const followToday = !this.data.selectedDate || this.data.selectedDate === this.data.today;
      const selectedDate = followToday ? today : this.data.selectedDate;
      const start = followToday ? calendar.weekStart(today) : this.data.weekStart || calendar.weekStart(selectedDate);
      const allLogs = selectors.listLogs(state, 'all');
      const logs = allLogs.filter(log => log.date === selectedDate &&
        (this.data.filter === 'all' || log.rating === Number(this.data.filter)));
      this.setData({
        today, selectedDate, weekStart: start,
        days: calendar.weekDays(start, selectedDate, today, allLogs.map(log => log.date)),
        monthLabel: calendar.monthLabel(start), selectedLabel: calendar.dayLabel(selectedDate),
        canNextWeek: start < calendar.weekStart(today),
        latestDate: allLogs.length ? allLogs[0].date : '',
        logs, stats: calendar.weeklyStats(allLogs, today),
        recipes: selectors.listRecipes(state, {sort: 'recent'}), warning: store.getWarning()
      });
    } catch (error) { wx.showToast({title: error.message || '暂时无法读取记录', icon: 'none'}); }
  },
  chooseFilter(event) {
    const filter = String(event.currentTarget && event.currentTarget.dataset.value !== undefined
      ? event.currentTarget.dataset.value : event.detail.value);
    if (!this.data.filters.some(item => item.value === filter)) return;
    this.setData({filter}); this.refresh();
  },
  chooseDay(event) {
    const date = event.currentTarget.dataset.date;
    if (!calendar.parseDate(date) || date > selectors.today()) return;
    this.setData({selectedDate: date, weekStart: calendar.weekStart(date)});
    this.refresh();
  },
  moveWeek(event) {
    const direction = Number(event.currentTarget.dataset.direction);
    if (![1, -1].includes(direction)) return;
    const today = selectors.today();
    const nextStart = calendar.shiftDate(this.data.weekStart, direction * 7);
    if (!nextStart || nextStart > calendar.weekStart(today)) return;
    const correspondingDate = calendar.shiftDate(this.data.selectedDate, direction * 7);
    const selectedDate = correspondingDate > today ? today : correspondingDate;
    this.setData({weekStart: nextStart, selectedDate}); this.refresh();
  },
  previousDay() {
    const date = calendar.shiftDate(this.data.selectedDate, -1);
    this.setData({selectedDate: date, weekStart: calendar.weekStart(date)}); this.refresh();
  },
  viewLatest() {
    if (!this.data.latestDate) return;
    const date = this.data.latestDate;
    this.setData({filter: 'all', selectedDate: date, weekStart: calendar.weekStart(date)});
    this.refresh();
  },
  resetFilter() { this.setData({filter: 'all'}); this.refresh(); },
  goToday() {
    const date = selectors.today();
    this.setData({selectedDate: date, weekStart: calendar.weekStart(date)}); this.refresh();
  },
  openRecordPicker() { this.setData({recordPickerVisible: true}); },
  closeRecordPicker() { this.setData({recordPickerVisible: false}); },
  recordPickerChange(event) { if (!event.detail.visible) this.closeRecordPicker(); },
  selectRecipe(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.recipes.some(recipe => recipe.id === id)) return;
    this.closeRecordPicker();
    wx.navigateTo({url: '/pages/record-editor/index?id=' + encodeURIComponent(id) +
      '&date=' + encodeURIComponent(this.data.selectedDate)});
  },
  addRecipe() { this.closeRecordPicker(); wx.navigateTo({url: '/pages/editor/index'}); },
  goRecipes() { wx.switchTab({url: '/pages/recipes/index'}); },
  editLog(event) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.logs.some(log => log.id === id)) return;
    wx.navigateTo({url: '/pages/record-editor/index?logId=' + encodeURIComponent(id)});
  }
});
