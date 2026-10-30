'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createHandler} = require('../cloudfunctions/babyBitesSync');
const {MAX_SNAPSHOT_BYTES, ownedFile, validateSnapshot} = require('../cloudfunctions/babyBitesSync/validate');
const ENV = 'cloud1-test';
const APPID = 'wx-test';
const NOW = Date.parse('2026-10-23T04:00:00Z');
const ownerFor = openid => crypto.createHash('sha256').update(`${APPID}:${openid}`).digest('hex');
const fileFor = (owner, kind = 'snapshots', name = 'snapshot-1.json', env = ENV) =>
  `cloud://${env}.636c-${env}-123/users/${owner}/${kind}/${name}`;
const clone = value => JSON.parse(JSON.stringify(value));

function snapshot(owner = ownerFor('alice')) {
  return {
    version: 1,
    data: {version: 1, nickname: '宝宝', profileUpdatedAt: 0,
      recipes: [{id: 'recipe-1', name: '南瓜粥', category: '粥饭主食', texture: '软烂颗粒', minutes: 20,
        ingredients: [{name: '南瓜', amount: '20克'}], steps: ['煮熟后压软'], note: '',
        photo: fileFor(owner, 'photos', 'photo-1.jpg'), imageKey: 'pumpkin', favorite: false,
        isExample: false, createdAt: 0, updatedAt: NOW}],
      logs: [{id: 'log-1', recipeId: 'recipe-1', rating: 3, date: '2026-10-23',
        portion: '吃了一些', note: '', createdAt: NOW, updatedAt: NOW}]},
    deleted: {recipes: [], logs: []}
  };
}

test('both cloud snapshot validators accept optional age groups without inventing legacy values', () => {
  const validators = [validateSnapshot, require('../cloudfunctions/babyBitesSocial/private-snapshot').validateSnapshot];
  for (const validate of validators) {
    const check = data => validate(Buffer.from(JSON.stringify(data)), {env: ENV, owner: ownerFor('alice'), now: NOW});
    assert.equal(Object.hasOwn(check(snapshot()).data.recipes[0], 'ageGroups'), false);
    for (const [input, expected] of [[[], []], [['18+', '6-8', '6-8'], ['6-8', '18+']],
      [['18+', '12-17', '9-11', '6-8'], ['6-8', '9-11', '12-17', '18+']]]) {
      const data = snapshot(); data.data.recipes[0].ageGroups = input;
      assert.deepEqual(check(data).data.recipes[0].ageGroups, expected);
    }
    for (const ageGroups of [null, '', {}, '6-8', [6], ['all'], ['6-8', ''], Array(5).fill('6-8')]) {
      const data = snapshot(); data.data.recipes[0].ageGroups = ageGroups;
      assert.throws(() => check(data), error => error.code === 'INVALID_SNAPSHOT' && /适用月龄/.test(error.message));
    }
  }
});

test('committing a private snapshot accepts recipe ages while invalid age metadata never starts a transaction', async () => {
  const env = fakeEnvironment();
  const data = snapshot(); data.data.recipes[0].ageGroups = ['9-11', '12-17'];
  const fileID = env.upload('alice', 'age-valid.json', data);
  const result = await env.handler()({action: 'commit', baseRevision: 0, fileID});
  assert.equal(result.revision, 1);
  const writes = env.writes, transactions = env.transactionCount;
  data.data.recipes[0].ageGroups = ['6-8', 'private-note'];
  const invalid = env.upload('alice', 'age-invalid.json', data);
  const failed = await env.handler()({action: 'commit', baseRevision: 1, fileID: invalid});
  assert.equal(failed.error.code, 'INVALID_SNAPSHOT');
  assert.equal(env.writes, writes); assert.equal(env.transactionCount, transactions);
});

function fakeEnvironment() {
  const records = new Map();
  const files = new Map();
  const downloads = [];
  let transactionCount = 0;
  let writes = 0;
  let queue = Promise.resolve();
  const reference = (target, id) => ({
    async get() { return {data: target.has(id) ? clone(target.get(id)) : null}; },
    async set({data}) { target.set(id, clone(data)); writes += 1; }
  });
  const database = {
    collection(name) {
      assert.equal(name, 'baby_bites_accounts');
      return {doc: id => reference(records, id)};
    },
    async runTransaction(callback) {
      transactionCount += 1;
      const previous = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await previous;
      const pending = new Map(records);
      try {
        const result = await callback({collection: name => {
          assert.equal(name, 'baby_bites_accounts');
          return {doc: id => reference(pending, id)};
        }});
        records.clear();
        pending.forEach((record, id) => records.set(id, record));
        return result;
      } finally { unlock(); }
    }
  };
  return {
    records, files, downloads,
    get transactionCount() { return transactionCount; },
    get writes() { return writes; },
    handler(openid = 'alice', overrides = {}) {
      const cloud = {
        getWXContext: () => ({OPENID: openid, APPID, ENV}),
        database(options) { assert.equal(options.throwOnNotFound, false); return database; },
        async downloadFile({fileID}) {
          downloads.push(fileID);
          if (!files.has(fileID)) throw new Error('private resource details');
          return {statusCode: 200, fileContent: files.get(fileID)};
        },
        ...overrides
      };
      return createHandler({cloud, now: () => NOW});
    },
    upload(openid = 'alice', name = 'snapshot-1.json', data = snapshot(ownerFor(openid))) {
      const fileID = fileFor(ownerFor(openid), 'snapshots', name);
      files.set(fileID, Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data)));
      return fileID;
    }
  };
}

test('identity derives owner from trusted context and never reads a requested owner', async () => {
  const env = fakeEnvironment();
  env.records.set(ownerFor('bob'), {revision: 2, fileID: fileFor(ownerFor('bob')), updatedAt: NOW});
  const result = await env.handler()({action: 'identity', owner: ownerFor('bob'), openid: 'bob'});
  assert.deepEqual(result, {owner: ownerFor('alice'), revision: 0, fileID: ''});
  assert.equal(env.downloads.length, 0);
  assert.equal(env.writes, 0);
});

test('missing login identity cannot read or commit data', async () => {
  const env = fakeEnvironment();
  for (const context of [{APPID, ENV}, {OPENID: 'alice', ENV}, {}]) {
    const handler = env.handler('alice', {getWXContext: () => context});
    assert.equal((await handler({action: 'identity'})).error.code, 'UNAUTHENTICATED');
  }
  assert.equal(env.writes, 0);
});

test('first commit validates snapshot then atomically creates revision 1', async () => {
  const env = fakeEnvironment();
  const fileID = env.upload();
  const handler = env.handler();
  const result = await handler({action: 'commit', baseRevision: 0, fileID, owner: ownerFor('bob')});
  assert.deepEqual(result, {owner: ownerFor('alice'), revision: 1, fileID});
  assert.deepEqual(await handler({action: 'identity'}), result);
  assert.deepEqual(env.records.get(ownerFor('alice')), {revision: 1, fileID, updatedAt: NOW});
});

test('matching revision updates pointer without deleting previous files', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  const first = env.upload();
  await handler({action: 'commit', baseRevision: 0, fileID: first});
  const next = env.upload('alice', 'snapshot-2.json');
  assert.deepEqual(await handler({action: 'commit', baseRevision: 1, fileID: next}),
    {owner: ownerFor('alice'), revision: 2, fileID: next});
  assert.equal(env.files.has(first), true);
});

test('concurrent commits from one base revision produce one winner and a conflict', async () => {
  const env = fakeEnvironment();
  const first = env.upload('alice', 'device-1.json');
  const second = env.upload('alice', 'device-2.json');
  const results = await Promise.all([first, second].map(fileID =>
    env.handler()({action: 'commit', baseRevision: 0, fileID})));
  const winner = results.find(result => !result.conflict);
  const conflict = results.find(result => result.conflict);
  assert.deepEqual(conflict, {...winner, conflict: true});
  assert.equal(env.records.get(ownerFor('alice')).revision, 1);
  assert.equal(env.writes, 1);
});

test('different users can commit independently and read only their own pointer', async () => {
  const env = fakeEnvironment();
  for (const openid of ['alice', 'bob']) {
    const fileID = env.upload(openid);
    const handler = env.handler(openid);
    await handler({action: 'commit', baseRevision: 0, fileID});
    assert.deepEqual(await handler({action: 'identity', owner: ownerFor('charlie')}),
      {owner: ownerFor(openid), revision: 1, fileID});
  }
  assert.equal(env.records.size, 2);
});

test('other-account and other-environment files are rejected before any download', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  const owner = ownerFor('alice');
  const forbidden = [fileFor(ownerFor('bob')), fileFor(owner, 'snapshots', 'a.json', 'other-env'),
    fileFor(owner, 'photos', 'a.jpg'), `https://example.com/users/${owner}/snapshots/a.json`,
    fileFor(owner, 'snapshots', '../photos/a.json'), fileFor(owner, 'snapshots', 'a.json?x=1'),
    fileFor(owner, 'snapshots', '%2e%2e.json'), fileFor(owner, 'snapshots', 'a.JSON')];
  for (const fileID of forbidden) {
    assert.equal((await handler({action: 'commit', baseRevision: 0, fileID})).error.code, 'INVALID_FILE');
  }
  assert.equal(env.downloads.length, 0);
  assert.equal(env.transactionCount, 0);
});

test('invalid revision and unknown actions cannot mutate cloud state', async () => {
  const env = fakeEnvironment();
  const fileID = env.upload();
  for (const baseRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER]) {
    const result = await env.handler()({action: 'commit', baseRevision, fileID});
    assert.equal(result.error.code, 'INVALID_REQUEST');
  }
  for (const input of [null, [], {action: 'delete'}, {action: 'upload'}]) {
    assert.equal((await env.handler()(input)).error.code, 'INVALID_REQUEST');
  }
  assert.equal(env.writes, 0);
});

test('download failure does not expose diagnostics or advance revision', async () => {
  const env = fakeEnvironment();
  const result = await env.handler()({action: 'commit', baseRevision: 0, fileID: fileFor(ownerFor('alice'))});
  assert.equal(result.error.code, 'SYNC_FAILED');
  assert.equal(JSON.stringify(result).includes('private resource'), false);
  assert.equal(env.writes, 0);
});

test('corrupt account index fails closed instead of exposing a different account file', async () => {
  const env = fakeEnvironment();
  env.records.set(ownerFor('alice'), {revision: 1, fileID: fileFor(ownerFor('bob')), updatedAt: NOW});
  const result = await env.handler()({action: 'identity'});
  assert.equal(result.error.code, 'INVALID_ACCOUNT');
  assert.equal(JSON.stringify(result).includes(ownerFor('bob')), false);
});

test('invalid snapshot variants fail before opening the database transaction', async () => {
  const invalid = [
    data => { data.version = 2; },
    data => { data.data.nickname = ''; },
    data => { data.data.profileUpdatedAt = -1; },
    data => { data.data.recipes[0].minutes = 481; },
    data => { data.data.recipes[0].category = '其他'; },
    data => { data.data.recipes[0].texture = '未知口感'; },
    data => { data.data.recipes[0].ingredients = []; },
    data => { data.data.recipes[0].steps = []; },
    data => { data.data.recipes.push(clone(data.data.recipes[0])); },
    data => { data.data.recipes[0].photo = 'wxfile://usr/photo.jpg'; },
    data => { data.data.recipes[0].photo = fileFor(ownerFor('bob'), 'photos', 'photo.jpg'); },
    data => { data.data.recipes[0].photo = fileFor(ownerFor('alice'), 'photos', 'photo.jpg', 'other-env'); },
    data => { data.data.recipes[0].photo = fileFor(ownerFor('alice'), 'photos', 'photo.svg'); },
    data => { data.data.recipes[0].privateFile = fileFor(ownerFor('bob')); },
    data => { data.data.logs[0].recipeId = 'deleted-recipe'; },
    data => { data.data.logs[0].rating = 4; },
    data => { data.data.logs[0].date = '2026-02-30'; },
    data => { data.data.logs[0].date = '2026-10-24'; },
    data => { data.data.logs.push(clone(data.data.logs[0])); },
    data => { data.deleted.recipes = [{id: 'r', updatedAt: -1}]; },
    data => { data.deleted.logs = [{id: 'r', updatedAt: 1}, {id: 'r', updatedAt: 2}]; },
    data => { data.deleted = {}; }
  ];
  const env = fakeEnvironment();
  for (let index = 0; index < invalid.length; index += 1) {
    const data = snapshot();
    invalid[index](data);
    const fileID = env.upload('alice', `invalid-${index}.json`, data);
    const result = await env.handler()({action: 'commit', baseRevision: 0, fileID});
    assert.equal(result.error.code, 'INVALID_SNAPSHOT', `invalid case ${index}`);
  }
  assert.equal(env.transactionCount, 0);
  assert.equal(env.writes, 0);
});

test('snapshot byte limit and malformed JSON are enforced', async () => {
  const env = fakeEnvironment();
  for (const bytes of [Buffer.alloc(MAX_SNAPSHOT_BYTES + 1), Buffer.from('{'), Buffer.from('null'), Buffer.alloc(0)]) {
    const fileID = env.upload('alice', 'invalid.json', bytes);
    assert.equal((await env.handler()({action: 'commit', baseRevision: 0, fileID})).error.code, 'INVALID_SNAPSHOT');
  }
  assert.equal(env.transactionCount, 0);
});

test('snapshot supports empty albums, deleted records, and local date at UTC day boundary', () => {
  const data = snapshot();
  data.data.recipes[0].photo = '';
  data.deleted = {recipes: [{id: 'old-recipe', updatedAt: NOW}], logs: [{id: 'old-log', updatedAt: NOW}]};
  assert.deepEqual(validateSnapshot(Buffer.from(JSON.stringify(data)),
    {env: ENV, owner: ownerFor('alice'), now: Date.parse('2026-10-22T17:00:00Z')}), data);
  data.data.recipes = [];
  data.data.logs = [];
  assert.doesNotThrow(() => validateSnapshot(Buffer.from(JSON.stringify(data)), {env: ENV, owner: ownerFor('alice'), now: NOW}));
});

test('owned photo paths accept only supported formats and no path traversal', () => {
  for (const extension of ['jpg', 'png', 'webp']) {
    assert.equal(ownedFile(fileFor(ownerFor('alice'), 'photos', `p-1.${extension}`), ENV, ownerFor('alice'), 'photos'), true);
  }
  for (const name of ['../p.jpg', 'x/y.jpg', 'x%2fy.jpg', 'p.gif', 'p.jpeg', 'p.jpg#x']) {
    assert.equal(ownedFile(fileFor(ownerFor('alice'), 'photos', name), ENV, ownerFor('alice'), 'photos'), false);
  }
});
