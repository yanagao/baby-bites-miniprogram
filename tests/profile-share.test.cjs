'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {evaluatePage} = require('./page-runtime.cjs');
const {getProfileAvatar} = require('../utils/profile-avatar');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const profile = {id: 'a'.repeat(32), name: '公开的小厨房', bio: '只分享做法', exists: true};
const friendId = 'b'.repeat(32);

function setup(options = {}, overrides = {}) {
  let owner = 'owner-a';
  const listeners = new Set(), waiting = new Map();
  const calls = {mine: 0, profiles: [], codes: [], downloads: [], removals: [], saves: [], settings: 0,
    previews: [], toasts: [], updates: 0, errors: [], exported: [], text: [], textDraws: [], imageInfo: [], images: [], fills: [], gradients: [], circles: []};
  let hold = overrides.hold;
  function boundary(stage, options, result) {
    if (hold === stage) waiting.set(stage, () => options.success(result));
    else options.success(result);
  }
  let fillStyle;
  const context = {
    setFillStyle(value) { fillStyle = value; },
    fillRect(x, y, width, height) { calls.fills.push({x, y, width, height, fillStyle}); },
    drawImage(source, x, y, width, height) { calls.images.push({source, x, y, width, height}); },
    createLinearGradient() { const stops = []; calls.gradients.push(stops); return {addColorStop(offset, color) { stops.push({offset, color}); }}; },
    beginPath() {}, arc(x, y, radius) { calls.circles.push({x, y, radius}); }, fill() {},
    moveTo() {}, quadraticCurveTo() {}, lineTo() {}, closePath() {}, setTextAlign() {}, setFontSize() {},
    measureText: value => ({width: Array.from(value).length * (overrides.characterWidth || 20)}),
    fillText(value, x, y) { calls.text.push(value); calls.textDraws.push({value, x, y}); },
    draw(reserve, done) { boundary('draw', {success: done}, undefined); }
  };
  const wx = {
    showShareMenu() {}, hideShareMenu() {}, showToast(options) { calls.toasts.push(options.title); },
    getAccountInfoSync: () => ({miniProgram: {envVersion: overrides.envVersion || 'release'}}),
    downloadFile(options) { calls.downloads.push({url: options.url, timeout: options.timeout}); boundary('download', options, {statusCode: 200, tempFilePath: '/tmp/code.png'}); },
    getImageInfo(options) { calls.imageInfo.push(options.src); boundary('image', options, {path: overrides.imagePath === undefined ? options.src : overrides.imagePath}); },
    createCanvasContext: () => context,
    canvasToTempFilePath(options, page) {
      calls.exported.push({canvasId: options.canvasId, width: options.width, height: options.height, destWidth: options.destWidth, destHeight: options.destHeight, page});
      boundary('export', options, {tempFilePath: '/tmp/poster.png'});
    },
    getFileSystemManager: () => ({unlink(options) { calls.removals.push(options.filePath); }}),
    saveImageToPhotosAlbum(options) { calls.saves.push(options); },
    openSetting() { calls.settings++; }, previewImage(options) { calls.previews.push(options.current); },
    ...overrides.wx
  };
  const store = {getState: () => ({recipes: [], logs: []}), getSyncInfo: () => ({owner}), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
  const social = {
    getMine: async () => { calls.mine++; return {profile}; },
    getProfile: async id => {
      calls.profiles.push(id);
      if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(Error('主页地址不正确'), {code: 'INVALID_INPUT'});
      return {profile: {...profile, id}, isSelf: id === profile.id, recipes: [], nextOffset: null};
    },
    getShareCode: async (id, version) => { calls.codes.push({id, version}); return {codeURL: 'https://code.example.test/share.png'}; },
    ...overrides.social
  };
  const accountModule = {exports: {}}, posterModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/profile-poster.js'), 'utf8'), {module: posterModule, wx, require(dep) {
    if (dep === './profile-avatar') return {getProfileAvatar};
    throw Error(dep);
  }});
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../pages/profile/account.js'), 'utf8'), {module: accountModule, wx, require: () => store});
  let definition;
  evaluatePage('profile', {
    wx, Page(value) { definition = value; }, require(dep) {
      if (dep.endsWith('/social')) return social;
      if (dep.endsWith('/store')) return store;
      if (dep.endsWith('/account')) return accountModule.exports;
      if (dep.endsWith('/profile-poster')) return posterModule.exports;
      if (dep.endsWith('/ui')) return {error(error) { calls.errors.push(error.message); }, back() {}};
      throw Error(dep);
    }
  });
  const page = {...definition, data: clone(definition.data), setData(value) { calls.updates++; Object.assign(this.data, clone(value)); }};
  page.onLoad(options);
  return {page, calls, poster: posterModule.exports, listeners, waiting,
    release(stage) { const finish = waiting.get(stage); assert.ok(finish, stage + ' reached'); waiting.delete(stage); hold = null; finish(); },
    changeOwner(value, notify = true) { owner = value; if (notify) listeners.forEach(fn => fn()); }};
}

test('QR scenes open their public profile and malformed scenes never fall back to the current user', async t => {
  const encoded = '%62'.repeat(32);
  const valid = setup({scene: encoded}); await valid.page.load();
  assert.deepEqual(valid.calls.profiles, [friendId]); assert.equal(valid.calls.mine, 0);
  assert.equal(valid.page.data.profile.id, friendId); assert.equal(valid.page.data.isSelf, false);
  for (const scene of ['not-a-profile', '%', '%20', '%00']) await t.test(scene, async () => {
    const {page, calls} = setup({scene}); await page.load();
    assert.equal(calls.mine, 0); assert.equal(page.data.profile, null); assert.equal(page.data.isSelf, false);
    assert.match(page.data.error, /主页地址/); assert.equal(page.onShareAppMessage().path, '/pages/home/index');
  });
  const direct = setup({id: friendId, scene: profile.id}); await direct.page.load();
  assert.deepEqual(direct.calls.profiles, [friendId]);
});

test('generation and preview never save to the album until the explicit save action', async () => {
  const {page, calls} = setup(); await page.load(); await page.openShare();
  assert.equal(page.data.posterPath, '/tmp/poster.png'); assert.equal(page.data.shareLoading, false);
  assert.deepEqual(calls.codes, [{id: profile.id, version: 'release'}]);
  assert.deepEqual(calls.saves, []); assert.equal(calls.settings, 0);
  assert.deepEqual(calls.downloads, [{url: 'https://code.example.test/share.png', timeout: 20000}]);
  assert.deepEqual(calls.imageInfo, [getProfileAvatar(profile.id)]);
  assert.equal(calls.exported[0].page, page); assert.equal(calls.exported[0].destWidth, 1200);
  assert.ok(calls.text.includes(profile.name)); assert.ok(calls.text.includes('小口袋 · 今天辅食吃什么'));
  page.previewPoster(); assert.deepEqual(calls.previews, ['/tmp/poster.png']); assert.equal(calls.saves.length, 0);
  const native = page.onShareAppMessage(); assert.equal(native.path, '/pages/profile/index?id=' + profile.id);
  assert.equal(native.imageUrl, '/assets/cute/pocket-mascot.png');
  await page.onShow(); assert.equal(calls.codes.length, 1); assert.equal(calls.mine, 1);
  page.savePoster(); page.savePoster(); assert.equal(calls.saves.length, 1);
  calls.saves[0].success(); calls.saves[0].complete();
  assert.deepEqual(calls.toasts, ['分享图已保存']); assert.equal(page.data.savingPoster, false);
  page.closeShare(); assert.equal(page.data.posterPath, ''); assert.ok(calls.removals.includes('/tmp/poster.png'));
});

test('poster normalizes iOS packaged image paths without corrupting absolute temporary paths', async t => {
  const avatar = getProfileAvatar(profile.id);
  for (const [imagePath, expected] of [
    [avatar.slice(1), avatar],
    ['.' + avatar, avatar],
    [avatar, avatar],
    ['wxfile://usr/logo.png', 'wxfile://usr/logo.png'],
    ['http://tmp/logo.png', 'http://tmp/logo.png'],
    ['', avatar]
  ]) await t.test(imagePath || 'empty path fallback', async () => {
    const {page, calls} = setup({}, {imagePath}); await page.load(); await page.openShare();
    assert.equal(page.data.shareError, ''); assert.equal(calls.images[0].source, expected);
    assert.equal(calls.images[0].width, calls.images[0].height, 'the square avatar must keep its aspect ratio');
    assert.deepEqual(calls.saves, []);
  });
});

test('own and visitor profile share posters use their stable avatar while the downloaded QR remains untouched', async t => {
  const sources = new Set();
  for (let index = 0; index < 5; index++) for (const visitor of [false, true]) {
    await t.test(`avatar ${index}, ${visitor ? 'visitor' : 'own'}`, async () => {
      const sharedProfile = {...profile, id: '0'.repeat(31) + index.toString(16)};
      const code = deferred();
      const {page, calls} = setup(visitor ? {id: sharedProfile.id} : {}, {social: {
        getMine: async () => ({profile: sharedProfile, published: []}),
        getProfile: async () => ({profile: sharedProfile, isSelf: false, recipes: [], nextOffset: null}),
        getShareCode: () => code.promise
      }});
      await page.load();
      const avatar = getProfileAvatar(sharedProfile.id); sources.add(avatar);
      assert.equal(page.data.avatarPath, avatar);
      const task = page.openShare();
      assert.equal(page.data.shareVisible, true); assert.equal(page.data.shareLoading, true);
      assert.equal(page.data.avatarPath, avatar, 'the loading placeholder retains the same profile avatar');
      code.resolve({codeURL: 'https://code.example.test/share.png'}); await task;
      assert.deepEqual(calls.imageInfo, [avatar]); assert.equal(calls.images[0].source, avatar);
      assert.equal(calls.images.length, 2, 'only the avatar and original QR image are drawn');
      assert.deepEqual(calls.images[1], {source: '/tmp/code.png', x: 113, y: 369, width: 374, height: 374});
      assert.equal(page.data.avatarPath, avatar); assert.deepEqual(calls.saves, []);
    });
  }
  assert.equal(sources.size, 5);
});

test('poster has a full illustrated banner and preserves a large, clear code below a two-line name', async () => {
  const longName = '一二三四五六七八九十一二三四五六七八九十';
  const {page, calls} = setup({}, {characterWidth: 28,
    social: {getMine: async () => ({profile: {...profile, name: longName}})}});
  await page.load(); await page.openShare();
  assert.equal(page.data.shareError, '');
  const exported = calls.exported[0];
  assert.equal(exported.width, 600); assert.equal(exported.height, 860);
  assert.equal(exported.destWidth, 1200); assert.equal(exported.destHeight, 1720);
  const sky = calls.fills.find(rect => typeof rect.fillStyle === 'object');
  assert.equal(sky.width, exported.width); assert.ok(sky.height >= 180);
  assert.deepEqual(calls.gradients[0].map(stop => stop.color), ['#73c6e8', '#eff8f8']);
  assert.ok(calls.circles.length >= 3, 'the banner includes vector illustration details');
  const code = calls.images.find(item => item.source === '/tmp/code.png');
  assert.ok(code.width >= 350); assert.equal(code.width, code.height);
  const quietZone = calls.fills.find(rect => rect.x < code.x && rect.y < code.y &&
    rect.x + rect.width > code.x + code.width && rect.y + rect.height > code.y + code.height &&
    (rect.fillStyle === '#fff' || rect.fillStyle === '#ffffff') && rect.width < exported.width);
  assert.ok(quietZone, 'the real code retains a white margin on all four sides');
  const nameLines = calls.textDraws.filter(draw => longName.includes(draw.value));
  assert.equal(nameLines.length, 2);
  assert.ok(nameLines.every(draw => draw.y < quietZone.y - 20));
  assert.ok(calls.textDraws.filter(draw => !nameLines.includes(draw)).every(draw =>
    draw.y < code.y - 20 || draw.y > code.y + code.height + 20));
  assert.ok(calls.images[0].y + calls.images[0].height < nameLines[0].y - 20);
  assert.ok(calls.textDraws.every(draw => draw.y < exported.height));
  assert.deepEqual(calls.saves, []);
});

test('unpublished profiles and active editing cannot generate a public share poster', async () => {
  const {page, calls} = setup();
  await page.openShare();
  page.setData({loading: false, profile: {...profile, exists: false}}); await page.openShare();
  page.setData({profile, editing: true}); await page.openShare();
  assert.deepEqual(calls.codes, []); assert.deepEqual(calls.downloads, []); assert.deepEqual(calls.saves, []);
});

test('closing while a share-code request is pending prevents rendering or reopening', async () => {
  const pending = deferred();
  const {page, calls} = setup({}, {social: {getShareCode: () => pending.promise}});
  await page.load(); const task = page.openShare(); page.closeShare(); const updates = calls.updates;
  pending.resolve({codeURL: 'https://code.example.test/stale'}); await task;
  assert.equal(calls.updates, updates); assert.deepEqual(calls.downloads, []); assert.equal(page.data.shareVisible, false);
});

test('an identity mismatch returned by share-code generation invalidates the old profile before local owner notification', async () => {
  const {page, calls} = setup({}, {social: {getShareCode: async () => {
    throw Object.assign(Error('微信账号已切换'), {code: 'ACCOUNT_CHANGED', userMessage: '微信账号已切换'});
  }}});
  await page.load(); await page.openShare();
  assert.equal(page.data.profile, null); assert.equal(page.data.shareVisible, false);
  assert.match(page.data.error, /账号已切换/);
  assert.equal(page.onShareAppMessage().path, '/pages/home/index'); assert.deepEqual(calls.downloads, []);
});

test('closing at each rendering boundary discards late output and cleans downloaded files', async t => {
  for (const stage of ['download', 'image', 'draw', 'export']) await t.test(stage, async () => {
    const fixture = setup({}, {hold: stage}); await fixture.page.load();
    const task = fixture.page.openShare(); await turn();
    assert.ok(fixture.waiting.has(stage)); fixture.page.closeShare(); const updates = fixture.calls.updates;
    fixture.release(stage); await task;
    assert.equal(fixture.calls.updates, updates); assert.equal(fixture.page.data.posterPath, '');
    assert.equal(fixture.page.data.shareError, ''); assert.ok(fixture.calls.removals.includes('/tmp/code.png'));
    if (stage === 'export') assert.ok(fixture.calls.removals.includes('/tmp/poster.png'));
    assert.deepEqual(fixture.calls.saves, []);
  });
});

test('account change or unload during export prevents stale poster and later album effects', async t => {
  for (const action of ['account', 'unload']) await t.test(action, async () => {
    const fixture = setup({}, {hold: 'export'}); await fixture.page.load();
    const task = fixture.page.openShare(); await turn();
    if (action === 'account') fixture.changeOwner('owner-b'); else fixture.page.onUnload();
    const updates = fixture.calls.updates; fixture.release('export'); await task;
    assert.equal(fixture.calls.updates, updates); assert.equal(fixture.page.data.posterPath, '');
    assert.equal(fixture.page.data.shareVisible, false); assert.ok(fixture.calls.removals.includes('/tmp/poster.png'));
    fixture.page.savePoster(); fixture.page.previewPoster(); assert.deepEqual(fixture.calls.saves, []);
    assert.deepEqual(fixture.calls.previews, []);
    if (action === 'account') assert.match(fixture.page.data.error, /账号已切换/);
    else assert.equal(fixture.listeners.size, 0);
  });
});

test('a newer share generation is not overwritten by the previous request', async () => {
  const old = deferred(); let requests = 0;
  const {page, calls} = setup({}, {social: {getShareCode: () => ++requests === 1 ? old.promise : Promise.resolve({codeURL: 'https://code.example.test/new'})}});
  await page.load(); const first = page.openShare(); await page.openShare();
  old.resolve({codeURL: 'https://code.example.test/old'}); await first;
  assert.equal(page.data.posterPath, '/tmp/poster.png'); assert.equal(page.data.shareError, '');
  assert.deepEqual(calls.downloads.map(item => item.url), ['https://code.example.test/new']);
});

test('album permission handling is user-triggered and a successful retry clears the old error', async () => {
  const {page, calls} = setup(); await page.load(); await page.openShare();
  page.albumSettings(); assert.equal(calls.settings, 0);
  page.savePoster(); calls.saves[0].fail({errMsg: 'saveImageToPhotosAlbum:fail auth deny'}); calls.saves[0].complete();
  assert.equal(page.data.albumDenied, true); assert.match(page.data.shareError, /相册权限/);
  assert.equal(calls.settings, 0); page.albumSettings(); assert.equal(calls.settings, 1);
  page.savePoster(); calls.saves[1].success(); calls.saves[1].complete();
  assert.equal(page.data.albumDenied, false); assert.equal(page.data.shareError, '');
  assert.deepEqual(calls.toasts, ['分享图已保存']);
});

test('album callbacks after close, account switch or unload cannot show stale messages', async t => {
  for (const action of ['close', 'account', 'unload']) await t.test(action, async () => {
    const fixture = setup(); await fixture.page.load(); await fixture.page.openShare(); fixture.page.savePoster();
    if (action === 'close') fixture.page.closeShare();
    else if (action === 'account') fixture.changeOwner('owner-b');
    else fixture.page.onUnload();
    const updates = fixture.calls.updates;
    fixture.calls.saves[0].fail({errMsg: 'auth deny'}); fixture.calls.saves[0].success(); fixture.calls.saves[0].complete();
    assert.equal(fixture.calls.updates, updates); assert.deepEqual(fixture.calls.toasts, []);
  });
});

test('generation errors preserve native share and non-release codes are accurately labelled', async () => {
  let tries = 0;
  const {page, calls} = setup({}, {envVersion: 'trial', social: {getShareCode: async () => {
    if (++tries === 1) throw Object.assign(Error('network'), {userMessage: '分享码暂时连接不上'});
    return {codeURL: 'https://code.example.test/retry'};
  }}});
  await page.load(); await page.openShare(); assert.equal(page.data.shareError, '分享码暂时连接不上');
  assert.equal(page.data.shareLoading, false); assert.equal(page.data.shareVisible, true);
  assert.equal(page.onShareAppMessage().path, '/pages/profile/index?id=' + profile.id);
  await page.openShare(); assert.equal(page.data.shareError, ''); assert.match(page.data.shareVersion, /体验版/);
  assert.ok(calls.text.includes('体验版 · 需有体验权限')); assert.deepEqual(calls.saves, []);
});

test('share deep links open the sheet once after profile loading and never auto-save an image', async () => {
  const {page, calls} = setup({share: '1'}); await page.load(); await turn();
  assert.equal(page.data.shareVisible, true); assert.equal(page.data.posterPath, '/tmp/poster.png');
  assert.equal(calls.codes.length, 1); assert.deepEqual(calls.saves, []);
  page.closeShare(); await page.load();
  assert.equal(page.data.shareVisible, false); assert.equal(calls.codes.length, 1);
});

test('a non-successful QR download cannot render a poster and its temporary file is removed', async () => {
  const {page, calls} = setup({}, {wx: {downloadFile(options) { options.success({statusCode: 403, tempFilePath: '/tmp/denied-code.png'}); }}});
  await page.load(); await page.openShare();
  assert.equal(page.data.posterPath, ''); assert.equal(page.data.shareLoading, false);
  assert.notEqual(page.data.shareError, ''); assert.equal(calls.exported.length, 0);
  assert.ok(calls.removals.includes('/tmp/denied-code.png')); assert.deepEqual(calls.saves, []);
});

test('poster rejects invalid profile or download URLs before any API call', async () => {
  const {poster, calls, page} = setup();
  for (const input of [{profile: {...profile, exists: false}, codeURL: 'https://example.test/code'},
    {profile, codeURL: 'http://example.test/code'}, {profile: {...profile, id: 'owner-secret'}, codeURL: 'https://example.test/code'}]) {
    await assert.rejects(poster.render(page, input, () => {}), /分享码/);
  }
  assert.deepEqual(calls.downloads, []); assert.deepEqual(calls.saves, []);
});
