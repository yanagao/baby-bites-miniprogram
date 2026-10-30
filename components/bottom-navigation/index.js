const {syncCurrentTabBar} = require('../../utils/tab-bar');

Component({
  data: {
    value: '',
    items: [
      {value:'/pages/home/index',label:'首页',icon:'home'},
      {value:'/pages/discover/index',label:'发现',icon:'book-open'},
      {value:'add',label:'添加',icon:{name:'add-circle-filled',size:'56rpx',color:'#73c6e8'}},
      {value:'/pages/records/index',label:'记录',icon:'calendar'},
      {value:'/pages/mine/index',label:'我的',icon:'user'}
    ]
  },
  lifetimes: {
    attached() { this.syncRoute(); },
    ready() { this.syncRoute(); }
  },
  pageLifetimes: {show() { this.syncRoute(); }},
  methods: {
    setActiveRoute(value) {
      if (value !== 'add' && value !== this.data.value && this.data.items.some(item => item.value === value)) {
        this.setData({value});
      }
    },
    syncRoute: syncCurrentTabBar,
    change(event) {
      const value = event.detail.value;
      if (!this.data.items.some(item => item.value === value)) return;
      if (value === 'add') {
        if (this._openingEditor) return;
        this._openingEditor = true;
        wx.navigateTo({url:'/pages/editor/index', complete: () => { this._openingEditor = false; syncCurrentTabBar(); }});
        return;
      }
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
