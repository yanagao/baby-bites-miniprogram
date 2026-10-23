// Every tab page owns an in-page navigation component. Update that instance,
// never the instance that started a switchTab request and is now hidden.
function syncTabBar(page) {
  if (!page || !page.route || typeof page.selectComponent !== 'function') return;
  const tabBar = page.selectComponent('#bottom-navigation');
  if (tabBar && typeof tabBar.setActiveRoute === 'function') {
    tabBar.setActiveRoute('/' + page.route);
  }
}

function syncCurrentTabBar() {
  const pages = getCurrentPages();
  syncTabBar(pages[pages.length - 1]);
}

module.exports = {syncTabBar, syncCurrentTabBar};
