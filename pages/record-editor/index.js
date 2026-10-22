const store = require('../../utils/store');
const {today} = require('../../utils/selectors');
const ui = require('../../utils/ui');

Page({
  data: {
    recipe: null, rating: 0,
    ratingOptions: [{label: '不太喜欢', value: 1}, {label: '还不错', value: 2}, {label: '超级喜欢', value: 3}],
    date: today(), maxDate: today(), portions: ['暂不记录', '尝了几口', '吃了一半', '吃了大半', '光盘啦'],
    portionIndex: 0, note: '', error: '', saving: false
  },
  onLoad(options) { this.recipeId = options.id; this.setData({recipe: store.getRecipe(options.id)}); },
  rate(event) {
    if (this.data.saving) return;
    const rating = Number(event.detail.value);
    if ([1, 2, 3].includes(rating)) this.setData({rating, error: ''});
  },
  changeDate(event) { if (!this.data.saving) this.setData({date: event.detail.value}); },
  portion(event) { if (!this.data.saving) this.setData({portionIndex: Number(event.detail.value)}); },
  note(event) { if (!this.data.saving) this.setData({note: event.detail.value}); },
  save() {
    if (this.data.saving) return;
    if (!this.data.rating) { this.setData({error: '请选择宝宝这次的喜爱程度。'}); return; }
    this.setData({saving: true});
    try {
      store.addLog({recipeId: this.recipeId, rating: this.data.rating, date: this.data.date,
        portion: this.data.portionIndex ? this.data.portions[this.data.portionIndex] : '', note: this.data.note.trim()});
      wx.showToast({title: '已记录', icon: 'success'});
      ui.back();
    } catch (error) { this.setData({error: error.message || '记录未保存，请重试'}); }
    finally { this.setData({saving: false}); }
  },
  back: ui.back
});
