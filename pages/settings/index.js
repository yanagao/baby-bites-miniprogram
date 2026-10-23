const store = require('../../utils/store');
const backup = require('../../utils/backup');
const {stats} = require('../../utils/selectors');
const ui = require('../../utils/ui');
const cloudSync = require('../../utils/cloud-sync');

const syncTitles = {unconfigured: '云同步未启用', syncing: '正在同步', synced: '已同步', pending: '等待同步', error: '同步未完成'};
function syncView(status) {
  const date = status.lastSyncedAt && new Date(status.lastSyncedAt);
  const time = date ? [date.getMonth() + 1, date.getDate()].join('/') + ' ' +
    [date.getHours(), date.getMinutes()].map(value => String(value).padStart(2, '0')).join(':') : '';
  return {syncState: status.state, syncTitle: syncTitles[status.state] || '等待同步', syncMessage: status.message,
    syncTime: time ? '上次同步 ' + time : '',
    storageDescription: status.state === 'synced' ? '已保存到当前微信账号。使用同一微信账号可在其他设备继续使用。' :
      status.state === 'unconfigured' ? '云同步尚未启用，数据保存在本机。换设备前请导出备份。' :
        '数据已保存在本机；同步完成后，可在同一微信账号的其他设备读取。'};
}

const errorReason = error => String(error && (error.message || error.errMsg) || '');
const cancelled = error => /cancel/i.test(errorReason(error));

function exportMethod() {
  let platform = '';
  try { if (wx.getDeviceInfo) platform = wx.getDeviceInfo().platform; } catch (error) {}
  const method = ['mac', 'windows'].includes(platform) ? 'saveFileToDisk' : 'shareFileMessage';
  return typeof wx[method] === 'function' ? method : '';
}

function exportError(error) {
  const reason = errorReason(error);
  if (/user TAP gesture/i.test(reason)) return '请重新导出，并点击「分享备份文件」完成保存。';
  if (/开发者工具.*不支持/.test(reason)) return '开发者工具不支持文件分享，请在手机微信中导出，或使用「其他备份方式 → 复制备份内容」。';
  if (/not support|unsupported|not available|不支持/i.test(reason)) return '当前环境不支持文件导出，请在手机微信中操作，或使用「复制备份内容」。';
  return error && error.message || (reason ? '导出未完成：' + reason : '导出未完成，请重试。');
}

Page({
  data: {
    nickname: '宝宝', counts: {}, warning: '', backupText: '', showPaste: false, busy: false, error: '',
    syncState: 'pending', syncTitle: '等待同步', syncMessage: '', syncTime: '', storageDescription: '',
    importVisible: false, importConfirmButton: {content: '合并导入', theme: 'primary'},
    exportVisible: false, exportDescription: '', exportConfirmButton: {content: '分享备份文件', theme: 'primary'}
  },
  onLoad() {
    this._draftOwner = store.getSyncInfo().owner;
    this._unsubscribeSync = cloudSync.subscribe(status => { if (!this._disposed) this.setData(syncView(status)); });
    this._unsubscribeStore = store.subscribe(info => {
      if (!this._draftOwner && info.owner) this._draftOwner = info.owner;
      if (!this._disposed) this.refresh();
    });
  },
  onShow() { this.refresh(); this.setData(syncView(cloudSync.getStatus())); },
  onUnload() {
    this._disposed = true;
    if (this._unsubscribeSync) this._unsubscribeSync();
    if (this._unsubscribeStore) this._unsubscribeStore();
    if (this.resolveImportConfirmation) this.resolveImportConfirmation(false);
    this.resolveImportConfirmation = null;
    const filePath = this._exportFilePath;
    this._exportFilePath = '';
    if (filePath) return backup.removeFile(filePath);
  },
  assertDraftAccount() {
    if (this._disposed) throw Error('页面已关闭，请重新打开设置后再操作。');
    const owner = store.getSyncInfo().owner;
    if (this._draftOwner && this._draftOwner !== owner) throw Error('微信账号已切换，请重新打开设置后再操作。');
    if (!this._draftOwner && owner) this._draftOwner = owner;
  },
  refresh() {
    const state = store.getState();
    const next = {counts: stats(state), warning: store.getWarning()};
    if (!this._nicknameDirty) next.nickname = state.nickname || '宝宝';
    this.setData(next);
  },
  nickname(event) { if (!this.data.busy) { this._nicknameDirty = true; this.setData({nickname: event.detail.value}); } },
  syncNow() { return cloudSync.syncNow(); },
  saveNickname() {
    if (this.data.busy) return;
    try { this.assertDraftAccount(); store.setNickname(this.data.nickname.trim() || '宝宝'); this._nicknameDirty = false; this.refresh(); wx.showToast({title: '已保存', icon: 'success'}); }
    catch (error) { ui.error(error); }
  },
  togglePaste() { if (!this.data.busy) this.setData({showPaste: !this.data.showPaste, error: ''}); },
  inputBackup(event) { if (!this.data.busy) this.setData({backupText: event.detail.value, error: ''}); },
  async exportBackup() {
    if (this.data.busy || this.data.exportVisible || this._disposed) return;
    this.setData({busy: true, error: ''});
    let filePath = '';
    try {
      this.assertDraftAccount();
      const method = exportMethod();
      if (!method) throw Error('当前微信版本不支持文件导出，请更新微信，或使用「复制备份内容」。');
      filePath = await backup.exportFile();
      if (this._disposed) return;
      this.assertDraftAccount();
      this._exportFilePath = filePath;
      this._exportMethod = method;
      filePath = '';
      const disk = method === 'saveFileToDisk';
      this.setData({
        exportVisible: true,
        exportDescription: disk ? '菜谱、照片和用餐记录已打包，接下来选择保存位置。' : '菜谱、照片和用餐记录已打包，接下来选择微信聊天保存这份备份。',
        exportConfirmButton: {content: disk ? '保存到电脑' : '分享备份文件', theme: 'primary'}
      });
    } catch (error) {
      if (!this._disposed && !cancelled(error)) this.setData({error: exportError(error)});
    } finally {
      if (filePath) await backup.removeFile(filePath);
      if (!this._disposed) this.setData({busy: false});
    }
  },
  confirmExportDialog() {
    if (this.data.busy || !this._exportFilePath || this._disposed) return Promise.resolve();
    try { this.assertDraftAccount(); }
    catch (error) {
      const filePath = this._exportFilePath;
      this._exportFilePath = '';
      this.setData({exportVisible: false, error: error.message});
      return backup.removeFile(filePath);
    }
    const filePath = this._exportFilePath;
    const method = this._exportMethod;
    // The system API must run synchronously in this new tap, before any async work.
    this._exportFilePath = '';
    this.setData({busy: true, exportVisible: false, error: ''});
    return new Promise((resolve, reject) => {
      const options = {filePath, success: resolve, fail: reject};
      if (method === 'shareFileMessage') options.fileName = filePath.split('/').pop();
      wx[method](options);
    }).then(() => {
      if (!this._disposed) wx.showToast({title: method === 'saveFileToDisk' ? '备份已保存' : '备份已分享', icon: 'success'});
    }, error => {
      if (!this._disposed && !cancelled(error)) this.setData({error: exportError(error)});
    }).finally(async () => {
      await backup.removeFile(filePath);
      if (!this._disposed) this.setData({busy: false});
    });
  },
  async cancelExportDialog() {
    if (this.data.busy) return;
    const filePath = this._exportFilePath;
    this._exportFilePath = '';
    if (!this._disposed) this.setData({busy: true, exportVisible: false});
    if (filePath) await backup.removeFile(filePath);
    if (!this._disposed) this.setData({busy: false});
  },
  async chooseBackup() {
    if (this.data.busy) return;
    this.setData({busy: true, error: ''});
    try {
      this.assertDraftAccount();
      const result = await new Promise((resolve, reject) => wx.chooseMessageFile({count: 1, type: 'file', extension: ['json'], success: resolve, fail: reject}));
      this.assertDraftAccount();
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.path) throw Error('没有选中备份文件，请重新选择。');
      if (file.size > 20 * 1024 * 1024) throw Error('请选择 20 MB 以内的 JSON 备份文件。');
      await this.loadFile(file.path);
    } catch (error) {
      if (!this._disposed && !cancelled(error)) this.setData({error: error.message || '未能读取备份文件，可使用「粘贴备份内容」。'});
    } finally { if (!this._disposed) this.setData({busy: false}); }
  },
  async loadFile(filePath) {
    this.assertDraftAccount();
    let text;
    try { text = await backup.read(filePath, 'utf8'); }
    catch (error) { throw Error('文件读取失败，请重新选择 JSON 备份。'); }
    this.assertDraftAccount();
    if (typeof text !== 'string') throw Error('文件读取失败，请重新选择 JSON 备份。');
    // Keep image-heavy JSON off the view bridge; confirmation imports this captured file text.
    await this.importAfterConfirmation(text);
  },
  async confirmImport() {
    if (this.data.busy) return;
    const text = this.data.backupText.trim();
    if (!text) { this.setData({error: '请先选择备份文件或粘贴备份内容。'}); return; }
    this.setData({busy: true, error: ''});
    try { await this.importAfterConfirmation(text); }
    catch (error) { if (!this._disposed) this.setData({error: error.message || '导入未完成，本机记录未修改。'}); }
    finally { if (!this._disposed) this.setData({busy: false}); }
  },
  async importAfterConfirmation(text) {
    this.assertDraftAccount();
    const confirmed = await new Promise(resolve => {
      this.resolveImportConfirmation = resolve;
      this.setData({importVisible: true});
    });
    if (!confirmed) return;
    this.assertDraftAccount();
    await backup.importText(text, () => this.assertDraftAccount());
    if (this._disposed) return;
    this.setData({backupText: '', showPaste: false});
    this.refresh();
    wx.showToast({title: '已合并导入', icon: 'success'});
  },
  confirmImportDialog() {
    const resolve = this.resolveImportConfirmation;
    this.resolveImportConfirmation = null;
    this.setData({importVisible: false});
    if (resolve) resolve(true);
  },
  cancelImportDialog() {
    const resolve = this.resolveImportConfirmation;
    this.resolveImportConfirmation = null;
    this.setData({importVisible: false});
    if (resolve) resolve(false);
  },
  async copyBackup() {
    if (this.data.busy) return;
    this.setData({busy: true, error: ''});
    try {
      this.assertDraftAccount();
      const text = await backup.exportText();
      this.assertDraftAccount();
      await new Promise((resolve, reject) => wx.setClipboardData({data: text, success: resolve, fail: reject}));
    } catch (error) { if (!this._disposed) this.setData({error: error.message || '复制失败，请使用导出备份文件。'}); }
    finally { if (!this._disposed) this.setData({busy: false}); }
  }
});
