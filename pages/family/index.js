const familyService = require('../../utils/family');
const store = require('../../utils/store');
const ui = require('../../utils/ui');
const babyAge = require('../../utils/baby-age');
const ROLE_LABELS = ['爸爸', '妈妈', '爷爷', '奶奶', '姥爷', '姥姥'];
const scopeKey = info => info.scopeKey || info.owner || '';
const fieldValue = event => event && event.detail && typeof event.detail.value === 'string' ? event.detail.value : '';
const newRequestId = () => 'family-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
const expiresLabel = time => {
  const date = new Date(time);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 前有效`;
};

Page({
  data: {loading: true, error: '', actionError: '', family: null, busy: false, busyText: '',
    name: '宝宝的小家庭', roleLabel: '', roleOptions: ROLE_LABELS, token: '', preview: null,
    invite: null, inviteExpiry: '', inviteMode: false, inviteStep: 'confirm', inviteError: '', inviteUnavailable: false,
    roleEditing: false, babyEditing: false, nickname: '', babyBirthDate: null,
    birthDateToday: babyAge.todayString(), babyAgeLabel: '',
    confirmVisible: false, confirmTitle: '', confirmText: '', confirmLabel: '确认', confirmDanger: false},
  onLoad(options = {}) {
    this.request = 0; this.disposed = false; this.locked = false;
    const info = store.getSyncInfo(); this.owner = info.owner || ''; this.scope = scopeKey(info);
    this.unsubscribe = store.subscribe(() => this.check());
    if (typeof options.token === 'string' && options.token.trim()) this.setData({token: options.token.trim().slice(0, 128), inviteMode: true});
    if (wx.showShareMenu) wx.showShareMenu({menus: ['shareAppMessage']});
  },
  onShow() {
    if (!this.check()) return;
    if (this.data.invite && this.data.invite.expiresAt <= Date.now()) this.setData({invite: null, inviteExpiry: ''});
    // Returning from the keyboard or another app does not restart an invitation.
    if (this.data.inviteMode && this.loadedAt) {
      if (!this.data.busy && this.data.preview) this.validInvitation();
      return;
    }
    if (!this.data.busy && !this.data.babyEditing && !this.data.roleEditing && (!this.loadedAt || Date.now() - this.loadedAt >= 30000)) return this.load();
  },
  onUnload() { this.disposed = true; this.request++; if (this.unsubscribe) this.unsubscribe(); },
  check() {
    if (this.disposed || this.locked) return false;
    const info = store.getSyncInfo();
    if (!this.owner && info.owner) { this.owner = info.owner; this.scope = scopeKey(info); return true; }
    if (this.owner !== (info.owner || '') || (!this.switching && this.scope !== scopeKey(info))) {
      this.locked = true; this.request++; this.confirmAction = null;
      this.setData({loading: false, busy: false, family: null, invite: null, preview: null,
        name: '', token: '', roleLabel: '', nickname: '', babyBirthDate: null, babyAgeLabel: '',
        inviteStep: 'confirm', inviteError: '', inviteUnavailable: false, inviteExpiry: '',
        roleEditing: false, babyEditing: false, confirmVisible: false, actionError: '',
        error: '微信账号已切换，或家庭已变化，请重新加载后再操作。'});
      return false;
    }
    return true;
  },
  reload() {
    if (this.disposed || this.data.busy) return;
    const info = store.getSyncInfo(); this.owner = info.owner || ''; this.scope = scopeKey(info); this.locked = false;
    return this.load({force: true});
  },
  async onPullDownRefresh() { try { await this.reload(); } finally { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); } },
  async load(options) {
    if (!this.check() || this.data.busy) return;
    const request = ++this.request;
    this.setData({loading: true, error: '', actionError: ''});
    try {
      const result = await familyService.info(options);
      if (!this.check() || request !== this.request) return;
      this.present(result); this.loadedAt = Date.now();
      if (!result.family && this.data.token) await this.previewInvite();
      else if (!result.family && this.data.inviteMode) this.setData({inviteUnavailable: true, inviteError: '请重新打开家人发来的邀请。'});
    } catch (error) {
      if (this.check() && request === this.request) this.setData({loading: false, error: error.message || '家庭暂时无法加载，请重试。'});
    }
  },
  present(result) {
    if (result.family) this.creation = null;
    const state = store.getState();
    const member = result.family && result.family.members.find(item => item.isSelf);
    this.setData({family: result.family, loading: false, error: '', actionError: '',
      roleLabel: member ? member.label : this.data.roleLabel,
      nickname: state.nickname || '宝宝', babyBirthDate: state.babyBirthDate || null,
      birthDateToday: babyAge.todayString(), babyAgeLabel: state.babyBirthDate ? babyAge.ageLabel(babyAge.ageInMonths(state.babyBirthDate)) : ''});
  },
  editable() { return this.check() && !this.data.loading && !this.data.busy && !this.data.error; },
  changeName(event) { if (this.editable()) this.setData({name: fieldValue(event).slice(0, 30), actionError: ''}); },
  changeRole(event) { if (this.editable()) this.setData({roleLabel: fieldValue(event).slice(0, 20), actionError: ''}); },
  chooseRole(event) {
    if (this.editable() && ROLE_LABELS.includes(event.currentTarget.dataset.label)) this.setData({roleLabel: event.currentTarget.dataset.label, actionError: ''});
  },
  changeToken(event) { if (this.editable() && !this.data.inviteMode) this.setData({token: fieldValue(event).trim().slice(0, 128), preview: null, actionError: ''}); },
  validRole() {
    if (!this.data.roleLabel.trim()) { this.setData({actionError: '请选择或填写你与宝宝的关系。'}); return false; }
    return true;
  },
  confirm(title, text, label, action, danger = false) {
    this.confirmAction = action;
    this.setData({confirmVisible: true, confirmTitle: title, confirmText: text, confirmLabel: label, confirmDanger: danger});
  },
  cancelConfirm() { if (!this.data.busy) { this.confirmAction = null; this.setData({confirmVisible: false}); } },
  confirmOperation() {
    if (!this.editable()) return;
    const action = this.confirmAction; this.confirmAction = null; this.setData({confirmVisible: false});
    if (action) return action();
  },
  create() {
    if (!this.editable() || this.data.family || this.data.inviteMode || !this.validRole()) return;
    const name = this.data.name.trim();
    if (!name) { this.setData({actionError: '请填写家庭名称。'}); return; }
    const input = {name, label: this.data.roleLabel.trim()};
    const key = JSON.stringify(input);
    if (!this.creation || this.creation.key !== key) this.creation = {key, requestId: newRequestId()};
    this.confirm('创建家庭并共享现有记录？', '当前宝宝的称呼、生日、食谱、照片、收藏、过敏食物和用餐记录将作为家庭的初始数据。加入的家人都能查看和记录；个人主页和关注仍属于各自账号，菜谱保留创建者身份并在同步后自动展示给其他家长。', '创建并共享',
      () => this.mutate('正在创建家庭…', () => familyService.create({...input, requestId: this.creation.requestId}), true));
  },
  async previewInvite() {
    if (!this.editable() || this.data.family || this.data.inviteUnavailable) return;
    const token = this.data.token.trim();
    if (!token) { this.setData({actionError: '请先填写家人发来的邀请码。'}); return; }
    const request = this.request;
    this.setData({busy: true, busyText: '正在确认邀请…', actionError: '', preview: null,
      inviteStep: 'confirm', inviteError: '', inviteExpiry: ''});
    try {
      const preview = await familyService.preview(token);
      if (this.check() && request === this.request) {
        this.setData({preview, inviteMode: true, inviteExpiry: expiresLabel(preview.expiresAt)});
        this.validInvitation(); this.scrollToTop();
      }
    } catch (error) {
      if (this.check() && request === this.request) {
        const message = error.message || '邀请暂时无法查看，请稍后重试。';
        this.setData(this.data.inviteMode ? {inviteError: message, inviteUnavailable: error.code === 'INVITE_INVALID'} : {actionError: message});
      }
    }
    finally { if (this.check() && request === this.request) this.setData({busy: false, busyText: ''}); }
  },
  validInvitation() {
    if (!this.data.preview) return false;
    if (this.data.preview.expiresAt <= Date.now()) {
      this.setData({preview: null, inviteStep: 'confirm', inviteExpiry: '', actionError: '',
        inviteUnavailable: true, inviteError: '邀请已过期，请家人重新生成邀请。'});
      return false;
    }
    return true;
  },
  scrollToTop() { if (wx.pageScrollTo) wx.pageScrollTo({scrollTop: 0, duration: 0}); },
  confirmInvitation() {
    if (!this.editable() || this.data.family || !this.data.inviteMode || !this.validInvitation()) return;
    this.setData({inviteStep: 'role', actionError: ''}); this.scrollToTop();
  },
  backToInvitation() {
    if (!this.editable() || !this.data.inviteMode) return;
    this.setData({inviteStep: 'confirm', actionError: ''}); this.scrollToTop();
  },
  openCurrentFamily() {
    if (!this.editable() || !this.data.family) return;
    this.setData({inviteMode: false, inviteStep: 'confirm', token: '', preview: null, inviteError: '', inviteUnavailable: false});
    this.scrollToTop();
  },
  join() {
    if (!this.editable() || this.data.family || !this.data.inviteMode || this.data.inviteStep !== 'role' || !this.validInvitation() || !this.validRole()) return;
    const input = {token: this.data.token, label: this.data.roleLabel.trim()};
    const key = JSON.stringify(input);
    if (!this.joining || this.joining.key !== key) this.joining = {key, requestId: newRequestId()};
    return this.mutate('正在加入家庭…', () => familyService.join({...input, requestId: this.joining.requestId}), true);
  },
  async mutate(busyText, operation, switches = false) {
    if (!this.editable()) return;
    const request = this.request;
    const fromInvitation = this.data.inviteMode;
    this.switching = switches;
    this.setData({busy: true, busyText, actionError: ''});
    try {
      const result = await operation();
      if (!this.check() || request !== this.request) return;
      this.scope = scopeKey(store.getSyncInfo());
      this.setData({invite: null, inviteExpiry: '', preview: null, token: '', roleEditing: false, babyEditing: false,
        inviteMode: false, inviteStep: 'confirm', inviteError: '', inviteUnavailable: false});
      this.present(result); this.loadedAt = Date.now();
      if (fromInvitation) this.scrollToTop();
      wx.showToast({title: '已完成', icon: 'success'});
    } catch (error) {
      if (this.check() && request === this.request) {
        const message = error.message || '操作暂未完成，请重试。';
        this.setData(this.data.inviteMode && error.code === 'INVITE_INVALID' ?
          {preview: null, inviteStep: 'confirm', inviteExpiry: '', inviteError: message, inviteUnavailable: true, actionError: ''} : {actionError: message});
      }
    } finally {
      this.switching = false;
      if (this.check() && request === this.request) this.setData({busy: false, busyText: ''});
    }
  },
  async generateInvite() {
    if (!this.editable() || !this.data.family || !this.data.family.isManager) return;
    const request = this.request;
    this.setData({busy: true, busyText: '正在生成邀请…', invite: null, actionError: ''});
    try {
      const invite = await familyService.invite();
      if (this.check() && request === this.request) this.setData({invite, inviteExpiry: expiresLabel(invite.expiresAt)});
    } catch (error) { if (this.check() && request === this.request) this.setData({actionError: error.message || '邀请未生成，请重试。'}); }
    finally { if (this.check() && request === this.request) this.setData({busy: false, busyText: ''}); }
  },
  copyInvite() {
    if (!this.editable() || !this.data.invite || this.data.invite.expiresAt <= Date.now()) return;
    wx.setClipboardData({data: this.data.invite.token, fail: () => { if (this.check()) this.setData({actionError: '复制未完成，请重试。'}); }});
  },
  editRole() {
    if (!this.editable() || !this.data.family) return;
    if (this.data.babyEditing) { this.setData({actionError: '请先保存或取消宝宝资料的修改。'}); return; }
    this.setData({roleEditing: true});
  },
  saveRole() {
    if (!this.editable() || !this.data.family || !this.validRole()) return;
    return this.mutate('正在保存称谓…', () => familyService.changeRole({memberId: this.data.family.memberId, label: this.data.roleLabel.trim()}));
  },
  cancelRole() { if (this.editable()) { const member = this.data.family.members.find(item => item.isSelf); this.setData({roleEditing: false, roleLabel: member.label, actionError: ''}); } },
  member(event) { return this.data.family && this.data.family.members.find(item => item.id === event.currentTarget.dataset.id); },
  removeMember(event) {
    if (!this.editable() || !this.data.family || !this.data.family.isManager) return;
    const member = this.member(event); if (!member || member.isSelf) return;
    this.confirm('移出这位家人？', `「${member.label}」将不能继续读取或修改家庭数据，已有用餐记录会保留。`, '确认移出',
      () => this.mutate('正在移出成员…', () => familyService.remove(member.id)), true);
  },
  transferManager(event) {
    if (!this.editable() || !this.data.family || !this.data.family.isManager) return;
    const member = this.member(event); if (!member || member.isSelf) return;
    this.confirm('转让家庭管理权限？', `转让后「${member.label}」可以邀请和移出成员，你仍能查看和记录宝宝辅食。`, '确认转让',
      () => this.mutate('正在转让管理权限…', () => familyService.transfer(member.id)));
  },
  leave() {
    if (!this.editable() || !this.data.family) return;
    const group = this.data.family;
    if (group.isManager && group.memberCount > 1) { this.setData({actionError: '请先将管理权限转给另一位家人，再退出家庭。'}); return; }
    const last = group.memberCount === 1;
    this.confirm(last ? '解散这个家庭？' : '退出这个家庭？', last ?
      '请先确认家庭数据已妥善备份。解散后不能继续访问这份家庭数据，当前账号将回到原来的个人食谱。' :
      '退出前会先同步本机修改。退出后将回到原来的个人食谱，不会把家庭记录带入个人数据；其他家人仍可继续使用。',
      last ? '确认解散' : '确认退出', () => this.mutate('正在同步并退出…', () => familyService.leave(), true), true);
  },
  editBaby() {
    if (!this.editable() || !this.data.family) return;
    if (this.data.roleEditing) { this.setData({actionError: '请先保存或取消称谓的修改。'}); return; }
    const state = store.getState();
    this.babyDraftBase = {nickname: state.nickname || '宝宝', babyBirthDate: state.babyBirthDate || null};
    this.setData({babyEditing: true, nickname: state.nickname || '宝宝', babyBirthDate: state.babyBirthDate || null, actionError: ''});
  },
  changeNickname(event) { if (this.editable() && this.data.babyEditing) this.setData({nickname: fieldValue(event).slice(0, 20)}); },
  changeBirthDate(event) { if (this.editable() && this.data.babyEditing && babyAge.isValidBirthDate(event.detail.value)) this.setData({babyBirthDate: event.detail.value}); },
  clearBirthDate() { if (this.editable() && this.data.babyEditing) this.setData({babyBirthDate: null}); },
  cancelBaby() { if (this.editable()) { const state = store.getState(); this.setData({babyEditing: false, actionError: '', nickname: state.nickname || '宝宝', babyBirthDate: state.babyBirthDate || null}); } },
  saveBaby() {
    if (!this.editable() || !this.data.family || !this.data.babyEditing) return;
    try {
      const nickname = this.data.nickname.trim();
      if (!nickname) throw Error('请填写宝宝称呼。');
      const base = this.babyDraftBase || {};
      const patch = {...(nickname !== base.nickname ? {nickname} : {}), ...(this.data.babyBirthDate !== base.babyBirthDate ? {babyBirthDate: this.data.babyBirthDate} : {})};
      if (Object.keys(patch).length) store.setBabyProfile(patch);
      if (!this.check()) return;
      const state = store.getState();
      this.setData({babyEditing: false, actionError: '', nickname: state.nickname || '宝宝', babyBirthDate: state.babyBirthDate || null,
        babyAgeLabel: state.babyBirthDate ? babyAge.ageLabel(babyAge.ageInMonths(state.babyBirthDate)) : ''});
      wx.showToast({title: '宝宝资料已保存', icon: 'success'});
    } catch (error) { if (this.check()) this.setData({actionError: error.message || '资料未保存，请重试。'}); }
  },
  onShareAppMessage(event = {}) {
    const invite = this.editable() && this.data.family && this.data.invite;
    const dataset = event.target && event.target.dataset || {};
    const invitationButton = dataset.invite === '1' || dataset.custom && dataset.custom.invite === '1';
    if (event.from === 'button' && invitationButton && invite && invite.expiresAt > Date.now()) {
      return {title: '一起记录宝宝的辅食 · 小口袋', path: '/pages/family/index?token=' + encodeURIComponent(invite.token), imageUrl: '/assets/cute/pocket-mascot.png'};
    }
    return {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  back() {
    if (this.data.busy) return;
    if (this.data.inviteMode && this.data.inviteStep === 'role') this.backToInvitation();
    else ui.back();
  }
});
