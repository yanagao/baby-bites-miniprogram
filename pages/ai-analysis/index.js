'use strict';

const grants = require('../../utils/ai-analysis');
const store = require('../../utils/store');
const scopeKey = info => JSON.stringify([info.owner || '', info.scope || null, info.scopeKey || '']);
const timeLabel = value => {
  if (!Number.isSafeInteger(value) || value <= 0) return '时间未知';
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

Page({
  data: {loading: true, statusLoaded: false, busy: '', error: '', locked: false, apiBaseUrl: '',
    activeGrant: false, grantExpiry: '', tokenAvailable: false, pendingSync: false},
  onLoad() {
    this._disposed = false; this._locked = false; this._request = 0; this._token = '';
    const info = store.getSyncInfo();
    this._scopeKey = info.owner ? scopeKey(info) : null;
    this._unsubscribe = store.subscribe(() => {
      if (this._scopeKey !== null || this._locked || this._disposed || store.getSyncInfo().blocked) return this.check();
      // Cold start binds the account and its family synchronously in two store notifications.
      // Read the settled scope before the first status request.
      Promise.resolve().then(() => {
        const current = store.getSyncInfo();
        if (!current.owner || current.blocked || this._scopeKey !== null || this._disposed || this._locked) return;
        this._scopeKey = scopeKey(current);
        return this.load();
      });
    });
    if (this._scopeKey === null) {
      this.setData({loading: false, error: '等待微信账号同步，完成后会自动读取授权状态。'});
    }
    return this.load();
  },
  onShow() {
    if (!this.check()) return;
    if (this._expiresAt && this._expiresAt <= Date.now()) this.clearGrant();
  },
  onUnload() {
    this._disposed = true; this._request++; this._token = ''; this._expiresAt = 0;
    this.data.tokenAvailable = false;
    if (this._unsubscribe) this._unsubscribe();
  },
  check() {
    if (this._disposed || this._locked) return false;
    const info = store.getSyncInfo();
    if (info.blocked || (this._scopeKey !== null && this._scopeKey !== scopeKey(info))) {
      this._locked = true; this._request++; this._token = ''; this._expiresAt = 0;
      this.setData({loading: false, statusLoaded: false, busy: '', locked: true, tokenAvailable: false, activeGrant: false,
        grantExpiry: '', apiBaseUrl: '',
        error: '微信账号或家庭已变化，请返回设置后重新打开。'});
      return false;
    }
    if (this._scopeKey === null) return false;
    this.setData({pendingSync: Boolean(info.dirty)});
    return true;
  },
  async load() {
    if (!this.check() || this.data.busy) return;
    const request = ++this._request;
    // Status never returns the secret and cannot attest that a previous
    // in-memory secret still matches a grant rotated on another device.
    this._token = '';
    this.setData({loading: true, statusLoaded: false, error: '', tokenAvailable: false});
    try {
      const result = await grants.status();
      if (!this.check() || request !== this._request) return;
      const active = Boolean(result.grant && result.grant.active && result.grant.expiresAt > Date.now());
      this._expiresAt = active ? result.grant.expiresAt : 0;
      this.setData({statusLoaded: true, apiBaseUrl: result.apiBaseUrl,
        activeGrant: active, grantExpiry: active ? timeLabel(this._expiresAt) : ''});
      if (!active) this.clearGrant();
    } catch (error) {
      if (this.check() && request === this._request) this.setData({error: error.message || '授权状态暂时无法加载，请重试。'});
    } finally {
      if (this.check() && request === this._request) this.setData({loading: false});
    }
  },
  clearGrant() {
    this._token = ''; this._expiresAt = 0;
    this.setData({tokenAvailable: false, activeGrant: false, grantExpiry: ''});
  },
  editable() { return this.check() && this.data.statusLoaded && !this.data.loading && !this.data.busy; },
  async run(kind, operation, present) {
    if (!this.editable()) return;
    const request = ++this._request;
    this.setData({busy: kind, error: ''});
    try {
      const result = await operation();
      if (!this.check() || request !== this._request) return;
      present(result);
    } catch (error) {
      if (this.check() && request === this._request) this.setData({error: error.message || '操作未完成，请稍后重试。'});
    } finally {
      if (this.check() && request === this._request) this.setData({busy: ''});
    }
  },
  createGrant() {
    if (!this.editable() || !this.data.apiBaseUrl) return;
    this._token = ''; this.setData({tokenAvailable: false});
    return this.run('createGrant', () => grants.createGrant(), result => {
      this._token = result.token; this._expiresAt = result.expiresAt;
      this.setData({apiBaseUrl: result.apiBaseUrl, activeGrant: true, tokenAvailable: true, grantExpiry: timeLabel(result.expiresAt)});
    });
  },
  revokeGrant() {
    if (!this.editable() || !this.data.activeGrant) return;
    this._token = ''; this.setData({tokenAvailable: false});
    return this.run('revokeGrant', () => grants.revokeGrant(), () => this.clearGrant());
  },
  copyValue(data, title) {
    const request = this._request;
    wx.setClipboardData({data, success: () => {
      if (this.check() && request === this._request && wx.showToast) wx.showToast({title, icon: 'success'});
    }, fail: () => { if (this.check() && request === this._request) this.setData({error: '复制未完成，请重试。'}); }});
  },
  copyAddress(event) {
    if (!this.editable() || !this.data.apiBaseUrl) return;
    const format = event.currentTarget.dataset.format;
    if (format !== 'mcp' && format !== 'openapi') return;
    const origin = this.data.apiBaseUrl.split('/', 3).join('/');
    this.copyValue(origin + '/baby-bites-tools/' + (format === 'mcp' ? 'mcp' : 'openapi.json'), '地址已复制');
  },
  canCopySecret() {
    if (!this.editable() || !this._token || !this.data.apiBaseUrl) return false;
    if (this._expiresAt > Date.now()) return true;
    this.clearGrant();
    this.setData({error: '授权已到期，请重新生成。'});
    return false;
  },
  copyToken() {
    if (this.canCopySecret()) this.copyValue(this._token, '密钥已复制');
  },
  copyConfiguration() {
    if (!this.canCopySecret()) return;
    const data = JSON.stringify({url: this.data.apiBaseUrl + '/v1/feeding-context', method: 'GET',
      headers: {Authorization: 'Bearer ' + this._token}, query: {days: 7}}, null, 2);
    this.copyValue(data, '调用配置已复制');
  }
});
