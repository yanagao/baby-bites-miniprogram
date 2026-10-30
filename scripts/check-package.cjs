'use strict';

// This intentionally sums source bytes without relying on DevTools internals.
// Compilation, dependency pruning and compression can change the official size.
const fs = require('node:fs');
const path = require('node:path');
const LIMITS = Object.freeze({main: 1.5 * 1024 * 1024, subpackage: 2 * 1024 * 1024, media: 200 * 1024});
const DEFAULT_DIRS = new Set(['.git', 'node_modules', '__MACOSX']);
const DEFAULT_FILES = new Set(['project.config.json', 'project.private.config.json', '.DS_Store', '.gitignore', '.gitattributes']);
const MEDIA = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif|heic|mp3|wav|aac|m4a|ogg|flac|amr|opus|mp4|m4v|mov|webm|avi|mkv|wmv|3gp|mpe?g)$/i;
const IMAGE_AUDIO = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif|heic|mp3|wav|aac|m4a|ogg|flac|amr|opus)$/i;

function readJSON(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw Error(`Cannot read valid JSON: ${label}`); }
}
function relativePath(value, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value)) throw Error(`Invalid relative path: ${label}`);
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[a-z]:/i.test(portable)) throw Error(`Invalid relative path: ${label}`);
  const normalized = (allowEmpty && portable === '.' ? '' : portable).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if ((!normalized && !allowEmpty) || normalized.split('/').some(part => part === '..' || part === '.')) throw Error(`Invalid relative path: ${label}`);
  return normalized;
}
function compileRules(input, label) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw Error(`${label} must be an array`);
  return input.map((rule, index) => {
    const where = `${label}[${index}]`;
    if (!rule || typeof rule.value !== 'string' || !rule.value || rule.value.includes('\0')) throw Error(`Invalid rule: ${where}`);
    const type = rule.type;
    if (!['file', 'folder', 'prefix', 'suffix', 'regexp'].includes(type)) throw Error(`Unsupported rule type in ${where}: ${String(type)}`);
    const value = ['file', 'folder'].includes(type) ? relativePath(rule.value, where) : rule.value;
    let expression;
    if (type === 'regexp') {
      try { expression = new RegExp(value); }
      catch (_) { throw Error(`Invalid regular expression in ${where}`); }
    }
    return {
      matches(file) {
        if (type === 'file') return file === value;
        if (type === 'folder') return file === value || file.startsWith(value + '/');
        if (type === 'prefix') return file.startsWith(value);
        if (type === 'suffix') return file.endsWith(value);
        return expression.test(file);
      },
      mayContain(directory) {
        if (type === 'file') return value.startsWith(directory + '/');
        if (type === 'folder') return value === directory || value.startsWith(directory + '/') || directory.startsWith(value + '/');
        if (type === 'prefix') return value.startsWith(directory + '/') || (directory + '/').startsWith(value);
        return true;
      }
    };
  });
}
function estimateProject(projectRoot) {
  const project = readJSON(path.join(projectRoot, 'project.config.json'), 'project.config.json');
  const miniRoot = relativePath(project.miniprogramRoot === undefined ? '' : project.miniprogramRoot, 'miniprogramRoot', true);
  const root = path.resolve(projectRoot, miniRoot);
  const app = readJSON(path.join(root, 'app.json'), 'app.json');
  if (project.packOptions != null && (typeof project.packOptions !== 'object' || Array.isArray(project.packOptions))) throw Error('packOptions must be an object');
  const pack = project.packOptions || {};
  const ignore = compileRules(pack.ignore, 'packOptions.ignore'), include = compileRules(pack.include, 'packOptions.include');
  if (app.subPackages && app.subpackages) throw Error('Specify only one of subPackages and subpackages');
  const definitions = app.subPackages || app.subpackages || [];
  if (!Array.isArray(definitions)) throw Error('subPackages must be an array');
  const packages = [{name: 'main', root: '', bytes: 0, files: 0, limit: LIMITS.main}];
  for (const [index, definition] of definitions.entries()) {
    const subRoot = relativePath(definition && definition.root, `subPackages[${index}].root`);
    if (packages.slice(1).some(item => item.root === subRoot || item.root.startsWith(subRoot + '/') || subRoot.startsWith(item.root + '/'))) throw Error('Duplicate or nested subpackage roots are unsupported');
    if (!fs.existsSync(path.join(root, subRoot)) || !fs.lstatSync(path.join(root, subRoot)).isDirectory()) throw Error(`Missing subpackage directory: ${subRoot}`);
    packages.push({name: definition.name || subRoot, root: subRoot, bytes: 0, files: 0, limit: LIMITS.subpackage});
  }
  const oversizedMedia = [], errors = [], warnings = [];
  let mediaCount = 0, mediaTotalBytes = 0;
  const defaultIgnored = file => file.split('/').some(part => DEFAULT_DIRS.has(part)) || DEFAULT_FILES.has(path.posix.basename(file));
  const included = file => include.some(rule => rule.matches(file)) || (!defaultIgnored(file) && !ignore.some(rule => rule.matches(file)));
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Avoid traversing dependency and Git trees unless an explicit include may restore a file.
        if (DEFAULT_DIRS.has(entry.name) && !include.some(rule => rule.mayContain(relative))) continue;
        walk(absolute, relative);
      } else if (included(relative)) {
        if (!entry.isFile()) { errors.push(`Unsupported non-regular package entry: ${relative}`); continue; }
        const bytes = fs.statSync(absolute).size;
        const bucket = packages.slice(1).find(item => relative.startsWith(item.root + '/')) || packages[0];
        bucket.bytes += bytes; bucket.files++;
        // DevTools' aggregate quality item concerns images and audio across all packages.
        if (IMAGE_AUDIO.test(relative)) mediaTotalBytes += bytes;
        if (MEDIA.test(relative)) {
          mediaCount++;
          if (bytes > LIMITS.media) oversizedMedia.push({path: relative, bytes});
        }
      }
    }
  }
  walk(root);
  for (const bucket of packages) if (bucket.bytes >= bucket.limit) errors.push(`${bucket.root || 'main'} source estimate must be < ${bucket.limit} bytes (found ${bucket.bytes})`);
  for (const item of oversizedMedia) errors.push(`Media must be <= ${LIMITS.media} bytes: ${item.path} (${item.bytes})`);
  if (mediaTotalBytes >= LIMITS.media) warnings.push(`All-package image/audio source total is ${mediaTotalBytes} bytes, not < ${LIMITS.media} bytes. This exceeds the official image/audio quality threshold; local per-file checks do not satisfy that quality item. Confirm with the official compiled scan.`);
  if (app.lazyCodeLoading !== 'requiredComponents') errors.push('app.json lazyCodeLoading must be "requiredComponents"');
  return {packages, mediaCount, mediaTotalBytes, oversizedMedia, lazyCodeLoading: app.lazyCodeLoading, errors, warnings};
}
function main() {
  console.log('Package source estimate / 源文件估算（未编译、未压缩；不是微信官方编译或上传包体）。');
  try {
    const report = estimateProject(path.resolve(__dirname, '..'));
    for (const bucket of report.packages) console.log(`${bucket.root ? `subpackage ${bucket.name} [${bucket.root}]` : 'main'}: ${bucket.bytes} bytes (${(bucket.bytes / 1024).toFixed(1)} KiB), ${bucket.files} files; limit < ${bucket.limit} bytes`);
    console.log(`Images/audio/video: ${report.mediaCount} files; local extra per-file limit <= ${LIMITS.media} bytes. lazyCodeLoading: ${report.lazyCodeLoading || '(missing)'}`);
    console.log(`Image/audio total across all packages (source estimate): ${report.mediaTotalBytes} bytes (${(report.mediaTotalBytes / 1024).toFixed(1)} KiB). Official aggregate threshold: < ${LIMITS.media} bytes.`);
    console.log('Official package quality uses uncompressed dev compilation (< 1.5 MiB per package), not this source estimate or compressed preview size.');
    report.warnings.forEach(warning => console.warn(`WARN: ${warning}`));
    if (report.errors.length) { report.errors.forEach(error => console.error(`FAIL: ${error}`)); process.exitCode = 1; }
    else console.log('PASS: 本地包体预检；官方质量扫描另计 (local source limits and lazy loading only)');
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}
if (require.main === module) main();
module.exports = {estimateProject, LIMITS};
