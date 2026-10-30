'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const {getProfileAvatar} = require('../utils/profile-avatar');
const avatars = [
  '/assets/cute/avatar-broccoli.png', '/assets/cute/avatar-pea.png', '/assets/cute/pantry-bowl.png',
  '/assets/cute/avatar-eggplant.png', '/assets/cute/pocket-mascot.png'
];

test('public profile avatars keep their fixed five-slot order and use the complete ID without precision loss', () => {
  avatars.forEach((avatar, index) => assert.equal(getProfileAvatar(index.toString(16).padStart(32, '0')), avatar));
  for (const id of ['f'.repeat(32), 'f'.repeat(31) + 'e', '80000000000000000000000000000001',
    '00000000000000010000000000000000', 'abcdef0123456789fedcba9876543210']) {
    const expected = avatars[Number(BigInt('0x' + id) % 5n)];
    assert.equal(getProfileAvatar(id), expected);
    assert.equal(getProfileAvatar(id.toUpperCase()), expected);
  }
});

test('stable account hashes reach all five avatars with a balanced distribution', () => {
  const counts = avatars.map(() => 0);
  for (let index = 0; index < 1000; index++) {
    const profileId = crypto.createHash('sha256').update('public-profile:test-account-' + index).digest('hex').slice(0, 32);
    const avatar = getProfileAvatar(profileId);
    assert.equal(avatar, avatars[Number(BigInt('0x' + profileId) % 5n)]);
    counts[avatars.indexOf(avatar)]++;
  }
  counts.forEach(count => assert.ok(count >= 150 && count <= 250, 'account hashes should distribute across the five fixed mascots'));
});

test('invalid or absent public IDs return the brand mascot without coercing arbitrary values', () => {
  for (const value of [undefined, null, '', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), ' ' + 'a'.repeat(32),
    'a'.repeat(32) + '\n', '../assets/avatar.png', 12, false, [], {}, new String('a'.repeat(32))]) {
    assert.equal(getProfileAvatar(value), avatars[4]);
  }
});

test('avatar selection is identical across fresh runtimes and needs no device, storage, time or random source', () => {
  const source = fs.readFileSync(require.resolve('../utils/profile-avatar'), 'utf8');
  const id = '13579bdf02468ace13579bdf02468ace';
  for (let index = 0; index < 3; index++) {
    const module = {exports: {}};
    const context = {module, exports: module.exports, require() { throw Error('No runtime dependency allowed'); }};
    Object.defineProperty(context, 'wx', {get() { throw Error('No device or storage access allowed'); }});
    Object.defineProperty(context, 'Date', {get() { throw Error('No time dependency allowed'); }});
    Object.defineProperty(context, 'Math', {get() { throw Error('No random dependency allowed'); }});
    vm.runInNewContext(source, context);
    assert.equal(module.exports.getProfileAvatar(id), getProfileAvatar(id));
  }
});
