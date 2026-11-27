'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createHandler, GRANTS} = require('../../cloudfunctions/babyBitesAnalysis');
const ENV = 'cloud1-analysis-test', APPID = 'wx-analysis-test';
const NOW = Date.parse('2026-11-27T04:00:00Z');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const ownerFor = (openid = 'alice') => crypto.createHash('sha256').update(APPID + ':' + openid).digest('hex');
const grantIdFor = owner => crypto.createHash('sha256').update('feeding-analysis-grant:' + owner).digest('hex').slice(0, 32);
const fileFor = (owner = ownerFor(), filename = 'snapshot-1.json') => `cloud://${ENV}.bucket/users/${owner}/snapshots/${filename}`;
const familyFile = (id, filename = 'snapshot-1.json') => `cloud://${ENV}.bucket/families/${id}/snapshots/${filename}`;
function snapshot() {
  return {version: 1, data: {version: 1, nickname: 'PRIVATE BABY NAME', profileUpdatedAt: NOW,
    babyBirthDate: '2026-01-27', babyBirthDateUpdatedAt: NOW, allergies: ['鸡蛋'], allergiesUpdatedAt: NOW,
    recipes: [{id: 'private-recipe-id', name: '南瓜粥', category: '粥饭主食', texture: '软烂颗粒', minutes: 20,
      ingredients: [{name: '南瓜', amount: '20克'}], steps: ['蒸熟'], note: 'PRIVATE RECIPE NOTE', photo: '',
      favorite: false, isExample: false, createdAt: NOW, updatedAt: NOW}],
    logs: [{id: 'private-log-id', recipeId: 'private-recipe-id', date: '2026-11-27', rating: 0, meal: 'breakfast',
      portion: '', note: '待补充进餐情况', createdAt: NOW, updatedAt: NOW}], mealPlans: []},
    deleted: {recipes: [], logs: [], mealPlans: []}};
}
function fakeEnvironment(options = {}) {
  const records = new Map(), files = new Map(), downloads = [];
  let time = NOW, openid = 'alice', contextOverride, writes = 0, randomCounter = 0, afterDownload;
  let queue = Promise.resolve();
  const key = (name, id) => name + ':' + id;
  const databaseFor = target => ({
    collection(name) { return {doc(id) { return {
      async get() { const data = target.get(key(name, id)); return {data: data ? {_id: id, ...clone(data)} : null}; },
      async set({data}) { assert.equal(Object.hasOwn(data, '_id'), false); target.set(key(name, id), clone(data)); writes++; }
    }; }}; }
  });
  const db = databaseFor(records);
  db.runTransaction = async callback => {
    const prior = queue; let unlock;
    queue = new Promise(resolve => { unlock = resolve; });
    await prior;
    const pending = new Map(Array.from(records, ([id, data]) => [id, clone(data)]));
    try {
      const result = await callback(databaseFor(pending));
      records.clear(); pending.forEach((data, id) => records.set(id, data));
      return result;
    } finally { unlock(); }
  };
  const cloud = {
    database: settings => { assert.equal(settings.throwOnNotFound, false); return db; },
    getWXContext: () => contextOverride || {APPID, OPENID: openid, ENV},
    async downloadFile({fileID}) {
      downloads.push(fileID);
      const content = files.get(fileID);
      if (!content) throw Error('sensitive storage detail');
      if (afterDownload) { const hook = afterDownload; afterDownload = null; await hook(); }
      return {statusCode: 200, fileContent: Buffer.from(JSON.stringify(content))};
    }
  };
  const env = {ANALYSIS_API_BASE_URL: 'https://analysis.example.test/baby-bites-ai', ...options.env};
  const optionsForHandler = {cloud, now: () => time, random: size => Buffer.alloc(size, ++randomCounter), env};
  const handler = createHandler(optionsForHandler);
  const set = (collection, id, data) => records.set(key(collection, id), clone(data));
  const get = (collection, id) => clone(records.get(key(collection, id)));
  const scopeFor = (who = openid) => {
    const owner = ownerFor(who), member = get('baby_bites_family_memberships', owner);
    return member && member.active !== false ? {kind: 'family', id: member.familyId, membershipId: member.membershipId} : {kind: 'personal', id: owner};
  };
  const seed = (who = 'alice', data = snapshot()) => {
    const owner = ownerFor(who), fileID = fileFor(owner);
    set('baby_bites_accounts', owner, {revision: 1, fileID, updatedAt: time}); files.set(fileID, clone(data)); return owner;
  };
  seed();
  return {handler, toolsHandler: () => createHandler({...optionsForHandler, toolsOnly: true}), records, files, downloads, set, get, seed, scopeFor,
    get writes() { return writes; }, get time() { return time; },
    tick(ms) { time += ms; }, as(who) { openid = who; contextOverride = undefined; },
    context(value) { contextOverride = value; }, onDownload(hook) { afterDownload = hook; },
    internal(action, input = {}) { return handler({action, protocolVersion: 2, expectedOwner: ownerFor(openid), expectedScope: scopeFor(), ...input}); },
    http(token, input = {}) { return handler({httpMethod: 'GET', path: '/baby-bites-ai/v1/feeding-context',
      headers: {Authorization: 'Bearer ' + token}, queryStringParameters: {}, ...input}); },
    grantRecord(who = openid) { return get(GRANTS, grantIdFor(ownerFor(who))); },
    grantRecordSet(data, who = openid) { return set(GRANTS, grantIdFor(ownerFor(who)), data); },
    joinFamily({id = 'f'.repeat(64), membershipId = 'a'.repeat(32), who = openid} = {}) {
      const owner = ownerFor(who), fileID = familyFile(id);
      set('baby_bites_family_memberships', owner, {familyId: id, membershipId, active: true});
      set('baby_bites_families', id, {name: 'PRIVATE FAMILY', managerOwner: owner, members: [{owner, id: 'b'.repeat(32), membershipId, label: '妈妈'}],
        revision: 1, fileID, updatedAt: time, closed: false});
      files.set(fileID, snapshot()); return {id, membershipId, owner};
    }
  };
}

module.exports = {fakeEnvironment, snapshot, ownerFor, fileFor, familyFile, grantIdFor, NOW, ENV, APPID, GRANTS};
