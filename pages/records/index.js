const {syncTabBar} = require('../../utils/tab-bar');
const store = require('../../utils/store');
const selectors = require('../../utils/selectors');

Page({
  data: {
    warning: '', stats: {}, logs: [], filter: 'all',
    filters: [{ value: 'all', name: '全部记录' }, { value: '3', name: '超级喜欢' }, { value: '2', name: '还不错' }, { value: '1', name: '不太喜欢' }]
  },
  onShow() { syncTabBar(this); this.refresh(); },
  onReady() { syncTabBar(this); },
  refresh() {
    try {
      const state = store.getState();
      const logs = selectors.listLogs(state, this.data.filter).map(log => {
        const rating = selectors.ratings[log.rating] || { name: '未记录', icon: 'heart' };
        return Object.assign({}, log, { ratingName: rating.name, ratingIcon: rating.icon, ratingTone: log.rating === 3 ? 'blue' : log.rating === 2 ? 'green' : 'brown' });
      });
      this.setData({ logs, stats: selectors.stats(state), warning: store.getWarning() });
    } catch (error) { wx.showToast({ title: error.message || '暂时无法读取记录', icon: 'none' }); }
  },
  chooseFilter(event) { const filter = String(event.detail.value); if (!this.data.filters.some(item => item.value === filter)) return; this.setData({ filter }); this.refresh(); },
  goRecipes() { wx.switchTab({ url: '/pages/recipes/index' }); },
  openRecipe(event) { wx.navigateTo({ url: '/pages/detail/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  deleteLog(event) {
    const id = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这条记录？', content: '这次试吃记录将被移除，菜谱会保留。', confirmText: '删除记录', confirmColor: '#c44747', cancelText: '保留',
      success: result => {
        if (!result.confirm) return;
        try { store.deleteLog(id); this.refresh(); wx.showToast({ title: '记录已删除', icon: 'none' }); }
        catch (error) { wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' }); }
      }
    });
  }
});
