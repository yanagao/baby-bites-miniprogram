const {syncCurrentTabBar} = require('../../utils/tab-bar');

Component({
  data: {
    value: '',
    items: [
      {value:'/pages/home/index',label:'今天',icon:'home'},
      {value:'/pages/ingredients/index',label:'食材',icon:'broccoli'},
      {value:'/pages/recipes/index',label:'食谱',icon:'book-open'},
      {value:'/pages/records/index',label:'记录',icon:'calendar'}
    ]
  },
  lifetimes: {
    attached() { this.syncRoute(); },
    ready() { this.syncRoute(); }
  },
  pageLifetimes: {show() { this.syncRoute(); }},
  methods: {
    setActiveRoute(value) {
      if (value !== this.data.value && this.data.items.some(item => item.value === value)) {
        this.setData({value});
      }
    },
    syncRoute: syncCurrentTabBar,
    change(event) {
      const value = event.detail.value;
      if (!this.data.items.some(item => item.value === value)) return;
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      if (page && value === '/' + page.route) {
        syncCurrentTabBar();
        return;
      }
      wx.switchTab({url: value, success: syncCurrentTabBar, fail: syncCurrentTabBar});
    }
  }
});
