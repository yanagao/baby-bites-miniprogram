'use strict';

function createSharePrompt({store, wx, isBuiltInRecipe, getMine, setTimer = setTimeout, clearTimer = clearTimeout}) {
  const data = {savedComplete: false, sharePromptVisible: false, sharePromptMessage: '', sharePromptBusy: false, sharePromptError: ''};
  const ownRecipe = recipe => Boolean(recipe && !isBuiltInRecipe(recipe) && !recipe.source && (!recipe.createdBy || recipe.createdBy === store.getSyncInfo().owner));
  return {data, methods: {
    initSharePrompt() {
      this._sharePromptOwner = store.getSyncInfo().owner;
      this._sharePromptScope = store.getSyncInfo().scopeKey || this._sharePromptOwner;
      this._sharePromptLocked = false;
      this._pageUnloaded = false;
      this._sharePromptRequest = 0;
    },
    sharePromptAccountChanged(info) {
      if (!this._sharePromptOwner && info.owner) { this._sharePromptOwner = info.owner; this._sharePromptScope = info.scopeKey || info.owner; }
      else if (this._sharePromptOwner && (this._sharePromptOwner !== info.owner || this._sharePromptScope !== (info.scopeKey || info.owner))) this._sharePromptLocked = true;
      if (this._sharePromptLocked && !this._pageUnloaded) {
        if (this._cancelShareStatus) this._cancelShareStatus();
        this.setData({sharePromptVisible: false, sharePromptBusy: false});
        if (this._sharePromptOwner === info.owner && typeof this.clearDraftForScopeChange === 'function') this.clearDraftForScopeChange();
      }
    },
    disposeSharePrompt() {
      this._pageUnloaded = true;
      this._sharePromptRequest++;
      if (this._cancelShareStatus) this._cancelShareStatus();
      this._cancelShareStatus = null;
    },
    cancelSharePrompt() {
      this._sharePromptRequest++;
      if (this._cancelShareStatus) this._cancelShareStatus();
      this._cancelShareStatus = null;
      if (this.data.sharePromptVisible && !this._pageUnloaded) this.setData({sharePromptVisible: false});
    },
    sharePromptCurrent() {
      return !this._pageUnloaded && !this._sharePromptLocked &&
        this._sharePromptOwner === store.getSyncInfo().owner && this._sharePromptScope === (store.getSyncInfo().scopeKey || store.getSyncInfo().owner);
    },
    async afterSavedRecipe(recipeId, message, {newRecipe = false} = {}) {
      if (!this.sharePromptCurrent()) return;
      const request = ++this._sharePromptRequest;
      this.setData({savedComplete: true, saving: false});
      this.alertEnabled = false;
      if (typeof wx.disableAlertBeforeUnload === 'function') wx.disableAlertBeforeUnload({fail() {}});
      const recipe = recipeId && store.getRecipe(recipeId);
      if (!message || !ownRecipe(recipe)) { this.leave(); return; }
      if (!newRecipe) {
        let timer, mine;
        try {
          // This is an optional invitation, never a prerequisite for saving.
          // Unknown/offline status leaves quietly; a late response cannot reopen
          // the prompt after the deadline, account switch or page disposal.
          mine = await Promise.race([
            Promise.resolve().then(() => this.sharePromptCurrent() && request === this._sharePromptRequest
              ? getMine({force: true}) : null),
            new Promise(resolve => {
              this._cancelShareStatus = () => resolve(null);
              timer = setTimer(() => resolve(null), 1200);
            })
          ]);
        } catch (_) { mine = null; }
        finally {
          if (timer !== undefined) clearTimer(timer);
          if (request === this._sharePromptRequest) this._cancelShareStatus = null;
        }
        if (!this.sharePromptCurrent() || request !== this._sharePromptRequest) return;
        const known = mine && Array.isArray(mine.published) &&
          mine.published.every(item => item && typeof item.sourceRecipeId === 'string' && item.sourceRecipeId.trim());
        if (!known || mine.published.some(item => item.sourceRecipeId === recipeId)) { this.leave(); return; }
        if (!ownRecipe(store.getRecipe(recipeId))) { this.leave(); return; }
      }
      this._savedRecipeId = recipeId;
      this.setData({sharePromptVisible: true, sharePromptMessage: message, sharePromptBusy: false, sharePromptError: ''});
    },
    keepRecipeForSelf() {
      if (!this.sharePromptCurrent() || !this.data.sharePromptVisible || this.data.sharePromptBusy) return;
      this.setData({sharePromptVisible: false});
      this.leave();
    },
    previewSavedRecipe() {
      if (!this.sharePromptCurrent() || !this.data.sharePromptVisible || this.data.sharePromptBusy) return;
      const recipe = store.getRecipe(this._savedRecipeId);
      if (!ownRecipe(recipe)) {
        this.setData({sharePromptVisible: false});
        this.leave();
        return;
      }
      this.setData({sharePromptBusy: true, sharePromptError: ''});
      const failed = () => {
        if (this.sharePromptCurrent()) this.setData({sharePromptBusy: false, sharePromptError: '暂时无法打开预览，菜谱已保存，可以稍后分享。'});
      };
      try {
        wx.redirectTo({url: '/pages/share-preview/index?id=' + encodeURIComponent(recipe.id), fail: failed});
      } catch (_) { failed(); }
    }
  }};
}

module.exports = {createSharePrompt};
