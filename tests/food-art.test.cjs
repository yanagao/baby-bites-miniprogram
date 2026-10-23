'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selectors = require('../utils/selectors');

function harness() {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/food-art/index.js'), 'utf8'), {
    Component: value => { definition = value; }, require: () => selectors
  });
  const instance = {data: {...definition.data}, setData(value) {Object.assign(this.data, value);}};
  return name => {
    definition.observers.name.call(instance, name);
    return {...instance.data};
  };
}

test('all nineteen illustrated foods resolve to their distinct sprite cells', () => {
  const render = harness();
  const sheets = [
    {src: '/assets/cute/ingredients-sprite.png', rows: 3,
      names: ['南瓜','小米','鸡蛋','鸡肉','土豆','西兰花','胡萝卜','面条','豆腐']},
    {src: '/assets/cute/ingredients-extra-sprite.png', rows: 4,
      names: ['番茄','菠菜','山药','牛肉','三文鱼','大米','面粉','红枣','香蕉','燕麦']}
  ];
  const cells = new Set();
  for (const sheet of sheets) {
    sheet.names.forEach((name, index) => {
      const data = render(name);
      assert.equal(data.matched, true, name);
      assert.equal(data.spriteSrc, sheet.src, name);
      assert.equal(data.rows, sheet.rows, name);
      assert.equal(data.columns, 3, name);
      assert.equal(data.column, index % 3, name);
      assert.equal(data.row, Math.floor(index / 3), name);
      cells.add([data.spriteSrc, data.row, data.column].join(':'));
    });
  }
  assert.equal(cells.size, 19);
});

test('ingredient aliases use the same artwork and unknown names clear previous artwork', () => {
  const render = harness();
  for (const [alias, name] of [['西红柿','番茄'], ['燕麦片','燕麦'], ['红枣肉','红枣'],
    ['马铃薯','土豆'], ['鸡胸肉','鸡肉'], ['鸡腿肉','鸡肉'], ['红萝卜','胡萝卜']]) {
    assert.deepEqual(render(' ' + alias + ' '), render(name), alias);
  }
  assert.deepEqual(render('南瓜泥'), render('南瓜'), 'preserves existing compound-name matching');
  for (const name of ['冬瓜', '', null, 'constructor']) {
    render('燕麦');
    const data = render(name);
    assert.equal(data.matched, false);
    assert.equal(data.spriteSrc, '');
    assert.equal(data.row, 0);
    assert.equal(data.column, 0);
  }
});
