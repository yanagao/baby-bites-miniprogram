const store = require('../../utils/store');
const MESSAGE = '微信账号已切换，请重新加载后再操作';
function check(page) {
  const session = page.accountSession;
  if (!session || session.disposed || session.changed) return false;
  const owner = store.getSyncInfo().owner || '';
  if (!session.owner) { session.owner = owner; return true; }
  if (owner === session.owner) return true;
  invalidate(page);
  return false;
}
function invalidate(page) {
  if (!page.accountSession || page.accountSession.disposed) return;
  page.accountSession.changed = true;
  page.request++;
  const cleared = {profile: null, recipe: null, author: null, recipes: [], profiles: [], importedId: '', editing: false, name: '', bio: '', loading: false, loadingMore: false, saving: false, adding: false, followBusy: false, nextCursor: null, nextOffset: null};
  const update = {error: MESSAGE};
  Object.keys(cleared).forEach(key => { if (key in page.data) update[key] = cleared[key]; });
  page.setData(update);
  if (wx.hideShareMenu) wx.hideShareMenu({menus: ['shareAppMessage']});
}
function bind(page) {
  page.accountSession = {owner: store.getSyncInfo().owner || '', changed: false, disposed: false};
  page.accountSession.unsubscribe = store.subscribe(() => check(page));
}
function reload(page) {
  if (!page.accountSession || page.accountSession.disposed) return;
  page.accountSession.owner = store.getSyncInfo().owner || '';
  page.accountSession.changed = false;
  return page.load();
}
function dispose(page) {
  if (!page.accountSession) return;
  page.accountSession.disposed = true;
  if (page.accountSession.unsubscribe) page.accountSession.unsubscribe();
}
module.exports = {bind, check, reload, dispose, invalidate};
