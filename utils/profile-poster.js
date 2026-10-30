'use strict';

const {getProfileAvatar} = require('./profile-avatar');

const WIDTH = 600, HEIGHT = 860;
const FONT_SCALE = WIDTH / 750;
const FONTS = {caption: 24 * FONT_SCALE, secondary: 26 * FONT_SCALE,
  body: 30 * FONT_SCALE, cardTitle: 34 * FONT_SCALE};
const BODY_LINE_HEIGHT = 1.6;
const CANVAS_ID = 'profile-share-canvas';
function canvasImagePath(value, fallback) {
  // getImageInfo may return a package-relative path on iOS. Canvas resolves it
  // against the current page unless the packaged asset has a leading slash.
  if (typeof value !== 'string' || !value) return fallback;
  return /^(?:\.\/)?assets\//.test(value) ? '/' + value.replace(/^\.\//, '') : value;
}
function circle(ctx, x, y, radius, color) {
  ctx.setFillStyle(color); ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
}
function banner(ctx) {
  const sky = ctx.createLinearGradient(0, 0, WIDTH, 210);
  sky.addColorStop(0, '#73c6e8'); sky.addColorStop(1, '#eff8f8');
  ctx.setFillStyle(sky); ctx.fillRect(0, 0, WIDTH, 210);
  circle(ctx, 490, 54, 32, '#fff1b8');
  [[55, 66, 18], [77, 58, 25], [102, 67, 18], [413, 87, 14], [431, 80, 19], [451, 88, 14]]
    .forEach(([x, y, radius]) => circle(ctx, x, y, radius, '#ffffff'));
  ctx.setFillStyle('rgba(85,187,164,0.42)'); ctx.beginPath();
  ctx.moveTo(0, 133); ctx.quadraticCurveTo(130, 95, 346, 210);
  ctx.lineTo(0, 210); ctx.closePath(); ctx.fill();
  ctx.setFillStyle('#55bba4'); ctx.beginPath();
  ctx.moveTo(WIDTH, 119); ctx.quadraticCurveTo(459, 124, 280, 210);
  ctx.lineTo(WIDTH, 210); ctx.closePath(); ctx.fill();
  ctx.setFillStyle('#ffffff'); ctx.beginPath();
  ctx.moveTo(0, 203); ctx.quadraticCurveTo(WIDTH / 2, 168, WIDTH, 203);
  ctx.lineTo(WIDTH, 236); ctx.lineTo(0, 236); ctx.closePath(); ctx.fill();
  circle(ctx, WIDTH / 2, 164, 72, '#ffffff');
}
function call(method, options, page) {
  return new Promise((resolve, reject) => {
    const args = Object.assign({}, options, {success: resolve, fail: reject});
    if (page) wx[method](args, page); else wx[method](args);
  });
}
function remove(filePath) {
  if (!filePath || typeof wx.getFileSystemManager !== 'function') return;
  wx.getFileSystemManager().unlink({filePath, fail() {}});
}
function lines(ctx, value, width, limit) {
  const result = [], chars = Array.from(String(value || ''));
  let line = '';
  for (let i = 0; i < chars.length; i++) {
    if (ctx.measureText(line + chars[i]).width <= width) { line += chars[i]; continue; }
    if (result.length === limit - 1) {
      while (line && ctx.measureText(line + '…').width > width) line = Array.from(line).slice(0, -1).join('');
      result.push(line + '…'); return result;
    }
    result.push(line); line = chars[i];
  }
  if (line) result.push(line);
  return result;
}
async function render(page, input, guard) {
  if (!input.profile || !input.profile.exists || !/^[a-f0-9]{32}$/.test(input.profile.id) ||
    typeof input.codeURL !== 'string' || !/^https:\/\/[^\s/@]+(?:\/|$)/.test(input.codeURL)) {
    throw Error('分享码尚未准备好，请重新生成。');
  }
  let codePath = '';
  try {
    guard();
    const downloaded = await call('downloadFile', {url: input.codeURL, timeout: 20000});
    codePath = downloaded.tempFilePath || '';
    guard();
    if (downloaded.statusCode !== 200 || !codePath) throw Error('分享码下载未完成，请重试。');
    const avatarPath = getProfileAvatar(input.profile.id);
    const avatar = await call('getImageInfo', {src: avatarPath});
    guard();
    const ctx = wx.createCanvasContext(CANVAS_ID, page);
    ctx.setFillStyle('#ffffff'); ctx.fillRect(0, 0, WIDTH, HEIGHT);
    banner(ctx);
    ctx.drawImage(canvasImagePath(avatar.path, avatarPath), 245, 109, 110, 110);
    ctx.setTextAlign('center'); ctx.setFillStyle('#345158'); ctx.setFontSize(FONTS.cardTitle);
    lines(ctx, input.profile.name, 480, 2).forEach((line, index) => ctx.fillText(line, WIDTH / 2, 265 + index * FONTS.cardTitle * BODY_LINE_HEIGHT));
    ctx.setFontSize(FONTS.secondary); ctx.setFillStyle('#82969a'); ctx.fillText('分享我做过的好味道', WIDTH / 2, 342);
    // Keep the real code square and unobstructed, with a white quiet zone.
    ctx.setFillStyle('#fff'); ctx.fillRect(98, 354, 404, 404);
    ctx.drawImage(codePath, 113, 369, 374, 374);
    ctx.setFillStyle('#345158'); ctx.setFontSize(FONTS.body); ctx.fillText('长按识别，来我的口袋小厨房', WIDTH / 2, 794);
    ctx.setFillStyle('#82969a'); ctx.setFontSize(FONTS.caption);
    ctx.fillText(input.envVersion === 'release' ? '小口袋 · 今天辅食吃什么' :
      input.envVersion === 'trial' ? '体验版 · 需有体验权限' : '开发版 · 需有开发权限', WIDTH / 2, 834);
    await new Promise(resolve => ctx.draw(false, resolve));
    guard();
    const result = await call('canvasToTempFilePath', {canvasId: CANVAS_ID, x: 0, y: 0,
      width: WIDTH, height: HEIGHT, destWidth: WIDTH * 2, destHeight: HEIGHT * 2, fileType: 'png'}, page);
    try { guard(); } catch (error) { remove(result.tempFilePath); throw error; }
    if (!result.tempFilePath) throw Error('海报还未生成，请重试。');
    return result.tempFilePath;
  } finally { remove(codePath); }
}

module.exports = {render, remove, lines};
