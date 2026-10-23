#!/usr/bin/env node
'use strict';

// Preserve the paths in TDesign's published mini-program files; do not bundle
// its all-component index. The same resolver validates the finished project.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const packageName = 'tdesign-miniprogram';
const output = path.join(root, 'miniprogram_npm', packageName);
const componentExtensions = ['.js', '.json', '.wxml', '.wxss'];
const textExtensions = new Set(['.js', '.json', '.wxml', '.wxss', '.wxs']);
const assetPattern = /\.(?:png|jpe?g|gif|webp|svg|avif|ico|ttf|otf|woff2?|eot|mp3|mp4|wav)$/i;
const runtimeIgnored = new Set(['node_modules', '.git', 'output', 'tests', 'scripts', 'cloudfunctions', 'cloud']);
const relative = (base, file) => path.relative(base, file).split(path.sep).join('/');
const inside = (base, file) => file === base || file.startsWith(base + path.sep);

function walk(directory, ignored = new Set()) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file, ignored) : [file];
    });
}

function localReference(value) {
  return value && !value.includes('{{') && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value);
}

function references(file) {
  const ext = path.extname(file);
  if (!textExtensions.has(ext)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const found = [];
  const add = (value, kind) => {
    if (localReference(value)) found.push({ value: value.split(/[?#]/)[0], kind });
  };
  if (ext === '.json') {
    const data = JSON.parse(text);
    Object.values(data.usingComponents || {}).forEach(value => add(value, 'component'));
    Object.values(data.componentGenerics || {}).forEach(value => {
      if (value && typeof value.default === 'string') add(value.default, 'component');
    });
  }
  if (ext === '.js' || ext === '.wxs') {
    const imports = /\b(?:import|export)\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(['"])([^'"]+)\1/g;
    const sideEffects = /\bimport\s*(['"])([^'"]+)\1/g;
    const requires = /\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
    for (const pattern of [imports, sideEffects, requires]) {
      for (const match of text.matchAll(pattern)) add(match[2], ext === '.wxs' ? 'wxs' : 'module');
    }
    for (const match of text.matchAll(/(['"])(\.{1,2}\/[^'"\s]+)\1/g)) {
      if (assetPattern.test(match[2])) add(match[2], 'asset');
    }
  }
  if (ext === '.wxml') {
    for (const match of text.matchAll(/<([\w-]+)\b[^>]*?\b(?:src|poster)\s*=\s*(['"])(.*?)\2[^>]*>/gs)) {
      const kind = ['import', 'include'].includes(match[1]) ? 'wxml' : match[1] === 'wxs' ? 'wxs' : 'asset';
      add(match[3], kind);
    }
  }
  if (ext === '.wxss') {
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?(['"])([^'"]+)\1/g)) add(match[2], 'wxss');
    for (const match of text.matchAll(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/g)) add(match[2], 'asset');
  }
  return found;
}

function fileCandidate(base, kind) {
  const suffixes = kind === 'module' ? ['', '.js', '.json', '/index.js']
    : kind === 'wxs' ? ['', '.wxs', '/index.wxs']
    : kind === 'component' ? ['.json']
    : kind === 'wxml' ? ['', '.wxml']
    : kind === 'wxss' ? ['', '.wxss'] : [''];
  return suffixes.map(suffix => base + suffix).find(file => fs.existsSync(file) && fs.statSync(file).isFile());
}

function resolveReference(from, reference, boundary, npmRoot) {
  const { value, kind } = reference;
  let candidates = [];
  if (value.startsWith('/')) candidates = [path.join(boundary, value)];
  else if (value.startsWith('.')) candidates = [path.resolve(path.dirname(from), value)];
  else if (kind === 'component' || kind === 'module') {
    for (let dir = path.dirname(from); inside(boundary, dir); dir = path.dirname(dir)) {
      candidates.push(path.join(dir, 'miniprogram_npm', value));
      if (dir === boundary) break;
    }
    if (npmRoot) candidates.push(path.join(npmRoot, value));
    if (kind === 'component') candidates.push(path.resolve(path.dirname(from), value));
  } else candidates = [path.resolve(path.dirname(from), value)];
  for (const base of candidates) {
    if (!inside(boundary, base)) continue;
    const found = fileCandidate(base, kind);
    if (found) return found;
  }
  throw new Error(`${relative(boundary, from)}: missing ${kind} dependency ${value}`);
}

function componentFiles(jsonFile) {
  const base = jsonFile.slice(0, -'.json'.length);
  return componentExtensions.map(ext => {
    const file = base + ext;
    if (!fs.existsSync(file)) throw new Error(`Incomplete component: ${file}`);
    return file;
  });
}

function checkDependencies() {
  const files = walk(root, runtimeIgnored).filter(file => path.basename(file) !== 'project.private.config.json');
  let count = 0;
  const errors = [];
  for (const file of files) {
    try {
      for (const reference of references(file)) {
        const resolved = resolveReference(file, reference, root);
        if (reference.kind === 'component') componentFiles(resolved);
        count++;
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return count;
}

function build() {
  const packageRoot = path.join(root, 'node_modules', packageName);
  if (!fs.existsSync(path.join(packageRoot, 'package.json'))) throw new Error('Run npm ci before building TDesign components.');
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies[packageName];
  if (metadata.version !== pinned) throw new Error(`Expected TDesign ${pinned}, found ${metadata.version}; run npm ci.`);
  const source = path.join(packageRoot, metadata.miniprogram || 'miniprogram_dist');
  const entries = new Set();
  const configs = [path.join(root, 'app.json'), ...['pages', 'components', 'custom-tab-bar'].flatMap(dir => walk(path.join(root, dir)))];
  for (const file of configs.filter(file => path.extname(file) === '.json')) {
    for (const reference of references(file).filter(item => item.kind === 'component')) {
      const entry = reference.value.replace(/^\/?miniprogram_npm\/tdesign-miniprogram\//, '').replace(/^tdesign-miniprogram\//, '');
      if (entry !== reference.value) entries.add(entry);
    }
  }
  if (!entries.size) throw new Error('No TDesign components are registered in app/pages/components/custom-tab-bar JSON. Existing output was left intact.');
  const collected = new Set();
  const queue = [];
  function add(file) {
    if (!inside(source, file)) throw new Error(`Dependency escapes TDesign package: ${file}`);
    if (!collected.has(file)) { collected.add(file); queue.push(file); }
  }
  function addComponent(base) {
    const json = fileCandidate(base, 'component');
    if (!json) throw new Error(`Missing TDesign component: ${relative(source, base)}`);
    componentFiles(json).forEach(add);
  }
  [...entries].sort().forEach(entry => addComponent(path.resolve(source, entry)));
  // Keep shared templates/styles together; follow their JS dependencies too.
  walk(path.join(source, 'common')).filter(file => !file.endsWith('.d.ts')).forEach(add);
  for (let index = 0; index < queue.length; index++) {
    const file = queue[index];
    for (const reference of references(file)) {
      const resolved = resolveReference(file, reference, source, path.join(source, 'miniprogram_npm'));
      if (reference.kind === 'component') componentFiles(resolved).forEach(add);
      else add(resolved);
    }
  }
  const license = path.join(packageRoot, 'LICENSE');
  if (!fs.existsSync(license)) throw new Error('TDesign LICENSE is missing; refusing to produce an unlicensed copy.');
  const bytes = [...collected].reduce((total, file) => total + fs.statSync(file).size, fs.statSync(license).size);
  if (!process.argv.includes('--dry-run')) {
    // Resolve everything before deleting only this generated package directory.
    fs.rmSync(output, { recursive: true, force: true });
    for (const file of [...collected].sort()) {
      const destination = path.join(output, relative(source, file));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }
    fs.copyFileSync(license, path.join(output, 'LICENSE'));
  }
  console.log(`TDesign ${metadata.version}: ${entries.size} registered components, ${collected.size + 1} files, ${(bytes / 1024).toFixed(1)} KiB${process.argv.includes('--dry-run') ? ' (dry run)' : ''}`);
  console.log(`Entries: ${[...entries].sort().join(', ')}`);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--check')) console.log(`PASS: ${checkDependencies()} local runtime dependencies resolve`);
    else build();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { references, resolveReference, checkDependencies };
