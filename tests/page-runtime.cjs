'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// Evaluate the real page entry and its shared controller with the same wx/store
// boundary mocks. The pure local-content projection remains production code.
function evaluatePage(name, context) {
  function evaluate(file) {
    const module = {exports: {}};
    const runtime = {...context, module, exports: module.exports, require(dep) {
      const resolved = path.resolve(path.dirname(file), dep + '.js');
      if (resolved === path.join(root, 'pages/profile/page.js')) return evaluate(resolved);
      if (dep.endsWith('/profile-content')) return require('../utils/profile-content');
      if (dep.endsWith('/profile-avatar')) return require('../utils/profile-avatar');
      if (dep.endsWith('/baby-age')) return context.babyAge || require('../utils/baby-age');
      if (dep.endsWith('/tab-bar')) return context.tabBar || {syncTabBar: () => { if (context.onSyncTabBar) context.onSyncTabBar(); }};
      if (dep.endsWith('/cloud')) return {socialEnabled: context.socialEnabled !== false};
      return context.require(dep);
    }};
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), runtime, {filename: file});
    return module.exports;
  }
  evaluate(path.join(root, 'pages', name, 'index.js'));
}
module.exports = {evaluatePage};
