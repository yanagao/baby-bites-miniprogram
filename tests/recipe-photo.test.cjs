'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const KB = 1024, MB = 1024 * KB;
const SOURCE = 'wxfile://usr/original-photo.png';

function setup(original = {size: 4 * MB, width: 4000, height: 3000}) {
  const files = new Map([[SOURCE, {...original}]]), calls = {info: [], images: [], compress: [], unlinks: []}, hooks = {};
  let current = true, guards = 0;
  const stale = Object.assign(Error('账号已变化'), {code: 'ACCOUNT_CHANGED'});
  const dispatch = (options, work) => Promise.resolve().then(work).then(options.success, options.fail);
  const manager = {
    getFileInfo(options) { dispatch(options, () => {
      calls.info.push(options.filePath);
      if (hooks.info) return hooks.info(options.filePath);
      if (!files.has(options.filePath)) throw Error('ENOENT');
      return {size: files.get(options.filePath).size};
    }); },
    unlink(options) { dispatch(options, () => {
      calls.unlinks.push(options.filePath);
      if (hooks.unlink) return hooks.unlink(options.filePath);
      files.delete(options.filePath); return {};
    }); }
  };
  const wx = {
    getFileSystemManager: () => manager,
    getImageInfo(options) { dispatch(options, () => {
      calls.images.push(options.src);
      if (hooks.image) return hooks.image(options.src);
      const image = files.get(options.src); if (!image) throw Error('bad image');
      return {width: image.width, height: image.height};
    }); },
    compressImage(options) { dispatch(options, () => {
      calls.compress.push({src: options.src, quality: options.quality,
        width: options.compressedWidth, height: options.compressedHeight});
      if (hooks.compress) return hooks.compress(options, calls.compress.length);
      const tempFilePath = 'wxfile://tmp/compressed-' + calls.compress.length;
      files.set(tempFilePath, {size: 300 * KB, width: options.compressedWidth, height: options.compressedHeight});
      return {tempFilePath};
    }); }
  };
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/recipe-photo.js'), 'utf8'), {module, wx});
  return {files, calls, hooks, wx, stale,
    expire() { current = false; }, guards: () => guards,
    prepare(filePath = SOURCE) { return module.exports.prepareRecipePhoto(filePath, {assertCurrent() { guards++; if (!current) throw stale; }}); }
  };
}

test('small photos are reused without compression or touching the original during repeated cleanup', async () => {
  const app = setup({size: 512 * KB, width: 1600, height: 1200});
  const result = await app.prepare();
  assert.equal(result.filePath, SOURCE); assert.equal(app.calls.compress.length, 0);
  await result.cleanup(); await result.cleanup();
  assert.deepEqual(app.calls.unlinks, []); assert.ok(app.files.has(SOURCE));
});

test('large portrait and landscape photos are resized proportionally and temporary files survive until cleanup', async t => {
  for (const [width, height, expected] of [[4000, 3000, [1600, 1200]], [3000, 4000, [1200, 1600]]]) {
    await t.test(width + 'x' + height, async () => {
      const app = setup({size: 20 * MB, width, height});
      const result = await app.prepare();
      assert.deepEqual(app.calls.compress, [{src: SOURCE, quality: 80, width: expected[0], height: expected[1]}]);
      assert.ok(app.files.has(result.filePath)); assert.equal(app.calls.info.length, 2); assert.equal(app.calls.images.length, 2);
      await Promise.all([result.cleanup(), result.cleanup()]);
      assert.deepEqual(app.calls.unlinks, [result.filePath]); assert.ok(app.files.has(SOURCE));
    });
  }
});

test('oversized bytes in a small image do not cause upscaling', async () => {
  const app = setup({size: 3 * MB, width: 500, height: 300});
  await app.prepare();
  assert.equal(app.calls.compress[0].width, 500); assert.equal(app.calls.compress[0].height, 300);
});

test('hard-to-compress images use bounded quality and size passes based on the original', async () => {
  const app = setup();
  app.hooks.compress = (options, pass) => {
    const tempFilePath = 'wxfile://tmp/pass-' + pass;
    app.files.set(tempFilePath, {size: pass < 3 ? 900 * KB : 400 * KB, width: options.compressedWidth, height: options.compressedHeight});
    return {tempFilePath};
  };
  const result = await app.prepare();
  assert.deepEqual(app.calls.compress, [
    {src: SOURCE, quality: 80, width: 1600, height: 1200},
    {src: SOURCE, quality: 65, width: 1280, height: 960},
    {src: SOURCE, quality: 50, width: 960, height: 720}
  ]);
  assert.equal(result.filePath, 'wxfile://tmp/pass-3'); await result.cleanup();
  assert.equal(app.calls.unlinks.length, 3); assert.ok(app.files.has(SOURCE));
});

test('the smallest qualifying file is retained when later passes grow, with a 2 MB hard limit', async () => {
  const app = setup();
  app.hooks.compress = (options, pass) => {
    const tempFilePath = 'wxfile://tmp/pass-' + pass;
    app.files.set(tempFilePath, {size: [700 * KB, 1000 * KB, 800 * KB][pass - 1], width: options.compressedWidth, height: options.compressedHeight});
    return {tempFilePath};
  };
  const result = await app.prepare(); assert.equal(result.filePath, 'wxfile://tmp/pass-1');
  await result.cleanup(); assert.ok(app.files.has(SOURCE));
});

test('compression never replaces an already smaller qualifying original with a larger result', async () => {
  const app = setup({size: 600 * KB, width: 900, height: 600});
  app.hooks.compress = (options, pass) => {
    const tempFilePath = 'wxfile://tmp/pass-' + pass;
    app.files.set(tempFilePath, {size: 900 * KB, width: options.compressedWidth, height: options.compressedHeight});
    return {tempFilePath};
  };
  const result = await app.prepare(); assert.equal(result.filePath, SOURCE);
  await result.cleanup(); assert.equal(app.calls.unlinks.length, 3); assert.ok(app.files.has(SOURCE));
});

test('a reused temporary path cannot retain stale metadata after a later pass overwrites it', async () => {
  const app = setup(), temporary = 'wxfile://tmp/reused';
  app.hooks.compress = (options, pass) => {
    app.files.set(temporary, {size: pass === 1 ? 700 * KB : 3 * MB,
      width: options.compressedWidth, height: options.compressedHeight});
    return {tempFilePath: temporary};
  };
  await assert.rejects(app.prepare(), error => error.code === 'PHOTO_COMPRESSION_FAILED');
  assert.equal(app.calls.compress.length, 3); assert.deepEqual(app.calls.unlinks, [temporary]);
  assert.ok(app.files.has(SOURCE));
});

test('no-op compression keeps an acceptable original and never removes it', async () => {
  const app = setup({size: 600 * KB, width: 900, height: 600});
  app.hooks.compress = () => ({tempFilePath: SOURCE});
  const result = await app.prepare(); assert.equal(result.filePath, SOURCE); assert.equal(app.calls.compress.length, 3);
  await result.cleanup(); assert.deepEqual(app.calls.unlinks, []); assert.ok(app.files.has(SOURCE));
});

test('ignored resize options and still-oversized outputs fail after three passes and preserve source files', async t => {
  for (const mode of ['dimensions', 'bytes', 'no-op']) await t.test(mode, async () => {
    const app = setup();
    app.hooks.compress = (options, pass) => {
      if (mode === 'no-op') return {tempFilePath: SOURCE};
      const tempFilePath = 'wxfile://tmp/pass-' + pass;
      app.files.set(tempFilePath, mode === 'dimensions' ? {size: 100 * KB, width: 4000, height: 3000} :
        {size: 2 * MB + 1, width: options.compressedWidth, height: options.compressedHeight});
      return {tempFilePath};
    };
    await assert.rejects(app.prepare(), error => error.code === 'PHOTO_COMPRESSION_FAILED');
    assert.equal(app.calls.compress.length, 3); assert.ok(app.files.has(SOURCE));
    assert.equal(app.calls.unlinks.length, mode === 'no-op' ? 0 : 3);
  });
});

test('invalid source paths, byte counts and dimensions fail before compression', async t => {
  for (const value of ['', null, {}, 'bad\npath']) await t.test('path ' + String(value), async () => {
    const app = setup(); await assert.rejects(app.prepare(value), error => error.code === 'INVALID_RECIPE_PHOTO');
    assert.equal(app.calls.info.length, 0); assert.equal(app.calls.compress.length, 0);
  });
  for (const invalid of [{size: 0}, {size: -1}, {size: Infinity}, {size: 20 * MB + 1},
    {width: 0}, {height: NaN}, {height: 2.5}]) await t.test(JSON.stringify(invalid), async () => {
    const app = setup({size: 1 * MB, width: 1000, height: 800, ...invalid});
    await assert.rejects(app.prepare(), error => error.code === 'INVALID_RECIPE_PHOTO');
    assert.equal(app.calls.compress.length, 0); assert.deepEqual(app.calls.unlinks, []);
  });
});

test('unreadable source files have a stable recovery code, including unavailable APIs', async t => {
  for (const mode of ['file', 'image', 'api', 'filesystem']) await t.test(mode, async () => {
    const app = setup();
    if (mode === 'file') app.files.delete(SOURCE);
    if (mode === 'image') app.hooks.image = () => { throw Error('decode failed'); };
    if (mode === 'api') delete app.wx.getImageInfo;
    if (mode === 'filesystem') app.wx.getFileSystemManager = () => { throw Error('runtime unavailable'); };
    await assert.rejects(app.prepare(), error => error.code === 'PHOTO_UNREADABLE' && /照片无法读取/.test(error.userMessage));
    assert.equal(app.calls.compress.length, 0); assert.deepEqual(app.calls.unlinks, []);
  });
});

test('compression errors and invalid output metadata reject and reclaim only new files', async t => {
  for (const mode of ['reject', 'missing', 'empty', 'unreadable', 'size', 'dimensions', 'oversized']) await t.test(mode, async () => {
    const app = setup(), output = 'wxfile://tmp/bad-output';
    app.hooks.compress = () => {
      if (mode === 'reject') throw Error('compress failed');
      if (mode === 'missing') return {};
      if (mode === 'empty') return {tempFilePath: ''};
      if (mode !== 'unreadable') app.files.set(output, {size: mode === 'size' ? 0 : mode === 'oversized' ? 20 * MB + 1 : 100 * KB,
        width: mode === 'dimensions' ? 0 : 1000, height: 700});
      return {tempFilePath: output};
    };
    await assert.rejects(app.prepare(), error => error.code === 'PHOTO_COMPRESSION_FAILED');
    assert.ok(app.files.has(SOURCE)); assert.equal(app.files.has(output), false);
    assert.deepEqual(app.calls.unlinks, ['reject', 'missing', 'empty'].includes(mode) ? [] : [output]);
  });
});

test('account changes during every async stage propagate the guard error and clean late compression results', async t => {
  for (const stage of ['before', 'source-info', 'source-image', 'compress', 'output-info', 'output-image']) await t.test(stage, async () => {
    const app = setup(), output = 'wxfile://tmp/late-photo';
    if (stage === 'before') app.expire();
    app.hooks.info = file => { if (stage === (file === SOURCE ? 'source-info' : 'output-info')) app.expire(); return {size: app.files.get(file).size}; };
    app.hooks.image = file => { if (stage === (file === SOURCE ? 'source-image' : 'output-image')) app.expire(); return app.files.get(file); };
    app.hooks.compress = options => {
      app.files.set(output, {size: 200 * KB, width: options.compressedWidth, height: options.compressedHeight});
      if (stage === 'compress') app.expire(); return {tempFilePath: output};
    };
    await assert.rejects(app.prepare(), error => error === app.stale);
    assert.ok(app.files.has(SOURCE)); assert.equal(app.files.has(output), false);
    assert.equal(app.calls.compress.length, ['compress', 'output-info', 'output-image'].includes(stage) ? 1 : 0);
  });
});

test('cleanup is idempotent and best-effort after unlink failure without hiding the preparation error', async () => {
  const app = setup(); app.hooks.unlink = () => { throw Error('already gone'); };
  const result = await app.prepare(); await result.cleanup(); await result.cleanup();
  assert.equal(app.calls.unlinks.length, 1); assert.ok(app.files.has(SOURCE));
  const failed = setup(); failed.hooks.unlink = () => { throw Error('cleanup failed'); };
  failed.hooks.compress = () => { failed.expire(); return {tempFilePath: 'wxfile://tmp/late-photo'}; };
  await assert.rejects(failed.prepare(), error => error === failed.stale);
  const unavailable = setup();
  const prepared = await unavailable.prepare();
  unavailable.wx.getFileSystemManager = () => { throw Error('runtime closed'); };
  await prepared.cleanup();
  assert.ok(unavailable.files.has(SOURCE));
});
