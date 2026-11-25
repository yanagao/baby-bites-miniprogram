'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createHandler, profileIdFor, recipeIdFor, COLLECTIONS, PAGE_SIZE} = require('../cloudfunctions/babyBitesSocial');
const {normalizeMealPlan, normalizeDays} = require('../utils/public-meal-plans');
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

function fakeEnvironment(options = {}) {
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
        if (options.beforeRead) await options.beforeRead({kind: 'count', name, condition});
        return {total: Array.from(table.values()).filter(item => matches(item, condition)).length};
      },
      async get() {
        queries.push({name, condition, sorts, skip, limit, fields});
        if (options.beforeRead) await options.beforeRead({kind: 'query', name, condition, fields});
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
      return {async get() {
        gets.push({name, id});
        if (options.beforeRead) await options.beforeRead({kind: 'document', name, id});
        return {data: clone(table.get(id) || null)};
      },
        async set({data}) {
          if (options.beforeWrite) await options.beforeWrite({name, id, data});
          writes.push({name, id, data: clone(data)}); table.set(id, {_id: id, ...clone(data)});
        }};
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
          security: {async msgSecCheck(args) { moderationRequests.push(clone(args)); return moderation(args); },
            async imgSecCheck(args) { moderationRequests.push({image: true, contentType: args.media.contentType, bytes: args.media.value.length}); return {errCode: 0}; }},
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

function plan(recipeId = 'recipe-1', date = '2026-10-23', meal = 'lunch') {
  return {id: `meal-${date}-${meal}`, recipeId, date, meal, createdAt: NOW - 10, updatedAt: NOW};
}
function plannedSnapshot(plans = [plan()], recipes = snapshot().data.recipes) {
  const data = snapshot();
  data.data.recipes = clone(recipes); data.data.mealPlans = clone(plans);
  data.data.logs = [];
  data.deleted.mealPlans = [];
  return data;
}
function publicMeal(id, overrides = {}) {
  return {id, name: '菜谱recipe-1', minutes: 20, texture: '软烂颗粒', imageKey: 'pumpkin', photoURL: '', kind: 'public', ...overrides};
}
function familySnapshot(env, data, members = ['alice', 'bob'], options = {}) {
  const id = options.id || 'f'.repeat(64), fileID = cloudFile(`families/${id}/snapshots/current.json`);
  const familyMembers = members.map((name, index) => ({owner: ownerFor(name), id: String(index + 1).repeat(32),
    membershipId: String(index + 4).repeat(32), label: index ? '爸爸' : '妈妈'}));
  const family = {_id: id, name: 'PRIVATE FAMILY', managerOwner: ownerFor(members[0]), createdBy: ownerFor(members[0]),
    members: familyMembers, revision: 3, attributionV1Revision: 3, legacyRecordersChecked: true, fileID, createdAt: NOW - 100};
  Object.assign(family, options.fields || {});
  env.table('families').set(id, family);
  for (const member of familyMembers) env.table('memberships').set(member.owner, {_id: member.owner,
    familyId: id, membershipId: member.membershipId, active: true});
  env.files.set(fileID, Buffer.from(JSON.stringify(data)));
  return {family, scope: {kind: 'family', id, membershipId: familyMembers[0].membershipId}};
}

test('public daily plans expose only confirmed arrangements and whitelisted publication summaries in meal order', async () => {
  const env = fakeEnvironment(), publicId = env.addPublished('alice'), profileId = profileIdFor(ownerFor('alice'));
  const data = plannedSnapshot([plan('recipe-1', '2026-10-23', 'dinner'), plan(), plan('recipe-1', '2026-10-23', 'breakfast')]);
  data.data.babyBirthDate = '2026-01-01'; data.data.babyBirthDateUpdatedAt = NOW;
  data.data.allergies = ['PRIVATE ALLERGY']; data.data.allergiesUpdatedAt = NOW;
  data.data.logs = snapshot().data.logs;
  data.data.recipes[0].name = 'PRIVATE EDIT';
  data.data.recipes[0].photo = privateFile(ownerFor('alice'), 'photos/private.jpg');
  env.table('profiles').get(profileId).babyBirthDate = '2026-01-01';
  env.commit('alice', data);
  const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
  assert.equal(result.date, '2026-10-23');
  assert.deepEqual(result.meals, ['breakfast', 'lunch', 'dinner'].map((meal, index) =>
    ({meal, label: ['早餐', '午餐', '晚餐'][index], recipe: publicMeal(publicId)})));
  assert.deepEqual(Object.keys(result.author).sort(), ['id', 'name', 'bio', 'babyAgeMonths', 'exists'].sort());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|nickname|babyBirthDate|allergies|rating|portion|note|owner|fileID|snapshot|createdBy|sourceRecipeId/);
  assert.equal(env.signed.length, 0); assert.equal(env.writes.length, 0); assert.equal(env.uploads.length, 0);
  assert.equal(env.gets.filter(item => item.name === COLLECTIONS.recipes && item.id === publicId).length, 2,
    'three meals reuse one public render plus its withdrawal check');
});

test('listing paginates dates descending by twenty and does not infer plans from meal history', async () => {
  const env = fakeEnvironment(), publicId = env.addPublished('alice'), profileId = profileIdFor(ownerFor('alice'));
  const dates = Array.from({length: 25}, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
  const data = plannedSnapshot(dates.map(date => plan('recipe-1', date)));
  data.data.logs = snapshot().data.logs; env.commit('alice', data);
  const visitor = env.handler('visitor'), first = await visitor({action: 'profileMealPlans', profileId});
  assert.deepEqual(first.days.map(day => day.date), dates.slice().reverse().slice(0, 20));
  assert.equal(first.nextOffset, 20); assert.equal(first.days[0].meals[0].recipe.id, publicId);
  const second = await visitor({action: 'profileMealPlans', profileId, offset: 20});
  assert.deepEqual(second.days.map(day => day.date), dates.slice(0, 5).reverse()); assert.equal(second.nextOffset, null);
  assert.deepEqual(await visitor({action: 'profileMealPlans', profileId, offset: 40}), {days: [], nextOffset: null});
  const historyOnly = snapshot(); env.commit('alice', historyOnly);
  assert.deepEqual(await visitor({action: 'profileMealPlans', profileId}), {days: [], nextOffset: null});
  assert.equal((await visitor({action: 'mealPlan', profileId, date: '2026-10-23'})).error.code, 'NOT_FOUND');
  assert.equal(env.writes.length, 0);
});

test('deleted plans and cleared dates disappear immediately without retaining a public copy', async () => {
  const env = fakeEnvironment(), profileId = env.addProfile('alice'); env.addPublished('alice');
  const data = plannedSnapshot(); env.commit('alice', data);
  const visitor = env.handler('visitor');
  assert.equal((await visitor({action: 'profileMealPlans', profileId})).days.length, 1);
  data.deleted.mealPlans = [{id: plan().id, updatedAt: NOW}]; env.commit('alice', data);
  assert.deepEqual(await visitor({action: 'profileMealPlans', profileId}), {days: [], nextOffset: null});
  assert.equal((await visitor({action: 'mealPlan', profileId, date: '2026-10-23'})).error.code, 'NOT_FOUND');
  data.data.mealPlans = []; data.deleted.mealPlans = []; env.commit('alice', data);
  assert.deepEqual(await visitor({action: 'profileMealPlans', profileId}), {days: [], nextOffset: null});
  assert.equal(env.writes.length, 0);
});

test('unpublished, revoked, deleted or wrong-scope recipes remain anonymous placeholders', async () => {
  for (const mode of ['missing', 'withdrawn', 'deleted', 'wrong-scope', 'wrong-owner']) {
    const env = fakeEnvironment(), publicId = env.addPublished('alice'), profileId = profileIdFor(ownerFor('alice'));
    const data = plannedSnapshot(); data.data.recipes[0].name = 'PRIVATE NAME';
    if (mode === 'missing') env.table('recipes').delete(publicId);
    if (mode === 'withdrawn') env.table('recipes').get(publicId).published = false;
    if (mode === 'wrong-scope') env.table('recipes').get(publicId).publicationScope = 'family:' + 'e'.repeat(64);
    if (mode === 'wrong-owner') env.table('recipes').get(publicId).owner = ownerFor('bob');
    if (mode === 'deleted') data.deleted.recipes.push({id: 'recipe-1', updatedAt: NOW});
    env.commit('alice', data);
    const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
    assert.deepEqual(result.meals, [{meal: 'lunch', label: '午餐', recipe: null}], mode);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE NAME|recipe-1/);
  }
});

test('saved copies resolve the original publication and reject mismatched attribution or stable IDs', async () => {
  for (const mode of ['valid', 'wrong-profile', 'wrong-stable-id', 'withdrawn', 'missing']) {
    const env = fakeEnvironment(), originalId = env.addPublished('bob'), profileId = env.addProfile('alice');
    const saved = {...snapshot().data.recipes[0], id: 'shared-' + originalId, name: 'PRIVATE SAVED EDIT',
      source: {recipeId: originalId, profileId: profileIdFor(ownerFor('bob')), authorName: 'PRIVATE STALE AUTHOR'}};
    if (mode === 'wrong-profile') saved.source.profileId = profileId;
    if (mode === 'wrong-stable-id') saved.id = 'shared-' + 'e'.repeat(64);
    if (mode === 'withdrawn') env.table('recipes').get(originalId).published = false;
    if (mode === 'missing') env.table('recipes').delete(originalId);
    env.commit('alice', plannedSnapshot([plan(saved.id)], [saved]));
    const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
    assert.deepEqual(result.meals[0].recipe, mode === 'valid' ? publicMeal(originalId) : null, mode);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE SAVED|PRIVATE STALE/);
  }
});

test('built-in links always use fixed original summaries and never edited private fields', async () => {
  const env = fakeEnvironment(), profileId = env.addProfile('alice'), original = seedRecipes[0];
  const edited = {...clone(original), name: 'PRIVATE CHANGED NAME', minutes: 1, texture: '手指食物', photo: '',
    imageKey: 'PRIVATE ART', isExample: true, favorite: true, createdAt: NOW - 10, updatedAt: NOW};
  env.commit('alice', plannedSnapshot([plan(edited.id)], [edited]));
  const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
  assert.deepEqual(result.meals[0].recipe, {id: original.id, name: original.name, minutes: original.minutes,
    texture: original.texture, imageKey: 'dish:' + original.id, photoURL: '', kind: 'builtin'});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(env.signed.length, 0);
});

test('visitors read the author current family plans, resolving another member publication without joining', async () => {
  const env = fakeEnvironment(), publicId = env.addPublished('bob'), profileId = env.addProfile('alice');
  env.commit('alice', plannedSnapshot([plan('recipe-1', '2026-10-22')]));
  const data = plannedSnapshot(); data.data.recipes[0].createdBy = ownerFor('bob');
  const {family} = familySnapshot(env, data); env.table('recipes').get(publicId).publicationScope = 'family:' + family._id;
  const visitor = env.handler('outsider');
  const result = await visitor({action: 'profileMealPlans', profileId});
  assert.deepEqual(result.days, [{date: '2026-10-23', meals: [{meal: 'lunch', label: '午餐', recipe: publicMeal(publicId)}]}]);
  assert.equal(env.table('memberships').has(ownerFor('outsider')), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE FAMILY|membership|createdBy|family:|owner/);
  assert.equal(env.writes.length, 0); assert.equal(env.uploads.length, 0);
  env.table('memberships').get(ownerFor('alice')).active = false;
  assert.deepEqual((await visitor({action: 'profileMealPlans', profileId})).days.map(day => day.date), ['2026-10-22']);
});

test('family plans cannot resolve same-ID publications from a personal or another family scope', async () => {
  for (const publicationScope of [undefined, 'personal', 'family:' + 'e'.repeat(64)]) {
    const env = fakeEnvironment(), publicId = env.addPublished('bob'), profileId = env.addProfile('alice');
    const data = plannedSnapshot(); data.data.recipes[0].createdBy = ownerFor('bob'); familySnapshot(env, data);
    if (publicationScope) env.table('recipes').get(publicId).publicationScope = publicationScope;
    const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
    assert.equal(result.meals[0].recipe, null);
  }
});

test('public reads never migrate legacy family snapshots or trust unverifiable creator claims', async () => {
  const env = fakeEnvironment(), publicId = env.addPublished('bob'), profileId = env.addProfile('alice');
  const data = plannedSnapshot(); data.data.recipes[0].createdBy = ownerFor('bob');
  const {family} = familySnapshot(env, data, ['alice', 'bob'], {fields: {attributionV1Revision: 1, legacyRecordersChecked: false}});
  env.table('recipes').get(publicId).publicationScope = 'family:' + family._id;
  const before = clone([...env.table('families')]);
  const result = await env.handler('visitor')({action: 'mealPlan', profileId, date: '2026-10-23'});
  assert.equal(result.meals[0].recipe, null); assert.deepEqual([...env.table('families')], before);
  assert.equal(env.writes.length, 0); assert.equal(env.uploads.length, 0); assert.equal(env.transactionStarts.length, 0);
});

test('strict IDs, calendar dates, offsets and identity checks fail before reading snapshots', async () => {
  const env = fakeEnvironment(), profileId = env.addProfile('alice'), visitor = env.handler('visitor');
  for (const value of [null, '', 'bad', [], {}, 'a'.repeat(31), 'A'.repeat(32)]) {
    assert.equal((await visitor({action: 'profileMealPlans', profileId: value})).error.code, 'INVALID_REQUEST');
  }
  for (const date of [undefined, null, '', '2026-2-01', '2026-02-29', '2026-04-31', '0999-12-31', '2026-13-01', [], {}]) {
    assert.equal((await visitor({action: 'mealPlan', profileId, date})).error.code, 'INVALID_REQUEST');
  }
  for (const offset of [-1, 0.5, '20', null, {}, 3001, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await visitor({action: 'profileMealPlans', profileId, offset})).error.code, 'INVALID_REQUEST');
  }
  assert.equal((await visitor({action: 'mealPlan', profileId: 'e'.repeat(32), date: '2026-10-23'})).error.code, 'NOT_FOUND');
  assert.equal((await env.handler('')({action: 'profileMealPlans', profileId})).error.code, 'UNAUTHENTICATED');
  assert.equal((await visitor({action: 'profileMealPlans', profileId, expectedOwner: ownerFor('alice')})).error.code, 'ACCOUNT_CHANGED');
  assert.equal(env.downloads.length, 0); assert.equal(env.writes.length, 0);
});

test('an existing profile with no committed snapshot has an empty list and no daily share', async () => {
  const env = fakeEnvironment(), profileId = env.addProfile('alice'), visitor = env.handler('visitor');
  assert.deepEqual(await visitor({action: 'profileMealPlans', profileId}), {days: [], nextOffset: null});
  assert.equal((await visitor({action: 'mealPlan', profileId, date: '2026-10-23'})).error.code, 'NOT_FOUND');
  assert.equal(env.writes.length, 0);
});

test('public photo signing returns only public copies and withdrawal during signing becomes a placeholder', async () => {
  for (const withdraw of [false, true]) {
    const env = fakeEnvironment(), publicId = env.addPublished('alice'), profileId = profileIdFor(ownerFor('alice'));
    const publication = env.table('recipes').get(publicId);
    publication.photoFileID = cloudFile(`social/${profileId}/${publicId}/dish.jpg`);
    env.commit('alice', plannedSnapshot());
    const visitor = env.handler('visitor', {async getTempFileURL({fileList}) {
      assert.equal(fileList[0].fileID, publication.photoFileID);
      if (withdraw) publication.published = false;
      return {fileList: [{fileID: publication.photoFileID, status: 0, tempFileURL: 'https://signed.example.test/public-photo'}]};
    }});
    const result = await visitor({action: 'mealPlan', profileId, date: '2026-10-23'});
    assert.deepEqual(result.meals[0].recipe, withdraw ? null : publicMeal(publicId, {photoURL: 'https://signed.example.test/public-photo'}));
  }
});

test('changing author committed data or family membership during a read rejects stale plans', async () => {
  for (const mode of ['revision', 'family-exit']) {
    const env = fakeEnvironment(), publicId = env.addPublished('alice'), profileId = profileIdFor(ownerFor('alice'));
    env.commit('alice', plannedSnapshot());
    if (mode === 'family-exit') {
      const data = plannedSnapshot(); data.data.recipes[0].createdBy = ownerFor('alice');
      const {family} = familySnapshot(env, data); env.table('recipes').get(publicId).publicationScope = 'family:' + family._id;
    }
    env.table('recipes').get(publicId).photoFileID = cloudFile(`social/${profileId}/${publicId}/dish.jpg`);
    const visitor = env.handler('visitor', {async getTempFileURL({fileList}) {
      if (mode === 'revision') env.commit('alice', plannedSnapshot([]));
      else env.table('memberships').get(ownerFor('alice')).active = false;
      return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://signed.example.test/photo'}]};
    }});
    const result = await visitor({action: 'mealPlan', profileId, date: '2026-10-23'});
    assert.equal(result.error.code, mode === 'revision' ? 'SYNC_REQUIRED' : 'FAMILY_CHANGED');
    assert.equal(result.meals, undefined); assert.equal(env.writes.length, 0);
  }
});

test('sharing a confirmed day creates only the current actor default profile and returns the public shape', async () => {
  const env = fakeEnvironment(), originalId = env.addPublished('bob');
  const saved = {...snapshot().data.recipes[0], id: 'shared-' + originalId,
    source: {recipeId: originalId, profileId: profileIdFor(ownerFor('bob')), authorName: '原作者'}};
  env.commit('alice', plannedSnapshot([plan(saved.id)], [saved]));
  const result = await env.handler('alice')({action: 'shareMealPlan', date: '2026-10-23'});
  assert.equal(result.author.id, profileIdFor(ownerFor('alice'))); assert.equal(result.author.exists, true);
  assert.match(result.author.name, /^小.+\d{4}$/); assert.equal(result.meals[0].recipe.id, originalId);
  assert.equal(env.writes.length, 1); assert.equal(env.writes[0].name, COLLECTIONS.profiles);
  assert.doesNotMatch(JSON.stringify(result), /Private baby name|PRIVATE NOTE|babyBirthDate|owner|snapshot|rating|portion/);
  const second = await env.handler('alice')({action: 'shareMealPlan', date: '2026-10-23'});
  assert.deepEqual(second, result); assert.equal(env.writes.length, 1, 'existing profiles are not rewritten');
});

test('sharing absent or deleted days never creates a profile and cannot target another account', async () => {
  const env = fakeEnvironment(), alice = env.handler('alice');
  for (const data of [plannedSnapshot([]), {...plannedSnapshot(), deleted: {recipes: [], logs: [], mealPlans: [{id: plan().id, updatedAt: NOW}]}}]) {
    env.commit('alice', data);
    assert.equal((await alice({action: 'shareMealPlan', date: '2026-10-23'})).error.code, 'NOT_FOUND');
  }
  assert.equal((await alice({action: 'shareMealPlan', date: '2026-10-23', profileId: profileIdFor(ownerFor('bob'))})).error.code, 'INVALID_REQUEST');
  assert.equal((await alice({action: 'shareMealPlan', date: '2026-02-29'})).error.code, 'INVALID_REQUEST');
  assert.equal(env.table('profiles').size, 0); assert.equal(env.writes.length, 0);
});

test('sharing family arrangements keeps the actor profile and preserves existing public profile fields', async () => {
  const env = fakeEnvironment(), publicId = env.addPublished('bob'), profileId = env.addProfile('alice', '我的原昵称');
  env.table('profiles').get(profileId).babyBirthDate = '2026-01-01';
  const data = plannedSnapshot(); data.data.recipes[0].createdBy = ownerFor('bob');
  const {family, scope} = familySnapshot(env, data); env.table('recipes').get(publicId).publicationScope = 'family:' + family._id;
  const result = await env.handler('alice')({action: 'shareMealPlan', date: '2026-10-23', protocolVersion: 2, expectedScope: scope});
  assert.equal(result.author.name, '我的原昵称'); assert.equal(result.author.id, profileId); assert.equal(result.meals[0].recipe.id, publicId);
  assert.equal(result.author.babyBirthDate, undefined); assert.equal(env.writes.length, 0);
  const invalid = await env.handler('alice')({action: 'shareMealPlan', date: '2026-10-23', protocolVersion: 2,
    expectedScope: {kind: 'personal', id: ownerFor('alice')}});
  assert.equal(invalid.error.code, 'FAMILY_CHANGED');
});

test('sharing ignores client supplied plans and rechecks the committed version before creating a profile', async () => {
  const env = fakeEnvironment(), originalId = env.addPublished('bob'), actorProfileId = profileIdFor(ownerFor('alice'));
  env.commit('alice', plannedSnapshot([]));
  assert.equal((await env.handler('alice')({action: 'shareMealPlan', date: '2026-10-23',
    snapshot: plannedSnapshot(), mealPlans: [plan()], recipes: snapshot().data.recipes})).error.code, 'NOT_FOUND');
  assert.equal(env.table('profiles').has(actorProfileId), false);
  const saved = {...snapshot().data.recipes[0], id: 'shared-' + originalId,
    source: {recipeId: originalId, profileId: profileIdFor(ownerFor('bob')), authorName: '原作者'}};
  env.commit('alice', plannedSnapshot([plan(saved.id)], [saved]));
  const original = env.table('recipes').get(originalId);
  original.photoFileID = cloudFile(`social/${original.profileId}/${originalId}/dish.jpg`);
  const actor = env.handler('alice', {async getTempFileURL({fileList}) {
    env.commit('alice', plannedSnapshot([], [saved]));
    return {fileList: [{fileID: fileList[0].fileID, status: 0, tempFileURL: 'https://signed.example.test/photo'}]};
  }});
  assert.equal((await actor({action: 'shareMealPlan', date: '2026-10-23'})).error.code, 'SYNC_REQUIRED');
  assert.equal(env.table('profiles').has(actorProfileId), false); assert.equal(env.writes.length, 0);
});

test('a source update while the final public author is read cannot return the earlier day', async () => {
  let env, reads = 0;
  const actorProfileId = profileIdFor(ownerFor('alice'));
  env = fakeEnvironment({beforeRead({kind, name, id}) {
    if (kind === 'document' && name === COLLECTIONS.profiles && id === actorProfileId && ++reads === 3) {
      env.commit('alice', plannedSnapshot([]));
    }
  }});
  env.addPublished('alice'); env.commit('alice', plannedSnapshot());
  const result = await env.handler('visitor')({action: 'mealPlan', profileId: actorProfileId, date: '2026-10-23'});
  assert.equal(result.error.code, 'SYNC_REQUIRED'); assert.equal(result.meals, undefined);
});

test('a family visitor carrying an expected scope still cannot trigger a private legacy migration', async () => {
  const env = fakeEnvironment(), profileId = env.addProfile('alice'); env.commit('alice', plannedSnapshot([]));
  const {scope} = familySnapshot(env, plannedSnapshot(), ['visitor'], {id: 'e'.repeat(64),
    fields: {attributionV1Revision: 1, legacyRecordersChecked: false}});
  const result = await env.handler('visitor')({action: 'profileMealPlans', profileId, expectedScope: scope, protocolVersion: 2});
  assert.deepEqual(result, {days: [], nextOffset: null}); assert.equal(env.writes.length, 0); assert.equal(env.uploads.length, 0);
});

function contractFixture() {
  const env = fakeEnvironment(), publicId = env.addPublished('bob');
  const publication = env.table('recipes').get(publicId);
  publication.photoFileID = cloudFile(`social/${publication.profileId}/${publicId}/contract.jpg`);
  const saved = {...snapshot().data.recipes[0], id: 'shared-' + publicId, name: 'PRIVATE LOCAL EDIT',
    source: {recipeId: publicId, profileId: publication.profileId, authorName: '原作者'}};
  const builtin = {...clone(seedRecipes[0]), name: 'PRIVATE BUILTIN EDIT', photo: '', isExample: true,
    favorite: true, createdAt: NOW - 10, updatedAt: NOW};
  const unavailable = {...snapshot().data.recipes[0], id: 'private-only', name: 'PRIVATE UNPUBLISHED'};
  const recipes = [saved, builtin, unavailable];
  const plansFor = date => recipes.map((recipe, index) => plan(recipe.id, date, ['breakfast', 'lunch', 'dinner'][index]));
  return {env, publicId, recipes, plansFor, profileId: profileIdFor(ownerFor('alice'))};
}

test('real shareMealPlan and mealPlan responses pass the client contract for public, builtin and unavailable dishes', async () => {
  const {env, publicId, recipes, plansFor, profileId} = contractFixture(), date = '2026-10-23';
  env.commit('alice', plannedSnapshot(plansFor(date), recipes));
  assert.equal(env.table('profiles').has(profileId), false, 'share creates the real default author response');
  const shared = await env.handler('alice')({action: 'shareMealPlan', date});
  const visited = await env.handler('visitor')({action: 'mealPlan', profileId, date});
  const normalized = [];
  for (const [action, response] of [['shareMealPlan', shared], ['mealPlan', visited]]) {
    assert.equal(response.error, undefined, action);
    assert.equal(response.author.exists, true, action + ' supplies the required author existence flag');
    const before = clone(response), result = normalizeMealPlan(response, profileId, date);
    assert.deepEqual(response, before, action + ' client normalization does not alter the server response');
    assert.deepEqual(result.author, {id: profileId, name: response.author.name, exists: true});
    assert.equal(result.date, date);
    assert.deepEqual(result.meals.map(item => [item.meal, item.label, item.recipe && item.recipe.kind]),
      [['breakfast', '早餐', 'public'], ['lunch', '午餐', 'builtin'], ['dinner', '晚餐', null]]);
    assert.equal(result.meals[0].recipe.id, publicId);
    assert.match(result.meals[0].recipe.photoURL, /^https:\/\/signed\.example\.test\//);
    assert.equal(result.meals[1].recipe.id, seedRecipes[0].id);
    assert.equal(result.meals[1].recipe.name, seedRecipes[0].name);
    assert.equal(result.meals[1].recipe.imageKey, 'dish:' + seedRecipes[0].id);
    assert.equal(result.meals[2].recipe, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|babyBirthDate|nickname|owner|rating|portion/);
    const missingExists = clone(response); delete missingExists.author.exists;
    assert.throws(() => normalizeMealPlan(missingExists, profileId, date), error => error.code === 'INVALID_MEAL_PLAN');
    normalized.push(result);
  }
  assert.deepEqual(normalized[0], normalized[1], 'sharing and visiting use the same client-compatible daily contract');
});

test('real profileMealPlans pages pass normalizeDays with all recipe variants, continuation and an empty result', async () => {
  const {env, publicId, recipes, plansFor, profileId} = contractFixture();
  env.addProfile('alice');
  const dates = Array.from({length: 21}, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);
  env.commit('alice', plannedSnapshot(dates.flatMap(plansFor), recipes));
  const visitor = env.handler('visitor'), normalizedDates = [];
  for (const offset of [0, 20]) {
    const response = await visitor({action: 'profileMealPlans', profileId, offset});
    assert.equal(response.error, undefined);
    const before = clone(response), result = normalizeDays(response, offset);
    assert.deepEqual(response, before, 'the client accepts an unmodified real backend page');
    assert.equal(result.days.length, offset === 0 ? 20 : 1);
    assert.equal(result.nextOffset, offset === 0 ? 20 : null);
    for (const day of result.days) {
      assert.deepEqual(day.meals.map(item => item.recipe && item.recipe.kind), ['public', 'builtin', null]);
      assert.equal(day.meals[0].recipe.id, publicId);
      assert.equal(day.meals[1].recipe.id, seedRecipes[0].id);
      assert.equal(day.meals[2].recipe, null);
      normalizedDates.push(day.date);
    }
  }
  assert.deepEqual(normalizedDates, dates.slice().reverse());
  env.commit('alice', plannedSnapshot([], recipes));
  assert.deepEqual(normalizeDays(await visitor({action: 'profileMealPlans', profileId}), 0), {days: [], nextOffset: null});
});

