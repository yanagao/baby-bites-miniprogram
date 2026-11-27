'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {validProfilePhotoPath, prepareProfilePhoto} = require('../utils/profile-photo');
const KB = 1024, MB = 1024 * KB;
const SOURCE = 'wxfile://tmp/avatar-selected.jpg';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const JPG = Buffer.from([255, 216, 255, 1]);

function setup(original = {size: 3 * MB, width: 4000, height: 3000, bytes: JPG}) {
  const files = new Map([[SOURCE, original]]), calls = {compress: [], unlink: [], info: [], read: []}, hooks = {};
  let current = true;
  const stale = Object.assign(Error('账号已变化'), {code: 'ACCOUNT_CHANGED'});
  const dispatch = (args, work) => Promise.resolve().then(work).then(args.success, args.fail);
  const manager = {
    getFileInfo(args) { dispatch(args, () => { calls.info.push(args.filePath); return {size: files.get(args.filePath).size}; }); },
    readFile(args) { dispatch(args, () => { calls.read.push(args.filePath); if (hooks.read) hooks.read(); return {data: files.get(args.filePath).bytes}; }); },
    unlink(args) { dispatch(args, () => { calls.unlink.push(args.filePath); files.delete(args.filePath); return {}; }); }
  };
  const api = {
    getFileSystemManager: () => manager,
    getImageInfo(args) { dispatch(args, () => {
      const file = files.get(args.src); return {width: file.width, height: file.height};
    }); },
    compressImage(args) { dispatch(args, () => {
      calls.compress.push(args);
      if (hooks.compress) return hooks.compress(args, calls.compress.length);
      const tempFilePath = 'wxfile://tmp/avatar-compressed-' + calls.compress.length;
      files.set(tempFilePath, {size: 200 * KB, width: args.compressedWidth, height: args.compressedHeight, bytes: JPG});
      return {tempFilePath};
    }); }
  };
  return {files, calls, hooks, stale, expire() { current = false; },
    prepare(path = SOURCE) { return prepareProfilePhoto(api, path, {assertCurrent() { if (!current) throw stale; }}); }};
}

test('avatars accept only native local path forms, never remote or cloud sources', () => {
  for (const value of ['wxfile://tmp/avatar.jpg', 'http://tmp/avatar.jpg', 'https://usr/avatar.png', '/var/tmp/avatar.jpg']) {
    assert.equal(validProfilePhotoPath(value), true, value);
  }
  for (const value of ['', null, undefined, {}, 'https://example.com/a.jpg', 'cloud://env/users/a.jpg',
    '//host/a.jpg', 'a.jpg', 'https://tmp.evil/a.jpg', 'wxfile://tmp/a\0.jpg']) {
    assert.equal(validProfilePhotoPath(value), false, String(value));
  }
});

test('small JPG and PNG avatars reuse the selected file and cleanup never deletes it', async () => {
  for (const [bytes, extension] of [[JPG, 'jpg'], [PNG, 'png']]) {
    const app = setup({size: 100 * KB, width: 750, height: 750, bytes});
    const result = await app.prepare();
    assert.equal(result.filePath, SOURCE); assert.equal(result.extension, extension);
    assert.equal(app.calls.compress.length, 0);
    await result.cleanup(); await result.cleanup();
    assert.deepEqual(app.calls.unlink, []); assert.ok(app.files.has(SOURCE));
  }
});

test('large landscape and portrait avatars resize proportionally without upscaling', async () => {
  for (const [width, height, expected] of [[4000, 3000, [750, 562]], [3000, 4000, [562, 750]], [500, 300, [500, 300]]]) {
    const app = setup({size: 3 * MB, width, height, bytes: JPG});
    const result = await app.prepare();
    assert.equal(app.calls.compress.length, 1);
    assert.deepEqual([app.calls.compress[0].compressedWidth, app.calls.compress[0].compressedHeight], expected);
    assert.ok(app.files.has(result.filePath));
    await result.cleanup();
    assert.deepEqual(app.calls.unlink, [result.filePath]); assert.ok(app.files.has(SOURCE));
  }
});

test('avatar compression is bounded and verifies each output size instead of trusting resize options', async () => {
  for (const succeeds of [false, true]) {
    const app = setup();
    app.hooks.compress = (args, pass) => {
      const tempFilePath = 'wxfile://tmp/avatar-pass-' + pass;
      app.files.set(tempFilePath, {size: succeeds && pass === 3 ? 200 * KB : 2 * MB,
        width: args.compressedWidth, height: args.compressedHeight, bytes: JPG});
      return {tempFilePath};
    };
    if (succeeds) { const result = await app.prepare(); assert.equal(result.filePath, 'wxfile://tmp/avatar-pass-3'); await result.cleanup(); }
    else await assert.rejects(app.prepare(), error => error.code === 'INVALID_PROFILE_AVATAR');
    assert.equal(app.calls.compress.length, 3); assert.equal(app.calls.unlink.length, 3);
    assert.ok(app.files.has(SOURCE));
  }
});

test('ignored resize options and no-op compression fail without deleting the selected avatar', async () => {
  for (const noOp of [true, false]) {
    const app = setup();
    app.hooks.compress = () => {
      if (noOp) return {tempFilePath: SOURCE};
      const tempFilePath = 'wxfile://tmp/still-too-large';
      app.files.set(tempFilePath, {size: 100 * KB, width: 4000, height: 3000, bytes: JPG});
      return {tempFilePath};
    };
    await assert.rejects(app.prepare(), error => error.code === 'INVALID_PROFILE_AVATAR');
    assert.equal(app.calls.compress.length, 3); assert.ok(app.files.has(SOURCE));
    assert.equal(app.calls.unlink.includes(SOURCE), false);
    assert.equal(app.calls.unlink.length, noOp ? 0 : 1);
  }
});

test('avatar metadata limits and actual image bytes are validated before upload', async () => {
  for (const changes of [{size: 10 * MB + 1}, {size: 0}, {width: 0}, {height: 2.5},
    {bytes: Buffer.from('GIF89a')}, {bytes: null}, {bytes: Buffer.concat([PNG, Buffer.alloc(MB)])}]) {
    const app = setup({size: 100 * KB, width: 640, height: 480, bytes: PNG, ...changes});
    await assert.rejects(app.prepare(), error => error.code === 'INVALID_PROFILE_AVATAR');
    assert.ok(app.files.has(SOURCE));
  }
});

test('late compression and file-read results after an identity change release derived files but retain the draft', async () => {
  for (const phase of ['compress', 'read']) {
    const app = setup(), temporary = 'wxfile://tmp/late-avatar';
    app.hooks.compress = args => {
      app.files.set(temporary, {size: 100 * KB, width: args.compressedWidth, height: args.compressedHeight, bytes: PNG});
      if (phase === 'compress') app.expire();
      return {tempFilePath: temporary};
    };
    if (phase === 'read') app.hooks.read = () => app.expire();
    await assert.rejects(app.prepare(), error => error === app.stale);
    assert.deepEqual(app.calls.unlink, [temporary]); assert.ok(app.files.has(SOURCE));
  }
});

test('a failed compression preserves the selected avatar for another save attempt', async () => {
  const app = setup(); app.hooks.compress = () => { throw Error('compress failed'); };
  await assert.rejects(app.prepare(), error => error.code === 'INVALID_PROFILE_AVATAR');
  assert.ok(app.files.has(SOURCE)); assert.deepEqual(app.calls.unlink, []);
  delete app.hooks.compress;
  const result = await app.prepare(); await result.cleanup(); assert.ok(app.files.has(SOURCE));
});
