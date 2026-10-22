const store = require('../../utils/store');
const backup = require('../../utils/backup');
const {stats} = require('../../utils/selectors');
const ui = require('../../utils/ui');

const cancelled = error => String(error && error.errMsg || '').includes('cancel');

Page({
  data: {nickname: '宝宝', counts: {}, warning: '', backupText: '', showPaste: false, busy: false, error: ''},
  onShow() { this.refresh(); },
  refresh() {
    const state = store.getState();
    this.setData({nickname: state.nickname || '宝宝', counts: stats(state), warning: store.getWarning()});
  },
  nickname(event) { if (!this.data.busy) this.setData({nickname: event.detail.value}); },
  saveNickname() {
    if (this.data.busy) return;
    try { store.setNickname(this.data.nickname.trim() || '宝宝'); this.refresh(); wx.showToast({title: '已保存', icon: 'success'}); }
    catch (error) { ui.error(error); }
  },
  togglePaste() { if (!this.data.busy) this.setData({showPaste: !this.data.showPaste, error: ''}); },
  inputBackup(event) { if (!this.data.busy) this.setData({backupText: event.detail.value, error: ''}); },
  async exportBackup() {
    if (this.data.busy) return;
    this.setData({busy: true, error: ''});
    let filePath = '';
    try {
      if (wx.shareFileMessage) {
        filePath = await backup.exportFile();
        await new Promise((resolve, reject) => wx.shareFileMessage({filePath, fileName: filePath.split('/').pop(), success: resolve, fail: reject}));
      } else {
        const text = await backup.exportText();
        await new Promise((resolve, reject) => wx.setClipboardData({data: text, success: resolve, fail: reject}));
        wx.showToast({title: '备份已复制，请保存到文件', icon: 'none'});
      }
    } catch (error) {
      if (!cancelled(error)) this.setData({error: error.message || '导出未完成，请重试。'});
    } finally {
      if (filePath) await backup.removeFile(filePath);
      this.setData({busy: false});
    }
  },
  async chooseBackup() {
    if (this.data.busy) return;
    this.setData({busy: true, error: ''});
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMessageFile({count: 1, type: 'file', extension: ['json'], success: resolve, fail: reject}));
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.path) throw Error('没有选中备份文件，请重新选择。');
      if (file.size > 20 * 1024 * 1024) throw Error('请选择 20 MB 以内的 JSON 备份文件。');
      await this.loadFile(file.path);
    } catch (error) {
      if (!cancelled(error)) this.setData({error: error.message || '未能读取备份文件，可使用「粘贴备份内容」。'});
    } finally { this.setData({busy: false}); }
  },
  async loadFile(filePath) {
    let text;
    try { text = await backup.read(filePath, 'utf8'); }
    catch (error) { throw Error('文件读取失败，请重新选择 JSON 备份。'); }
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
    catch (error) { this.setData({error: error.message || '导入未完成，本机记录未修改。'}); }
    finally { this.setData({busy: false}); }
  },
  async importAfterConfirmation(text) {
    const result = await new Promise((resolve, reject) => wx.showModal({
      title: '合并这份备份？', content: '将菜谱和喜好记录合并到本机；相同内容保留较新的修改。',
      confirmText: '合并导入', success: resolve, fail: reject
    }));
    if (!result.confirm) return;
    await backup.importText(text);
    this.setData({backupText: '', showPaste: false});
    this.refresh();
    wx.showToast({title: '已合并导入', icon: 'success'});
  },
  async copyBackup() {
    if (this.data.busy) return;
    this.setData({busy: true, error: ''});
    try {
      const text = await backup.exportText();
      await new Promise((resolve, reject) => wx.setClipboardData({data: text, success: resolve, fail: reject}));
    } catch (error) { this.setData({error: error.message || '复制失败，请使用导出备份文件。'}); }
    finally { this.setData({busy: false}); }
  }
});
