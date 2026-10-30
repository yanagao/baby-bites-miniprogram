const {getProfileAvatar} = require('../../utils/profile-avatar');

Component({
  properties: {
    recipe: {type: Object, value: null},
    showAuthor: {type: Boolean, value: false},
    showVisibility: {type: Boolean, value: false}
  },
  data: {imageSource: '', photoFailed: false, authorAvatar: getProfileAvatar('')},
  observers: {
    recipe(recipe) {
      const imageSource = recipe && (recipe.displayPhoto || recipe.photoURL || recipe.photo) || '';
      const id = recipe && recipe.id || '';
      const update = {};
      if (id !== this._imageRecipeId || imageSource !== this.data.imageSource) {
        this._imageRecipeId = id;
        Object.assign(update, {imageSource, photoFailed: false});
      }
      const authorAvatar = getProfileAvatar(recipe && recipe.profileId);
      if (authorAvatar !== this.data.authorAvatar) update.authorAvatar = authorAvatar;
      if (Object.keys(update).length) this.setData(update);
    }
  },
  methods: {
    open() { if (this.data.recipe && this.data.recipe.id) this.triggerEvent('open', {id: this.data.recipe.id}); },
    author() { if (this.data.showAuthor && this.data.recipe && this.data.recipe.profileId) this.triggerEvent('author', {id: this.data.recipe.profileId}); },
    photoError(event) {
      if (!this.data.recipe) return;
      const source = event && event.currentTarget && event.currentTarget.dataset;
      if (source && (source.id !== this.data.recipe.id || source.url !== this.data.imageSource)) return;
      this.setData({photoFailed: true});
      this.triggerEvent('photoerror', {id: this.data.recipe.id, url: this.data.imageSource});
    }
  }
});
