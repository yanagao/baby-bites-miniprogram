const social = require('../../utils/social');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');
const mealPlanCopy = require('../../utils/meal-plan-copy');
const account = require('../profile/account');
const {MEALS, validPlanDate} = require('../../utils/meal-plans');
const {parseDate, dayLabel, shiftDate} = require('../../utils/calendar');
const {getProfileAvatar} = require('../../utils/profile-avatar');
const {withCover} = require('../../utils/recipe-covers');
const ui = require('../../utils/ui');

const APP_SHARE = {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
const validProfileId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const readVersion = () => typeof social.getReadVersion === 'function' ? social.getReadVersion() : null;

function publicRecipe(recipe) {
  if (!recipe || typeof recipe !== 'object' || typeof recipe.id !== 'string' || typeof recipe.name !== 'string' || !recipe.name.trim() ||
    !(recipe.kind === 'public' && /^[a-f0-9]{64}$/.test(recipe.id || '') ||
      recipe.kind === 'builtin' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(recipe.id || ''))) return null;
  // Only the public meal DTO belongs in this page, never private feedback or a
  // local recipe snapshot that happened to be present on the response object.
  const clean = {id: recipe.id, kind: recipe.kind, name: recipe.name,
    minutes: Number.isFinite(recipe.minutes) && recipe.minutes > 0 ? recipe.minutes : null,
    texture: typeof recipe.texture === 'string' ? recipe.texture : '',
    imageKey: typeof recipe.imageKey === 'string' ? recipe.imageKey : '',
    photoURL: typeof recipe.photoURL === 'string' ? recipe.photoURL : ''};
  clean.displayPhoto = clean.photoURL || withCover(clean).displayPhoto || '';
  return clean;
}

function mealRows(result, profileId, date) {
  if (!result || result.date !== date || !Array.isArray(result.meals) ||
    !result.author || result.author.id !== profileId || result.author.exists !== true ||
    typeof result.author.name !== 'string' || !result.author.name.trim()) {
    throw Error('这份餐单暂时无法查看，请重新加载。');
  }
  if (!result.meals.length) throw Error('这一天还没有已确认的餐单。');
  const entries = new Map();
  for (const entry of result.meals) {
    if (!entry || entry.recipe === undefined || !MEALS.some(meal => meal.value === entry.meal) || entries.has(entry.meal)) {
      throw Error('餐单信息暂时无法读取，请重新加载。');
    }
    entries.set(entry.meal, entry);
  }
  return MEALS.map(meal => {
    const entry = entries.get(meal.value), recipe = entry ? publicRecipe(entry.recipe) : null;
    return {meal: meal.value, label: meal.label, icon: meal.icon, planned: Boolean(entry), recipe,
      photoFailed: false, emptyLabel: entry ? '菜谱暂不可查看' : '未安排'};
  });
}

Page({
  data: {loading: true, error: '', ready: false, author: null, date: '', dateLabel: '', weekdayLabel: '', meals: [], hasPlans: false,
    hasSavableMeals: false, copyVisible: false, copySaving: false, copyDate: '', copyDateLabel: '', copyMinDate: '',
    copyMode: 'keep', copyRows: [], copySaveCount: 0, copyConflictCount: 0, copyUnavailableCount: 0,
    copyError: '', copySavedDate: '', copyResultMessage: '', copyDestination: '', copyCanView: false},
  onLoad(options = {}) {
    this.profileId = options.profileId;
    this.planDate = options.date;
    this.request = 0;
    this._copyRequest = 0;
    this._unloaded = false;
    this._failedAuthorAvatar = '';
    this._loadPromise = null;
    this._validLink = validProfileId(this.profileId) && validPlanDate(this.planDate);
    account.bind(this);
  },
  onShow() {
    if (!account.check(this)) return;
    if (this.data.copySaving) return;
    if (this.data.copyVisible) {
      if (!this.data.copySavedDate) this.refreshCopyPreview();
      return;
    }
    if (this.data.loading && this._loadPromise) return this._loadPromise;
    if (this.data.ready && !this.data.error && this._loadedVersion === readVersion()) return;
    return this.load();
  },
  onUnload() { this._unloaded = true; this.request++; this._copyRequest++; this._copyPreview = null; this._loadPromise = null; account.dispose(this); },
  reload() { return account.reload(this, {force: true}); },
  onPullDownRefresh() {
    if (this.data.copySaving || this.data.copyVisible) {
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      return;
    }
    if (this._pullDownFlight) return this._pullDownFlight;
    const work = Promise.resolve(this.reload()).finally(() => {
      if (this._pullDownFlight === work) this._pullDownFlight = null;
      if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
    });
    this._pullDownFlight = work;
    return work;
  },
  disposeLocalContent() {
    if (this.accountSession && this.accountSession.changed) this._failedAuthorAvatar = '';
    this.resetCopy();
    this.setData({ready: false, author: null, meals: [], hasPlans: false, hasSavableMeals: false, date: '', dateLabel: '', weekdayLabel: ''});
  },
  load(options) {
    if (!account.check(this)) return Promise.resolve();
    const request = ++this.request;
    const version = readVersion();
    this.disposeLocalContent();
    if (!this._validLink) {
      this.setData({loading: false, error: '餐单链接不完整或日期无效，请重新打开分享。'});
      return Promise.resolve();
    }
    this.setData({loading: true, error: ''});
    this._loadPromise = Promise.resolve().then(() => {
      if (!account.check(this) || request !== this.request) return null;
      return social.getMealPlan(this.profileId, this.planDate, options);
    }).then(result => {
      if (!account.check(this) || request !== this.request) return;
      const meals = mealRows(result, this.profileId, this.planDate);
      const candidate = getProfileAvatar(result.author.id, result.author.avatarURL);
      const author = {id: result.author.id, name: result.author.name, avatar: this._failedAuthorAvatar === result.author.id + ':' + candidate ?
        getProfileAvatar(result.author.id) : candidate};
      const weekdayLabel = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parseDate(result.date).getDay()];
      this._loadedVersion = version;
      this.setData({loading: false, error: '', ready: true, author, date: result.date,
        dateLabel: dayLabel(result.date), weekdayLabel, meals, hasPlans: meals.some(meal => meal.planned),
        hasSavableMeals: meals.some(meal => meal.planned && meal.recipe)});
    }).catch(error => {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      this.setData({loading: false, ready: false, error: error.message || '餐单暂时无法读取，请重试。'});
    }).finally(() => { if (request === this.request) this._loadPromise = null; });
    return this._loadPromise;
  },
  openRecipe(event) {
    if (!account.check(this) || !this.data.ready || this.data.loading || this.data.error || this.data.copySaving) return;
    const meal = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.meal;
    const row = this.data.meals.find(item => item.meal === meal);
    if (!row || !row.recipe) return;
    const page = row.recipe.kind === 'builtin' ? 'builtin-recipe' : 'public-recipe';
    wx.navigateTo({url: '/pages/' + page + '/index?id=' + encodeURIComponent(row.recipe.id)});
  },
  openAuthor() {
    if (!account.check(this) || !this.data.ready || this.data.loading || this.data.error || !this.data.author || this.data.copySaving) return;
    wx.navigateTo({url: '/pages/profile/index?id=' + encodeURIComponent(this.data.author.id)});
  },
  authorAvatarError(event) {
    if (!account.check(this) || !this.data.author) return;
    const {id, url} = event.currentTarget.dataset, author = this.data.author;
    const fallback = getProfileAvatar(author.id);
    if (id !== author.id || url !== author.avatar || url === fallback) return;
    this._failedAuthorAvatar = id + ':' + url;
    this.setData({author: {...author, avatar: fallback}});
  },
  photoError(event) {
    if (!account.check(this) || !this.data.ready || this.data.loading) return;
    const meal = event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.meal;
    this.setData({meals: this.data.meals.map(row => row.meal === meal ? {...row, photoFailed: true} : row)});
  },
  resetCopy() {
    this._copyRequest = (this._copyRequest || 0) + 1;
    this._copyPreview = null;
    this._copySavedScope = '';
    this.setData({copyVisible: false, copySaving: false, copyRows: [], copySaveCount: 0, copyConflictCount: 0,
      copyUnavailableCount: 0, copyError: '', copySavedDate: '', copyResultMessage: '', copyCanView: false,
      copyDate: '', copyDateLabel: '', copyMinDate: '', copyMode: 'keep', copyDestination: ''});
  },
  openCopy() {
    if (!account.check(this) || !this.data.ready || this.data.loading || this.data.error ||
      !this.data.hasSavableMeals || this.data.copySaving) return;
    this.resetCopy();
    const today = selectors.today();
    const info = store.getSyncInfo();
    this.setData({copyVisible: true, copyDate: shiftDate(today, 1), copyMinDate: today, copyMode: 'keep',
      copyDestination: info.scope && info.scope.kind === 'family' ? '保存到当前家庭餐单' : '保存到我的餐单'});
    this.refreshCopyPreview();
  },
  closeCopy() { if (!this.data.copySaving) this.resetCopy(); },
  copyVisibleChange(event) { if (!event.detail.visible) this.closeCopy(); },
  changeCopyDate(event) {
    if (!account.check(this) || !this.data.copyVisible || this.data.copySaving || this.data.copySavedDate) return;
    const date = event && event.detail && event.detail.value;
    if (!validPlanDate(date) || date < selectors.today()) {
      this.setData({copyError: '请选择今天或之后的日期。'}); return;
    }
    this.setData({copyDate: date, copyError: ''}); this.refreshCopyPreview();
  },
  changeCopyMode(event) {
    if (!account.check(this) || !this.data.copyVisible || this.data.copySaving || this.data.copySavedDate) return;
    const mode = event && event.currentTarget && event.currentTarget.dataset.mode;
    if (!['keep', 'replace'].includes(mode)) return;
    this.setData({copyMode: mode, copyError: ''}); this.refreshCopyPreview();
  },
  refreshCopyPreview() {
    if (!account.check(this) || !this.data.copyVisible || this.data.copySaving || this.data.copySavedDate) return;
    try {
      const preview = mealPlanCopy.preview(this.data.meals, this.data.copyDate, this.data.copyMode);
      this._copyPreview = preview;
      const notes = {add: '将加入这一天', same: '已安排这道菜', unavailable: '做法暂未公开，本次跳过', empty: '未安排'};
      const rows = preview.rows.map(row => ({...row, actionLabel: row.action === 'replace' ? '将替换：' + row.existingName :
        row.action === 'locked' ? '已记录用餐，保留：' + row.existingName :
          row.action === 'keep' ? '保留：' + row.existingName : notes[row.action] || ''}));
      this.setData({copyRows: rows, copyDateLabel: dayLabel(this.data.copyDate), copySaveCount: preview.saveCount,
        copyConflictCount: preview.conflictCount, copyUnavailableCount: preview.unavailableCount,
        copyCanView: preview.expected.length > 0});
    } catch (error) {
      this._copyPreview = null;
      this.setData({copyRows: [], copySaveCount: 0, copyConflictCount: 0, copyUnavailableCount: 0,
        copyCanView: false, copyError: error.message || '暂时无法读取这一天的安排，请重试。'});
    }
  },
  async confirmCopy() {
    if (!account.check(this) || !this.data.copyVisible || this.data.copySaving || this.data.copySavedDate ||
      !this._copyPreview || !this.data.copySaveCount) return;
    const request = ++this._copyRequest;
    const targetDate = this.data.copyDate;
    const current = () => !this._unloaded && request === this._copyRequest && this.data.copyVisible && account.check(this);
    this.setData({copySaving: true, copyError: ''});
    try {
      const result = await mealPlanCopy.save({profileId: this.profileId, sourceDate: this.planDate, targetDate,
        mode: this.data.copyMode, expected: this._copyPreview.expected, meals: this.data.meals, isCurrent: current});
      if (!current()) return;
      this._copySavedScope = result.scopeKey;
      const parts = ['已安排 ' + result.savedCount + ' 餐'];
      if (result.keptCount) parts.push('保留原有 ' + result.keptCount + ' 餐');
      if (result.unavailableCount) parts.push('跳过未公开的 ' + result.unavailableCount + ' 餐');
      this.setData({copySavedDate: result.date, copyResultMessage: parts.join(' · '), copyCanView: true});
    } catch (error) {
      if (!current()) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      if (error.code === 'SOURCE_CHANGED') {
        this.resetCopy();
        await this.load({force: true});
        if (!this._unloaded && account.check(this)) wx.showToast({title: '原餐单有更新，请查看后重新保存', icon: 'none'});
        return;
      }
      this.setData({copySaving: false, copyError: error.message || '餐单尚未保存，请重试。'});
      this.refreshCopyPreview();
    } finally { if (current()) this.setData({copySaving: false}); }
  },
  viewCopiedPlan() {
    if (!account.check(this) || !this.data.copyVisible || this.data.copySaving || !this.data.copyCanView) return;
    const date = this.data.copySavedDate || this.data.copyDate;
    const info = store.getSyncInfo(), owner = info.owner || '';
    const scope = this._copySavedScope || info.scopeKey || owner;
    if (!validPlanDate(date) || scope !== (info.scopeKey || owner)) return;
    // switchTab legitimately unloads this page before success. Keep a separate
    // short-lived identity guard until the destination has been selected.
    let changed = false;
    const unsubscribe = store.subscribe(() => {
      const next = store.getSyncInfo();
      if ((next.owner || '') !== owner || (next.scopeKey || next.owner || '') !== scope) changed = true;
    });
    wx.switchTab({url: '/pages/records/index', success() {
      unsubscribe();
      const current = store.getSyncInfo();
      if (changed || (current.owner || '') !== owner || (current.scopeKey || current.owner || '') !== scope) return;
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      if (page && page.route === 'pages/records/index' && typeof page.selectConfirmedDate === 'function') page.selectConfirmedDate(date, scope);
    }, fail: () => {
      unsubscribe();
      if (!this._unloaded && account.check(this)) this.setData({copyError: '暂时无法打开餐单，请再试一次。'});
    }, complete: unsubscribe});
  },
  onShareAppMessage() {
    if (!account.check(this) || !this.data.ready || this.data.loading || this.data.error || !this.data.author || !this.data.hasPlans) return {...APP_SHARE};
    return {title: this.data.date + ' 餐单 · ' + this.data.author.name,
      path: '/pages/public-meal-plan/index?profileId=' + encodeURIComponent(this.profileId) + '&date=' + encodeURIComponent(this.planDate),
      imageUrl: APP_SHARE.imageUrl};
  },
  back() { if (!this.data.copySaving) ui.back(); }
});
