const store = require('./utils/store');
App({ globalData: { pantry: [] }, onLaunch() { store.init(); } });
