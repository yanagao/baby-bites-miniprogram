'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {createReader, sameScope} = require('../cloudfunctions/babyBitesAnalysis/scope');
const {buildFeedingData, MAX_RESPONSE_BYTES} = require('../cloudfunctions/babyBitesAnalysis/data');
const NOW = Date.parse('2026-11-27T03:00:00Z'), ENV = 'cloud1-test', OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const FAMILY = 'f'.repeat(64), MEMBER = '1'.repeat(32), GENERATION = '2'.repeat(32);
const file = path => `cloud://${ENV}.bucket/${path}`;
const personalFile = file(`users/${OWNER}/snapshots/a.json`), familyFile = file(`families/${FAMILY}/snapshots/a.json`);
const clone = value => JSON.parse(JSON.stringify(value));
function recipe(id = 'r1') {
  return {id, name: '南瓜粥', category: '粥饭主食', texture: '软烂颗粒', minutes: 20,
    ingredients: [{name: '南瓜', amount: '20 克'}], steps: ['蒸熟'], photo: '', note: '菜谱私密心得',
    createdAt: NOW - 100, updatedAt: NOW, favorite: false, isExample: false, imageKey: ''};
}
function snapshot() {
  return {version: 1, data: {version: 1, nickname: '宝宝私密姓名', profileUpdatedAt: NOW,
    babyBirthDate: '2025-10-31', babyBirthDateUpdatedAt: NOW, allergies: ['鸡蛋'], allergiesUpdatedAt: NOW,
    recipes: [recipe()], mealPlans: [{id: 'meal-2026-11-27-breakfast', date: '2026-11-27', meal: 'breakfast', recipeId: 'r1', createdAt: NOW, updatedAt: NOW}],
    logs: [{id: 'log-1', recipeId: 'r1', date: '2026-11-27', meal: 'breakfast', rating: 0, portion: '', note: '用餐备注', createdAt: NOW, updatedAt: NOW}]},
    deleted: {recipes: [], logs: [], mealPlans: []}};
}
function fixture() {
  const tables = new Map(), files = new Map([[personalFile, Buffer.from(JSON.stringify(snapshot()))]]), calls = {downloads: [], writes: 0}, hooks = {};
  function table(name) { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); }
  table('baby_bites_accounts').set(OWNER, {_id: OWNER, revision: 7, fileID: personalFile, updatedAt: NOW});
  const db = {collection(name) { return {doc(id) { return {async get() {return {data: table(name).has(id) ? clone(table(name).get(id)) : null};}, async set() {calls.writes++; throw Error('Unexpected write');}}; }}; }};
  const cloud = {async downloadFile({fileID}) { calls.downloads.push(fileID); if (hooks.download) await hooks.download(); return {statusCode: 200, fileContent: files.get(fileID)}; }};
  const reader = createReader({cloud, db, now: () => NOW});
  function family() {
    table('baby_bites_family_memberships').set(OWNER, {_id: OWNER, familyId: FAMILY, membershipId: GENERATION, active: true});
    table('baby_bites_families').set(FAMILY, {_id: FAMILY, revision: 3, fileID: familyFile, updatedAt: NOW, managerOwner: OWNER,
      members: [{owner: OWNER, id: MEMBER, membershipId: GENERATION, label: '妈妈'}]});
    files.set(familyFile, Buffer.from(JSON.stringify(snapshot())));
  }
  return {reader, tables, table, files, calls, hooks, family};
}
const source = {revision: 7, updatedAt: NOW};
const build = (data = snapshot(), query = {}, now = NOW) => buildFeedingData(data, {source, query, now});
const rejects = code => error => error && error.code === code;

test('analysis deployment carries its own unchanged snapshot validator', () => {
  assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/babyBitesAnalysis/validate'), 'utf8'),
    fs.readFileSync(require.resolve('../cloudfunctions/babyBitesSync/validate'), 'utf8'));
});
test('personal reader only downloads its verified account snapshot and never writes', async () => {
  const f = fixture(), state = await f.reader.resolve(OWNER, ENV), data = await f.reader.read(state, OWNER, ENV);
  assert.deepEqual(state, {scope: {kind: 'personal', id: OWNER}, accessVersion: state.accessVersion, revision: 7, fileID: personalFile, updatedAt: NOW});
  assert.match(state.accessVersion, /^[a-f0-9]{64}$/);
  assert.equal(data.data.nickname, '宝宝私密姓名');
  assert.deepEqual(f.calls, {downloads: [personalFile], writes: 0});
});
test('an empty account is represented as no synced records, without downloading or writing', async () => {
  const f = fixture(), state = await f.reader.resolve(OTHER, ENV), result = await f.reader.read(state, OTHER, ENV);
  assert.equal(state.revision, 0); assert.deepEqual(result.data.logs, []); assert.deepEqual(f.calls.downloads, []);
  assert.equal(buildFeedingData(result, {source: state, now: NOW}).allergies.status, 'not_recorded');
});
test('cross-account states and foreign snapshot paths are denied before storage access', async () => {
  const f = fixture(), state = await f.reader.resolve(OWNER, ENV);
  await assert.rejects(f.reader.read(state, OTHER, ENV), rejects('SCOPE_CHANGED'));
  f.table('baby_bites_accounts').get(OWNER).fileID = file(`users/${OTHER}/snapshots/a.json`);
  await assert.rejects(f.reader.resolve(OWNER, ENV), rejects('INVALID_ACCOUNT'));
  assert.deepEqual(f.calls.downloads, []);
});
test('malformed owner and environment never reach database queries', async () => {
  const reader = createReader({cloud: {}, db: {collection() {throw Error('must not read');}}});
  await assert.rejects(reader.resolve('guess', ENV), rejects('UNAUTHENTICATED'));
  await assert.rejects(reader.resolve(OWNER, '../other'), rejects('INVALID_ENV'));
});
test('family reads do not perform migration and fail if removed while downloading', async () => {
  const f = fixture(); f.family(); const state = await f.reader.resolve(OWNER, ENV);
  assert.equal((await f.reader.read(state, OWNER, ENV)).data.logs.length, 1);
  assert.equal(f.calls.writes, 0);
  f.hooks.download = () => { f.table('baby_bites_family_memberships').set(OWNER, {_id: OWNER, active: false, previousFamilyId: FAMILY, updatedAt: NOW}); };
  await assert.rejects(f.reader.read(state, OWNER, ENV), rejects('SCOPE_CHANGED'));
});
test('leaving and rejoining the same family cannot reuse an earlier membership scope', async () => {
  const f = fixture(); f.family(); const state = await f.reader.resolve(OWNER, ENV), next = '3'.repeat(32);
  f.table('baby_bites_family_memberships').get(OWNER).membershipId = next;
  f.table('baby_bites_families').get(FAMILY).members[0].membershipId = next;
  assert.equal(sameScope(state.scope, (await f.reader.resolve(OWNER, ENV)).scope), false);
  await assert.rejects(f.reader.read(state, OWNER, ENV), rejects('SCOPE_CHANGED'));
  assert.deepEqual(f.calls.downloads, []);
});
test('family membership metadata updates never masquerade as a fresh snapshot commit time', async () => {
  const f = fixture(); f.family(); const before = await f.reader.resolve(OWNER, ENV);
  assert.equal(before.updatedAt, 0);
  f.table('baby_bites_families').get(FAMILY).updatedAt = NOW + 3600000;
  const after = await f.reader.assertCurrent(before, OWNER, ENV);
  assert.equal(after.revision, before.revision); assert.equal(after.fileID, before.fileID); assert.equal(after.updatedAt, 0);
  const data = await f.reader.read(after, OWNER, ENV);
  assert.equal(buildFeedingData(data, {source: after, now: NOW}).source.updatedAt, 0);
});
test('personal grants cannot revive after joining and leaving a family without changing personal data', async () => {
  const f = fixture(), before = await f.reader.resolve(OWNER, ENV); f.family();
  f.table('baby_bites_family_memberships').set(OWNER, {_id: OWNER, active: false, previousFamilyId: FAMILY, updatedAt: NOW});
  const after = await f.reader.resolve(OWNER, ENV);
  assert.deepEqual(after.scope, before.scope); assert.equal(after.revision, before.revision); assert.equal(after.fileID, before.fileID);
  assert.notEqual(after.accessVersion, before.accessVersion);
  await assert.rejects(f.reader.read(before, OWNER, ENV), rejects('SCOPE_CHANGED'));
  assert.equal((await f.reader.read(after, OWNER, ENV)).data.logs.length, 1);
});
test('malformed inactive membership cannot masquerade as an initial personal account', async () => {
  const f = fixture();
  f.table('baby_bites_family_memberships').set(OWNER, {_id: OWNER, active: false});
  await assert.rejects(f.reader.resolve(OWNER, ENV), rejects('INVALID_FAMILY'));
});
test('family index and member generation must agree and family paths cannot cross households', async () => {
  const f = fixture(); f.family();
  f.table('baby_bites_family_memberships').get(OWNER).membershipId = '3'.repeat(32);
  await assert.rejects(f.reader.resolve(OWNER, ENV), rejects('SCOPE_CHANGED'));
  f.family(); f.table('baby_bites_families').get(FAMILY).fileID = file(`families/${OTHER}/snapshots/a.json`);
  await assert.rejects(f.reader.resolve(OWNER, ENV), rejects('INVALID_FAMILY'));
});
test('changed revision during a download discards its old private payload', async () => {
  const f = fixture(), state = await f.reader.resolve(OWNER, ENV);
  f.hooks.download = () => { f.table('baby_bites_accounts').get(OWNER).revision++; };
  await assert.rejects(f.reader.read(state, OWNER, ENV), rejects('REVISION_CHANGED'));
});
test('snapshot validation rejects foreign recipe photos even on an owned snapshot', async () => {
  const f = fixture(), data = snapshot(); data.data.recipes[0].photo = file(`users/${OTHER}/photos/a.jpg`);
  f.files.set(personalFile, Buffer.from(JSON.stringify(data)));
  await assert.rejects(f.reader.read(await f.reader.resolve(OWNER, ENV), OWNER, ENV), rejects('INVALID_SNAPSHOT'));
});
test('feeding response defaults to seven China calendar days with correctly labelled unrated completion', () => {
  const result = build();
  assert.deepEqual(result.period, {startDate: '2026-11-21', endDate: '2026-11-27', days: 7});
  assert.deepEqual(result.baby, {ageMonths: 12, ageAsOf: '2026-11-27'});
  assert.deepEqual(result.summary.ratingCounts, {unrated: 1, disliked: 0, okay: 0, liked: 0});
  assert.equal(result.records[0].rating, 0); assert.match(result.records[0].ratingLabel, /未记录/);
  assert.equal(result.summary.plannedMealCount, 1); assert.equal(result.summary.recordCount, 1);
  assert.equal(result.records[0].portion, '');
  assert.equal(build(snapshot(), {}, Date.parse('2026-11-27T16:01:00Z')).period.endDate, '2026-11-28');
});
test('dates reject impossible, future, inverted and oversized windows and accept exactly ninety days', () => {
  for (const query of [{startDate: '2026-02-30'}, {endDate: '2026-11-28'}, {startDate: '2026-11-27', endDate: '2026-11-26'},
    {startDate: '2026-08-28', endDate: '2026-11-27'}, {startDate: null}, {endDate: '2026-1-2'}, {owner: OWNER}]) {
    assert.throws(() => build(snapshot(), query), rejects('INVALID_REQUEST'));
  }
  assert.equal(build(snapshot(), {startDate: '2026-08-30'}).period.days, 90);
});
test('days presets accept HTTP strings and cannot conflict with explicit date windows', () => {
  assert.equal(build(snapshot(), {days: '7'}).period.days, 7);
  assert.equal(build(snapshot(), {days: 30}).period.startDate, '2026-10-29');
  assert.equal(build(snapshot(), {days: '90'}).period.days, 90);
  for (const query of [{days: 14}, {days: 0}, {days: null}, {days: 7, startDate: '2026-11-21'}, {days: 7, endDate: '2026-11-27'}]) {
    assert.throws(() => build(snapshot(), query), rejects('INVALID_REQUEST'));
  }
});
test('summary covers the full window while deterministic pages require a matching revision', () => {
  const data = snapshot(); data.data.logs = Array.from({length: 4}, (_, index) => ({...data.data.logs[0], id: 'l' + index,
    date: index === 3 ? '2026-11-20' : '2026-11-27', rating: index % 4, createdAt: NOW + index}));
  const one = build(data, {limit: '2'}), two = build(data, {limit: 2, offset: 2, revision: '7'});
  assert.equal(one.summary.recordCount, 3); assert.equal(two.summary.recordCount, 3);
  assert.deepEqual(one.records.map(row => row.rating), [0, 1]); assert.deepEqual(two.records.map(row => row.rating), [2]);
  assert.equal(one.pagination.nextOffset, 2); assert.equal(two.pagination.nextOffset, null);
  assert.throws(() => build(data, {offset: 1}), rejects('REVISION_REQUIRED'));
  assert.throws(() => build(data, {offset: 1, revision: 6}), rejects('REVISION_CHANGED'));
  for (const query of [{limit: 101}, {limit: 0}, {offset: -1}, {limit: '1e2'}, {revision: true}]) assert.throws(() => build(data, query), rejects('INVALID_REQUEST'));
});
test('missing fields stay unknown and old records never gain an inferred meal', () => {
  const data = snapshot(); delete data.data.babyBirthDate; delete data.data.allergies; delete data.data.logs[0].meal;
  const result = build(data);
  assert.equal(result.baby.ageMonths, null); assert.deepEqual(result.allergies, {status: 'not_recorded', foods: []});
  assert.equal(result.records[0].meal, null); assert.equal(result.summary.mealCounts.unspecified, 1);
  data.data.allergies = []; assert.deepEqual(build(data).allergies, {status: 'recorded', foods: []});
});
test('response uses a field allowlist and exposes no profile identities, paths or unrelated private recipe notes', () => {
  const data = snapshot(), item = data.data.recipes[0];
  item.photo = file(`users/${OWNER}/photos/private.jpg`); item.createdBy = OWNER;
  item.source = {profileId: '4'.repeat(32), recipeId: OTHER, authorName: '作者私密姓名'};
  data.data.logs[0].recordedBy = {memberId: MEMBER, label: '家人私密姓名'};
  const result = buildFeedingData(data, {now: NOW, source: {...source, scope: {kind: 'family', id: FAMILY, membershipId: GENERATION}}, query: {}});
  const text = JSON.stringify(result);
  for (const secret of [data.data.nickname, data.data.babyBirthDate, '菜谱私密心得', '作者私密姓名', '家人私密姓名', 'cloud://', OWNER, OTHER, FAMILY, MEMBER, GENERATION, 'log-1', 'r1']) assert.ok(!text.includes(secret), secret);
  assert.equal(result.records[0].note, '用餐备注'); assert.equal(result.records[0].recipe.name, '南瓜粥');
  result.records[0].recipe.ingredients[0].amount = 'changed'; assert.equal(item.ingredients[0].amount, '20 克');
});
test('large responses shrink pages with an exact continuation offset instead of silently dropping rows', () => {
  const data = snapshot(); data.data.recipes[0].ingredients = Array.from({length: 50}, () => ({name: '食'.repeat(80), amount: '量'.repeat(80)}));
  data.data.logs = Array.from({length: 100}, (_, index) => ({...data.data.logs[0], id: 'log-' + index, note: '记'.repeat(500)}));
  const one = build(data, {limit: 100});
  assert.ok(one.records.length > 0 && one.records.length < 100); assert.equal(one.pagination.nextOffset, one.records.length);
  assert.equal(one.summary.recordCount, 100); assert.ok(Buffer.byteLength(JSON.stringify(one)) < MAX_RESPONSE_BYTES);
  const two = build(data, {limit: 100, offset: one.pagination.nextOffset, revision: 7}); assert.equal(two.pagination.offset, one.records.length);
});
