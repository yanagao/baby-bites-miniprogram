const {normalizeIngredient} = require('../../utils/selectors');
const sheets = [
  {
    src: '/assets/cute/ingredients-sprite.png', columns: 3, rows: 3,
    names: ['南瓜','小米','鸡蛋','鸡肉','土豆','西兰花','胡萝卜','面条','豆腐'],
    // Visible artwork bounds: horizontal center, bottom, top within each cell.
    anchors: [[0.5657,0.9108,0.3756],[0.5047,0.9014,0.4319],[0.4718,0.9155,0.4225],
      [0.5561,0.7664,0.3380],[0.5047,0.7757,0.3192],[0.4812,0.8271,0.2629],
      [0.5563,0.7136,0.1033],[0.5070,0.6854,0.1596],[0.4906,0.6854,0.1784]]
  },
  {
    src: '/assets/cute/ingredients-extra-sprite.png', columns: 3, rows: 4,
    names: ['番茄','菠菜','山药','牛肉','三文鱼','大米','面粉','红枣','香蕉','燕麦'],
    anchors: [[0.5267,0.9467,0.4733],[0.5500,0.9800,0.4200],[0.5100,0.9533,0.5467],
      [0.5200,0.8800,0.4667],[0.5167,0.8933,0.4867],[0.5033,0.9200,0.4267],
      [0.5300,0.8133,0.3267],[0.5133,0.7800,0.3933],[0.5067,0.8000,0.3133],[0.5267,0.6800,0.2333]]
  }
];
Component({
  properties: {name: {type: String, value: ''}, size: {type: Number, value: 80}, alignToLabel: {type: Boolean, value: false}},
  data: {column: 0, row: 0, columns: 3, rows: 3, spriteSrc: '', matched: false, offsetX: 0, offsetY: 0},
  observers: {'name': function(name) {
    const normalized = normalizeIngredient(name);
    for (const sheet of sheets) {
      const index = sheet.names.findIndex(value => normalized.includes(value));
      if (index < 0) continue;
      this.setData({matched: true, spriteSrc: sheet.src, columns: sheet.columns, rows: sheet.rows,
        column: index % sheet.columns, row: Math.floor(index / sheet.columns),
        offsetX: 0.5 - sheet.anchors[index][0],
        offsetY: 0.32 - (sheet.anchors[index][1] + sheet.anchors[index][2]) / 2});
      return;
    }
    this.setData({matched: false, spriteSrc: '', column: 0, row: 0, columns: 3, rows: 3, offsetX: 0, offsetY: 0});
  }}
});
