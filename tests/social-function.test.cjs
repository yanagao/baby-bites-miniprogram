'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {createHandler, profileIdFor, recipeIdFor, COLLECTIONS, PAGE_SIZE} = require('../cloudfunctions/babyBitesSocial');
const {getImageKey} = require('../cloudfunctions/babyBitesSocial/recipe-covers');
const seedRecipes = require('../data/recipes');
const ENV = 'cloud1-social-test';
const APPID = 'wx-social-test';
const NOW = Date.parse('2026-10-23T08:00:00Z');
const ownerFor = openid => crypto.createHash('sha256').update(`${APPID}:${openid}`).digest('hex');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const cloudFile = path => `cloud://${ENV}.bucket-123/${path}`;
const privateFile = (owner, path) => cloudFile(`users/${owner}/${path}`);
const JPG = Buffer.from([255, 216, 255, 224, 0, 1, 2, 3]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

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
  const gets = [];
  const codeRequests = [];
  const moderationRequests = [];
  const writes = [];
  const transactionStarts = [];
  let moderation = async () => ({errCode: 0, result: {suggest: 'pass'}});
  let serial = 0;
  let queue = Promise.resolve();
  const matches = (record, conditions) => Object.entries(conditions).every(([key, value]) => {
    if (value && value.operator === 'in') return Array.isArray(record[key]) ?
      record[key].some(item => value.values.includes(item)) : value.values.includes(record[key]);
    if (value && value.operator === 'gt') return record[key] > value.value;
    return record[key] === value;
  });
  function collection(name, target = tables) {
    if (!target.has(name)) throw new Error('Missing table');
    const table = target.get(name);
    const makeQuery = (condition = {}, sorts = [], skip = 0, limit = 100, fields = null) => ({
      where(next) { return makeQuery(next, sorts, skip, limit, fields); },
      orderBy(field, direction) { return makeQuery(condition, sorts.concat([{field, direction}]), skip, limit, fields); },
      skip(value) { return makeQuery(condition, sorts, value, limit, fields); },
      limit(value) { assert.ok(value <= 1000); return makeQuery(condition, sorts, skip, value, fields); },
      field(value) { return makeQuery(condition, sorts, skip, limit, value); },
      async count() {
        queries.push({name, condition, count: true});
        return {total: Array.from(table.values()).filter(item => matches(item, condition)).length};
      },
      async get() {
        queries.push({name, condition, sorts, skip, limit, fields});
        const records = Array.from(table.values()).filter(item => matches(item, condition));
        records.sort((a, b) => {
          for (const {field, direction} of sorts) {
            if (a[field] !== b[field]) return (a[field] < b[field] ? -1 : 1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        return {data: clone(records.slice(skip, skip + limit).map(record => fields ?
          Object.fromEntries(Object.entries(record).filter(([key]) => fields[key])) : record))};
      }
    });
    return {...makeQuery(), doc(id) {
      return {async get() { gets.push({name, id}); return {data: clone(table.get(id) || null)}; },
        async set({data}) { writes.push({name, id, data: clone(data)}); table.set(id, {_id: id, ...clone(data)}); }};
    }};
  }
  const database = {
    collection: name => collection(name),
    command: {in: values => ({operator: 'in', values}), gt: value => ({operator: 'gt', value})},
    async runTransaction(callback) {
      transactionStarts.push(true);
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
    tables, files, downloads, uploads, signed, queries, gets, codeRequests, moderationRequests, writes, transactionStarts,
    table(name) { return tables.get(COLLECTIONS[name]); },
    setModeration(callback) { moderation = callback; },
    handler(openid = 'alice', overrides = {}, clock = () => NOW, factory = createHandler) {
      const cloud = {
        getWXContext: () => ({OPENID: openid, APPID, ENV}),
        database(options) { assert.equal(options.throwOnNotFound, false); return database; },
        openapi: {
          security: {async msgSecCheck(args) { moderationRequests.push(clone(args)); return moderation(args); }},
          wxacode: {async getUnlimited(args) { codeRequests.push(clone(args)); return {buffer: PNG}; }}
        },
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
      return factory({cloud, now: clock, unique: () => `photo-${++serial}`});
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

test('recipe age groups are copied from the committed snapshot and preserved by every public recipe read', async () => {
  const env = fakeEnvironment();
  const authorId = env.addProfile('alice'); env.addProfile('bob');
  const data = snapshot(); data.data.recipes[0].ageGroups = ['18+', '6-8', '18+']; env.commit('alice', data);
  const result = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1', ageGroups: ['9-11']});
  assert.deepEqual(result.recipe.ageGroups, ['6-8', '18+']);
  const id = result.recipe.id;
  assert.deepEqual(env.table('recipes').get(id).ageGroups, ['6-8', '18+']);
  await env.handler('bob')({action: 'follow', profileId: authorId, following: true});
  const detail = await env.handler('bob')({action: 'recipe', recipeId: id});
  const profile = await env.handler('bob')({action: 'profile', profileId: authorId});
  const feed = await env.handler('bob')({action: 'feed'});
  const discovery = await env.handler('bob')({action: 'discover', search: ''});
  for (const recipe of [detail.recipe, profile.recipes[0], feed.recipes[0], discovery.recipes[0]]) {
    assert.deepEqual(recipe.ageGroups, ['6-8', '18+']);
    assert.equal(Object.hasOwn(recipe, 'note'), false); assert.equal(Object.hasOwn(recipe, 'sourceRecipeId'), false);
    assert.equal(Object.hasOwn(recipe, 'favorite'), false); assert.equal(Object.hasOwn(recipe, 'babyBirthDate'), false);
  }
  data.data.recipes[0].ageGroups = []; data.data.recipes[0].updatedAt++; env.commit('alice', data);
  const cleared = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'});
  assert.deepEqual(cleared.recipe.ageGroups, []);
  assert.deepEqual(env.table('recipes').get(id).ageGroups, []);
});

test('legacy public recipes remain unannotated and invalid snapshot ages cannot publish or copy photos', async () => {
  const legacy = fakeEnvironment(), id = legacy.addPublished('alice', 'pumpkin-millet');
  const before = clone(legacy.table('recipes').get(id));
  const read = await legacy.handler('visitor')({action: 'recipe', recipeId: id});
  assert.equal(Object.hasOwn(read.recipe, 'ageGroups'), false);
  assert.deepEqual(legacy.table('recipes').get(id), before);
  for (const ageGroups of [null, ['all'], Array(5).fill('6-8')]) {
    const env = fakeEnvironment(); env.addProfile('alice');
    const data = snapshot(); data.data.recipes[0].ageGroups = ageGroups; env.commit('alice', data);
    const result = await env.handler()({action: 'publish', sourceRecipeId: 'recipe-1'});
    assert.equal(result.error.code, 'INVALID_SNAPSHOT');
    assert.equal(env.table('recipes').size, 0); assert.equal(env.uploads.length, 0);
  }
});

test('authenticated identity comes only from context and mine does not create a public profile', async () => {
  const env = fakeEnvironment();
  const bob = env.addProfile('bob');
  const result = await env.handler()({action: 'mine', owner: ownerFor('bob'), profileId: bob, OPENID: 'bob'});
  assert.match(result.profile.name, /^小(?:胡萝卜|南瓜|番茄|土豆|西兰花|玉米)[1-9]\d{3}$/);
  assert.deepEqual(result, {profile: {id: profileIdFor(ownerFor('alice')), name: result.profile.name, bio: '', babyAgeMonths: null, babyBirthDate: null, exists: false},
    published: [], publishedCount: 0, followingCount: 0, followerCount: 0});
  assert.equal(env.table('profiles').size, 1);
  assert.equal(env.downloads.length, 0);
});

test('generated profile names stay stable across handlers and repeated account reads without creating data', async () => {
  const env = fakeEnvironment();
  const first = await env.handler('alice')({action: 'mine'});
  await env.handler('bob')({action: 'mine'});
  const sameHandler = env.handler('alice');
  for (let index = 0; index < 3; index++) {
    assert.deepEqual((await sameHandler({action: 'mine'})).profile, first.profile);
  }
  const newSession = await env.handler('alice')({action: 'mine', expectedOwner: ownerFor('alice')});
  const otherDevice = await fakeEnvironment().handler('alice')({action: 'mine'});
  assert.deepEqual(newSession.profile, first.profile);
  assert.deepEqual(otherDevice.profile, first.profile);
  assert.equal(first.profile.exists, false);
  assert.equal(first.profile.babyAgeMonths, null);
  assert.equal(first.profile.bio, '');
  for (const records of env.tables.values()) assert.equal(records.size, 0);
  assert.equal(env.files.size, 0);
  assert.equal(env.uploads.length, 0); assert.equal(env.downloads.length, 0);
});

test('generated names vary across accounts without exposing identity or reading private baby details', async () => {
  const env = fakeEnvironment();
  const names = [];
  env.commit('alice');
  const accountsBefore = clone(Array.from(env.table('accounts')));
  for (let index = 0; index < 24; index++) {
    const openid = `account-${index}`;
    const result = await env.handler(openid)({action: 'mine', owner: ownerFor('alice'), name: '伪造昵称'});
    const name = result.profile.name;
    assert.match(name, /^小(?:胡萝卜|南瓜|番茄|土豆|西兰花|玉米)[1-9]\d{3}$/);
    assert.equal(name.includes(openid), false);
    assert.equal(JSON.stringify(result).includes(ownerFor(openid)), false);
    names.push(name);
  }
  assert.ok(new Set(names).size >= 20, 'names should distribute across accounts; global uniqueness is not promised');
  const alice = await env.handler('alice')({action: 'mine'});
  assert.equal(JSON.stringify(alice).includes('Private baby name'), false);
  assert.equal(env.gets.some(item => item.name === COLLECTIONS.accounts), false);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.table('profiles').size, 0);
  assert.deepEqual(Array.from(env.table('accounts')), accountsBefore);
});

test('only explicit profile save creates a profile and later reads preserve the custom nickname', async () => {
  const env = fakeEnvironment();
  const generated = (await env.handler()({action: 'mine'})).profile;
  assert.equal(env.table('profiles').size, 0);
  const saved = await env.handler()({action: 'updateProfile', name: '妈妈的周末厨房', bio: '自己取的名字', babyAgeMonths: 9});
  assert.equal(saved.profile.exists, true);
  assert.notEqual(saved.profile.name, generated.name);
  const before = clone(Array.from(env.table('profiles')));
  for (let index = 0; index < 3; index++) {
    const mine = await env.handler()({action: 'mine'});
    assert.equal(mine.profile.name, '妈妈的周末厨房');
    assert.equal(mine.profile.bio, '自己取的名字');
    assert.equal(mine.profile.babyAgeMonths, 9);
    assert.equal(mine.profile.exists, true);
  }
  const shared = await env.handler('visitor')({action: 'profile', profileId: generated.id});
  assert.equal(shared.profile.name, '妈妈的周末厨房');
  assert.deepEqual(Array.from(env.table('profiles')), before);
});

test('all social operations require a trusted WeChat login and environment', async () => {
  const env = fakeEnvironment();
  for (const action of ['mine', 'profile', 'recipe', 'feed', 'discover', 'shareCode', 'follow', 'following', 'followers', 'publish', 'unpublish', 'updateProfile', 'checkProfile']) {
    const handler = env.handler('alice', {getWXContext: () => ({APPID, ENV})});
    assert.equal((await handler({action})).error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await env.handler('alice', {getWXContext: () => ({OPENID: 'alice', APPID, ENV: '../env'})})({action: 'mine'})).error.code, 'INVALID_ENV');
});

test('expectedOwner is a precondition and prevents actions after a WeChat account change', async () => {
  const env = fakeEnvironment();
  for (const action of ['mine', 'profile', 'recipe', 'feed', 'discover', 'shareCode', 'follow', 'following', 'followers', 'publish', 'unpublish', 'updateProfile', 'checkProfile']) {
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
  assert.deepEqual(result.profile, {id: profileIdFor(ownerFor('alice')), name: '周末小厨房', bio: '做些小点心', babyAgeMonths: null, babyBirthDate: null, exists: true});
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

function profileState(env) {
  return clone({tables: Array.from(env.tables, ([name, records]) => [name, Array.from(records)]),
    files: Array.from(env.files, ([id, bytes]) => [id, bytes.toString('base64')])});
}

function existingModerationProfile(env) {
  env.commit();
  env.addPublished('alice');
  const profileId = profileIdFor(ownerFor('alice'));
  const code = cloudFile(`social/${profileId}/codes/trial/v1-existing.png`);
  Object.assign(env.table('profiles').get(profileId), {
    name: '原公开名字', bio: '原公开简介', babyBirthDate: '2026-01-31', babyAgeMonths: 9,
    shareCodes: {trial: code}, updatedAt: NOW - 1000
  });
  env.files.set(code, PNG);
  const otherId = env.addProfile('bob');
  env.table('follows').set(ownerFor('alice'), {_id: ownerFor('alice'), profileIds: [otherId]});
  return profileId;
}

function assertNoModerationWrites(env, before) {
  assert.deepEqual(profileState(env), before, 'all profiles, birthdays, cached codes, accounts and files must remain unchanged');
  assert.deepEqual(env.writes, []);
  assert.deepEqual(env.transactionStarts, [], 'moderation must finish before a transaction starts');
  assert.deepEqual(env.uploads, []);
  assert.deepEqual(env.downloads, []);
  assert.deepEqual(env.codeRequests, []);
  assert.deepEqual(env.signed, []);
}

function moderationTimerFactory(timers, cleared) {
  const entry = require.resolve('../cloudfunctions/babyBitesSocial');
  const localRequire = createRequire(entry);
  const moderationFile = localRequire.resolve('./profile-moderation');
  const moderationModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(moderationFile, 'utf8'), {
    module: moderationModule, exports: moderationModule.exports, require: localRequire,
    setTimeout(callback, delay) {
      assert.equal(delay, 8000);
      const timer = {fire: callback}; timers.push(timer); return timer;
    },
    clearTimeout(timer) { cleared.push(timer); }
  }, {filename: moderationFile});
  const handlerModule = {exports: {}};
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    module: handlerModule, exports: handlerModule.exports, Buffer,
    require: name => name === './profile-moderation' ? moderationModule.exports : localRequire(name)
  }, {filename: entry});
  return handlerModule.exports.createHandler;
}

test('profile moderation uses the trusted openid and only the trimmed public text, ignoring forged identities and private fields', async () => {
  const env = fakeEnvironment();
  const profileId = existingModerationProfile(env);
  const before = profileState(env);
  const result = await env.handler()({action: 'updateProfile', name: '  新公开名字  ', bio: '  新公开简介  ',
    OPENID: 'bob', openid: 'bob', APPID: 'forged-app', ENV: 'forged-env', owner: ownerFor('bob'),
    profileId: profileIdFor(ownerFor('bob')), userInfo: {openId: 'bob'}, tcbContext: {OPENID: 'bob'},
    nickname: 'PRIVATE BABY NAME', privateNote: 'PRIVATE NOTE', babyBirthDate: '2026-02-28'});
  assert.equal(result.error, undefined);
  assert.deepEqual(env.moderationRequests, [
    {openid: 'alice', version: 2, scene: 1, content: '新公开名字', nickname: '新公开名字'},
    {openid: 'alice', version: 2, scene: 1, content: '新公开简介', signature: '新公开简介'}
  ]);
  assert.equal(result.profile.id, profileId);
  assert.equal(result.profile.name, '新公开名字');
  assert.equal(result.profile.bio, '新公开简介');
  assert.equal(result.profile.babyBirthDate, '2026-02-28');
  const current = env.table('profiles').get(profileId);
  assert.equal(current.owner, ownerFor('alice'));
  assert.deepEqual(current.shareCodes, before.tables.find(([name]) => name === COLLECTIONS.profiles)[1][0][1].shareCodes);
  assert.equal(env.writes.length, 1);
  assert.equal(env.writes[0].name, COLLECTIONS.profiles);
  assert.equal(env.writes[0].id, profileId);
  assert.deepEqual(Array.from(env.table('accounts')), before.tables.find(([name]) => name === COLLECTIONS.accounts)[1]);
  assert.deepEqual(profileState(env).files, before.files);
  assert.equal(env.table('profiles').get(profileIdFor(ownerFor('bob'))).name, 'bob的小厨房');
  assert.equal(env.downloads.length, 0);
});

test('forged platform identity cannot reach moderation or write without a real trusted context', async () => {
  const env = fakeEnvironment();
  const before = profileState(env);
  const event = {action: 'updateProfile', name: '新厨房', bio: '新简介', OPENID: 'alice', APPID, ENV,
    userInfo: {openId: 'alice', appId: APPID}, tcbContext: {OPENID: 'alice', APPID, ENV}};
  const result = await env.handler('alice', {getWXContext: () => ({APPID, ENV})})(event);
  assert.equal(result.error.code, 'UNAUTHENTICATED');
  const switched = await env.handler('bob')({...event, expectedOwner: ownerFor('alice')});
  assert.equal(switched.error.code, 'ACCOUNT_CHANGED');
  assert.deepEqual(env.moderationRequests, []);
  assertNoModerationWrites(env, before);
});

test('new profiles save only on explicit successful v2 moderation and blank bios do not cause a second check', async t => {
  for (const [label, response] of [
    ['errCode', {errCode: 0, result: {suggest: 'pass'}}],
    ['errcode', {errcode: 0, result: {suggest: 'pass'}}],
    ['both', {errCode: 0, errcode: 0, result: {suggest: 'pass'}}]
  ]) await t.test(label, async () => {
    for (const bio of [undefined, '', '   ']) {
      const env = fakeEnvironment(); env.setModeration(async () => response);
      const event = {action: 'updateProfile', name: '  公开小厨房  ', babyBirthDate: '2026-04-01'};
      if (bio !== undefined) event.bio = bio;
      const result = await env.handler()(event);
      assert.equal(result.error, undefined);
      assert.equal(result.profile.name, '公开小厨房');
      assert.equal(result.profile.bio, '');
      assert.equal(result.profile.babyBirthDate, '2026-04-01');
      assert.equal(env.moderationRequests.length, 1);
      assert.equal(env.moderationRequests[0].nickname, '公开小厨房');
      assert.equal(env.table('profiles').size, 1);
      assert.equal(env.writes.length, 1);
      assert.equal(env.transactionStarts.length, 1);
      assert.equal(env.table('accounts').size, 0);
      assert.equal(env.files.size, 0);
    }
  });
});

test('risky, review and 87014 results block the relevant profile field without modifying any existing data', async t => {
  const outcomes = [
    ['risky', {errCode: 0, result: {suggest: 'risky'}}],
    ['review', {errcode: 0, result: {suggest: 'review'}}],
    ['errCode 87014', {errCode: 87014, errmsg: 'SECRET upstream details'}],
    ['errcode 87014', {errcode: 87014, result: {suggest: 'pass'}}],
    ['thrown 87014', Object.assign(Error('SECRET upstream details'), {errCode: 87014})],
    ['thrown lowercase 87014', Object.assign(Error('SECRET upstream details'), {errcode: '87014'})]
  ];
  for (const field of ['name', 'bio']) for (const [label, outcome] of outcomes) await t.test(`${field}: ${label}`, async () => {
    const env = fakeEnvironment(); existingModerationProfile(env);
    const before = profileState(env);
    env.setModeration(async request => {
      if (field === 'bio' && request.nickname !== undefined) return {errCode: 0, result: {suggest: 'pass'}};
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const result = await env.handler()({action: 'updateProfile', name: '待审昵称', bio: '待审简介', babyBirthDate: null});
    assert.equal(result.error.code, field === 'name' ? 'PROFILE_NAME_REJECTED' : 'PROFILE_BIO_REJECTED');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|upstream|87014/);
    assert.equal(env.moderationRequests.length, field === 'name' ? 1 : 2);
    assertNoModerationWrites(env, before);
  });
});

test('missing, ambiguous or failed moderation responses never authorize a profile edit', async t => {
  const outcomes = [
    ['undefined', undefined], ['null', null], ['empty result', {}],
    ['missing success code', {result: {suggest: 'pass'}}], ['missing verdict', {errCode: 0}],
    ['empty verdict', {errCode: 0, result: {}}], ['unknown verdict', {errCode: 0, result: {suggest: 'unknown'}}],
    ['uppercase verdict', {errCode: 0, result: {suggest: 'PASS'}}],
    ['API failure', {errcode: 40001, result: {suggest: 'pass'}, errmsg: 'SECRET upstream details'}],
    ['contradictory codes', {errCode: 0, errcode: 40001, result: {suggest: 'pass'}}],
    ['boolean code', {errCode: false, result: {suggest: 'pass'}}],
    ['exception', Error('SECRET upstream details')]
  ];
  for (const field of ['name', 'bio']) for (const [label, outcome] of outcomes) await t.test(`${field}: ${label}`, async () => {
    const env = fakeEnvironment(); existingModerationProfile(env);
    const before = profileState(env);
    env.setModeration(async request => {
      if (field === 'bio' && request.nickname !== undefined) return {errCode: 0, result: {suggest: 'pass'}};
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const result = await env.handler()({action: 'updateProfile', name: '待审昵称', bio: '待审简介', babyBirthDate: '2026-05-01'});
    assert.equal(result.error.code, 'PROFILE_MODERATION_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|upstream|40001/);
    assert.equal(env.moderationRequests.length, field === 'name' ? 1 : 2);
    assertNoModerationWrites(env, before);
  });
});

test('missing moderation API fails closed without creating a first public profile', async t => {
  for (const [label, openapi] of [['no openapi', undefined], ['no security', {}], ['no msgSecCheck', {security: {}}],
    ['invalid msgSecCheck', {security: {msgSecCheck: true}}]]) await t.test(label, async () => {
    const env = fakeEnvironment(); env.commit();
    const before = profileState(env);
    const result = await env.handler('alice', {openapi})({action: 'updateProfile', name: '首个主页', bio: '简介', babyBirthDate: '2026-05-01'});
    assert.equal(result.error.code, 'PROFILE_MODERATION_UNAVAILABLE');
    assert.equal(env.table('profiles').size, 0);
    assertNoModerationWrites(env, before);
  });
});

test('rejected first profile attempts do not create a profile even when the name has already passed', async t => {
  for (const field of ['name', 'bio']) await t.test(field, async () => {
    const env = fakeEnvironment(); env.commit();
    const before = profileState(env);
    env.setModeration(async request => ({errCode: 0,
      result: {suggest: field === 'bio' && request.nickname !== undefined ? 'pass' : 'risky'}}));
    const result = await env.handler()({action: 'updateProfile', name: '首个主页', bio: '简介', babyBirthDate: '2026-05-01'});
    assert.equal(result.error.code, field === 'name' ? 'PROFILE_NAME_REJECTED' : 'PROFILE_BIO_REJECTED');
    assert.equal(env.table('profiles').size, 0);
    assertNoModerationWrites(env, before);
  });
});

test('profile transaction and writes wait for both moderation checks, preserving birthday and share-code edits completed while awaiting review', async () => {
  const env = fakeEnvironment();
  const profileId = existingModerationProfile(env);
  let releaseName, releaseBio;
  env.setModeration(request => new Promise(resolve => {
    if (request.nickname !== undefined) releaseName = resolve;
    else releaseBio = resolve;
  }));
  const before = profileState(env);
  const saving = env.handler()({action: 'updateProfile', name: '审核后的昵称', bio: '审核后的简介'});
  assert.equal(typeof releaseName, 'function');
  assert.equal(releaseBio, undefined, 'the bio is checked only after the name passes');
  assertNoModerationWrites(env, before);
  releaseName({errCode: 0, result: {suggest: 'pass'}});
  await new Promise(setImmediate);
  assert.equal(typeof releaseBio, 'function');
  assertNoModerationWrites(env, before);
  const current = env.table('profiles').get(profileId);
  current.babyBirthDate = '2026-03-31';
  current.shareCodes.release = cloudFile(`social/${profileId}/codes/release/v1-new.png`);
  const expectedCodes = clone(current.shareCodes);
  releaseBio({errcode: 0, result: {suggest: 'pass'}});
  const result = await saving;
  assert.equal(result.error, undefined);
  assert.equal(result.profile.babyBirthDate, '2026-03-31');
  assert.deepEqual(env.table('profiles').get(profileId).shareCodes, expectedCodes);
  assert.equal(env.writes.length, 1);
  assert.equal(env.transactionStarts.length, 1);
});

test('moderation timeout returns without writing and a late pass or rejection cannot revive the save', async t => {
  for (const field of ['name', 'bio']) for (const late of ['pass', 'reject']) await t.test(`${field}: late ${late}`, async () => {
    const env = fakeEnvironment(); existingModerationProfile(env);
    const before = profileState(env), timers = [], cleared = [];
    const factory = moderationTimerFactory(timers, cleared);
    let resolveRequest, rejectRequest;
    env.setModeration(request => {
      if (field === 'bio' && request.nickname !== undefined) return {errCode: 0, result: {suggest: 'pass'}};
      return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    });
    const saving = env.handler('alice', {}, () => NOW, factory)({action: 'updateProfile', name: '待审昵称', bio: '待审简介', babyBirthDate: null});
    await new Promise(setImmediate);
    assert.equal(timers.length, field === 'name' ? 1 : 2);
    assertNoModerationWrites(env, before);
    const timer = timers[timers.length - 1]; timer.fire();
    const result = await saving;
    assert.equal(result.error.code, 'PROFILE_MODERATION_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /timeout|SECRET/);
    assert.ok(cleared.includes(timer));
    assertNoModerationWrites(env, before);
    if (late === 'pass') resolveRequest({errCode: 0, result: {suggest: 'pass'}});
    else rejectRequest(Error('SECRET late rejection'));
    await new Promise(setImmediate);
    assertNoModerationWrites(env, before);
  });
});

test('checkProfile is read-only for a first or existing profile even when both text fields pass', async t => {
  for (const existing of [false, true]) await t.test(existing ? 'existing profile' : 'first profile', async () => {
    const env = fakeEnvironment();
    if (existing) existingModerationProfile(env);
    else env.commit();
    const before = profileState(env);
    const result = await env.handler()({action: 'checkProfile', name: '  只读检查昵称  ', bio: '  只读检查简介  ',
      babyBirthDate: null, owner: ownerFor('bob'), OPENID: 'bob', userInfo: {openId: 'bob'}});
    assert.deepEqual(result, {validated: true, saved: false});
    assert.deepEqual(env.moderationRequests, [
      {openid: 'alice', version: 2, scene: 1, content: '只读检查昵称', nickname: '只读检查昵称'},
      {openid: 'alice', version: 2, scene: 1, content: '只读检查简介', signature: '只读检查简介'}
    ]);
    assertNoModerationWrites(env, before);
    assert.deepEqual(env.gets, []);
    assert.deepEqual(env.queries, []);
  });
});

test('checkProfile rejects risky text without any write and a passed read-only check never bypasses save-time moderation', async () => {
  const env = fakeEnvironment(); existingModerationProfile(env);
  const before = profileState(env);
  const event = {name: '检查昵称', bio: '检查简介', babyBirthDate: '2026-05-01'};
  env.setModeration(async request => ({errCode: 0, result: {suggest: request.signature ? 'risky' : 'pass'}}));
  const rejected = await env.handler()({action: 'checkProfile', ...event});
  assert.equal(rejected.error.code, 'PROFILE_BIO_REJECTED');
  assertNoModerationWrites(env, before);
  env.setModeration(async () => ({errCode: 0, result: {suggest: 'pass'}}));
  assert.deepEqual(await env.handler()({action: 'checkProfile', ...event}), {validated: true, saved: false});
  assertNoModerationWrites(env, before);
  const priorCalls = env.moderationRequests.length;
  env.setModeration(async () => ({errCode: 0, result: {suggest: 'risky'}}));
  const saved = await env.handler()({action: 'updateProfile', ...event});
  assert.equal(saved.error.code, 'PROFILE_NAME_REJECTED');
  assert.equal(env.moderationRequests.length, priorCalls + 1);
  assertNoModerationWrites(env, before);
});

test('checkProfile validates local field bounds before invoking moderation', async () => {
  const env = fakeEnvironment(), before = profileState(env);
  for (const [fields, code] of [
    [{name: ' '}, 'INVALID_REQUEST'], [{name: '检查昵称', bio: '简'.repeat(121)}, 'INVALID_REQUEST'],
    [{name: '检查昵称', babyBirthDate: '2026-02-30'}, 'INVALID_BABY_BIRTH_DATE'],
    [{name: '检查昵称', babyAgeMonths: -1}, 'INVALID_BABY_AGE']
  ]) assert.equal((await env.handler()({action: 'checkProfile', ...fields})).error.code, code);
  assert.deepEqual(env.moderationRequests, []);
  assertNoModerationWrites(env, before);
});

test('baby month age accepts integer boundaries and explicit null and is shared from one public profile', async () => {
  const env = fakeEnvironment();
  for (const babyAgeMonths of [0, 1, 12, 120, null]) {
    const updated = await env.handler()({action: 'updateProfile', name: '我的厨房', bio: '', babyAgeMonths});
    assert.equal(updated.error, undefined);
    assert.equal(updated.profile.babyAgeMonths, babyAgeMonths);
    assert.equal(env.table('profiles').get(updated.profile.id).babyAgeMonths, babyAgeMonths);
    assert.equal((await env.handler()({action: 'mine'})).profile.babyAgeMonths, babyAgeMonths);
    assert.equal((await env.handler('visitor')({action: 'profile', profileId: updated.profile.id})).profile.babyAgeMonths, babyAgeMonths);
  }
});

test('old profile edits preserve month age including zero and new or legacy profiles default to null', async () => {
  const env = fakeEnvironment();
  const first = await env.handler()({action: 'updateProfile', name: '新主页'});
  assert.equal(first.profile.babyAgeMonths, null);
  assert.equal(env.table('profiles').get(first.profile.id).babyAgeMonths, null);
  const legacy = env.addProfile('legacy');
  const oldRead = await env.handler('legacy')({action: 'mine'});
  assert.equal(oldRead.profile.babyAgeMonths, null);
  assert.equal(env.table('profiles').get(legacy).babyAgeMonths, undefined, 'a read must not backfill legacy data');
  for (const babyAgeMonths of [0, 18, null]) {
    await env.handler()({action: 'updateProfile', name: '原昵称', babyAgeMonths});
    const updated = await env.handler()({action: 'updateProfile', name: '旧客户端改名', bio: '新简介'});
    assert.equal(updated.profile.babyAgeMonths, babyAgeMonths);
    assert.equal(env.table('profiles').get(first.profile.id).babyAgeMonths, babyAgeMonths);
  }
});

test('invalid explicit month ages reject before resource access without altering a valid profile', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  env.table('profiles').get(profileId).babyAgeMonths = 8;
  const before = clone(Array.from(env.table('profiles')));
  for (const babyAgeMonths of [undefined, -1, 121, 0.5, 12.5, NaN, Infinity, '12', '', true, false, [], {}]) {
    const result = await env.handler()({action: 'updateProfile', name: '不得写入', babyAgeMonths});
    assert.equal(result.error.code, 'INVALID_BABY_AGE', String(babyAgeMonths));
  }
  assert.deepEqual(Array.from(env.table('profiles')), before);
  assert.equal(env.gets.length, 0); assert.equal(env.queries.length, 0);
  assert.equal(env.downloads.length, 0); assert.equal(env.uploads.length, 0);
});

test('legacy month age DTOs expose no private data and public recipe payloads remain unchanged', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  const aliceId = profileIdFor(ownerFor('alice')), bobId = env.addProfile('bob');
  env.commit();
  const accountBefore = clone(Array.from(env.table('accounts')));
  const filesBefore = Array.from(env.files, ([id, value]) => [id, value.toString('base64')]);
  await env.handler()({action: 'updateProfile', name: '公开厨房', babyAgeMonths: 14,
    owner: ownerFor('bob'), profileId: bobId, birthday: 'PRIVATE BIRTHDAY', nickname: 'PRIVATE NICKNAME'});
  await env.handler('bob')({action: 'updateProfile', name: '朋友厨房', babyAgeMonths: 8});
  Object.assign(env.table('profiles').get(aliceId), {birthday: 'PRIVATE BIRTHDAY', nickname: 'PRIVATE NICKNAME', privateNote: 'PRIVATE NOTE'});
  await env.handler()({action: 'follow', profileId: bobId, following: true});
  await env.handler('bob')({action: 'follow', profileId: aliceId, following: true});
  const mine = await env.handler()({action: 'mine'});
  const shared = await env.handler('visitor')({action: 'profile', profileId: aliceId});
  const detail = await env.handler('visitor')({action: 'recipe', recipeId});
  for (const dto of [mine.profile, shared.profile, detail.author]) {
    assert.equal(dto.babyAgeMonths, 14);
    assert.deepEqual(Object.keys(dto).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'exists']
      .concat(dto === mine.profile ? ['babyBirthDate'] : []).sort());
    assert.equal(JSON.stringify(dto).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(dto).includes(ownerFor('alice')), false);
  }
  for (const action of ['following', 'followers']) {
    const list = await env.handler()({action});
    assert.equal(list.profiles[0].id, bobId);
    assert.equal(list.profiles[0].babyAgeMonths, 8);
    const reverse = await env.handler('bob')({action});
    assert.equal(reverse.profiles[0].babyAgeMonths, 14);
  }
  assert.equal(Object.hasOwn(detail.recipe, 'babyAgeMonths'), false);
  const discovery = await env.handler('visitor')({action: 'discover'});
  assert.equal(Object.hasOwn(discovery.recipes[0], 'babyAgeMonths'), false);
  assert.deepEqual(Array.from(env.table('accounts')), accountBefore);
  assert.deepEqual(Array.from(env.files, ([id, value]) => [id, value.toString('base64')]), filesBefore);
  assert.equal(env.gets.some(item => item.name === COLLECTIONS.accounts), false);
  assert.equal(env.downloads.length, 0);
});

test('corrupt stored month ages are normalized to null without blocking profiles or leaking values', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  for (const babyAgeMonths of ['PRIVATE SECRET', -1, 121, 5.5, {birthday: 'PRIVATE SECRET'}]) {
    env.table('profiles').get(profileId).babyAgeMonths = babyAgeMonths;
    const result = await env.handler('visitor')({action: 'profile', profileId});
    assert.equal(result.profile.exists, true);
    assert.equal(result.profile.babyAgeMonths, null);
    assert.equal(JSON.stringify(result).includes('PRIVATE SECRET'), false);
    assert.deepEqual(env.table('profiles').get(profileId).babyAgeMonths, babyAgeMonths);
  }
  env.table('profiles').get(profileId).babyAgeMonths = 6;
  env.table('profiles').get(profileId).updatedAt = 1;
  assert.equal((await env.handler()({action: 'mine'})).profile.babyAgeMonths, 6, 'age is manually set and never grows from timestamps');
});

test('concurrent old profile edits preserve the latest committed month age and explicit clearing', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  for (const babyAgeMonths of [18, null, 0]) {
    const [updated, legacy] = await Promise.all([
      env.handler()({action: 'updateProfile', name: '设置月龄', babyAgeMonths}),
      env.handler()({action: 'updateProfile', name: '旧客户端改名', bio: '保留月龄'})
    ]);
    assert.equal(updated.profile.babyAgeMonths, babyAgeMonths);
    assert.equal(legacy.profile.babyAgeMonths, babyAgeMonths);
    const current = await env.handler()({action: 'mine'});
    assert.equal(current.profile.babyAgeMonths, babyAgeMonths);
    assert.equal(current.profile.name, '旧客户端改名');
  }
});

test('deployed birthday calendar helper remains identical to the client helper', () => {
  assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/babyBitesSocial/baby-age'), 'utf8'),
    fs.readFileSync(require.resolve('../utils/baby-age'), 'utf8'));
});

test('birthday-derived ages advance on the Chinese calendar and month-end anniversaries without writing on reads', async () => {
  const env = fakeEnvironment();
  let time = Date.parse('2025-02-27T15:59:59Z');
  const clock = () => time;
  const self = env.handler('alice', {}, clock), visitor = env.handler('visitor', {}, clock);
  const saved = await self({action: 'updateProfile', name: '月末厨房', babyBirthDate: '2025-01-31'});
  assert.equal(saved.profile.babyBirthDate, '2025-01-31');
  assert.equal(saved.profile.babyAgeMonths, 0);
  const before = clone(Array.from(env.table('profiles')));
  const cases = [
    ['2025-02-27T16:00:00Z', 1], // UTC+8 February 28, including a short month.
    ['2025-03-29T16:00:00Z', 1],
    ['2025-03-30T16:00:00Z', 2],
    ['2026-01-30T16:00:00Z', 12]
  ];
  for (const [instant, expected] of cases) {
    time = Date.parse(instant);
    const mine = await self({action: 'mine'});
    const publicRead = await visitor({action: 'profile', profileId: saved.profile.id});
    assert.equal(mine.profile.babyAgeMonths, expected, instant);
    assert.equal(publicRead.profile.babyAgeMonths, expected, instant);
    assert.equal(Object.hasOwn(publicRead.profile, 'babyBirthDate'), false);
  }
  assert.deepEqual(Array.from(env.table('profiles')), before);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.uploads.length, 0);
});

test('server birthday calculations cover leap days, today and the full accepted date range without a 120-month clamp', async () => {
  const cases = [
    ['2024-01-31', '2024-02-28T04:00:00Z', 0],
    ['2024-01-31', '2024-02-29T04:00:00Z', 1],
    ['2024-02-29', '2025-02-28T04:00:00Z', 12],
    ['2026-10-23', '2026-10-23T04:00:00Z', 0],
    ['1900-01-01', '2026-10-23T04:00:00Z', 1521]
  ];
  for (const [babyBirthDate, instant, months] of cases) {
    const env = fakeEnvironment();
    const saved = await env.handler('alice', {}, () => Date.parse(instant))({action: 'updateProfile', name: '我的厨房', babyBirthDate});
    assert.equal(saved.error, undefined, babyBirthDate + ' on ' + instant);
    assert.equal(saved.profile.babyAgeMonths, months);
    assert.equal(saved.profile.babyBirthDate, babyBirthDate);
    assert.equal(env.table('profiles').get(saved.profile.id).babyAgeMonths, null, 'derived age is not stored as a manual age');
  }
});

test('invalid birthdays fail before database access and never normalize impossible or future dates', async () => {
  const env = fakeEnvironment();
  const id = env.addProfile('alice');
  Object.assign(env.table('profiles').get(id), {babyBirthDate: '2026-09-20', babyAgeMonths: null});
  const before = clone(Array.from(env.table('profiles')));
  for (const babyBirthDate of [undefined, '', ' ', '2026-1-01', '2026-01-1', '2026/01/01',
    '2026-02-29', '2024-02-30', '1900-02-29', '2026-13-01', '2026-00-01', '2026-01-00',
    '1899-12-31', '2026-10-24', '2026-10-23T00:00:00Z', '2026-10-23\n', 20261023, true, [], {}]) {
    const result = await env.handler()({action: 'updateProfile', name: '不得保存', babyBirthDate});
    assert.equal(result.error.code, 'INVALID_BABY_BIRTH_DATE', String(babyBirthDate));
  }
  assert.deepEqual(Array.from(env.table('profiles')), before);
  assert.equal(env.gets.length, 0);
  assert.equal(env.queries.length, 0);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.uploads.length, 0);
  // Validation rolls over at midnight in China, rather than UTC midnight.
  const nextDay = await env.handler('alice', {}, () => Date.parse('2026-10-23T16:00:00Z'))({
    action: 'updateProfile', name: '当天生日', babyBirthDate: '2026-10-24'});
  assert.equal(nextDay.profile.babyAgeMonths, 0);
});

test('only own profile reads return the birthday and public DTOs expose calculated age without private data', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  const aliceId = profileIdFor(ownerFor('alice')), bobId = env.addProfile('bob');
  env.commit();
  const accountsBefore = clone(Array.from(env.table('accounts')));
  const filesBefore = Array.from(env.files, ([id, bytes]) => [id, Buffer.from(bytes)]);
  const updated = await env.handler()({action: 'updateProfile', name: '生日厨房', babyBirthDate: '2026-01-31',
    owner: ownerFor('bob'), profileId: bobId, birthday: 'PRIVATE OTHER BIRTHDAY', nickname: 'PRIVATE NICKNAME'});
  await env.handler('bob')({action: 'updateProfile', name: '朋友厨房', babyBirthDate: '2026-03-20'});
  await env.handler()({action: 'follow', profileId: bobId, following: true});
  await env.handler('bob')({action: 'follow', profileId: aliceId, following: true});
  const mine = await env.handler()({action: 'mine'});
  const ownProfile = await env.handler()({action: 'profile', profileId: aliceId});
  assert.equal(ownProfile.isSelf, true);
  for (const dto of [updated.profile, mine.profile, ownProfile.profile]) {
    assert.equal(dto.babyBirthDate, '2026-01-31');
    assert.equal(dto.babyAgeMonths, 8);
    assert.deepEqual(Object.keys(dto).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'babyBirthDate', 'exists'].sort());
  }
  const shared = await env.handler('visitor')({action: 'profile', profileId: aliceId, isSelf: true, owner: ownerFor('alice')});
  assert.equal(shared.isSelf, false);
  const authorSelf = await env.handler()({action: 'recipe', recipeId});
  const authorVisitor = await env.handler('visitor')({action: 'recipe', recipeId});
  for (const dto of [shared.profile, authorSelf.author, authorVisitor.author]) {
    assert.equal(dto.babyAgeMonths, 8);
    assert.deepEqual(Object.keys(dto).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'exists'].sort());
  }
  const publicResults = [shared, authorSelf, authorVisitor];
  for (const action of ['following', 'followers']) {
    const alice = await env.handler()({action}), bob = await env.handler('bob')({action});
    assert.equal(alice.profiles[0].babyAgeMonths, 7);
    assert.equal(bob.profiles[0].babyAgeMonths, 8);
    publicResults.push(alice, bob);
  }
  publicResults.push(await env.handler('bob')({action: 'feed'}), await env.handler('visitor')({action: 'discover'}));
  for (const value of publicResults) {
    const text = JSON.stringify(value);
    for (const secret of ['babyBirthDate', '2026-01-31', '2026-03-20', 'PRIVATE', ownerFor('alice')]) {
      assert.equal(text.includes(secret), false, secret);
    }
  }
  assert.deepEqual(Array.from(env.table('accounts')), accountsBefore);
  assert.deepEqual(Array.from(env.files), filesBefore);
  assert.equal(env.gets.some(item => item.name === COLLECTIONS.accounts), false);
  assert.equal(env.downloads.length, 0);
});

test('legacy monthly age stays usable until a birthday is supplied and explicit birthday clearing removes both fields', async () => {
  const env = fakeEnvironment();
  const handler = env.handler();
  const legacy = await handler({action: 'updateProfile', name: '旧资料', babyAgeMonths: 9});
  assert.equal(legacy.profile.babyAgeMonths, 9);
  assert.equal(legacy.profile.babyBirthDate, null);
  assert.equal((await handler({action: 'updateProfile', name: '旧客户端改名'})).profile.babyAgeMonths, 9);
  const fromBirthday = await handler({action: 'updateProfile', name: '填写生日', babyBirthDate: '2026-09-23'});
  assert.equal(fromBirthday.profile.babyAgeMonths, 1);
  assert.equal(env.table('profiles').get(fromBirthday.profile.id).babyAgeMonths, null);
  for (const input of [{}, {babyAgeMonths: 0}, {babyAgeMonths: 120}, {babyAgeMonths: null}]) {
    const updated = await handler({action: 'updateProfile', name: '旧客户端再次保存', ...input});
    assert.equal(updated.profile.babyBirthDate, '2026-09-23');
    assert.equal(updated.profile.babyAgeMonths, 1, 'stored birthday always takes precedence');
  }
  const cleared = await handler({action: 'updateProfile', name: '清除生日', babyBirthDate: null, babyAgeMonths: 10});
  assert.equal(cleared.profile.babyBirthDate, null);
  assert.equal(cleared.profile.babyAgeMonths, null);
  const stored = env.table('profiles').get(cleared.profile.id);
  assert.equal(stored.babyBirthDate, null);
  assert.equal(stored.babyAgeMonths, null);
  assert.equal((await handler({action: 'updateProfile', name: '不再显示月龄'})).profile.babyAgeMonths, null);
});

test('concurrent name-only updates preserve the latest birthday or its explicit clearing', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  for (const babyBirthDate of ['2026-01-31', '2026-10-23', null]) {
    const [updated, legacy] = await Promise.all([
      env.handler()({action: 'updateProfile', name: '修改生日', babyBirthDate}),
      env.handler()({action: 'updateProfile', name: '旧客户端改名'})
    ]);
    assert.equal(updated.profile.babyBirthDate, babyBirthDate);
    assert.equal(legacy.profile.babyBirthDate, babyBirthDate);
    const current = await env.handler()({action: 'mine'});
    assert.equal(current.profile.babyBirthDate, babyBirthDate);
    assert.equal(current.profile.name, '旧客户端改名');
    assert.equal(current.profile.babyAgeMonths, babyBirthDate === null ? null : babyBirthDate === '2026-10-23' ? 0 : 8);
  }
});

test('invalid stored birthday values are never exposed and reads preserve the legacy age without repairing the document', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  for (const babyBirthDate of ['PRIVATE BIRTHDAY', '2026-02-29', '2026-10-24', {secret: 'PRIVATE'}, undefined]) {
    Object.assign(env.table('profiles').get(profileId), {babyBirthDate, babyAgeMonths: 6});
    const before = clone(env.table('profiles').get(profileId));
    const self = await env.handler()({action: 'mine'});
    const visitor = await env.handler('visitor')({action: 'profile', profileId});
    assert.equal(self.profile.babyBirthDate, null);
    assert.equal(self.profile.babyAgeMonths, 6);
    assert.equal(visitor.profile.babyAgeMonths, 6);
    assert.equal(Object.hasOwn(visitor.profile, 'babyBirthDate'), false);
    assert.equal(JSON.stringify(visitor).includes('PRIVATE'), false);
    assert.deepEqual(clone(env.table('profiles').get(profileId)), before);
  }
});

test('sharing code cache transactions retain concurrent birthday edits and explicit clearing without exposing the birthday', async () => {
  for (const babyBirthDate of ['2026-01-31', null]) {
    const env = fakeEnvironment();
    const saved = await env.handler()({action: 'updateProfile', name: '原名字', babyBirthDate: '2026-02-28'});
    const profileId = saved.profile.id;
    const visitor = env.handler('visitor', {openapi: {wxacode: {async getUnlimited() {
      await env.handler()({action: 'updateProfile', name: '新名字', babyBirthDate});
      return {buffer: PNG};
    }}}});
    const result = await visitor({action: 'shareCode', profileId, envVersion: 'trial'});
    assert.equal(result.error, undefined);
    assert.deepEqual(Object.keys(result).sort(), ['profileId', 'envVersion', 'codeURL'].sort());
    const current = env.table('profiles').get(profileId);
    assert.equal(current.babyBirthDate, babyBirthDate);
    assert.equal(current.babyAgeMonths, null);
    assert.equal(current.name, '新名字');
    assert.ok(current.shareCodes.trial);
    const renamed = await env.handler()({action: 'updateProfile', name: '旧客户端又改名'});
    assert.equal(renamed.profile.babyBirthDate, babyBirthDate);
    assert.equal(env.table('profiles').get(profileId).shareCodes.trial, current.shareCodes.trial);
    assert.equal(env.table('accounts').size, 0);
  }
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

test('stock artwork keys cover all 21 seed IDs within the existing imageKey limit and do not guess other recipes', () => {
  assert.equal(seedRecipes.length, 21);
  for (const recipe of seedRecipes) {
    const key = getImageKey(recipe.id, recipe.imageKey);
    assert.equal(key, 'dish:' + recipe.id);
    assert.ok(key.length <= 40);
  }
  for (const id of ['my-pumpkin', 'pumpkin-millet-copy', 'dish:pumpkin-millet', '__proto__', 'constructor', 'toString', '', null]) {
    assert.equal(getImageKey(id, 'pumpkin'), 'pumpkin');
    assert.equal(getImageKey(id, ''), '');
  }
  assert.equal(getImageKey('shared-' + '1'.repeat(64), 'dish:pumpkin-millet'), 'dish:pumpkin-millet');
});

test('publishing any catalog recipe adds its exact stock key without changing private source data or leaking source IDs', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = snapshot();
  input.data.recipes = seedRecipes.map((recipe, index) => ({...clone(recipe), photo: '', favorite: false,
    isExample: false, createdAt: NOW - 21 + index, updatedAt: NOW}));
  input.data.logs = [];
  env.commit('alice', input);
  const privateBefore = Array.from(env.files, ([id, bytes]) => [id, Buffer.from(bytes)]);
  const handler = env.handler();
  for (const recipe of seedRecipes) {
    const response = await handler({action: 'publish', sourceRecipeId: recipe.id, imageKey: 'dish:forged'});
    assert.equal(response.error, undefined, recipe.id);
    assert.equal(response.recipe.imageKey, 'dish:' + recipe.id);
    assert.equal(response.recipe.photoURL, '');
    assert.equal(response.recipe.sourceRecipeId, undefined);
    assert.equal(response.recipe.id, recipeIdFor(ownerFor('alice'), recipe.id));
    assert.equal(env.table('recipes').get(response.recipe.id).imageKey, 'dish:' + recipe.id);
    assert.equal(JSON.stringify(response).includes(ownerFor('alice')), false);
  }
  assert.deepEqual(Array.from(env.files), privateBefore);
  assert.equal(env.uploads.length, 0);
});

test('legacy public catalog recipes receive stock covers in detail, profiles, discovery and following feeds without writes', async () => {
  const env = fakeEnvironment();
  const id = env.addPublished('alice', 'pumpkin-millet');
  const profileId = profileIdFor(ownerFor('alice'));
  env.table('follows').set(ownerFor('bob'), {_id: ownerFor('bob'), profileIds: [profileId]});
  const before = clone(Array.from(env.tables, ([name, table]) => [name, Array.from(table)]));
  const visitor = env.handler('bob');
  const results = [
    (await visitor({action: 'recipe', recipeId: id})).recipe,
    (await visitor({action: 'profile', profileId})).recipes[0],
    (await visitor({action: 'discover', search: ''})).recipes[0],
    (await visitor({action: 'feed'})).recipes[0]
  ];
  for (const recipe of results) {
    assert.equal(recipe.id, id);
    assert.equal(recipe.imageKey, 'dish:pumpkin-millet');
    assert.equal(recipe.sourceRecipeId, undefined);
  }
  assert.deepEqual(clone(Array.from(env.tables, ([name, table]) => [name, Array.from(table)])), before);
  assert.equal(env.table('recipes').get(id).imageKey, 'pumpkin');
  assert.equal(env.downloads.length, 0);
  assert.equal(env.uploads.length, 0);
});

test('ordinary recipes keep their image keys and saved public copies retain an explicit stock key when republished', async () => {
  for (const imageKey of ['pumpkin', 'dish:broccoli-potato']) {
    const env = fakeEnvironment();
    env.addProfile('alice');
    const input = snapshot();
    const sourceId = imageKey.startsWith('dish:') ? 'shared-' + '1'.repeat(64) : 'recipe-1';
    input.data.recipes[0].id = sourceId;
    input.data.recipes[0].imageKey = imageKey;
    input.data.logs = [];
    env.commit('alice', input);
    const response = await env.handler()({action: 'publish', sourceRecipeId: sourceId});
    assert.equal(response.error, undefined);
    assert.equal(response.recipe.imageKey, imageKey);
    assert.equal(response.recipe.sourceRecipeId, undefined);
    const visitor = await env.handler('bob')({action: 'recipe', recipeId: response.recipe.id});
    assert.equal(visitor.recipe.imageKey, imageKey);
  }
});

test('a catalog stock key does not replace the separately published user photo', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const input = snapshot();
  input.data.recipes[0].id = 'pumpkin-millet';
  input.data.logs = [];
  const photo = privateFile(ownerFor('alice'), 'photos/custom.jpg');
  input.data.recipes[0].photo = photo;
  env.files.set(photo, JPG);
  env.commit('alice', input);
  const response = await env.handler()({action: 'publish', sourceRecipeId: 'pumpkin-millet'});
  assert.equal(response.error, undefined);
  assert.equal(response.recipe.imageKey, 'dish:pumpkin-millet');
  assert.match(response.recipe.photoURL, /^https:\/\//);
  assert.equal(env.uploads.length, 1);
  assert.deepEqual(env.uploads[0].fileContent, JPG);
  assert.deepEqual(env.files.get(photo), JPG);
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
  env.addProfile('bob');
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
  env.addProfile('bob');
  const bob = env.handler('bob');
  for (let index = 0; index < 2; index++) assert.deepEqual(await bob({action: 'follow', profileId, following: true}), {following: true, followedBy: false});
  assert.equal((await bob({action: 'mine'})).followingCount, 1);
  assert.equal((await env.handler('charlie')({action: 'mine'})).followingCount, 0);
  assert.equal((await env.handler()({action: 'follow', profileId, following: true})).error.code, 'INVALID_REQUEST');
  assert.equal((await bob({action: 'follow', profileId: 'f'.repeat(32), following: true})).error.code, 'NOT_FOUND');
  for (let index = 0; index < 2; index++) assert.deepEqual(await bob({action: 'follow', profileId, following: false}), {following: false, followedBy: false});
  assert.equal((await bob({action: 'mine'})).followingCount, 0);
});

test('following requires an explicit public profile, while legacy unnamed accounts can still unfollow', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const bobOwner = ownerFor('bob');
  const bob = env.handler('bob');
  assert.equal((await bob({action: 'follow', profileId: aliceId, following: true})).error.code, 'PROFILE_REQUIRED');
  assert.equal(env.table('profiles').size, 1);
  assert.equal(env.table('follows').size, 0);
  const legacy = {_id: bobOwner, profileIds: [aliceId], updatedAt: NOW - 10};
  env.table('follows').set(bobOwner, clone(legacy));
  assert.equal((await bob({action: 'follow', profileId: aliceId, following: true})).error.code, 'PROFILE_REQUIRED');
  assert.deepEqual(env.table('follows').get(bobOwner), legacy);
  assert.equal((await bob({action: 'mine'})).followingCount, 1);
  assert.equal((await env.handler()({action: 'mine'})).followerCount, 1);
  assert.deepEqual(await env.handler()({action: 'followers'}), {profiles: [], nextOffset: null});
  assert.deepEqual(await bob({action: 'follow', profileId: aliceId, following: false}), {following: false, followedBy: false});
  assert.equal((await env.handler()({action: 'mine'})).followerCount, 0);
  assert.equal(env.table('profiles').size, 1);
});

test('follow back and unfollow keep both relationship directions and counts consistent', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const bobId = env.addProfile('bob');
  const alice = env.handler();
  const bob = env.handler('bob');
  assert.deepEqual(await bob({action: 'follow', profileId: aliceId, following: true}), {following: true, followedBy: false});
  let page = await alice({action: 'profile', profileId: bobId});
  assert.equal(page.following, false);
  assert.equal(page.followedBy, true);
  assert.equal(page.followingCount, 1);
  assert.equal(page.followerCount, 0);
  const incoming = await alice({action: 'followers'});
  assert.deepEqual(incoming.profiles[0], {id: bobId, name: 'bob的小厨房', bio: '今天做点好吃的',
    babyAgeMonths: null, exists: true, following: false, followedBy: true});
  const replies = await Promise.all(Array.from({length: 3}, () => alice({action: 'follow', profileId: bobId, following: true})));
  assert.deepEqual(replies, Array(3).fill({following: true, followedBy: true}));
  assert.deepEqual(env.table('follows').get(ownerFor('alice')).profileIds, [bobId]);
  for (const handler of [alice, bob]) {
    const mine = await handler({action: 'mine'});
    assert.equal(mine.followingCount, 1);
    assert.equal(mine.followerCount, 1);
    for (const action of ['following', 'followers']) {
      const list = await handler({action});
      assert.equal(list.profiles.length, 1);
      assert.equal(list.profiles[0].following, true);
      assert.equal(list.profiles[0].followedBy, true);
    }
  }
  assert.deepEqual(await alice({action: 'follow', profileId: bobId, following: false}), {following: false, followedBy: true});
  assert.equal((await alice({action: 'mine'})).followingCount, 0);
  assert.equal((await bob({action: 'mine'})).followerCount, 0);
  page = await bob({action: 'profile', profileId: aliceId});
  assert.equal(page.following, true);
  assert.equal(page.followedBy, false);
  assert.equal((await alice({action: 'followers'})).profiles[0].following, false);
  assert.deepEqual(await bob({action: 'followers'}), {profiles: [], nextOffset: null});
});

test('concurrent reciprocal follows return mutual state after both transactions complete', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const bobId = env.addProfile('bob');
  const results = await Promise.all([
    env.handler()({action: 'follow', profileId: bobId, following: true}),
    env.handler('bob')({action: 'follow', profileId: aliceId, following: true})
  ]);
  assert.equal(results.every(result => result.following === true), true);
  for (const [openid, otherId] of [['alice', bobId], ['bob', aliceId]]) {
    const page = await env.handler(openid)({action: 'profile', profileId: otherId});
    assert.equal(page.following, true);
    assert.equal(page.followedBy, true);
    assert.equal(page.followingCount, 1);
    assert.equal(page.followerCount, 1);
  }
});

test('followers query is account-scoped, stably paginated and skips unnamed legacy accounts without leaking owners', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const bobId = env.addProfile('bob');
  const owners = Array.from({length: 23}, (_, index) => {
    const openid = `friend-${index}`;
    env.addProfile(openid);
    const owner = ownerFor(openid);
    env.table('follows').set(owner, {_id: owner, profileIds: [aliceId], updatedAt: NOW});
    return owner;
  }).sort();
  env.table('profiles').delete(profileIdFor(owners[0]));
  const strangerOwner = ownerFor('stranger');
  env.addProfile('stranger');
  env.table('follows').set(strangerOwner, {_id: strangerOwner, profileIds: [bobId]});
  const mutualId = profileIdFor(owners[1]);
  env.table('follows').set(ownerFor('alice'), {_id: ownerFor('alice'), profileIds: [mutualId]});
  const first = await env.handler()({action: 'followers', owner: ownerFor('bob'), profileId: bobId});
  const second = await env.handler()({action: 'followers', offset: first.nextOffset});
  assert.equal(first.profiles.length, 19);
  assert.equal(first.nextOffset, 20);
  assert.equal(second.profiles.length, 3);
  assert.equal(second.nextOffset, null);
  const profiles = first.profiles.concat(second.profiles);
  assert.deepEqual(profiles.map(item => item.id), owners.slice(1).map(profileIdFor));
  assert.equal(profiles.every(item => item.followedBy === true), true);
  assert.deepEqual(profiles.filter(item => item.following).map(item => item.id), [mutualId]);
  assert.equal((await env.handler()({action: 'mine'})).followerCount, 23);
  for (const item of profiles) assert.deepEqual(Object.keys(item).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'exists', 'following', 'followedBy'].sort());
  for (const owner of owners) assert.equal(JSON.stringify({first, second}).includes(owner), false);
  const queries = env.queries.filter(query => query.name === COLLECTIONS.follows && !query.count);
  assert.equal(queries.length, 2);
  for (const query of queries) {
    assert.deepEqual(query.condition, {profileIds: {operator: 'in', values: [aliceId]}});
    assert.deepEqual(query.sorts, [{field: '_id', direction: 'asc'}]);
    assert.equal(query.limit, PAGE_SIZE + 1);
  }
  assert.deepEqual(queries.map(query => query.skip), [0, 20]);
});

test('legacy followers become visible only after saving their own public profile', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const bobOwner = ownerFor('bob');
  env.table('follows').set(bobOwner, {_id: bobOwner, profileIds: [aliceId]});
  assert.equal((await env.handler()({action: 'followers'})).profiles.length, 0);
  assert.deepEqual(await env.handler('bob')({action: 'followers', profileId: aliceId}), {profiles: [], nextOffset: null});
  await env.handler('bob')({action: 'updateProfile', name: '小波厨房'});
  const list = await env.handler()({action: 'followers'});
  assert.equal(list.profiles[0].name, '小波厨房');
  assert.equal(list.profiles[0].followedBy, true);
  assert.deepEqual(env.table('follows').get(bobOwner).profileIds, [aliceId]);
});

test('followers continue past 1020 relationships without truncating later pages', async () => {
  const env = fakeEnvironment();
  const aliceId = env.addProfile('alice');
  const owners = Array.from({length: 1041}, (_, index) => {
    const openid = `fan-${index}`;
    env.addProfile(openid);
    const owner = ownerFor(openid);
    env.table('follows').set(owner, {_id: owner, profileIds: [aliceId]});
    return owner;
  }).sort();
  const first = await env.handler()({action: 'followers', offset: 1000});
  assert.equal(first.profiles.length, PAGE_SIZE);
  assert.equal(first.nextOffset, 1020);
  const second = await env.handler()({action: 'followers', offset: first.nextOffset});
  assert.equal(second.profiles.length, PAGE_SIZE);
  assert.equal(second.nextOffset, 1040);
  const third = await env.handler()({action: 'followers', offset: second.nextOffset});
  assert.equal(third.profiles.length, 1);
  assert.equal(third.nextOffset, null);
  assert.deepEqual([...first.profiles, ...second.profiles, ...third.profiles].map(item => item.id),
    owners.slice(1000).map(profileIdFor));
  assert.equal((await env.handler()({action: 'mine'})).followerCount, 1041);
});

test('relationship mutations fail closed on damaged reverse records without writing the caller account', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
  const bobId = env.addProfile('bob');
  env.table('follows').set(ownerFor('bob'), {_id: ownerFor('bob'), profileIds: ['invalid']});
  const result = await env.handler()({action: 'follow', profileId: bobId, following: true});
  assert.equal(result.error.code, 'INVALID_ACCOUNT');
  assert.equal(env.table('follows').has(ownerFor('alice')), false);
});

test('concurrent follow edits do not overwrite each other and the follow limit is enforced', async () => {
  const env = fakeEnvironment();
  const first = env.addProfile('alice');
  const second = env.addProfile('charlie');
  env.addProfile('bob');
  const bob = env.handler('bob');
  await Promise.all([first, second].map(profileId => bob({action: 'follow', profileId, following: true})));
  assert.equal((await bob({action: 'mine'})).followingCount, 2);
  const ids = Array.from({length: 200}, (_, i) => profileIdFor(ownerFor(`friend-${i}`)));
  env.table('follows').set(ownerFor('bob'), {profileIds: ids});
  assert.equal((await bob({action: 'follow', profileId: first, following: true})).error.code, 'FOLLOW_LIMIT');
  await bob({action: 'follow', profileId: ids[0], following: false});
  assert.deepEqual(await bob({action: 'follow', profileId: first, following: true}), {following: true, followedBy: false});
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
  assert.deepEqual(Object.keys(first.profiles[0]).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'exists', 'following', 'followedBy'].sort());
  assert.equal(first.profiles.every(item => item.following === true && item.followedBy === false), true);
});

test('profile listing is paginated, shows follow state, and does not leak private recipes', async () => {
  const env = fakeEnvironment();
  for (let index = 0; index < 23; index++) env.addPublished('alice', `recipe-${index}`, NOW - index);
  env.commit();
  const profileId = profileIdFor(ownerFor('alice'));
  env.addProfile('bob');
  const bob = env.handler('bob');
  await bob({action: 'follow', profileId, following: true});
  const first = await bob({action: 'profile', profileId});
  assert.equal(first.isSelf, false);
  assert.equal(first.following, true);
  assert.equal(first.followedBy, false);
  assert.equal(first.followingCount, 0);
  assert.equal(first.followerCount, 1);
  assert.equal(first.publishedCount, 23);
  assert.equal(first.recipes.length, 20);
  assert.equal(first.nextOffset, 20);
  const second = await bob({action: 'profile', profileId, offset: 20});
  assert.equal(second.recipes.length, 3);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set(first.recipes.concat(second.recipes).map(item => item.id)).size, 23);
  assert.equal(second.publishedCount, 23);
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
  env.addProfile('alice');
  env.addPublished('bob');
  const profileId = profileIdFor(ownerFor('bob'));
  await handler({action: 'follow', profileId, following: true});
  assert.equal((await handler({action: 'feed'})).recipes.length, 1);
  await handler({action: 'follow', profileId, following: false});
  assert.equal((await handler({action: 'feed'})).recipes.length, 0);
});

test('discover lists latest public recipes for a new visitor without reading private data', async () => {
  const env = fakeEnvironment();
  for (let index = 0; index < 23; index++) env.addPublished(`chef-${index}`, `public-${index}`, NOW - index);
  const withdrawn = env.addPublished('withdrawn', 'withdrawn', NOW + 1);
  env.table('recipes').get(withdrawn).published = false;
  env.commit('alice');
  const privateBefore = clone(Array.from(env.table('accounts').values()));
  const first = await env.handler()({action: 'discover'});
  const newer = env.addPublished('newer', 'after-first-page', NOW + 2);
  const second = await env.handler()({action: 'discover', cursor: first.nextCursor});
  const recipes = first.recipes.concat(second.recipes);
  assert.equal(first.recipes.length, 20);
  assert.equal(second.recipes.length, 3);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set(recipes.map(item => item.id)).size, 23);
  for (let index = 1; index < recipes.length; index++) assert.ok(recipes[index - 1].publishedAt > recipes[index].publishedAt);
  assert.equal(recipes.some(item => item.id === newer || item.id === withdrawn), false);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.gets.some(item => item.name === COLLECTIONS.accounts), false);
  assert.deepEqual(Array.from(env.table('accounts').values()), privateBefore);
  assert.equal(env.table('profiles').has(profileIdFor(ownerFor('alice'))), false);
  for (const forbidden of ['Private baby name', 'PRIVATE NOTE', 'PRIVATE MEAL', 'sourceRecipeId', ownerFor('chef-0')]) {
    assert.equal(JSON.stringify(recipes).includes(forbidden), false);
  }
  for (const query of env.queries) {
    assert.equal(query.name, COLLECTIONS.recipes);
    assert.equal(query.condition.published, true);
    assert.equal(query.limit, PAGE_SIZE + 1);
    assert.equal(query.skip, 0);
    assert.equal(query.fields.steps, undefined);
    assert.equal(query.fields.note, undefined);
  }
});

test('discover search matches literal recipe names, ingredients and current public author names only', async () => {
  const env = fakeEnvironment();
  const recipeId = env.addPublished('alice');
  env.table('recipes').get(recipeId).name = '鸡蛋 [南瓜] 饼';
  env.table('recipes').get(recipeId).ingredients = [{name: '胡萝卜', amount: '20克'}];
  env.table('recipes').get(recipeId).note = 'SECRET-NOTE';
  env.table('profiles').get(profileIdFor(ownerFor('alice'))).name = 'ＡＬＩＣＥ厨房';
  env.table('profiles').get(profileIdFor(ownerFor('alice'))).bio = 'SECRET-BIO';
  for (const search of ['鸡蛋', '[南瓜]', '胡萝卜', 'ALICE', '  alice   胡萝卜  ']) {
    const result = await env.handler('visitor')({action: 'discover', search});
    assert.deepEqual(result.recipes.map(item => item.id), [recipeId], search);
  }
  for (const search of ['.*', 'SECRET-NOTE', 'SECRET-BIO', '鸡蛋 小米']) {
    assert.deepEqual(await env.handler('visitor')({action: 'discover', search}), {recipes: [], nextCursor: null}, search);
  }
  await env.handler()({action: 'updateProfile', name: '小米厨房'});
  assert.equal((await env.handler('visitor')({action: 'discover', search: 'ALICE'})).recipes.length, 0);
  assert.equal((await env.handler('visitor')({action: 'discover', search: '小米厨房'})).recipes.length, 1);
});

test('discover cursor is bound to normalized search and rejects malformed inputs before database access', async () => {
  const env = fakeEnvironment();
  for (let index = 0; index < 23; index++) env.addPublished('alice', `r-${index}`, NOW - index);
  const handler = env.handler('visitor');
  const first = await handler({action: 'discover', search: '  南瓜  '});
  assert.ok(first.nextCursor);
  const second = await handler({action: 'discover', search: '南瓜', cursor: first.nextCursor});
  assert.equal(second.recipes.length, 3);
  const getsBefore = env.gets.length;
  const queriesBefore = env.queries.length;
  for (const request of [
    {search: '胡萝卜', cursor: first.nextCursor}, {cursor: 0}, {cursor: null}, {cursor: '../private'},
    {cursor: first.nextCursor + 'x'}, {search: null}, {search: {}}, {search: '字'.repeat(61)},
    {search: 'a\nb'}, {search: 'a b c d e f g'}
  ]) assert.equal((await handler({action: 'discover', ...request})).error.code, 'INVALID_REQUEST');
  assert.equal(env.gets.length, getsBefore);
  assert.equal(env.queries.length, queriesBefore);
});

test('discover search bounds each scan and advances an empty page to older matching recipes', async () => {
  const env = fakeEnvironment();
  let expected;
  for (let index = 0; index < 65; index++) {
    const id = env.addPublished('alice', `r-${index}`, NOW - index);
    env.table('recipes').get(id).name = index === 60 ? '西兰花面条' : '南瓜粥';
    if (index === 60) expected = id;
  }
  const first = await env.handler('visitor')({action: 'discover', search: '西兰花'});
  assert.deepEqual(first.recipes, []);
  assert.ok(first.nextCursor);
  assert.equal(env.queries.length, 1);
  assert.equal(env.queries[0].limit, 61);
  assert.equal(env.gets.filter(item => item.name === COLLECTIONS.recipes).length, 0);
  const second = await env.handler('visitor')({action: 'discover', search: '西兰花', cursor: first.nextCursor});
  assert.deepEqual(second.recipes.map(item => item.id), [expected]);
  assert.equal(second.nextCursor, null);
  assert.ok(env.queries.every(query => query.condition.published === true && query.limit === 61 && query.skip === 0));
});

test('discover excludes a withdrawal during signing and corrupt author ownership', async () => {
  const env = fakeEnvironment();
  const id = env.addPublished('alice');
  const record = env.table('recipes').get(id);
  record.photoFileID = cloudFile(`social/${record.profileId}/${id}/photo.jpg`);
  const corrupt = env.addPublished('charlie', 'corrupt', NOW - 1);
  env.table('recipes').get(corrupt).owner = ownerFor('alice');
  const result = await env.handler('visitor', {async getTempFileURL({fileList}) {
    await env.handler()({action: 'unpublish', sourceRecipeId: 'recipe-1'});
    return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://signed.example.test/code'}]};
  }})({action: 'discover'});
  assert.deepEqual(result, {recipes: [], nextCursor: null});
});

test('shareCode uses the verified public profile scene, version and page with a temporary URL', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  env.commit();
  const privateBefore = clone(Array.from(env.table('accounts').values()));
  for (const envVersion of ['develop', 'trial', 'release']) {
    const result = await env.handler()({action: 'shareCode', profileId, envVersion,
      scene: ownerFor('bob'), page: 'pages/private/index', width: 1280, checkPath: false});
    assert.deepEqual(Object.keys(result).sort(), ['profileId', 'envVersion', 'codeURL'].sort());
    assert.equal(result.profileId, profileId);
    assert.equal(result.envVersion, envVersion);
    assert.ok(result.codeURL.startsWith('https://'));
    assert.deepEqual(env.codeRequests[env.codeRequests.length - 1], {
      scene: profileId, page: 'pages/profile/index', envVersion, checkPath: envVersion === 'release', width: 430
    });
    assert.equal(env.signed[env.signed.length - 1].maxAge, 300);
    assert.match(env.uploads[env.uploads.length - 1].cloudPath,
      new RegExp(`^social/${profileId}/codes/${envVersion}/v1-[A-Za-z0-9_-]+\\.png$`));
    assert.equal(JSON.stringify(result).includes(ownerFor('alice')), false);
  }
  assert.equal(env.gets.some(item => item.name === COLLECTIONS.accounts), false);
  assert.equal(env.downloads.length, 0);
  assert.deepEqual(Array.from(env.table('accounts').values()), privateBefore);
  const mine = await env.handler()({action: 'mine'});
  assert.equal(JSON.stringify(mine.profile).includes('shareCodes'), false);
});

test('shareCode caches per profile and version without losing a concurrent profile edit', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  const handler = env.handler('visitor', {openapi: {wxacode: {async getUnlimited(args) {
    env.codeRequests.push(clone(args));
    await env.handler()({action: 'updateProfile', name: '新名字', bio: '新简介', babyAgeMonths: 17});
    return {buffer: PNG};
  }}}});
  const first = await handler({action: 'shareCode', profileId, envVersion: 'trial'});
  const stored = env.table('profiles').get(profileId);
  assert.equal(stored.name, '新名字');
  assert.equal(stored.bio, '新简介');
  assert.equal(stored.babyAgeMonths, 17);
  assert.ok(stored.shareCodes.trial);
  await env.handler()({action: 'updateProfile', name: '再次改名', bio: ''});
  const second = await env.handler('visitor')({action: 'shareCode', profileId, envVersion: 'trial'});
  assert.equal(second.codeURL, first.codeURL);
  assert.equal(env.codeRequests.length, 1);
  assert.equal(env.uploads.length, 1);
  assert.equal(env.signed.length, 2);
  assert.equal(env.table('profiles').get(profileId).name, '再次改名');
  assert.equal(env.table('profiles').get(profileId).babyAgeMonths, 17);
});

test('concurrent shareCode generation converges on one cached file without exposing intermediate files', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  const results = await Promise.all(Array.from({length: 3}, () => env.handler()({action: 'shareCode', profileId, envVersion: 'trial'})));
  assert.equal(new Set(results.map(result => result.codeURL)).size, 1);
  const cached = env.table('profiles').get(profileId).shareCodes.trial;
  assert.equal(env.signed.every(item => item.fileID === cached), true);
});

test('shareCode rejects absent profiles and invalid versions before calling WeChat or storage', async () => {
  const env = fakeEnvironment();
  const profileId = profileIdFor(ownerFor('alice'));
  assert.equal((await env.handler()({action: 'shareCode', profileId, envVersion: 'trial'})).error.code, 'PROFILE_REQUIRED');
  env.addProfile('alice');
  for (const request of [{envVersion: undefined}, {envVersion: 'preview'}, {envVersion: null},
    {envVersion: 'trial', profileId: '../private'}, {envVersion: 'trial', profileId: ownerFor('alice')}]) {
    assert.equal((await env.handler()({action: 'shareCode', profileId, ...request})).error.code, 'INVALID_REQUEST');
  }
  assert.equal(env.codeRequests.length, 0);
  assert.equal(env.uploads.length, 0);
  assert.equal(env.signed.length, 0);
});

test('shareCode reports unpublished release pages distinctly and hides upstream diagnostics', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  for (const envVersion of ['release', 'trial']) {
    const result = await env.handler('alice', {openapi: {wxacode: {async getUnlimited() {
      throw {errCode: 41030, errMsg: 'SECRET upstream diagnostics'};
    }}}})({action: 'shareCode', profileId, envVersion});
    assert.equal(result.error.code, envVersion === 'release' ? 'SHARE_CODE_NOT_PUBLISHED' : 'SHARE_CODE_UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
  }
  const denied = await env.handler('alice', {openapi: {wxacode: {async getUnlimited() {
    return {errCode: -604101, errMsg: 'SECRET permissions'};
  }}}})({action: 'shareCode', profileId, envVersion: 'release'});
  assert.equal(denied.error.code, 'SHARE_CODE_UNAVAILABLE');
  assert.equal(JSON.stringify(denied).includes('SECRET'), false);
  assert.equal(env.uploads.length, 0);
  assert.equal(env.table('profiles').get(profileId).shareCodes, undefined);
});

test('shareCode accepts PNG and JPEG bytes with matching extensions and reuses both cached formats', async () => {
  for (const [buffer, extension, contentType] of [[PNG, 'png', 'image/png'], [JPG, 'jpg', 'image/jpeg']]) {
    const env = fakeEnvironment();
    const profileId = env.addProfile('alice');
    let calls = 0;
    const handler = env.handler('alice', {openapi: {wxacode: {async getUnlimited() {
      calls += 1;
      return {buffer, contentType};
    }}}});
    const first = await handler({action: 'shareCode', profileId, envVersion: 'trial'});
    assert.equal(first.error, undefined);
    assert.ok(env.uploads[0].cloudPath.endsWith(`.${extension}`));
    assert.deepEqual(env.uploads[0].fileContent, buffer);
    assert.ok(env.table('profiles').get(profileId).shareCodes.trial.endsWith(`.${extension}`));
    const second = await handler({action: 'shareCode', profileId, envVersion: 'trial'});
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    assert.equal(env.uploads.length, 1);
  }
});

test('shareCode rejects invalid image payloads and foreign upload paths without caching them', async () => {
  for (const buffer of [undefined, Buffer.from('{"errcode":41030}'), Buffer.from('GIF89a000'), Buffer.concat([PNG, Buffer.alloc(512 * 1024)])]) {
    const env = fakeEnvironment();
    const profileId = env.addProfile('alice');
    const result = await env.handler('alice', {openapi: {wxacode: {async getUnlimited() { return {buffer}; }}}})({action: 'shareCode', profileId, envVersion: 'trial'});
    assert.equal(result.error.code, 'SHARE_CODE_FAILED');
    assert.equal(env.uploads.length, 0);
    assert.equal(env.table('profiles').get(profileId).shareCodes, undefined);
  }
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  const result = await env.handler('alice', {async uploadFile() {
    return {fileID: privateFile(ownerFor('alice'), 'photos/private.png')};
  }})({action: 'shareCode', profileId, envVersion: 'trial'});
  assert.equal(result.error.code, 'STORAGE_FAILED');
  assert.equal(env.table('profiles').get(profileId).shareCodes, undefined);
  assert.equal(env.signed.length, 0);
});

test('shareCode never signs corrupt cached private paths and rechecks profile availability after signing', async () => {
  const env = fakeEnvironment();
  const profileId = env.addProfile('alice');
  const privatePath = privateFile(ownerFor('alice'), 'photos/private.png');
  env.table('profiles').get(profileId).shareCodes = {trial: privatePath};
  const result = await env.handler()({action: 'shareCode', profileId, envVersion: 'trial'});
  assert.ok(result.codeURL);
  assert.equal(env.codeRequests.length, 1);
  assert.equal(env.signed.some(item => item.fileID === privatePath), false);
  const disappeared = await env.handler('alice', {async getTempFileURL({fileList}) {
    env.table('profiles').delete(profileId);
    return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://signed.example.test/code'}]};
  }})({action: 'shareCode', profileId, envVersion: 'trial'});
  assert.equal(disappeared.error.code, 'NOT_FOUND');
  assert.equal(disappeared.codeURL, undefined);
});

test('very long recipes remain intact while page payloads stay below the mini-program limit', async () => {
  const env = fakeEnvironment();
  env.addProfile('alice');
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
  for (const offset of [-1, 0.5, '20', null, Number.MAX_SAFE_INTEGER - PAGE_SIZE + 1, Infinity, NaN]) {
    assert.equal((await handler({action: 'followers', offset})).error.code, 'INVALID_REQUEST');
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
