'use strict';

// Keep asynchronous form work bound to the account and family that opened it.
function createFormSession({store, wx}) {
  return {data: {savedComplete: false}, methods: {
    initDraftSession() {
      const info = store.getSyncInfo();
      this._formOwner = info.owner;
      this._formScope = info.scopeKey || info.owner;
      this._draftLocked = false;
      this._pageUnloaded = false;
    },
    draftSessionChanged(info) {
      if (!this._formOwner && info.owner) { this._formOwner = info.owner; this._formScope = info.scopeKey || info.owner; }
      else if (this._formOwner && (this._formOwner !== info.owner || this._formScope !== (info.scopeKey || info.owner))) this._draftLocked = true;
      if (this._draftLocked && !this._pageUnloaded && this._formOwner === info.owner &&
        typeof this.clearDraftForScopeChange === 'function') this.clearDraftForScopeChange();
    },
    disposeDraftSession() { this._pageUnloaded = true; },
    draftCurrent() {
      const info = store.getSyncInfo();
      return !this._pageUnloaded && !this._draftLocked && this._formOwner === info.owner && this._formScope === (info.scopeKey || info.owner);
    },
    finishSaved() {
      if (!this.draftCurrent()) return;
      this.setData({savedComplete: true, saving: false});
      this.leave();
    }
  }};
}
module.exports = {createFormSession};
