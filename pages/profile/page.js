const social = require('../../utils/social');
const ui = require('../../utils/ui');
const account = require('./account');
const poster = require('../../utils/profile-poster');
const store = require('../../utils/store');
const content = require('../../utils/profile-content');
const babyAge = require('../../utils/baby-age');
const config = require('../../config/cloud');
const {syncTabBar} = require('../../utils/tab-bar');
const {getProfileAvatar} = require('../../utils/profile-avatar');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const normalizeBabyNickname = value => typeof value === 'string' && value.trim() ? value.trim() : '宝宝';
const babyNicknameFields = state => {
  const nickname = state ? normalizeBabyNickname(state.nickname) : '';
  return {babyNickname: nickname, babyNicknameBase: nickname, babyNicknameDirty: false, babyNicknameError: ''};
};
const babyAgeFields = (profile, isSelf = false) => {
  const today = babyAge.todayString();
  const birthDate = isSelf && profile && babyAge.isValidBirthDate(profile.babyBirthDate, today) ? profile.babyBirthDate : null;
  const months = birthDate ? babyAge.ageInMonths(birthDate, today) :
    profile && Number.isSafeInteger(profile.babyAgeMonths) && profile.babyAgeMonths >= 0 ? profile.babyAgeMonths : null;
  return {babyAgeMonths: months, babyAgeLabel: babyAge.ageLabel(months),
    babyBirthDate: birthDate, birthdayDirty: false, birthDateToday: today,
    birthdayAgeLabel: birthDate ? babyAge.ageLabel(months) : ''};
};

module.exports = function createProfilePage(isTab = false) { return {
  data: {
    isTab, socialEnabled: config.socialEnabled === true, loading: true, error: '', profile: null, isSelf: isTab, following: false, followedBy: false,
    contentTab: 'recipes', visibility: 'all', logs: [], recipeCount: 0, favoriteCount: 0, logCount: 0,
    publicCount: 0, privateCount: 0, publicationReady: false, publicationError: '',
    publishedCount: 0, followingCount: 0, followerCount: 0, needsProfile: false,
    recipes: [], nextOffset: null, loadingMore: false, editing: false, name: '', bio: '', saving: false, followBusy: false,
    profileSaveError: '', profileModerating: false, avatarPath: getProfileAvatar(),
    babyAgeMonths: null, babyAgeLabel: '', babyBirthDate: null, birthdayDirty: false,
    birthdayAgeLabel: '', birthDateToday: '',
    ...babyNicknameFields(null),
    shareVisible: false, shareLoading: false, shareError: '', posterPath: '', albumDenied: false, savingPoster: false, shareVersion: ''
  },
  onLoad(options = {}) {
    let scene = '';
    if (options.scene) { try { scene = decodeURIComponent(options.scene); } catch (_) { scene = 'invalid'; } }
    this.profileId = isTab ? '' : options.id || scene || '';
    this.returnAfterSave = !isTab && !this.profileId && options.returnToRecipe === '1';
    this.published = []; this.pendingShare = false;
    this.setupRequested = options.edit === '1'; this.shareRequested = options.share === '1';
    this.request = 0; this.shareRequest = 0; account.bind(this);
  },
  onShow() {
    if (isTab) syncTabBar(this);
    if (!this.data.editing && !this.data.followBusy && !this.data.shareVisible) return this.load();
  },
  onReady() { if (isTab) syncTabBar(this); },
  onUnload() { this.request++; this.disposeShare(); account.dispose(this); },
  reload() { return account.reload(this); },
  async load() {
    if (!account.check(this)) return;
    const request = ++this.request;
    this.publicSavedForEdit = false;
    this.published = [];
    const currentProfileId = this.data.profile && this.data.profile.id;
    const sameProfile = typeof currentProfileId === 'string' && /^[a-f0-9]{32}$/.test(currentProfileId) &&
      (this.profileId ? this.profileId === currentProfileId : this.data.isSelf);
    this.setData({loading: true, error: '', avatarPath: getProfileAvatar(sameProfile ? currentProfileId : ''), loadingMore: false, saving: false, profileSaveError: '', profileModerating: false, needsProfile: false, publicationReady: false, publicationError: ''});
    this.refresh();
    try {
      let result, mine;
      if (!this.data.socialEnabled && isTab) {
        result = {profile: {name: '我的小口袋', bio: '', exists: false}, isSelf: true, recipes: []};
      } else if (this.profileId) {
        result = await social.getProfile(this.profileId, 0);
        if (!account.check(this) || request !== this.request) return;
        if (result.isSelf) mine = await social.getMine();
      } else {
        mine = await social.getMine();
        result = Object.assign({}, mine, {isSelf: true, following: false, followedBy: false, recipes: [], nextOffset: null});
      }
      if (!account.check(this) || request !== this.request) return;
      const profile = Object.assign({}, result.profile, result.isSelf && mine && mine.profile ? mine.profile : {});
      if (!result.isSelf) delete profile.babyBirthDate;
      const editing = result.isSelf && this.setupRequested;
      this.setupRequested = false;
      const publicationReady = !!mine && Array.isArray(mine.published) &&
        mine.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim());
      this.published = publicationReady ? mine.published : [];
      this.setData({
        profile, avatarPath: getProfileAvatar(profile.id), isSelf: !!result.isSelf, following: !!result.following, followedBy: !!result.followedBy,
        publishedCount: Number.isSafeInteger(result.publishedCount) ? count(result.publishedCount) :
          result.nextOffset == null ? (result.recipes || []).length : null,
        followingCount: count(result.followingCount), followerCount: count(result.followerCount),
        recipes: result.isSelf ? [] : result.recipes || [], logs: [],
        nextOffset: result.isSelf || result.nextOffset == null ? null : result.nextOffset,
        publicationReady, publicationError: mine && !publicationReady ? '暂时无法确认菜谱公开状态，请重试。' : '',
        name: profile.name, bio: profile.bio || '', ...babyAgeFields(profile, !!result.isSelf),
        ...babyNicknameFields(editing ? store.getState() : null), loading: false, editing
      });
      if (result.isSelf) this.refresh();
      else this.setData({contentTab: 'recipes', visibility: 'public', recipeCount: count(result.publishedCount), favoriteCount: 0, logCount: 0, publicCount: 0, privateCount: 0});
      if (profile.exists !== false) wx.showShareMenu({menus: ['shareAppMessage']});
      else wx.hideShareMenu({menus: ['shareAppMessage']});
      if (this.shareRequested && profile.exists !== false) { this.shareRequested = false; this.openShare(); }
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
      if (isTab) {
        this.setData({loading: false, profile: null, avatarPath: getProfileAvatar(), ...babyAgeFields(null), ...babyNicknameFields(null), isSelf: true, publicationReady: false,
          publicationError: error.message || '公开状态暂时无法读取'});
        this.refresh();
      } else this.setData({loading: false, profile: null, avatarPath: getProfileAvatar(), ...babyAgeFields(null), ...babyNicknameFields(null), recipes: [], logs: [], error: error.message || '主页暂时无法加载'});
      if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
    }
  },
  refresh() {
    if (!account.check(this) || !this.data.isSelf) return;
    try {
      const state = store.getState();
      this.setData({...content.build(state, {tab: this.data.contentTab, visibility: this.data.visibility,
        publicationReady: this.data.publicationReady, published: this.published || []}),
        ...(this.data.editing && !this.data.babyNicknameDirty ? babyNicknameFields(state) : {})});
    } catch (error) { ui.error(error); }
  },
  disposeLocalContent() { this.published = []; this.pendingShare = false; this.shareRequested = false; this.returnAfterSave = false; this.publicSavedForEdit = false; },
  changeContentTab(event) {
    if (!account.check(this)) return;
    const value = event.currentTarget && event.currentTarget.dataset.value || event.detail && event.detail.value;
    if (!['recipes', 'favorites', 'records'].includes(value) || (!this.data.isSelf && value !== 'recipes')) return;
    this.setData({contentTab: value}); this.refresh();
  },
  changeVisibility(event) {
    if (!account.check(this) || !this.data.isSelf) return;
    const value = event.currentTarget && event.currentTarget.dataset.value || event.detail && event.detail.value;
    if (!['all', 'public', 'private'].includes(value)) return;
    this.setData({visibility: value}); this.refresh();
  },
  edit() {
    if (!account.check(this) || !this.data.isSelf || this.data.loading || this.data.saving) return;
    try {
      this.publicSavedForEdit = false;
      this.setData({editing: true, profileSaveError: '', profileModerating: false, name: this.data.profile ? this.data.profile.name : '', bio: this.data.profile && this.data.profile.bio || '',
        ...babyAgeFields(this.data.profile, true), ...babyNicknameFields(store.getState())});
    } catch (error) { ui.error(error); }
  },
  cancelEdit() { if (account.check(this) && !this.data.saving) { this.pendingShare = false; this.publicSavedForEdit = false;
    this.setData({editing: false, profileSaveError: '', profileModerating: false, ...babyAgeFields(this.data.profile, this.data.isSelf), ...babyNicknameFields(null)}); this.returnToRecipe(); } },
  returnToRecipe(saved = false) {
    if (!this.returnAfterSave || !account.check(this) || typeof getCurrentPages !== 'function') return false;
    const pages = getCurrentPages();
    if (pages.length < 2 || pages[pages.length - 1] !== this || pages[pages.length - 2].route !== 'pages/detail/index') return false;
    this.returnAfterSave = false;
    if (saved && typeof this.getOpenerEventChannel === 'function') {
      const channel = this.getOpenerEventChannel();
      if (channel && typeof channel.emit === 'function') channel.emit('profileSaved');
    }
    wx.navigateBack({delta: 1});
    return true;
  },
  editVisibilityChange(event) { if (event.detail.visible === false) this.cancelEdit(); },
  changeName(event) { if (account.check(this) && this.data.isSelf && this.data.socialEnabled && this.data.profile && !this.data.saving) this.setData({name: event.detail.value}); },
  changeBio(event) { if (account.check(this) && this.data.isSelf && this.data.socialEnabled && this.data.profile && !this.data.saving) this.setData({bio: event.detail.value}); },
  changeBabyNickname(event) {
    if (!account.check(this) || !this.data.isSelf || !this.data.editing || this.data.saving) return;
    const value = event.detail && typeof event.detail.value === 'string' ? event.detail.value : '';
    this.setData({babyNickname: value, babyNicknameDirty: normalizeBabyNickname(value) !== this.data.babyNicknameBase, babyNicknameError: ''});
  },
  changeBabyBirthDate(event) {
    if (!account.check(this) || !this.data.isSelf || !this.data.socialEnabled || !this.data.profile || !this.data.editing || this.data.saving) return;
    const value = event.detail && event.detail.value;
    const today = babyAge.todayString();
    if (!babyAge.isValidBirthDate(value, today)) return;
    this.setData({babyBirthDate: value, birthdayDirty: true, birthDateToday: today,
      birthdayAgeLabel: babyAge.ageLabel(babyAge.ageInMonths(value, today))});
  },
  clearBabyBirthDate() {
    if (!account.check(this) || !this.data.isSelf || !this.data.socialEnabled || !this.data.profile || !this.data.editing || this.data.saving) return;
    this.setData({babyBirthDate: null, birthdayDirty: true, birthdayAgeLabel: ''});
  },
  async save() {
    if (!account.check(this) || !this.data.isSelf) return;
    if (this.data.saving) return;
    const name = this.data.name.trim(), bio = this.data.bio.trim();
    const nickname = normalizeBabyNickname(this.data.babyNickname);
    if (this.data.babyNicknameDirty && nickname.length > 20) { ui.error(new Error('宝宝称呼请填写 1–20 个字。')); return; }
    const profile = this.data.profile;
    const publicChanged = this.data.socialEnabled && !!profile && (name !== profile.name.trim() || bio !== (profile.bio || '').trim() || this.data.birthdayDirty);
    const privateOnly = this.data.babyNicknameDirty && !publicChanged &&
      ((!this.pendingShare && !this.returnAfterSave) || this.publicSavedForEdit);
    if (!privateOnly && (!this.data.socialEnabled || !profile)) { ui.error(new Error('生日与公开资料暂不可编辑，请稍后重试')); return; }
    if (!privateOnly && !name) { ui.error(new Error('请填写公开昵称')); return; }
    const input = {name, bio};
    if (this.data.birthdayDirty) {
      if (this.data.babyBirthDate !== null && !babyAge.isValidBirthDate(this.data.babyBirthDate)) {
        ui.error(new Error('请选择有效的宝宝生日，不能晚于今天。')); return;
      }
      input.babyBirthDate = this.data.babyBirthDate;
    }
    const request = ++this.request;
    this.setData({saving: true, profileModerating: !privateOnly, profileSaveError: '', babyNicknameError: ''});
    try {
      if (!privateOnly) {
        const result = await social.saveProfile(input);
        if (!account.check(this) || request !== this.request) return;
        const savedProfile = result && result.profile ? result.profile : {...profile, ...input, exists: true,
          ...(Object.prototype.hasOwnProperty.call(input, 'babyBirthDate') ? {babyAgeMonths: babyAge.ageInMonths(input.babyBirthDate)} : {})};
        this.publicSavedForEdit = true;
        this.setData({profile: savedProfile, avatarPath: getProfileAvatar(savedProfile.id), profileModerating: false, name: savedProfile.name, bio: savedProfile.bio || '', ...babyAgeFields(savedProfile, true)});
      }
      if (!account.check(this) || request !== this.request) return;
      if (this.data.babyNicknameDirty) {
        try { store.setNickname(nickname); }
        catch (error) {
          if (!account.check(this) || request !== this.request) return;
          const message = this.publicSavedForEdit ? '主页已保存，宝宝称呼未保存，请重试' : error.message || '宝宝称呼未保存，请重试';
          this.setData({babyNicknameError: message}); ui.error(new Error(message)); return;
        }
      }
      if (!account.check(this) || request !== this.request) return;
      const savedPublic = this.publicSavedForEdit;
      this.setData({editing: false, saving: false, profileModerating: false, profileSaveError: '', ...babyNicknameFields(null)});
      this.publicSavedForEdit = false;
      if (privateOnly && !savedPublic) { wx.showToast({title: '宝宝称呼已保存', icon: 'success'}); this.refresh(); return; }
      if (this.pendingShare) { this.shareRequested = true; this.pendingShare = false; }
      wx.showToast({title: '资料已保存', icon: 'success'});
      if (this.returnToRecipe(true)) return;
      await this.load();
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); ui.error(error); return; }
      const message = error.userMessage || error.message || '资料未保存，请稍后重试。';
      this.setData({profileSaveError: message});
      ui.error(new Error(message));
    } finally { if (account.check(this) && request === this.request) this.setData({saving: false, profileModerating: false}); }
  },
  async toggleFollow() {
    if (!account.check(this)) return;
    if (this.data.followBusy || !this.data.profile || this.data.isSelf) return;
    const previous = this.data.following;
    const request = ++this.request;
    this.setData({followBusy: true, needsProfile: false, loadingMore: false});
    try {
      const result = await social.setFollowing(this.data.profile.id, !previous);
      if (!account.check(this) || request !== this.request) return;
      const following = !!result.following;
      const followedBy = typeof result.followedBy === 'boolean' ? result.followedBy : this.data.followedBy;
      this.setData({following, followedBy,
        followerCount: Math.max(0, this.data.followerCount + Number(following) - Number(previous))});
      wx.showToast({title: following ? followedBy ? '已互相关注' : '已关注' : '已取消关注', icon: 'none'});
    } catch (error) {
      if (!account.check(this) || request !== this.request) return;
      if (error.code === 'PROFILE_REQUIRED') this.setData({needsProfile: true});
      else { ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    } finally { if (account.check(this) && request === this.request) this.setData({followBusy: false}); }
  },
  async loadMore() {
    if (!account.check(this)) return;
    if (this.data.isSelf || this.data.loading || this.data.loadingMore || this.data.followBusy || this.data.nextOffset === null || !this.data.profile) return;
    const request = this.request;
    this.setData({loadingMore: true});
    try {
      const result = await social.getProfile(this.data.profile.id, this.data.nextOffset);
      if (!account.check(this) || request !== this.request) return;
      const known = new Set(this.data.recipes.map(item => item.id));
      this.setData({recipes: this.data.recipes.concat(result.recipes.filter(item => !known.has(item.id))), nextOffset: result.nextOffset == null ? null : result.nextOffset});
    } catch (error) { if (!account.check(this) || request !== this.request) return; ui.error(error); if (error.code === 'ACCOUNT_CHANGED') account.invalidate(this); }
    finally { if (account.check(this) && request === this.request) this.setData({loadingMore: false}); }
  },
  onReachBottom() { return this.loadMore(); },
  photoError(event) {
    const id = event.detail && event.detail.id;
    const index = id ? this.data.recipes.findIndex(item => item.id === id) : Number(event.currentTarget.dataset.index);
    if (Number.isInteger(index) && this.data.recipes[index]) this.setData({[`recipes[${index}].photoURL`]: '', [`recipes[${index}].displayPhoto`]: ''});
  },
  openRecipe(event) {
    if (!account.check(this)) return;
    const id = event.detail && event.detail.id || event.currentTarget && event.currentTarget.dataset.id;
    if (!this.data.recipes.some(recipe => recipe.id === id)) return;
    wx.navigateTo({url: '/pages/' + (this.data.isSelf ? 'detail' : 'public-recipe') + '/index?id=' + encodeURIComponent(id)});
  },
  openCookbook() { if (account.check(this)) wx.navigateTo({url: '/pages/recipes/index'}); },
  openFollowing() { if (account.check(this) && this.data.isSelf) wx.navigateTo({url: '/pages/following/index?tab=people'}); },
  openFollowers() { if (account.check(this) && this.data.isSelf) wx.navigateTo({url: '/pages/following/index?tab=followers'}); },
  openMine() { if (account.check(this)) wx.navigateTo({url: '/pages/profile/index?edit=1'}); },
  openSettings() { if (account.check(this) && this.data.isSelf) wx.navigateTo({url: '/pages/settings/index'}); },
  openRecords() { if (account.check(this) && this.data.isSelf) wx.switchTab({url: '/pages/records/index'}); },
  openLog(event) {
    if (!account.check(this) || !this.data.isSelf) return;
    const id = event.currentTarget.dataset.id;
    if (this.data.logs.some(log => log.id === id)) wx.navigateTo({url: '/pages/record-editor/index?logId=' + encodeURIComponent(id)});
  },
  requestShare() {
    if (!account.check(this) || !this.data.socialEnabled || this.data.loading) return;
    if (!this.data.profile) return this.reload();
    if (this.data.isSelf && this.data.profile.exists === false) { this.pendingShare = true; return this.edit(); }
    return this.openShare();
  },
  disposeShare() {
    this.shareRequest = (this.shareRequest || 0) + 1;
    poster.remove(this.data.posterPath);
    this.setData({shareVisible: false, shareLoading: false, shareError: '', posterPath: '', albumDenied: false, savingPoster: false});
  },
  closeShare() { this.disposeShare(); },
  shareVisibilityChange(event) { if (event.detail.visible === false) this.closeShare(); },
  async openShare() {
    if (!account.check(this) || this.data.loading || this.data.editing || !this.data.profile || this.data.profile.exists === false) return;
    this.disposeShare();
    const profile = this.data.profile, request = this.shareRequest;
    this.setData({shareVisible: true, shareLoading: true});
    const guard = () => {
      if (!account.check(this) || request !== this.shareRequest || !this.data.shareVisible ||
        !this.data.profile || this.data.profile.id !== profile.id) throw Error('分享页面已关闭，请重新生成。');
    };
    try {
      const info = wx.getAccountInfoSync();
      const envVersion = info && info.miniProgram && info.miniProgram.envVersion;
      this.setData({shareVersion: envVersion === 'release' ? '' : envVersion === 'trial' ? '体验版分享码，需有体验权限' : '开发版分享码，需有开发权限'});
      const code = await social.getShareCode(profile.id, envVersion);
      guard();
      const posterPath = await poster.render(this, {profile, codeURL: code.codeURL, envVersion}, guard);
      guard(); this.setData({posterPath, shareLoading: false});
    } catch (error) {
      if (account.check(this) && request === this.shareRequest && this.data.shareVisible) {
        if (error.code === 'ACCOUNT_CHANGED') { account.invalidate(this); return; }
        this.setData({shareLoading: false, shareError: error.userMessage || '分享海报暂时无法生成，可以先发送主页给朋友。'});
      }
    }
  },
  previewPoster() {
    if (account.check(this) && this.data.shareVisible && this.data.posterPath) wx.previewImage({current: this.data.posterPath, urls: [this.data.posterPath]});
  },
  savePoster() {
    if (!account.check(this) || !this.data.shareVisible || !this.data.posterPath || this.data.savingPoster) return;
    const request = this.shareRequest;
    this.setData({savingPoster: true, albumDenied: false, shareError: ''});
    wx.saveImageToPhotosAlbum({filePath: this.data.posterPath,
      success: () => { if (account.check(this) && request === this.shareRequest) wx.showToast({title: '分享图已保存', icon: 'success'}); },
      fail: error => {
        if (!account.check(this) || request !== this.shareRequest) return;
        const denied = /auth|deny|denied|authorize|permission/i.test(error.errMsg || '');
        this.setData({albumDenied: denied, shareError: denied ? '保存图片需要相册权限，也可以点开图片后长按保存。' : '暂时无法保存，请点开图片后长按保存。'});
      },
      complete: () => { if (account.check(this) && request === this.shareRequest) this.setData({savingPoster: false}); }
    });
  },
  albumSettings() { if (account.check(this) && this.data.albumDenied) wx.openSetting({}); },
  onShareAppMessage() {
    const profile = account.check(this) && !this.data.loading && !this.data.error ? this.data.profile : null;
    return profile && profile.exists !== false ? {title: profile.name + '的口袋食谱', path: '/pages/profile/index?id=' + encodeURIComponent(profile.id), imageUrl: '/assets/cute/pocket-mascot.png'} : {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index'};
  },
  back: ui.back

}; };
