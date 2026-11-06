const {getBuiltInRecipe} = require('../../utils/recipe-origin');
const {withCover, getCover} = require('../../utils/recipe-covers');
const {findRecipeAllergens} = require('../../utils/allergies');
const store = require('../../utils/store');
const ui = require('../../utils/ui');

Page({
  data: {recipe: null, error: '', photoFailed: false, allergyWarning: ''},
  onLoad(options = {}) {
    this._unloaded = false;
    this.recipeId = options.id || '';
    // Shared starter recipes come only from the bundled catalog, even if the
    // recipient edited or removed their own copy. No private snapshot is shared.
    const recipe = getBuiltInRecipe(this.recipeId);
    this.setData({recipe: recipe ? withCover(recipe) : null,
      error: recipe ? '' : '这道内置菜谱暂时无法查看，请更新小程序后重试。'});
    const method = recipe ? 'showShareMenu' : 'hideShareMenu';
    if (wx[method]) wx[method]({menus: ['shareAppMessage']});
  },
  onShow() { this.refreshAllergies(); },
  refreshAllergies() {
    if (this._unloaded || !this.data.recipe) return;
    const matched = findRecipeAllergens(this.data.recipe, store.getState().allergies || []);
    const allergyWarning = matched.length ? '含已记录的过敏食材：' + matched.join('、') + '，请勿给宝宝食用。' : '';
    if (allergyWarning !== this.data.allergyWarning) this.setData({allergyWarning});
  },
  photoError() { this.setData({photoFailed: true}); },
  onUnload() { this._unloaded = true; },
  onShareAppMessage() {
    const recipe = !this._unloaded && getBuiltInRecipe(this.recipeId);
    return recipe ? {title: recipe.name + ' · 口袋食谱',
      path: '/pages/builtin-recipe/index?id=' + encodeURIComponent(recipe.id), imageUrl: getCover(recipe) || '/assets/cute/pocket-mascot.png'} :
      {title: '小口袋 · 今天辅食吃什么', path: '/pages/home/index', imageUrl: '/assets/cute/pocket-mascot.png'};
  },
  back: ui.back
});
