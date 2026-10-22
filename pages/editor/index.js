const store = require('../../utils/store');
const { categories, textures } = require('../../utils/selectors');
const ui = require('../../utils/ui');

Page({
  data: {
    categories: categories.slice(1), textures, categoryIndex: 0, textureIndex: 0,
    ratingIndex: 0, ratingOptions: ['先收进菜谱，稍后记录喜好', '超级喜欢', '还不错', '不太喜欢'],
    form: { name: '', minutes: '20', ingredients: '', steps: '', note: '' },
    photo: '', saving: false, error: '', editing: false, missingRecipe: false
  },
  onLoad(options) {
    if (!options.id) return;
    const recipe = store.getRecipe(options.id);
    if (!recipe) { this.setData({ missingRecipe: true }); return; }
    this.original = recipe;
    wx.setNavigationBarTitle({ title: '编辑菜谱' });
    this.setData({
      editing: true,
      form: { name: recipe.name, minutes: String(recipe.minutes), ingredients: recipe.ingredients.map(item => item.name + (item.amount ? ' ' + item.amount : '')).join('\n'), steps: recipe.steps.join('\n'), note: recipe.note || '' },
      categoryIndex: this.data.categories.indexOf(recipe.category), textureIndex: textures.indexOf(recipe.texture), photo: recipe.photo || ''
    });
  },
  onUnload() { this.discardStagedPhoto(); },
  discardStagedPhoto() {
    if (!this.stagedPhotoPath) return;
    wx.getFileSystemManager().unlink({ filePath: this.stagedPhotoPath, fail() {} });
    this.stagedPhotoPath = '';
  },
  input(event) { if (!this.data.saving) this.setData({ ['form.' + event.currentTarget.dataset.field]: event.detail.value, error: '' }); },
  pick(event) { if (!this.data.saving) this.setData({ [event.currentTarget.dataset.field]: Number(event.detail.value) }); },
  choosePhoto() {
    if (this.data.saving) return;
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: result => {
        const file = result.tempFiles && result.tempFiles[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { ui.error(Error('请选择小于 2 MB 的照片')); return; }
        this.discardStagedPhoto();
        this.pendingPhoto = file.tempFilePath;
        this.setData({ photo: file.tempFilePath });
      },
      fail: error => { if (!String(error.errMsg).includes('cancel')) ui.error(Error('未能选择照片，请检查相册权限后重试')); }
    });
  },
  clearPhoto() {
    if (this.data.saving) return;
    this.discardStagedPhoto();
    this.pendingPhoto = null;
    this.setData({ photo: '' });
  },
  async save() {
    if (this.data.saving || this.data.missingRecipe) return;
    const form = this.data.form;
    const ingredients = form.ingredients.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { const parts = line.split(/\s+/); return { name: parts.shift(), amount: parts.join(' ') }; });
    const steps = form.steps.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!form.name.trim() || !ingredients.length || !steps.length) { this.setData({ error: '请填写菜谱名称、至少一种食材和制作步骤。' }); return; }
    const minutes = Number(form.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) { this.setData({ error: '烹饪时间请填写 1 至 480 分钟。' }); return; }
    this.setData({ saving: true, error: '' });
    try {
      let photo = this.data.photo;
      if (this.pendingPhoto) {
        const savedPath = await new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({ tempFilePath: this.pendingPhoto, success: result => resolve(result.savedFilePath), fail: reject }));
        this.stagedPhotoPath = savedPath;
        this.pendingPhoto = null;
        photo = savedPath;
        this.setData({ photo: savedPath });
      }
      const recipe = Object.assign({}, this.original || {}, {
        name: form.name.trim(), minutes, category: this.data.categories[this.data.categoryIndex], texture: textures[this.data.textureIndex], ingredients, steps, note: form.note.trim(), photo
      });
      store.saveRecipe(recipe, this.data.editing ? 0 : [0, 3, 2, 1][this.data.ratingIndex]);
      this.stagedPhotoPath = '';
      wx.showToast({ title: '已保存', icon: 'success' });
      ui.back();
    } catch (error) {
      // Keep a newly saved photo available when storage fails, so the same draft can be retried.
      this.setData({ error: error.message || '保存失败，请检查剩余存储空间后重试。' });
    } finally { this.setData({ saving: false }); }
  },
  cancel: ui.back
});
