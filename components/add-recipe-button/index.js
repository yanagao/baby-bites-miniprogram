Component({
  data: {
    addIcon: {name: '/assets/icons/plus-white.png', size: '56rpx'},
    buttonProps: {size: 'large', theme: 'primary', shape: 'circle'}
  },
  methods: {
    add() { wx.navigateTo({url: '/pages/editor/index'}); }
  }
});
