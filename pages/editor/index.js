const store = require('../../utils/store');
const { categories, textures } = require('../../utils/selectors');
const recipeAges = require('../../utils/recipe-ages');
const ui = require('../../utils/ui');
const ageGroupFields = values => ({
  ageGroups: values,
  ageGroupOptions: recipeAges.ageGroups.map(group => ({...group, selected: values.includes(group.value)}))
});

Page({
  data: {
    categories: categories.slice(1), textures, categoryIndex: 0, textureIndex: 0,
    ...ageGroupFields([]), ageGroupsDirty: false,
    pickerVisible: false, pickerField: '', pickerTitle: '', pickerOptions: [], pickerValue: [],
    recordMeal: false, rating: 0,
    ratingOptions: [{ label: '不太喜欢', value: 1 }, { label: '还不错', value: 2 }, { label: '很喜欢', value: 3 }],
    form: { name: '', minutes: '20', ingredients: '', steps: '', note: '' },
    photo: '', saving: false, error: '', editing: false, missingRecipe: false,
    nameError: '', minutesError: '', ingredientsError: '', stepsError: '', ratingError: '',
    discardVisible: false
  },
  onLoad(options = {}) {
    this._draftOwner = store.getSyncInfo().owner;
    this._unsubscribeAccount = store.subscribe(info => {
      if (!this._draftOwner && info.owner) this._draftOwner = info.owner;
    });
    if (options.id) {
      const recipe = store.getRecipe(options.id);
      if (!recipe) { this.setData({ missingRecipe: true }); return; }
      this.original = recipe;
      wx.setNavigationBarTitle({ title: '编辑菜谱' });
      this.setData({
        editing: true,
        form: {
          name: recipe.name, minutes: String(recipe.minutes),
          ingredients: recipe.ingredients.map(item => item.name + (item.amount ? ' ' + item.amount : '')).join('\n'),
          steps: recipe.steps.join('\n'), note: recipe.note || ''
        },
        categoryIndex: this.data.categories.indexOf(recipe.category),
        textureIndex: textures.indexOf(recipe.texture), photo: recipe.photo || '',
        ...ageGroupFields(recipeAges.recipeAgeGroups(recipe))
      });
    }
    this.initialAgeGroups = this.data.ageGroups.slice();
    this.initialDraft = this.draftSnapshot();
  },
  onUnload() {
    if (this._unsubscribeAccount) this._unsubscribeAccount();
    this.discardStagedPhoto();
  },
  assertDraftAccount() {
    const owner = store.getSyncInfo().owner;
    if (this._draftOwner && this._draftOwner !== owner) throw Error('微信账号已切换，请重新打开菜谱编辑页后再保存。');
    if (!this._draftOwner && owner) this._draftOwner = owner;
  },
  draftSnapshot() {
    return JSON.stringify({
      form: this.data.form, categoryIndex: this.data.categoryIndex,
      textureIndex: this.data.textureIndex, photo: this.data.photo, ageGroups: this.data.ageGroups,
      recordMeal: this.data.recordMeal, rating: this.data.recordMeal ? this.data.rating : 0
    });
  },
  updateUnsavedAlert() {
    const dirty = this.initialDraft !== undefined && this.draftSnapshot() !== this.initialDraft;
    if (dirty === Boolean(this.alertEnabled)) return;
    this.alertEnabled = dirty;
    if (dirty && typeof wx.enableAlertBeforeUnload === 'function') {
      wx.enableAlertBeforeUnload({ message: '菜谱尚未保存，返回将丢弃本次修改。', fail() {} });
    } else if (!dirty && typeof wx.disableAlertBeforeUnload === 'function') {
      wx.disableAlertBeforeUnload({ fail() {} });
    }
  },
  leave() {
    this.alertEnabled = false;
    if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload({ complete: () => ui.back() });
    else ui.back();
  },
  discardStagedPhoto() {
    if (!this.stagedPhotoPath) return;
    wx.getFileSystemManager().unlink({ filePath: this.stagedPhotoPath, fail() {} });
    this.stagedPhotoPath = '';
  },
  input(event) {
    if (this.data.saving) return;
    const field = event.currentTarget.dataset.field;
    if (!Object.prototype.hasOwnProperty.call(this.data.form, field)) return;
    this.setData({ ['form.' + field]: event.detail.value, [field + 'Error']: '', error: '' });
    this.updateUnsavedAlert();
  },
  toggleAgeGroup(event) {
    if (this.data.saving || this.data.missingRecipe) return;
    try { this.assertDraftAccount(); }
    catch (error) { this.setData({error: error.message}); return; }
    const value = event.currentTarget && event.currentTarget.dataset.value;
    if (!recipeAges.ageGroups.some(group => group.value === value)) return;
    const values = recipeAges.normalizeAgeGroups(this.data.ageGroups.includes(value)
      ? this.data.ageGroups.filter(group => group !== value) : this.data.ageGroups.concat(value));
    this.setData({...ageGroupFields(values), ageGroupsDirty: JSON.stringify(values) !== JSON.stringify(this.initialAgeGroups || []), error: ''});
    this.updateUnsavedAlert();
  },
  openPicker(event) {
    if (this.data.saving) return;
    const field = event.currentTarget.dataset.field;
    const values = field === 'categoryIndex' ? this.data.categories : field === 'textureIndex' ? this.data.textures : null;
    if (!values) return;
    this.setData({
      pickerField: field, pickerTitle: field === 'categoryIndex' ? '菜谱分类' : '食物口感',
      pickerOptions: values.map((label, value) => ({ label, value })),
      pickerValue: [this.data[field]], pickerVisible: true
    });
  },
  pick(event) {
    if (this.data.saving) return;
    const field = this.data.pickerField;
    const values = field === 'categoryIndex' ? this.data.categories : field === 'textureIndex' ? this.data.textures : null;
    const value = Number(Array.isArray(event.detail.value) ? event.detail.value[0] : event.detail.value);
    if (!values || !Number.isInteger(value) || value < 0 || value >= values.length) return;
    this.setData({ [field]: value, pickerVisible: false, error: '' });
    this.updateUnsavedAlert();
  },
  closePicker() { this.setData({ pickerVisible: false }); },
  toggleRecordMeal(event) {
    if (this.data.saving || this.data.editing) return;
    this.setData({ recordMeal: Boolean(event.detail.value), ratingError: '', error: '' });
    this.updateUnsavedAlert();
  },
  rate(event) {
    if (this.data.saving) return;
    const rating = Number(event.detail.value);
    if (![1, 2, 3].includes(rating)) return;
    this.setData({ rating, ratingError: '', error: '' });
    this.updateUnsavedAlert();
  },
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
        this.setData({ photo: file.tempFilePath, error: '' });
        this.updateUnsavedAlert();
      },
      fail: error => { if (!String(error.errMsg).includes('cancel')) ui.error(Error('未能选择照片，请检查相册权限后重试')); }
    });
  },
  previewPhoto() {
    if (this.data.photo) wx.previewImage({ current: this.data.photo, urls: [this.data.photo] });
  },
  clearPhoto() {
    if (this.data.saving) return;
    this.discardStagedPhoto();
    this.pendingPhoto = null;
    this.setData({ photo: '', error: '' });
    this.updateUnsavedAlert();
  },
  async save() {
    if (this.data.saving || this.data.missingRecipe) return;
    try { this.assertDraftAccount(); }
    catch (error) { this.setData({error: error.message}); return; }
    const form = this.data.form;
    const ingredients = form.ingredients.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      return { name: parts.shift(), amount: parts.join(' ') };
    });
    const steps = form.steps.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const minutes = Number(form.minutes);
    const validation = {
      nameError: !form.name.trim() ? '请填写菜谱名称' : '',
      minutesError: !Number.isFinite(minutes) || minutes < 1 || minutes > 480 ? '请填写 1 至 480 分钟' : '',
      ingredientsError: !ingredients.length ? '请至少填写一种食材' : ingredients.length > 50 || ingredients.some(item => item.name.length > 80 || item.amount.length > 80) ? '最多填写 50 种食材，每项名称和用量不超过 80 字' : '',
      stepsError: !steps.length ? '请填写做法' : steps.length > 30 || steps.some(step => step.length > 2000) ? '最多填写 30 步，每步不超过 2000 字' : '',
      ratingError: this.data.recordMeal && !this.data.editing && ![1, 2, 3].includes(this.data.rating) ? '请选择本次喜好' : ''
    };
    this.setData(Object.assign({ error: '' }, validation));
    if (Object.values(validation).some(Boolean)) return;
    this.setData({ saving: true });
    try {
      let photo = this.data.photo;
      if (this.pendingPhoto) {
        const savedPath = await new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({
          tempFilePath: this.pendingPhoto, success: result => resolve(result.savedFilePath), fail: reject
        }));
        this.stagedPhotoPath = savedPath;
        this.pendingPhoto = null;
        photo = savedPath;
        this.setData({ photo: savedPath });
      }
      const recipe = Object.assign({}, this.original || {}, {
        name: form.name.trim(), minutes, category: this.data.categories[this.data.categoryIndex],
        texture: textures[this.data.textureIndex], ingredients, steps, note: form.note.trim(), photo
      });
      if (this.data.ageGroupsDirty) recipe.ageGroups = recipeAges.normalizeAgeGroups(this.data.ageGroups);
      else delete recipe.ageGroups;
      this.assertDraftAccount();
      store.saveRecipe(recipe, !this.data.editing && this.data.recordMeal ? this.data.rating : 0);
      this.stagedPhotoPath = '';
      this.initialDraft = this.draftSnapshot();
      wx.showToast({ title: '菜谱已保存', icon: 'success' });
      this.leave();
    } catch (error) {
      // Retain a newly saved photo when storage fails, so the complete draft can be retried.
      this.setData({ error: error.message || '保存失败，请检查剩余存储空间后重试。' });
    } finally { this.setData({ saving: false }); }
  },
  cancel() {
    if (this.data.saving) return;
    if (this.initialDraft !== undefined && this.draftSnapshot() !== this.initialDraft) this.setData({ discardVisible: true });
    else this.leave();
  },
  continueEditing() { this.setData({ discardVisible: false }); },
  discard() { this.setData({ discardVisible: false }); this.leave(); }
});
