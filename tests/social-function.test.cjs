'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createHandler, profileIdFor, recipeIdFor, COLLECTIONS, PAGE_SIZE} = require('../cloudfunctions/babyBitesSocial');
const ENV = 'cloud1-social-test';
const APPID = 'wx-social-test';
const NOW = Date.parse('2026-10-23T08:00:00Z');
const ownerFor = openid => crypto.createHash('sha256').update(`${APPID}:${openid}`).digest('hex');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const cloudFile = path => `cloud://${ENV}.bucket-123/${path}`;
const privateFile = (owner, path) => cloudFile(`users/${owner}/${path}`);
const JPG = Buffer.from([255, 216, 255, 224, 0, 1, 2, 3]);

function snapshot(openid = 'alice') {
  return {version: 1, data: {version: 1, nickname: 'Private baby name', profileUpdatedAt: NOW,
    recipes: [{id: 'recipe-1', name: '南瓜粥', category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
      ingredients: [{name: '南瓜', amount: '20克'}], steps: ['煮熟'], imageKey: 'pumpkin', photo: '',
      note: 'PRIVATE NOTE', favorite: true, isExample: false, createdAt: NOW - 10, updatedAt: NOW}],
    logs: [{id: 'meal-1', recipeId: 'recipe-1', rating: 3, date: '2026-10-23', note: 'PRIVATE MEAL',
      portion: '吃了一些', createdAt: NOW, updatedAt: NOW}]}, deleted: {recipes: [], logs: []}};
}

function fakeEnvironment() {
  const tables = new Map(Object.values(COLLECTIONS).map(name => [name, new Map()]));
  const files = new Map();
  const downloads = [];
  const uploads = [];
  const signed = [];
  const queries = [];
  let serial = 0;
  let queue = Promise.resolve();
  const matches = (record, conditions) => Object.entries(conditions).every(([key, value]) => {
    if (value && value.operator === 'in') return value.values.includes(record[key]);
    if (value && value.operator === 'gt') return record[key] > value.value;
    return record[key] === value;
  });
  function collection(name, target = tables) {
    if (!target.has(name)) throw new Error('Missing table');
    const table = target.get(name);
    const makeQuery = (condition = {}, sorts = [], skip = 0, limit = 100) => ({
      where(next) { return makeQuery(next, sorts, skip, limit); },
      orderBy(field, direction) { return makeQuery(condition, sorts.concat([{field, direction}]), skip, limit); },
      skip(value) { return makeQuery(condition, sorts, value, limit); },
      limit(value) { assert.ok(value <= 1000); return makeQuery(condition, sorts, skip, value); },
      async get() {
        queries.push({name, condition, sorts, skip, limit});
        const records = Array.from(table.values()).filter(item => matches(item, condition));
        records.sort((a, b) => {
          for (const {field, direction} of sorts) {
            if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        return {data: clone(records.slice(skip, skip + limit))};
      }
    });
    return {...makeQuery(), doc(id) {
      return {async get() { return {data: clone(table.get(id) || null)}; },
        async set({data}) { table.set(id, {_id: id, ...clone(data)}); }};
    }};
  }
  const database = {
    collection: name => collection(name),
    command: {in: values => ({operator: 'in', values}), gt: value => ({operator: 'gt', value})},
    async runTransaction(callback) {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const pending = new Map(Array.from(tables, ([name, records]) => [name, new Map(records)]));
      try {
        const value = await callback({collection: name => collection(name, pending)});
        for (const [name, records] of pending) {
          const target = tables.get(name);
          target.clear();
          for (const [id, record] of records) target.set(id, record);
        }
        return value;
      } finally { release(); }
    }
  };
  return {
    tables, files, downloads, uploads, signed, queries,
    table(name) { return tables.get(COLLECTIONS[name]); },
    handler(openid = 'alice', overrides = {}) {
      const cloud = {
        getWXContext: () => ({OPENID: openid, APPID, ENV}),
        database(options) { assert.equal(options.throwOnNotFound, false); return database; },
        async downloadFile({fileID}) {
          downloads.push(fileID);
          if (!files.has(fileID)) throw new Error('SECRET storage diagnostics');
          return {statusCode: 200, fileContent: files.get(fileID)};
        },
        async uploadFile({cloudPath, fileContent}) {
          uploads.push({cloudPath, fileContent});
          const fileID = cloudFile(cloudPath);
          files.set(fileID, fileContent);
          return {fileID};
        },
        async getTempFileURL({fileList}) {
          signed.push(...fileList);
          return {fileList: fileList.map(item => ({fileID: item.fileID, status: 0,
            tempFileURL: `https://signed.example.test/${encodeURIComponent(item.fileID)}?maxAge=${item.maxAge}`}))};
        },
        ...overrides
      };
      return createHandler({cloud, now: () => NOW, unique: () => `photo-${++serial}`});
    },
    addProfile(openid, name = `${openid}的小厨房`) {
      const owner = ownerFor(openid);
      const id = profileIdFor(owner);
      this.table('profiles').set(id, {_id: id, owner, name, bio: '今天做点好吃的', updatedAt: NOW});
      return id;
    },
    commit(openid = 'alice', data = snapshot(openid)) {
      const owner = ownerFor(openid);
      const fileID = privateFile(owner, `snapshots/data-${++serial}.json`);
      files.set(fileID, Buffer.from(JSON.stringify(data)));
      this.table('accounts').set(owner, {_id: owner, revision: serial, fileID});
      return data;
    },
    addPublished(openid, id = 'recipe-1', time = NOW) {
      const owner = ownerFor(openid);
      const profileId = this.addProfile(openid);
      const publicId = recipeIdFor(owner, id);
      this.table('recipes').set(publicId, {_id: publicId, owner, profileId, sourceRecipeId: id,
        sourceUpdatedAt: time, name: `菜谱${id}`, category: '粥饭主食', minutes: 20, texture: '软烂颗粒',
        ingredients: [{name: '南瓜', amount: '20克'}], steps: ['煮熟'], imageKey: 'pumpkin', photoFileID: '',
        published: true, generation: 1, publishedAt: time, updatedAt: time,
        sortKey: `${String(9999999999999 - time).padStart(13, '0')}-${publicId}`});
      return publicId;
    }
  };
}

test('authenticated identity comes only from context and mine does not create a public profile', async () => {
  const env = fakeEnvironment();
  const bob = env.addProfile('bob');
  const result = await env.handler()({action: 'mine', owner: ownerFor('bob'), profileId: bob, OPENID: 'bob'});
  assert.deepEqual(result, {profile: {id: profileIdFor(ownerFor('alice')), name: '口袋小厨', bio: '', exists: false},
    published: [], followingCount: 0});
  assert.equal(env.table('profiles').size, 1);
  assert.equal(env.downloads.length, 0);
});

test('all social operations require a trusted WeChat login and environment', async () => {
  const env = fakeEnvironment();
  for (const action of ['mine', 'profile', 'recipe', 'feed', 'follow', 'publish', 'unpublish', 'updateProfile']) {
    const handler = env.handler('alice', {getWXContext: () => ({APPID, ENV})});
    assert.equal((await handler({action})).error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await env.handler('alice', {getWXContext: () => ({OPENID: 'alice', APPID, ENV: '../env'})})({action: 'mine'})).error.code, 'INVALID_ENV');
});

test('expectedOwner is a precondition and prevents actions after a WeChat account change', async () => {
  const env = fakeEnvironment();
  for (const action of ['mine', 'profile', 'recipe', 'feed', 'follow', 'publish', 'unpublish', 'updateProfile']) {
    const result = await env.handler('bob')({action, expectedOwner: ownerFor('alice'), owner: ownerFor('alice')});
    assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  }
  assert.equal((await env.handler()({action: 'mine', expectedOwner: ownerFor('alice')})).profile.exists, false);
  assert.equal(env.table('profiles').size, 0);
  assert.equal(env.table('recipes').size, 0);
  assert.equal(env.table('follows').size, 0);
});

test('public profile requires an explicit edit and never imports baby nickname', async () => {
  const env = fakeEnvironment();
  env.commit();
  const result = await env.handler()({action: 'updateProfile', name: '  周末小厨房  ', bio: '  做些小点心  ', owner: ownerFor('bob')});
  assert.deepEqual(result.profile, {id: profileIdFor(ownerFor('alice')), name: '周末小厨房', bio: '做些小点心', exists: true});
  assert.equal(env.table('profiles').get(result.profile.id).owner, ownerFor('alice'));
  assert.equal(env.downloads.length, 0);
});

test('profile names and bios enforce bounds and reject controls', async () => {
  const env = fakeEnvironment();
  for (const data of [{name: ''}, {name: ' '.repeat(10)}, {name: '名'.repeat(21)}, {name: '名\n字'},
    {name: '厨房', bio: '简'.repeat(121)}, {name: '厨房', bio: '\u0000'}, {name: 1}]) {
    assert.equal((await env.handler()({action: 'updateProfile', ...data})).error.code, 'INVALID_REQUEST');
  }
  assert.equal(env.table('profiles').size, 0);
});

test('publishing needs a profile and a committed private snapshot', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'PROFILE_REQUIRED');
  env.addProfile('alice');
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'SYNC_REQUIRED');
  env.commit('bob');
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1', owner: ownerFor('bob')})).error.code, 'SYNC_REQUIRED');
  assert.equal(env.table('recipes').size, 0);
});

test('publish projects only an explicitly selected recipe and preserves private source data', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = env.commit();
  const result = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1', name: 'FORGED NAME', photo: 'FORGED PHOTO'});
  assert.equal(result.recipe.name, '南瓜粥');
  assert.deepEqual(Object.keys(result.recipe).sort(), ['id', 'profileId', 'authorName', 'name', 'category', 'minutes', 'texture',
    'ingredients', 'steps', 'imageKey', 'photoURL', 'updatedAt', 'publishedAt'].sort());
  for (const forbidden of ['Private baby name', 'PRIVATE NOTE', 'PRIVATE MEAL', ownerFor('alice'), 'recipe-1', 'favorite']) {
    assert.equal(JSON.stringify(result).includes(forbidden), false, forbidden);
  }
  const stored = env.table('recipes').get(result.recipe.id);
  assert.equal(stored.note, undefined);
  assert.equal(stored.favorite, undefined);
  assert.equal(stored.sourceRecipeId, 'recipe-1');
  assert.equal(input.data.recipes[0].note, 'PRIVATE NOTE');
  assert.deepEqual((await env.handler()({action: 'mine'})).published, [{id: result.recipe.id, sourceRecipeId: 'recipe-1', sourceUpdatedAt: NOW}]);
});

test('publishing never accepts an arbitrary file ID or another account snapshot', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  env.commit('bob');
  env.table('accounts').set(ownerFor('alice'), {revision: 1, fileID: privateFile(ownerFor('bob'), 'snapshots/data.json')});
  assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'SYNC_REQUIRED');
  assert.equal(env.downloads.length, 0);
  const input = snapshot();
  input.data.recipes[0].photo = privateFile(ownerFor('bob'), 'photos/private.jpg');
  env.commit('alice', input);
  assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'INVALID_SNAPSHOT');
  assert.equal(env.downloads.length, 1);
  assert.equal(env.uploads.length, 0);
});

test('public photos are copied to isolated server-managed paths with short-lived URLs', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = snapshot();
  const privatePhoto = privateFile(ownerFor('alice'), 'photos/original.jpg');
  input.data.recipes[0].photo = privatePhoto;
  env.files.set(privatePhoto, JPG);
  env.commit('alice', input);
  const result = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1', fileID: 'attacker-file'});
  assert.ok(result.recipe.photoURL.startsWith('https://'));
  assert.equal(env.uploads.length, 1);
  assert.match(env.uploads[0].cloudPath, new RegExp(`^social/${profileIdFor(ownerFor('alice'))}/${result.recipe.id}/photo-\\d+\\.jpg$`));
  assert.deepEqual(env.uploads[0].fileContent, JPG);
  assert.equal(env.signed[0].maxAge, 300);
  assert.equal(JSON.stringify(result).includes(privatePhoto), false);
  assert.deepEqual(env.files.get(privatePhoto), JPG);
  const visitor = await env.handler('bob')({action: 'recipe', recipeId: result.recipe.id});
  assert.ok(visitor.recipe.photoURL);
  assert.equal(visitor.author.name, 'alice的小厨房');
});

test('corrupt, oversized, and unsupported images fail without publishing', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from('<svg>private</svg>')]) {
    const env = fakeEnvironment();
    env.addProfile('alice');
    const input = snapshot();
    input.data.recipes[0].photo = privateFile(ownerFor('alice'), 'photos/photo.jpg');
    env.files.set(input.data.recipes[0].photo, bytes);
    env.commit('alice', input);
    assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'INVALID_PHOTO');
    assert.equal(env.table('recipes').size, 0);
    assert.equal(env.uploads.length, 0);
  }
});

test('public image signing refuses corrupt stored paths to private files', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  env.table('recipes').get(recipeId).photoFileID = privateFile(ownerFor('alice'), 'photos/private.jpg');
  const result = await env.handler('bob')({action: 'recipe', recipeId});
  assert.equal(result.error.code, 'INVALID_PHOTO');
  assert.equal(env.signed.length, 0);
});

test('a failed signer does not return upstream diagnostics or cloud file IDs', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  const record = env.table('recipes').get(recipeId);
  record.photoFileID = cloudFile(`social/${record.profileId}/${recipeId}/photo.jpg`);
  const result = await env.handler('bob', {async getTempFileURL() { throw Error('SECRET storage diagnostics'); }})({action: 'recipe', recipeId});
  assert.deepEqual(result, {error: {code: 'SOCIAL_FAILED', message: '暂时无法完成，请稍后重试。'}});
});

test('only own source IDs can be unpublished; withdrawal hides detail, profile and feed', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  const aliceProfile = profileIdFor(ownerFor('alice'));
  await env.handler('bob')({action: 'follow', profileId: aliceProfile, following: true});
  await env.handler('bob')({action: 'unpublish', sourceRecipeId: 'recipe-1', owner: ownerFor('alice')});
  assert.ok((await env.handler('bob')({action: 'recipe', recipeId})).recipe);
  assert.deepEqual(await env.handler()({action: 'unpublish', sourceRecipeId: 'recipe-1'}), {ok: true});
  assert.equal((await env.handler('bob')({action: 'recipe', recipeId})).error.code, 'NOT_FOUND');
  assert.deepEqual((await env.handler('bob')({action: 'profile', profileId: aliceProfile})).recipes, []);
  assert.deepEqual((await env.handler('bob')({action: 'feed'})).recipes, []);
  assert.equal((await env.handler()({action: 'mine'})).published.length, 0);
});

test('withdrawal during photo signing is rechecked before detail is returned', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  const record = env.table('recipes').get(recipeId);
  record.photoFileID = cloudFile(`social/${record.profileId}/${recipeId}/photo.jpg`);
  const visitor = env.handler('bob', {async getTempFileURL({fileList}) {
    await env.handler()({action: 'unpublish', sourceRecipeId: 'recipe-1'});
    return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://signed.example.test/temporary'}]};
  }});
  assert.equal((await visitor({action: 'recipe', recipeId})).error.code, 'NOT_FOUND');
});

test('unpublish tombstone prevents a delayed publish from restoring withdrawn content', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  env.commit();
  const handler = env.handler('alice', {async downloadFile({fileID}) {
    await env.handler()({action: 'unpublish', sourceRecipeId: 'recipe-1'});
    return {statusCode: 200, fileContent: env.files.get(fileID)};
  }});
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'CONFLICT');
  assert.equal(env.table('recipes').get(recipeIdFor(ownerFor('alice'), 'recipe-1')).published, false);
});

test('publish refuses a snapshot that changed while preparing publication', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  env.commit();
  const handler = env.handler('alice', {async downloadFile({fileID}) {
    const newer = snapshot();
    newer.data.recipes[0].name = '已修改';
    env.commit('alice', newer);
    return {statusCode: 200, fileContent: env.files.get(fileID)};
  }});
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'SYNC_REQUIRED');
  assert.equal(env.table('recipes').size, 0);
});

test('public copy is a fixed snapshot until explicitly republished', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  env.commit();
  const handler = env.handler();
  const original = await handler({action: 'publish', sourceRecipeId: 'recipe-1'});
  const changed = snapshot();
  changed.data.recipes[0].name = '改良南瓜粥';
  changed.data.recipes[0].updatedAt = NOW + 1;
  env.commit('alice', changed);
  assert.equal((await env.handler('bob')({action: 'recipe', recipeId: original.recipe.id})).recipe.name, '南瓜粥');
  assert.equal((await handler({action: 'publish', sourceRecipeId: 'recipe-1'})).recipe.name, '改良南瓜粥');
  assert.equal((await handler({action: 'mine'})).published[0].sourceUpdatedAt, NOW + 1);
});

test('deleted private recipe cannot be published even if stale copy remains in snapshot', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = snapshot();
  input.deleted.recipes.push({id: 'recipe-1', updatedAt: NOW});
  env.commit('alice', input);
  assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'NOT_FOUND');
});

test('follow is idempotent, account-specific and rejects self/missing profiles', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  const bob = env.handler('bob');
  for (let index = 0; index < 2; index++) assert.deepEqual(await bob({action: 'follow', profileId, following: true}), {following: true});
  assert.equal((await bob({action: 'mine'})).followingCount, 1);
  assert.equal((await env.handler('charlie')({action: 'mine'})).followingCount, 0);
  assert.equal((await env.handler()({action: 'follow', profileId, following: true})).error.code, 'INVALID_REQUEST');
  assert.equal((await bob({action: 'follow', profileId: 'f'.repeat(32), following: true})).error.code, 'NOT_FOUND');
  for (let index = 0; index < 2; index++) assert.deepEqual(await bob({action: 'follow', profileId, following: false}), {following: false});
  assert.equal((await bob({action: 'mine'})).followingCount, 0);
});

test('concurrent follow edits do not overwrite each other and the follow limit is enforced', async () => {
  const env = fakeEnvironment();
  const first = env.addProfile('alice');
  const second = env.addProfile('charlie');
  const bob = env.handler('bob');
  await Promise.all([first, second].map(profileId => bob({action: 'follow', profileId, following: true})));
  assert.equal((await bob({action: 'mine'})).followingCount, 2);
  const ids = Array.from({length: 200}, (_, i) => profileIdFor(ownerFor(`friend-${i}`)));
  env.table('follows').set(ownerFor('bob'), {profileIds: ids});
  assert.equal((await bob({action: 'follow', profileId: first, following: true})).error.code, 'FOLLOW_LIMIT');
  await bob({action: 'follow', profileId: ids[0], following: false});
  assert.deepEqual(await bob({action: 'follow', profileId: first, following: true}), {following: true});
});

test('following pages preserve account order and expose only public profile fields', async () => {
  const env = fakeEnvironment();
  const ids = Array.from({length: 23}, (_, index) => env.addProfile(`friend-${index}`));
  env.table('follows').set(ownerFor('alice'), {profileIds: ids});
  const first = await env.handler()({action: 'following'});
  assert.equal(first.profiles.length, 20);
  assert.equal(first.nextOffset, 20);
  const second = await env.handler()({action: 'following', offset: first.nextOffset});
  assert.equal(second.profiles.length, 3);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(first.profiles.concat(second.profiles).map(item => item.id), ids);
  assert.deepEqual(Object.keys(first.profiles[0]).sort(), ['id', 'name', 'bio', 'exists'].sort());
});

test('profile listing is paginated, shows follow state, and does not leak private recipes', async () => {
  const env = fakeEnvironment();
  for (let index = 0; index < 23; index++) env.addPublished('alice', `recipe-${index}`, NOW - index);
  env.commit();
  const profileId = profileIdFor(ownerFor('alice'));
  const bob = env.handler('bob');
  await bob({action: 'follow', profileId, following: true});
  const first = await bob({action: 'profile', profileId});
  assert.equal(first.isSelf, false);
  assert.equal(first.following, true);
  assert.equal(first.recipes.length, 20);
  assert.equal(first.nextOffset, 20);
  const second = await bob({action: 'profile', profileId, offset: 20});
  assert.equal(second.recipes.length, 3);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set(first.recipes.concat(second.recipes).map(item => item.id)).size, 23);
  assert.equal((await env.handler()({action: 'profile', profileId})).isSelf, true);
});

test('feed globally sorts multiple batches, pages without duplicates, and excludes non-followed or withdrawn recipes', async () => {
  const env = fakeEnvironment();
  const ids = [];
  for (let index = 0; index < 23; index++) {
    env.addPublished(`friend-${index}`, 'r1', NOW - index * 2);
    env.addPublished(`friend-${index}`, 'r2', NOW - index * 2 - 1);
    ids.push(profileIdFor(ownerFor(`friend-${index}`)));
  }
  env.addPublished('stranger', 'r1', NOW + 100);
  const hiddenId = env.addPublished('friend-0', 'hidden', NOW + 1);
  env.table('recipes').get(hiddenId).published = false;
  env.table('follows').set(ownerFor('alice'), {profileIds: ids});
  const results = [];
  let cursor;
  do {
    const page = await env.handler()({action: 'feed', ...(cursor ? {cursor} : {})});
    assert.ok(page.recipes.length <= PAGE_SIZE);
    results.push(...page.recipes);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(results.length, 46);
  assert.equal(new Set(results.map(item => item.id)).size, 46);
  for (let i = 1; i < results.length; i++) assert.ok(results[i].publishedAt < results[i - 1].publishedAt);
  assert.equal(results.some(item => item.profileId === profileIdFor(ownerFor('stranger'))), false);
  assert.equal(results.some(item => item.id === hiddenId), false);
  const feedQueries = env.queries.filter(query => query.condition.profileId?.operator === 'in');
  assert.equal(feedQueries.length, 6);
  for (const query of feedQueries) {
    assert.equal(query.limit, PAGE_SIZE + 1);
    assert.equal(query.skip, 0);
    assert.ok(query.condition.profileId.values.length <= 20);
  }
});

test('empty feed requires no recipe scans and unfollow removes the author from subsequent feed', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  assert.deepEqual(await handler({action: 'feed'}), {recipes: [], nextCursor: null});
  assert.equal(env.queries.length, 0);
  env.addPublished('bob');
  const profileId = profileIdFor(ownerFor('bob'));
  await handler({action: 'follow', profileId, following: true});
  assert.equal((await handler({action: 'feed'})).recipes.length, 1);
  await handler({action: 'follow', profileId, following: false});
  assert.equal((await handler({action: 'feed'})).recipes.length, 0);
});

test('very long recipes remain intact while page payloads stay below the mini-program limit', async () => {
  const env = fakeEnvironment();
  for (let index = 0; index < 12; index++) {
    const id = env.addPublished('bob', `long-${index}`, NOW - index);
    env.table('recipes').get(id).steps = Array.from({length: 30}, () => '南'.repeat(2000));
  }
  const profileId = profileIdFor(ownerFor('bob'));
  const handler = env.handler();
  await handler({action: 'follow', profileId, following: true});
  const seen = new Set();
  let cursor;
  do {
    const page = await handler({action: 'feed', ...(cursor ? {cursor} : {})});
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    assert.ok(page.recipes.length > 0 && page.recipes.length < 20);
    for (const recipe of page.recipes) {
      assert.equal(recipe.steps.length, 30);
      assert.equal(recipe.steps[0].length, 2000);
      assert.equal(seen.has(recipe.id), false);
      seen.add(recipe.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 12);
  let offset = 0;
  const fromProfile = [];
  do {
    const page = await handler({action: 'profile', profileId, offset});
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    fromProfile.push(...page.recipes.map(item => item.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(new Set(fromProfile).size, 12);
});

test('malformed IDs and pagination are rejected before resource access', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  for (const recipeId of ['../private', null, 'z'.repeat(64), 'a'.repeat(63)]) {
    assert.equal((await handler({action: 'recipe', recipeId})).error.code, 'INVALID_REQUEST');
  }
  for (const profileId of ['../private', null, 'z'.repeat(32)]) {
    assert.equal((await handler({action: 'profile', profileId})).error.code, 'INVALID_REQUEST');
  }
  for (const offset of [-1, 0.5, '20', null, 1001]) {
    assert.equal((await handler({action: 'following', offset})).error.code, 'INVALID_REQUEST');
  }
  for (const cursor of [null, 1, 'a', '../snapshot.json']) {
    assert.equal((await handler({action: 'feed', cursor})).error.code, 'INVALID_REQUEST');
  }
  for (const sourceRecipeId of ['', '\n', 'r'.repeat(101)]) {
    assert.equal((await handler({action: 'unpublish', sourceRecipeId})).error.code, 'INVALID_REQUEST');
  }
  assert.equal(env.queries.length, 0);
  assert.equal(env.downloads.length, 0);
});

test('imported source attribution resolves against server records, never a forged author name', async () => {
  const env = fakeEnvironment();
  const sourceRecipeId = env.addPublished('bob');
  const sourceProfileId = profileIdFor(ownerFor('bob'));
  env.addProfile('alice');
  const input = snapshot();
  input.data.recipes[0].source = {profileId: sourceProfileId, recipeId: sourceRecipeId, authorName: 'FORGED AUTHOR'};
  env.commit('alice', input);
  const result = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'});
  assert.deepEqual(result.recipe.source, {profileId: sourceProfileId, recipeId: sourceRecipeId, authorName: 'bob的小厨房'});
  await env.handler('bob')({action: 'unpublish', sourceRecipeId: 'recipe-1'});
  assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).recipe.source.authorName, 'bob的小厨房');
});

test('invalid source attribution cannot access arbitrary resources', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = snapshot();
  input.data.recipes[0].source = {profileId: '../private', recipeId: 'x', authorName: 'name'};
  env.commit('alice', input);
  assert.equal((await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'})).error.code, 'INVALID_SNAPSHOT');
});

test('nonexistent or corrupt public records never grant access to private details', async () => {
  const env = fakeEnvironment();
  const id = env.addPublished('alice');
  env.table('recipes').get(id).owner = ownerFor('bob');
  assert.equal((await env.handler('bob')({action: 'recipe', recipeId: id})).error.code, 'NOT_FOUND');
  assert.equal((await env.handler('bob')({action: 'profile', profileId: profileIdFor(ownerFor('alice'))})).recipes.length, 0);
  assert.equal((await env.handler()({action: 'recipe', recipeId: '0'.repeat(64)})).error.code, 'NOT_FOUND');
});
