// Every tab page owns a separate custom tab bar. Update that page's instance,
// never the instance that started a switchTab request and is now hidden.
function syncTabBar(page) {
  if (!page || !page.route || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.setActiveRoute === 'function') {
    tabBar.setActiveRoute('/' + page.route);
  }
}

function syncCurrentTabBar() {
  const pages = getCurrentPages();
  syncTabBar(pages[pages.length - 1]);
}

module.exports = {syncTabBar, syncCurrentTabBar};
