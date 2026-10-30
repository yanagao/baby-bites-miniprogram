'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {estimateProject, LIMITS} = require('../scripts/check-package.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-bites-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const project = {miniprogramRoot: options.miniRoot || './', packOptions: options.pack || {ignore: [], include: []}};
  const app = {pages: [], lazyCodeLoading: 'requiredComponents', ...options.app};
  const mini = path.join(root, options.miniRoot || ''); fs.mkdirSync(mini, {recursive: true});
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify(project));
  fs.writeFileSync(path.join(mini, 'app.json'), JSON.stringify(app));
  for (const item of app.subPackages || app.subpackages || []) fs.mkdirSync(path.join(mini, item.root), {recursive: true});
  const write = (file, bytes) => { const target = path.join(mini, file); fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.closeSync(fs.openSync(target, 'w')); fs.truncateSync(target, bytes); };
  return {root, mini, appBytes: fs.statSync(path.join(mini, 'app.json')).size, write, report: () => estimateProject(root)};
}

test('source estimate respects ignore boundaries and include overrides while excluding tool-private files', t => {
  const f = fixture(t, {pack: {ignore: [{type: 'folder', value: 'drafts'}, {type: 'file', value: 'scratch.js'}],
    include: [{type: 'file', value: 'drafts/keep.js'}]}});
  f.write('drafts/drop.js', 500); f.write('drafts/keep.js', 20); f.write('drafts-other/use.js', 30);
  f.write('scratch.js', 500); f.write('app.js', 40); f.write('README.md', 50); f.write('LICENSE', 60);
  f.write('.git/objects/private', 100000); f.write('node_modules/dependency/index.js', 100000);
  f.write('project.private.config.json', 100000); f.write('.DS_Store', 100000);
  const report = f.report();
  assert.equal(report.packages[0].bytes, f.appBytes + 200);
  assert.equal(report.packages[0].files, 6); assert.deepEqual(report.errors, []);
});

test('explicit includes can restore files below an ignored directory without restoring its siblings', t => {
  const f = fixture(t, {pack: {ignore: [{type: 'folder', value: 'vendor'}],
    include: [{type: 'folder', value: 'vendor/runtime'}, {type: 'file', value: 'node_modules/small/runtime.js'}]}});
  f.write('vendor/runtime/index.js', 10); f.write('vendor/runtime/helper.js', 20); f.write('vendor/docs.md', 1000);
  f.write('node_modules/small/runtime.js', 30); f.write('node_modules/small/private.js', 1000);
  assert.equal(f.report().packages[0].bytes, f.appBytes + 60);
});

test('prefix, suffix and regexp rules apply to portable relative filenames and include wins', t => {
  const f = fixture(t, {pack: {ignore: [
    {type: 'prefix', value: 'temp-'}, {type: 'suffix', value: '.map'}, {type: 'regexp', value: '^notes/.*\\.txt$'}
  ], include: [{type: 'regexp', value: '^temp-public/.*\\.js$'}]}});
  f.write('temp-private.js', 1000); f.write('code.js.map', 1000); f.write('notes/draft.txt', 1000);
  f.write('temp-public/index.js', 11); f.write('notes/source.js', 12); f.write('code.js', 13);
  const report = f.report(); assert.equal(report.packages[0].bytes, f.appBytes + 36); assert.deepEqual(report.errors, []);
});

test('miniprogramRoot and subpackage directory boundaries put every included byte in exactly one package', t => {
  const f = fixture(t, {miniRoot: 'miniapp', app: {subPackages: [{name: 'media', root: 'recipe-media'}]}});
  f.write('app.js', 17); f.write('recipe-media/index.js', 19); f.write('recipe-media/fonts/icon.woff2', 23);
  f.write('recipe-media-other.js', 29); f.write('recipe-media/README.md', 31);
  fs.writeFileSync(path.join(f.root, 'outside-secret.txt'), 'not part of the miniapp');
  const report = f.report();
  assert.equal(report.packages[0].bytes, f.appBytes + 46); assert.equal(report.packages[1].bytes, 73);
  assert.equal(report.packages[1].files, 3); assert.deepEqual(report.errors, []);
});

test('main and subpackage budgets are strict while the individual media limit is inclusive', t => {
  const f = fixture(t, {app: {subPackages: [{root: 'media'}]}});
  f.write('main.bin', LIMITS.main - f.appBytes); f.write('media/payload.bin', LIMITS.subpackage);
  let report = f.report();
  assert.equal(report.errors.filter(error => /source estimate must/.test(error)).length, 2);
  f.write('main.bin', LIMITS.main - f.appBytes - 1); f.write('media/payload.bin', LIMITS.subpackage - 1);
  report = f.report(); assert.deepEqual(report.errors, []);
  f.write('main.bin', 0); f.write('media/payload.bin', 0);
  f.write('photo.PNG', LIMITS.media); f.write('media/clip.mp4', LIMITS.media + 1); f.write('sound.m4a', LIMITS.media + 1);
  report = f.report(); assert.equal(report.mediaCount, 3);
  assert.deepEqual(report.oversizedMedia.map(item => item.path).sort(), ['media/clip.mp4', 'sound.m4a']);
  assert.equal(report.errors.length, 2);
});

test('ignored oversized media does not trigger a failure, but an include makes it count again', t => {
  const f = fixture(t, {pack: {ignore: [{type: 'folder', value: 'unused'}], include: [{type: 'file', value: 'unused/kept.jpg'}]}});
  f.write('unused/draft.jpg', LIMITS.media * 3); f.write('unused/kept.jpg', LIMITS.media + 1);
  const report = f.report(); assert.equal(report.mediaCount, 1); assert.equal(report.errors.length, 1);
  assert.equal(report.oversizedMedia[0].path, 'unused/kept.jpg');
});

test('several individually small image/audio files trigger an aggregate quality warning across packages without failing local limits', t => {
  const f = fixture(t, {app: {subPackages: [{root: 'media'}]}, pack: {ignore: [{type: 'folder', value: 'unused'}]}});
  f.write('photo.png', 120 * 1024); f.write('media/sound.mp3', 80 * 1024);
  f.write('media/clip.mp4', 50 * 1024); f.write('unused/draft.jpg', 500 * 1024);
  let report = f.report();
  assert.equal(report.mediaTotalBytes, LIMITS.media, 'official aggregate scope is images/audio, excluding video and ignored files');
  assert.equal(report.mediaCount, 3); assert.deepEqual(report.oversizedMedia, []); assert.deepEqual(report.errors, []);
  assert.equal(report.warnings.length, 1); assert.match(report.warnings[0], /204800 bytes.*official image\/audio quality threshold/);
  f.write('media/sound.mp3', 80 * 1024 - 1); report = f.report();
  assert.equal(report.mediaTotalBytes, LIMITS.media - 1); assert.deepEqual(report.warnings, []);
});

test('missing required-components lazy loading fails the preflight', t => {
  const f = fixture(t, {app: {lazyCodeLoading: 'other'}});
  assert.deepEqual(f.report().errors, ['app.json lazyCodeLoading must be "requiredComponents"']);
});

test('unsupported or malformed packing rules fail explicitly instead of silently undercounting', t => {
  const unsupported = fixture(t, {pack: {ignore: [{type: 'glob', value: '**/*.map'}]}});
  assert.throws(() => unsupported.report(), /Unsupported rule type.*glob/);
  const badRegex = fixture(t, {pack: {include: [{type: 'regexp', value: '['}]}});
  assert.throws(() => badRegex.report(), /Invalid regular expression/);
  const escaping = fixture(t, {pack: {ignore: [{type: 'folder', value: '../outside'}]}});
  assert.throws(() => escaping.report(), /Invalid relative path/);
});

test('ambiguous package roots and included symlinks cannot silently undercount package contents', t => {
  const nested = fixture(t, {app: {subPackages: [{root: 'media'}, {root: 'media/nested'}]}});
  assert.throws(() => nested.report(), /nested subpackage roots/);
  const linked = fixture(t); linked.write('source.js', 17); fs.symlinkSync('source.js', path.join(linked.mini, 'linked.js'));
  assert.match(linked.report().errors[0], /Unsupported non-regular package entry: linked.js/);
});
