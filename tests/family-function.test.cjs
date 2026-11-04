'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {mergeSnapshots} = require('../utils/sync-merge');
const {createHandler: syncHandler} = require('../cloudfunctions/babyBitesSync');
const {createHandler: socialHandler, COLLECTIONS, recipeIdFor, profileIdFor} = require('../cloudfunctions/babyBitesSocial');
const ENV = 'cloud1-family-test', APPID = 'wx-family-test', NOW = Date.parse('2026-11-02T03:00:00Z');
const ownerFor = openid => crypto.createHash('sha256').update(`${APPID}:${openid}`).digest('hex');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const file = path => `cloud://${ENV}.bucket-test/${path}`;
const personal = name => ({kind: 'personal', id: ownerFor(name)});
const JPG = Buffer.from([255,216,255,224,0,1,2,3]);
function recipe(id = 'r1') { return {id,name:'南瓜粥',category:'粥饭主食',texture:'软烂颗粒',minutes:20,ingredients:[{name:'南瓜',amount:'20克'}],steps:['蒸熟压泥'],note:'家庭小心得',photo:'',imageKey:'',favorite:false,isExample:false,createdAt:NOW-1,updatedAt:NOW}; }
function snapshot() {return {version:1,data:{version:1,nickname:'小宝',profileUpdatedAt:NOW,allergies:['鸡蛋'],allergiesUpdatedAt:NOW,recipes:[recipe()],logs:[{id:'l1',recipeId:'r1',date:'2026-11-02',rating:3,portion:'一小碗',note:'家里的记录',createdAt:NOW,updatedAt:NOW}]},deleted:{recipes:[],logs:[]}};}
function environment() {
  const tables = new Map(Object.values(COLLECTIONS).map(name => [name,new Map()])), files = new Map(), calls={downloads:[],uploads:[],signed:[],deleted:[]}, hooks={};
  let clock=NOW,serial=0,queue=Promise.resolve();
  const matches=(record,conditions)=>Object.entries(conditions).every(([key,value])=>value&&value.op==='in' ? (Array.isArray(record[key])?record[key].some(x=>value.values.includes(x)):value.values.includes(record[key])) : value&&value.op==='gt'?record[key]>value.value:record[key]===value);
  function collection(name,target=tables){
    if(!target.has(name))target.set(name,new Map());const table=target.get(name);
    const query=(condition={},sorts=[],offset=0,limit=100,fields=null)=>({where(next){return query(next,sorts,offset,limit,fields);},orderBy(key,direction){return query(condition,sorts.concat({key,direction}),offset,limit,fields);},skip(value){return query(condition,sorts,value,limit,fields);},limit(value){return query(condition,sorts,offset,value,fields);},field(value){return query(condition,sorts,offset,limit,value);},async count(){return {total:[...table.values()].filter(item=>matches(item,condition)).length};},async get(){const rows=[...table.values()].filter(item=>matches(item,condition));rows.sort((a,b)=>{for(const {key,direction}of sorts)if(a[key]!==b[key])return(a[key]<b[key]?-1:1)*(direction==='desc'?-1:1);return 0;});return{data:clone(rows.slice(offset,offset+limit).map(row=>fields?Object.fromEntries(Object.entries(row).filter(([key])=>fields[key])):row))};}});
    return {...query(),doc(id){return{async get(){if(hooks.read)await hooks.read(name,id);return{data:clone(table.get(id)||null)};},async set({data}){if(hooks.write)await hooks.write(name,id,data);table.set(id,{_id:id,...clone(data)});}};}};
  }
  const db={collection:name=>collection(name),command:{in:values=>({op:'in',values}),gt:value=>({op:'gt',value})},async runTransaction(callback){const previous=queue;let release;queue=new Promise(resolve=>release=resolve);await previous;const pending=new Map([...tables].map(([name,rows])=>[name,new Map([...rows].map(([id,value])=>[id,clone(value)]))]));try{const result=await callback({collection:name=>collection(name,pending)});for(const[name,rows]of pending){const dest=tables.get(name)||new Map();dest.clear();for(const[id,row]of rows)dest.set(id,row);tables.set(name,dest);}return result;}finally{release();}}};
  const cloud=name=>({getWXContext:()=>({OPENID:name,APPID,ENV}),database:()=>db,async downloadFile({fileID}){calls.downloads.push(fileID);if(hooks.download)await hooks.download(fileID);if(!files.has(fileID))throw Error('private storage diagnostic');return{fileContent:files.get(fileID),statusCode:200};},async uploadFile({cloudPath,fileContent}){if(hooks.upload)await hooks.upload(cloudPath);const id=file(cloudPath);calls.uploads.push(id);files.set(id,Buffer.from(fileContent));return{fileID:id};},async getTempFileURL({fileList}){if(hooks.sign)await hooks.sign(fileList);calls.signed.push(...fileList.map(x=>x.fileID));return{fileList:fileList.map(x=>({fileID:x.fileID,status:0,tempFileURL:'https://signed.test/'+encodeURIComponent(x.fileID)}))};},async deleteFile({fileList}){calls.deleted.push(...fileList);fileList.forEach(id=>files.delete(id));return{};},openapi:{security:{msgSecCheck:async()=>({errCode:0,result:{suggest:'pass'}}),imgSecCheck:async()=>({errCode:0})}}});
  const syncs=new Map(),socials=new Map();
  const api=(name='alice')=>{if(!syncs.has(name))syncs.set(name,syncHandler({cloud:cloud(name),now:()=>clock,random:size=>Buffer.from((++serial).toString(16).padStart(size*2,'0'),'hex')}));return syncs.get(name);};
  const social=(name='alice')=>{if(!socials.has(name))socials.set(name,socialHandler({cloud:cloud(name),now:()=>clock,unique:()=>String(++serial)}));return socials.get(name);};
  const staging=(name,data)=>{const id=file(`users/${ownerFor(name)}/snapshots/stage-${++serial}.json`);files.set(id,Buffer.from(JSON.stringify(data)));return id;};
  async function savePersonal(name='alice',data=snapshot()){const id=staging(name,data);const current=tables.get(COLLECTIONS.accounts).get(ownerFor(name));const result=await api(name)({action:'commit',baseRevision:current?current.revision:0,fileID:id});assert.ok(!result.error,JSON.stringify(result));return result;}
  async function create(name='alice',data=snapshot()){const account=await savePersonal(name,data);const result=await api(name)({action:'familyCreate',protocolVersion:2,expectedOwner:ownerFor(name),expectedScope:personal(name),name:'小宝的家',roleLabel:'妈妈',requestId:'create-'+name,baseRevision:account.revision});assert.ok(result.family,JSON.stringify(result));return result;}
  async function invite(creator){const result=await api(creator||'alice')({action:'identity',protocolVersion:2});const invitation=await api(creator||'alice')({action:'familyInvite',protocolVersion:2,expectedScope:result.scope});assert.ok(invitation.token,JSON.stringify(invitation));return invitation;}
  async function join(name='bob',creator='alice'){const invitation=await invite(creator);const result=await api(name)({action:'familyJoin',protocolVersion:2,expectedScope:personal(name),token:invitation.token,roleLabel:'爸爸',requestId:'join-'+name+'-'+serial});assert.ok(result.family,JSON.stringify(result));return result;}
  const call=(name,action,scope,fields={})=>api(name)({action,protocolVersion:2,expectedOwner:ownerFor(name),expectedScope:scope,...fields});
  const read=(name,scope)=>call(name,'familyRead',scope);
  const commit=(name,scope,revision,data)=>call(name,'commit',scope,{baseRevision:revision,fileID:staging(name,data)});
  const socialCall=(name,action,scope,fields={})=>social(name)({action,protocolVersion:2,expectedOwner:ownerFor(name),expectedScope:scope,...fields});
  return{tables,files,calls,hooks,api,social,staging,savePersonal,create,invite,join,call,read,commit,socialCall,advance:ms=>clock+=ms};
}
test('canonical family helper is identical in both independently deployed functions',()=>{
  assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/babyBitesSync/family'),'utf8'),fs.readFileSync(require.resolve('../cloudfunctions/babyBitesSocial/family'),'utf8'));
});
test('protocol 2 personal identity keeps the real account identity and no data writes',async()=>{
  const env=environment(),result=await env.api()({action:'identity',protocolVersion:2});
  assert.deepEqual(result,{owner:ownerFor('alice'),revision:0,fileID:'',scope:personal('alice')});assert.equal(env.tables.get(COLLECTIONS.accounts).size,0);
});
test('creation copies committed data and photos to a canonical family without changing personal history',async()=>{
  const env=environment(),data=snapshot(),photo=file(`users/${ownerFor('alice')}/photos/a.jpg`);env.files.set(photo,JPG);data.data.recipes[0].photo=photo;
  const created=await env.create('alice',data),personalBefore=clone(env.tables.get(COLLECTIONS.accounts).get(ownerFor('alice')));
  assert.equal(created.owner,ownerFor('alice'));assert.equal(created.scope.kind,'family');assert.equal(created.family.members[0].label,'妈妈');
  assert.ok(!JSON.stringify(created.family).includes(ownerFor('alice')));
  const result=await env.read('alice',created.scope);assert.equal(result.snapshot.data.nickname,'小宝');assert.deepEqual(result.snapshot.data.allergies,['鸡蛋']);
  assert.match(result.fileID,/families\//);assert.match(result.snapshot.data.recipes[0].photo,/families\//);assert.equal(result.snapshot.data.recipes[0].createdBy,ownerFor('alice'));
  assert.equal(result.snapshot.data.logs[0].recordedBy,undefined);assert.ok(result.photoURLs[result.snapshot.data.recipes[0].photo]);
  assert.deepEqual(env.tables.get(COLLECTIONS.accounts).get(ownerFor('alice')),personalBefore);env.files.delete(photo);assert.ok(!(await env.read('alice',created.scope)).error);
});
test('empty personal accounts can create a family without accepting a client snapshot',async()=>{
  const env=environment(),result=await env.call('alice','familyCreate',personal('alice'),{name:'我们的家',roleLabel:'妈妈',requestId:'empty-family',baseRevision:0,snapshot:snapshot()});
  assert.ok(result.family);const read=await env.read('alice',result.scope);assert.equal(read.snapshot.data.recipes.length,0);assert.equal(read.snapshot.data.logs.length,0);
});
test('creating a family from a personal backup never credits or publishes as an invited member', async () => {
  const env = environment(), data = snapshot();
  data.data.recipes[0].createdBy = ownerFor('bob');
  data.data.logs[0].recordedBy = {memberId: 'b'.repeat(32), label: '爸爸'};
  const alice = await env.create('alice', data), bob = await env.join();
  const {snapshot: shared} = await env.read('alice', alice.scope);
  assert.equal(shared.data.recipes[0].createdBy, ownerFor('alice'));
  assert.equal(shared.data.logs[0].recordedBy, undefined);
  assert.deepEqual(await env.socialCall('bob', 'syncPublications', bob.scope), {updated: 0, removed: 0, hasMore: false});
  assert.equal(env.tables.get(COLLECTIONS.recipes).size, 0);
});
test('concurrent legacy family reads migrate a forged initial author once and only sign the corrected large snapshot', async () => {
  const env = environment(), data = snapshot();
  data.data.recipes = Array.from({length: 300}, (_, index) => ({...recipe('r' + (index + 1)), note: '饭'.repeat(700)}));
  const alice = await env.create('alice', data), bob = await env.join();
  const family = env.tables.get(COLLECTIONS.families).get(alice.scope.id), original = family.fileID;
  delete family.attributionV1Revision;
  const legacy = JSON.parse(env.files.get(original));
  legacy.data.recipes[0].createdBy = ownerFor('bob');
  legacy.data.logs[0].recordedBy = {memberId: bob.family.memberId, label: '爸爸'};
  env.files.set(original, Buffer.from(JSON.stringify(legacy)));
  const [one, two] = await Promise.all([env.read('alice', alice.scope), env.read('bob', bob.scope)]);
  assert.ok(one.snapshotURL, JSON.stringify(one.error));
  assert.equal(one.revision, 2);
  assert.equal(two.fileID, one.fileID);
  assert.notEqual(one.fileID, original);
  assert.equal(two.snapshotURL, 'https://signed.test/' + encodeURIComponent(one.fileID));
  assert.equal(env.calls.signed.includes(original), false);
  assert.equal(env.tables.get(COLLECTIONS.families).get(alice.scope.id).originalAttributionFileID, original);
  assert.equal(JSON.parse(env.files.get(original)).data.recipes[0].createdBy, ownerFor('bob'));
  const corrected = JSON.parse(env.files.get(one.fileID));
  assert.equal(corrected.data.recipes[0].createdBy, ownerFor('alice'));
  assert.equal(corrected.data.logs[0].recordedBy, undefined);
  assert.equal((await env.api('bob')({action: 'identity', protocolVersion: 2})).revision, 2);
});
test('an old writer carrying a stale provenance revision cannot authorize a forged publication in a mixed family', async () => {
  const env = environment(), alice = await env.create(), bob = await env.join();
  const family = env.tables.get(COLLECTIONS.families).get(alice.scope.id), old = JSON.parse(env.files.get(family.fileID));
  family.revision = 3;
  // An old instance could copy the V1 field into a later revision without
  // validating its snapshot. Only a marker equal to that revision is trusted.
  family.attributionV1Revision = 2;
  const owner = ownerFor('bob');
  old.data.recipes.push(...['corroborated', 'unverified', 'circular'].map(id => ({...recipe(id), createdBy: owner})));
  env.files.set(family.fileID, Buffer.from(JSON.stringify(old)));
  for (const [sourceRecipeId, publishedAt] of [['corroborated', family.createdAt - 1], ['circular', family.createdAt + 1]]) {
    const id = recipeIdFor(owner, sourceRecipeId);
    env.tables.get(COLLECTIONS.recipes).set(id, {_id: id, owner, profileId: profileIdFor(owner), sourceRecipeId,
      publicationScope: 'family:' + family._id, publishedAt});
  }
  const denied = await env.socialCall('bob', 'previewPublication', bob.scope, {sourceRecipeId: 'unverified'});
  assert.equal(denied.error.code, 'RECIPE_AUTHOR_REQUIRED');
  const read = await env.read('bob', bob.scope);
  assert.deepEqual(read.snapshot.data.recipes.map(item => [item.id, item.createdBy]), [
    ['r1', ownerFor('alice')], ['corroborated', owner], ['unverified', undefined], ['circular', undefined]]);
  assert.equal(read.revision, 4);
  old.data.recipes[2].name = '仍可编辑和同步';
  const saved = await env.commit('bob', bob.scope, read.revision, old);
  assert.ok(saved.snapshot, JSON.stringify(saved));
  assert.equal(saved.snapshot.data.recipes[2].name, '仍可编辑和同步');
  assert.equal(saved.snapshot.data.recipes[2].createdBy, undefined);
  assert.equal(env.tables.get(COLLECTIONS.families).get(alice.scope.id).attributionV1Revision, saved.revision);
});
test('migrating a mixed legacy family verifies meal recorders before they can enter deletion history', async () => {
  const env = environment(), foreign = await env.create('carol'), alice = await env.create(), bob = await env.join();
  const family = env.tables.get(COLLECTIONS.families).get(alice.scope.id);
  const initial = JSON.parse(env.files.get(family.fileID));
  const foreignRecorder = {memberId: foreign.family.memberId, label: '妈妈'};
  // Old creation copied this other family's recorder from the personal backup.
  initial.data.logs[0].recordedBy = foreignRecorder;
  env.files.set(family.fileID, Buffer.from(JSON.stringify(initial)));
  initial.data.logs.push({...initial.data.logs[0], id: 'real', recordedBy: undefined});
  const saved = await env.commit('bob', bob.scope, family.revision, initial);
  assert.deepEqual(saved.snapshot.data.logs[1].recordedBy, {memberId: bob.family.memberId, label: '爸爸'});
  delete env.tables.get(COLLECTIONS.families).get(alice.scope.id).attributionV1Revision;

  const clean = await env.read('alice', alice.scope);
  assert.equal(clean.snapshot.data.logs[0].recordedBy, undefined);
  assert.deepEqual(clean.snapshot.data.logs[1].recordedBy, saved.snapshot.data.logs[1].recordedBy);
  const removed = clean.snapshot.data.logs.shift();
  clean.snapshot.deleted.logs.push({id: removed.id, updatedAt: NOW + 1, recordedBy: foreignRecorder});
  const deleted = await env.commit('alice', alice.scope, clean.revision, clean.snapshot);
  assert.equal(deleted.snapshot.deleted.logs[0].recordedBy, undefined);
  deleted.snapshot.data.logs.push({...removed, recordedBy: foreignRecorder, updatedAt: NOW + 2});
  const restored = await env.commit('alice', alice.scope, deleted.revision, deleted.snapshot);
  assert.equal(restored.snapshot.data.logs.find(log => log.id === removed.id).recordedBy, undefined);
});
test('a V1-migrated family scrubs inherited tombstones and keeps later verified attributions after the member leaves', async () => {
  const env = environment(), alice = await env.create(), bob = await env.join();
  const family = env.tables.get(COLLECTIONS.families).get(alice.scope.id);
  const original = family.fileID, previous = JSON.parse(env.files.get(original));
  previous.data.logs[0].recordedBy = {memberId: 'f'.repeat(32), label: '爸爸'};
  env.files.set(original, Buffer.from(JSON.stringify(previous)));
  const next = clone(previous);
  next.data.logs = [{...previous.data.logs[0], id: 'later', recordedBy: undefined}];
  next.deleted.logs.push({id: 'l1', updatedAt: NOW + 1});
  next.data.recipes.push(recipe('later-recipe'));
  const saved = await env.commit('bob', bob.scope, family.revision, next);
  const laterRecorder = saved.snapshot.data.logs[0].recordedBy;
  assert.deepEqual(saved.snapshot.deleted.logs[0].recordedBy, previous.data.logs[0].recordedBy);
  await env.call('bob', 'familyLeave', bob.scope);
  // Previous software marked recipes migrated, without checking mixed logs.
  env.tables.get(COLLECTIONS.families).get(alice.scope.id).originalAttributionFileID = original;
  const fixed = await env.socialCall('alice', 'mine', alice.scope);
  assert.ok(!fixed.error, JSON.stringify(fixed));
  const read = await env.read('alice', alice.scope);
  assert.equal(read.revision, saved.revision + 1);
  assert.deepEqual(read.snapshot.data.logs[0].recordedBy, laterRecorder);
  assert.equal(read.snapshot.deleted.logs[0].recordedBy, undefined);
  assert.equal(read.snapshot.data.recipes[1].createdBy, ownerFor('bob'));
  assert.equal((await env.read('alice', alice.scope)).revision, read.revision);
});
test('birthdays prefer existing private data and only migrate a valid own public birthday when absent',async()=>{
  for(const existing of [undefined,null,'2025-01-01']){const env=environment(),data=snapshot();env.tables.get(COLLECTIONS.profiles).set(profileIdFor(ownerFor('alice')),{_id:profileIdFor(ownerFor('alice')),owner:ownerFor('alice'),name:'妈妈',babyBirthDate:'2024-01-01'});
    if(existing!==undefined)Object.assign(data.data,{babyBirthDate:existing,babyBirthDateUpdatedAt:NOW-2});const created=await env.create('alice',data),read=await env.read('alice',created.scope);assert.equal(read.snapshot.data.babyBirthDate,existing===undefined?'2024-01-01':existing);assert.equal(env.tables.get(COLLECTIONS.profiles).get(profileIdFor(ownerFor('alice'))).babyBirthDate,'2024-01-01');}
});
test('creation is idempotent across a lost response and rejects stale personal revisions',async()=>{
  const env=environment(),created=await env.create();const replay=await env.call('alice','familyCreate',personal('alice'),{name:'ignored',roleLabel:'妈妈',requestId:'create-alice',baseRevision:1});assert.deepEqual(replay,created);
  const other=environment();await other.savePersonal();const stale=await other.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'stale-create',baseRevision:0});assert.equal(stale.error.code,'SYNC_REQUIRED');assert.equal(other.tables.get(COLLECTIONS.families).size,0);
});
test('single-use invitations preview limited metadata and joining does not merge personal data',async()=>{
  const env=environment(),created=await env.create();const b=snapshot();b.data.nickname='另一个宝宝';b.data.recipes[0].name='另一道菜';await env.savePersonal('bob',b);const original=clone(env.tables.get(COLLECTIONS.accounts).get(ownerFor('bob'))),invite=await env.invite();
  const preview=await env.call('bob','familyPreview',personal('bob'),{token:invite.token});assert.deepEqual(Object.keys(preview).sort(),['owner','scope','name','nickname','memberCount','expiresAt'].sort());assert.equal(preview.nickname,'小宝');assert.ok(!JSON.stringify(preview).includes('鸡蛋'));
  const joined=await env.call('bob','familyJoin',personal('bob'),{token:invite.token,roleLabel:'爸爸',requestId:'join-once'});assert.equal(joined.family.id,created.family.id);assert.equal(joined.family.memberCount,2);
  assert.equal((await env.read('bob',joined.scope)).snapshot.data.nickname,'小宝');assert.deepEqual(env.tables.get(COLLECTIONS.accounts).get(ownerFor('bob')),original);
  assert.deepEqual(await env.call('bob','familyJoin',personal('bob'),{token:invite.token,roleLabel:'爸爸',requestId:'join-once'}),joined);
  assert.equal((await env.call('carol','familyJoin',personal('carol'),{token:invite.token,roleLabel:'奶奶',requestId:'join-again'})).error.code,'INVITE_INVALID');
});
test('expired and replaced invitations cannot reveal family preview or join',async()=>{
  const env=environment();await env.create();const old=await env.invite();await env.invite();assert.equal((await env.call('bob','familyPreview',personal('bob'),{token:old.token})).error.code,'INVITE_INVALID');const next=await env.invite();env.advance(24*60*60*1000+1);assert.equal((await env.call('bob','familyJoin',personal('bob'),{token:next.token,roleLabel:'爸爸',requestId:'expired-join'})).error.code,'INVITE_INVALID');
});
test('only managers invite, remove or transfer; members can edit only their own label',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();
  for(const action of ['familyInvite','familyRemove','familyTransfer'])assert.equal((await env.call('bob',action,b.scope,{memberId:a.family.memberId})).error.code,'FAMILY_FORBIDDEN');
  const relabeled=await env.call('bob','familyRole',b.scope,{memberId:a.family.memberId,roleLabel:'姥姥'});assert.equal(relabeled.family.members.find(x=>x.isSelf).label,'姥姥');assert.equal(relabeled.family.members.find(x=>!x.isSelf).label,'妈妈');
  assert.equal((await env.call('alice','familyLeave',a.scope)).error.code,'FAMILY_TRANSFER_REQUIRED');
  await env.call('alice','familyTransfer',a.scope,{memberId:b.family.memberId});const left=await env.call('alice','familyLeave',a.scope);assert.equal(left.family,null);assert.deepEqual(left.scope,personal('alice'));
  assert.equal((await env.call('bob','familyState',b.scope)).family.isManager,true);
});
test('removal immediately rejects old scopes and rejoining receives a new membership capability',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),old=await env.read('bob',b.scope);await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});
  assert.equal((await env.read('bob',b.scope)).error.code,'FAMILY_CHANGED');assert.equal((await env.commit('bob',b.scope,old.revision,old.snapshot)).error.code,'FAMILY_CHANGED');
  const next=await env.join();assert.equal(next.scope.id,b.scope.id);assert.notEqual(next.scope.membershipId,b.scope.membershipId);assert.equal((await env.read('bob',b.scope)).error.code,'FAMILY_CHANGED');
});
test('last member leaves to the original personal index without copying shared data back',async()=>{
  const env=environment(),a=await env.create(),before=clone(env.tables.get(COLLECTIONS.accounts).get(ownerFor('alice'))),read=await env.read('alice',a.scope);read.snapshot.data.nickname='家庭里改名';read.snapshot.data.profileUpdatedAt++;
  assert.ok(!(await env.commit('alice',a.scope,read.revision,read.snapshot)).error);const left=await env.call('alice','familyLeave',a.scope);assert.equal(left.family,null);assert.deepEqual(env.tables.get(COLLECTIONS.accounts).get(ownerFor('alice')),before);assert.equal((await env.read('alice',a.scope)).error.code,'FAMILY_CHANGED');
});
test('last member can retry a failed public deletion before closing the family', async () => {
  const env = environment(), source = snapshot(), photo = file(`users/${ownerFor('alice')}/photos/dinner.jpg`);
  source.data.recipes[0].photo = photo;
  env.files.set(photo, JPG);
  const {scope} = await env.create('alice', source);
  const {recipe: published} = await env.socialCall('alice', 'publish', scope, {sourceRecipeId: 'r1'});
  assert.ok(published.photoURL);
  const saved = await env.read('alice', scope);
  saved.snapshot.data.recipes = [];
  saved.snapshot.data.logs = [];
  saved.snapshot.deleted.recipes.push({id: 'r1', updatedAt: NOW + 1});
  assert.ok(!(await env.commit('alice', scope, saved.revision, saved.snapshot)).error);
  env.hooks.write = (name) => { if (name === COLLECTIONS.recipes) throw Error('temporary failure'); };
  assert.ok((await env.socialCall('alice', 'syncPublications', scope)).error);
  assert.equal((await env.call('alice', 'familyLeave', scope)).error.code, 'PUBLICATION_PENDING');
  assert.equal((await env.call('alice', 'familyState', scope)).family.memberCount, 1);

  delete env.hooks.write;
  assert.deepEqual(await env.socialCall('alice', 'syncPublications', scope), {updated: 0, removed: 1, hasMore: false});
  assert.equal((await env.call('alice', 'familyLeave', scope)).family, null);
  assert.equal((await env.social('visitor')({action: 'recipe', recipeId: published.id})).error.code, 'NOT_FOUND');
  assert.equal(env.tables.get(COLLECTIONS.recipes).get(published.id).photoFileID, undefined);
});
test('a member who becomes the last member during leave must first check public removals', async () => {
  const env = environment(), a = await env.create(), b = await env.join();
  await env.socialCall('alice', 'publish', a.scope, {sourceRecipeId: 'r1'});
  const saved = await env.read('alice', a.scope);
  saved.snapshot.deleted.recipes.push({id: 'r1', updatedAt: NOW + 1});
  assert.ok(!(await env.commit('alice', a.scope, saved.revision, saved.snapshot)).error);
  const [bob, alice] = await Promise.all([
    env.call('bob', 'familyLeave', b.scope), env.call('alice', 'familyLeave', a.scope)
  ]);
  assert.equal(bob.family, null);
  assert.equal(alice.error.code, 'FAMILY_CONFLICT');
  assert.equal((await env.call('alice', 'familyLeave', a.scope)).error.code, 'PUBLICATION_PENDING');
});
test('a deletion committed during the final publication check prevents family closure', async () => {
  const env = environment(), {scope} = await env.create();
  await env.socialCall('alice', 'publish', scope, {sourceRecipeId: 'r1'});
  const saved = await env.read('alice', scope);
  env.hooks.download = async id => {
    if (id !== saved.fileID) return;
    delete env.hooks.download;
    saved.snapshot.deleted.recipes.push({id: 'r1', updatedAt: NOW + 1});
    assert.ok(!(await env.commit('alice', scope, saved.revision, saved.snapshot)).error);
  };
  assert.equal((await env.call('alice', 'familyLeave', scope)).error.code, 'FAMILY_CONFLICT');
  assert.equal((await env.call('alice', 'familyLeave', scope)).error.code, 'PUBLICATION_PENDING');
});
test('the final family publication check includes deletions after a full inventory page', async () => {
  const env = environment(), data = snapshot(), owner = ownerFor('alice');
  const inventory = Array.from({length: 1001}, (_, index) => {
    const sourceRecipeId = 'dish-' + index;
    return {_id: recipeIdFor(owner, sourceRecipeId), sourceRecipeId, owner, published: true};
  }).sort((a, b) => a._id < b._id ? -1 : 1);
  data.data.recipes = inventory.slice(0, 1000).map(row => recipe(row.sourceRecipeId));
  data.data.logs = [];
  const {scope} = await env.create('alice', data);
  const table = env.tables.get(COLLECTIONS.recipes);
  for (const row of inventory) table.set(row._id, {...row, publicationScope: 'family:' + scope.id});
  assert.equal((await env.call('alice', 'familyLeave', scope)).error.code, 'PUBLICATION_PENDING');
  table.get(inventory[1000]._id).published = false;
  assert.equal((await env.call('alice', 'familyLeave', scope)).family, null);
});
test('old clients cannot read or overwrite an active family',async()=>{
  const env=environment();await env.create();assert.equal((await env.api()({action:'identity'})).error.code,'CLIENT_UPDATE_REQUIRED');assert.equal((await env.api()({action:'commit',baseRevision:1,fileID:env.staging('alice',snapshot())})).error.code,'CLIENT_UPDATE_REQUIRED');
  assert.equal((await env.social()({action:'previewPublication',sourceRecipeId:'r1'})).error.code,'CLIENT_UPDATE_REQUIRED');
});
test('family commits stamp new authors and recorders without rewriting historical attribution',async()=>{
  const env=environment();await env.create();const b=await env.join(),read=await env.read('bob',b.scope);read.snapshot.data.recipes.push(recipe('r2'));read.snapshot.data.logs.push({...read.snapshot.data.logs[0],id:'l2',recipeId:'r2'});
  const saved=await env.commit('bob',b.scope,read.revision,read.snapshot);assert.ok(saved.snapshot,JSON.stringify(saved));assert.equal(saved.snapshot.data.recipes[0].createdBy,ownerFor('alice'));assert.equal(saved.snapshot.data.recipes[1].createdBy,ownerFor('bob'));assert.equal(saved.snapshot.data.logs[0].recordedBy,undefined);assert.deepEqual(saved.snapshot.data.logs[1].recordedBy,{memberId:b.family.memberId,label:'爸爸'});
  const forged=clone(saved.snapshot);forged.data.recipes[0].createdBy=ownerFor('bob');assert.equal((await env.commit('bob',b.scope,saved.revision,forged)).error.code,'INVALID_SNAPSHOT');
  const forgedRecorder=clone(saved.snapshot);forgedRecorder.data.logs[1].recordedBy.label='妈妈';assert.equal((await env.commit('bob',b.scope,saved.revision,forgedRecorder)).error.code,'INVALID_SNAPSHOT');
});

const completionId = 'meal-log-meal-2026-11-02-breakfast';
async function completedFamilyMeal() {
  const env = environment(), data = snapshot();
  data.data.logs = []; data.data.recipes.push(recipe('r2'));
  data.data.mealPlans = [{id: 'meal-2026-11-02-breakfast', date: '2026-11-02', meal: 'breakfast',
    recipeId: 'r1', createdAt: NOW, updatedAt: NOW}];
  data.deleted.mealPlans = [];
  const alice = await env.create('alice', data), bob = await env.join();
  const first = await env.read('alice', alice.scope);
  first.snapshot.data.logs.push({id: completionId, recipeId: 'r1', date: '2026-11-02', meal: 'breakfast',
    rating: 1, portion: '', note: '', createdAt: NOW + 10, updatedAt: NOW + 10});
  const saved = await env.commit('alice', alice.scope, first.revision, first.snapshot);
  assert.ok(saved.snapshot, JSON.stringify(saved));
  return {env, alice, bob, saved};
}

for (const syncedDeletion of [false, true]) test(`a new family completion credits its new member after ${syncedDeletion ? 'a synchronized' : 'an offline'} deletion`, async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const mom = {memberId: alice.family.memberId, label: '妈妈'}, dad = {memberId: bob.family.memberId, label: '爸爸'};
  assert.deepEqual(saved.snapshot.data.logs[0].recordedBy, mom);
  const removed = clone(saved.snapshot);
  removed.data.logs = []; removed.deleted.logs = [{id: completionId, updatedAt: NOW + 20}];
  let previous = saved;
  if (syncedDeletion) previous = await env.commit('alice', alice.scope, saved.revision, removed);
  const next = clone(removed);
  next.data.mealPlans[0].recipeId = 'r2'; next.data.mealPlans[0].updatedAt = NOW + 30;
  next.data.logs = [{id: completionId, recipeId: 'r2', date: '2026-11-02', meal: 'breakfast',
    rating: 3, portion: '', note: '', createdAt: NOW + 30, updatedAt: NOW + 30}];
  const merged = mergeSnapshots(next, previous.snapshot, true);
  assert.equal(merged.data.logs[0].recordedBy, undefined);
  const result = await env.commit('bob', bob.scope, previous.revision, merged);
  assert.ok(result.snapshot, JSON.stringify(result));
  assert.deepEqual(result.snapshot.data.logs[0].recordedBy, dad);
  assert.equal(result.snapshot.data.logs[0].recipeId, 'r2');
  assert.deepEqual(result.snapshot.deleted.logs[0], {id: completionId, updatedAt: NOW + 20, createdAt: NOW + 10, recordedBy: mom});
  assert.deepEqual((await env.read('bob', bob.scope)).snapshot.data.logs[0].recordedBy, dad);
  const socialRead = await env.socialCall('bob', 'familyRecipeLink', bob.scope, {sourceRecipeId: 'r2'});
  assert.equal(socialRead.error, undefined, JSON.stringify(socialRead));
});

test('same-generation concurrent completions and edits preserve the server recorder and creation time', async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const original = saved.snapshot.data.logs[0], next = clone(saved.snapshot);
  delete next.data.logs[0].recordedBy;
  next.data.logs[0].createdAt += 5; next.data.logs[0].updatedAt += 5;
  const concurrent = await env.commit('bob', bob.scope, saved.revision, next);
  assert.ok(concurrent.snapshot, JSON.stringify(concurrent));
  assert.deepEqual(concurrent.snapshot.data.logs[0].recordedBy, original.recordedBy);
  assert.equal(concurrent.snapshot.data.logs[0].createdAt, original.createdAt);
  const forged = clone(concurrent.snapshot);
  forged.data.logs[0].createdAt += 100;
  forged.data.logs[0].recordedBy = {memberId: bob.family.memberId, label: '爸爸'};
  assert.equal((await env.commit('bob', bob.scope, concurrent.revision, forged)).error.code, 'INVALID_SNAPSHOT');
  const edited = clone(concurrent.snapshot);
  delete edited.data.logs[0].recordedBy;
  edited.data.logs[0].updatedAt += 100;
  const result = await env.commit('bob', bob.scope, concurrent.revision, edited);
  assert.deepEqual(result.snapshot.data.logs[0].recordedBy, original.recordedBy);
  assert.equal((await env.read('alice', alice.scope)).snapshot.data.logs[0].createdAt, original.createdAt);
});

test('new completion generations retain canonical deletion provenance and unverified backup claims stay unknown', async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const next = clone(saved.snapshot), original = clone(next.data.logs[0]);
  next.deleted.logs = [{id: completionId, updatedAt: NOW + 20, createdAt: NOW + 19,
    recordedBy: {memberId: bob.family.memberId, label: '伪造旧归属'}}];
  Object.assign(next.data.logs[0], {recipeId: 'r2', createdAt: NOW + 30, updatedAt: NOW + 30});
  next.data.mealPlans[0].recipeId = 'r2';
  // This is an imported claim, not a fresh completion by the uploading actor.
  next.data.logs[0].recordedBy = {memberId: alice.family.memberId, label: '妈妈'};
  const imported = await env.commit('bob', bob.scope, saved.revision, next);
  assert.ok(imported.snapshot, JSON.stringify(imported));
  assert.equal(imported.snapshot.data.logs[0].recordedBy, undefined);
  assert.equal(imported.snapshot.deleted.logs[0].createdAt, original.createdAt);
  assert.deepEqual(imported.snapshot.deleted.logs[0].recordedBy, original.recordedBy);
});

test('repeated completion generations restore only the recorder associated with that deleted generation', async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const original = clone(saved.snapshot.data.logs[0]), next = clone(saved.snapshot);
  next.deleted.logs = [{id: completionId, updatedAt: NOW + 20}];
  Object.assign(next.data.logs[0], {recipeId: 'r2', createdAt: NOW + 30, updatedAt: NOW + 30});
  delete next.data.logs[0].recordedBy;
  next.data.mealPlans[0].recipeId = 'r2';
  const rebuilt = await env.commit('bob', bob.scope, saved.revision, next);
  assert.ok(rebuilt.snapshot, JSON.stringify(rebuilt));
  const replacement = clone(rebuilt.snapshot.data.logs[0]), remove = clone(rebuilt.snapshot);
  remove.data.logs = []; remove.deleted.logs = [{id: completionId, updatedAt: NOW + 40}];
  const removed = await env.commit('alice', alice.scope, rebuilt.revision, remove);
  assert.equal(removed.snapshot.deleted.logs[0].createdAt, replacement.createdAt);
  assert.deepEqual(removed.snapshot.deleted.logs[0].recordedBy, replacement.recordedBy);
  const sameGeneration = clone(removed.snapshot);
  sameGeneration.data.logs = [{...replacement, updatedAt: NOW + 50, recordedBy: original.recordedBy}];
  const restored = await env.commit('alice', alice.scope, removed.revision, sameGeneration);
  assert.deepEqual(restored.snapshot.data.logs[0].recordedBy, replacement.recordedBy);
  // After deleting and restoring B, the latest boundary covers both A and B.
  // Its recorder must not silently turn an older A backup into B's generation.
  const staleWhileLive = clone(restored.snapshot);
  staleWhileLive.data.logs = [{...original, updatedAt: NOW + 55, recordedBy: replacement.recordedBy}];
  const staleResult = await env.commit('bob', bob.scope, restored.revision, staleWhileLive);
  assert.equal(staleResult.error && staleResult.error.code, 'FAMILY_CONFLICT');
  assert.deepEqual((await env.read('alice', alice.scope)).snapshot.data.logs[0], restored.snapshot.data.logs[0]);
  const removeAgain = clone(restored.snapshot);
  removeAgain.data.logs = []; removeAgain.deleted.logs = [{id: completionId, updatedAt: NOW + 60}];
  const deletedAgain = await env.commit('alice', alice.scope, restored.revision, removeAgain);
  const olderBackup = clone(deletedAgain.snapshot);
  olderBackup.data.logs = [{...original, updatedAt: NOW + 70, recordedBy: replacement.recordedBy}];
  const oldRestored = await env.commit('bob', bob.scope, deletedAgain.revision, olderBackup);
  assert.ok(oldRestored.snapshot, JSON.stringify(oldRestored));
  assert.equal(oldRestored.snapshot.data.logs[0].recordedBy, undefined, 'the latest deleted recorder cannot attest to an earlier generation');
});

test('a late old-generation edit cannot replace a completion born after its deletion boundary', async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const older = clone(saved.snapshot), updated = clone(saved.snapshot);
  updated.data.logs[0].updatedAt = NOW + 100;
  const oldEdited = await env.commit('alice', alice.scope, saved.revision, updated);
  const newer = clone(older);
  newer.deleted.logs = [{id: completionId, updatedAt: NOW + 20}];
  newer.data.mealPlans[0].recipeId = 'r2';
  Object.assign(newer.data.logs[0], {recipeId: 'r2', createdAt: NOW + 30, updatedAt: NOW + 30});
  delete newer.data.logs[0].recordedBy;
  const rebuilt = await env.commit('bob', bob.scope, oldEdited.revision, newer);
  assert.ok(rebuilt.snapshot, JSON.stringify(rebuilt));
  assert.equal(rebuilt.snapshot.deleted.logs[0].updatedAt, NOW + 20);
  assert.equal(rebuilt.snapshot.data.logs[0].recordedBy.memberId, bob.family.memberId);
  const stale = clone(rebuilt.snapshot);
  stale.data.logs = [{...older.data.logs[0], updatedAt: NOW + 200}];
  const rejected = await env.commit('alice', alice.scope, rebuilt.revision, stale);
  assert.equal(rejected.error.code, 'FAMILY_CONFLICT');
  stale.deleted.logs[0].updatedAt = NOW + 150;
  const advancedBoundary = await env.commit('alice', alice.scope, rebuilt.revision, stale);
  assert.equal(advancedBoundary.error.code, 'FAMILY_CONFLICT', 'a newer client marker cannot erase the older authoritative boundary');
  assert.equal((await env.read('alice', alice.scope)).snapshot.data.logs[0].recipeId, 'r2');
});

test('canonical deletion metadata remains readable for legacy creation and edit timestamp ordering', async () => {
  for (const createdAt of [NOW + 200, null]) {
    const {env, alice, saved} = await completedFamilyMeal();
    const legacy = clone(saved.snapshot);
    legacy.data.logs[0].createdAt = createdAt; legacy.data.logs[0].updatedAt = NOW + 100;
    env.files.set(saved.fileID, Buffer.from(JSON.stringify(legacy)));
    const deletion = clone(legacy); deletion.data.logs = []; deletion.deleted.logs = [];
    const result = await env.commit('alice', alice.scope, saved.revision, deletion);
    assert.ok(result.snapshot, JSON.stringify(result));
    const tombstone = result.snapshot.deleted.logs[0];
    assert.ok(tombstone.updatedAt >= (createdAt || 0));
    assert.equal(tombstone.createdAt, createdAt === null ? undefined : createdAt);
    assert.ok((await env.read('alice', alice.scope)).snapshot);
  }
});

test('legacy completion tombstones preserve historical attribution while ordinary log IDs cannot claim a new generation', async () => {
  const {env, alice, bob, saved} = await completedFamilyMeal();
  const remove = clone(saved.snapshot), original = clone(remove.data.logs[0]);
  remove.data.logs = []; remove.deleted.logs = [{id: completionId, updatedAt: NOW + 20}];
  const removed = await env.commit('alice', alice.scope, saved.revision, remove);
  const legacy = clone(removed.snapshot); delete legacy.deleted.logs[0].createdAt;
  env.files.set(removed.fileID, Buffer.from(JSON.stringify(legacy)));
  const restore = clone(legacy);
  restore.data.logs = [{...original, updatedAt: NOW + 30}]; delete restore.data.logs[0].recordedBy;
  const restored = await env.commit('bob', bob.scope, removed.revision, restore);
  assert.deepEqual(restored.snapshot.data.logs[0].recordedBy, original.recordedBy);
  const plain = clone(restored.snapshot);
  plain.data.logs.push({...original, id: 'ordinary-log'}); delete plain.data.logs[1].recordedBy;
  const first = await env.commit('alice', alice.scope, restored.revision, plain);
  const replacement = clone(first.snapshot);
  replacement.deleted.logs.push({id: 'ordinary-log', updatedAt: NOW + 40});
  Object.assign(replacement.data.logs[1], {recipeId: 'r2', createdAt: NOW + 50, updatedAt: NOW + 50});
  delete replacement.data.logs[1].recordedBy;
  const ordinary = await env.commit('bob', bob.scope, first.revision, replacement);
  assert.deepEqual(ordinary.snapshot.data.logs[1].recordedBy, original.recordedBy);
});
test('concurrent family commits use one revision and stale writers receive current scope without overwriting',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('alice',a.scope),one=clone(read.snapshot),two=clone(read.snapshot);one.data.recipes[0].name='甲';two.data.recipes[0].name='乙';
  const results=await Promise.all([env.commit('alice',a.scope,read.revision,one),env.commit('bob',b.scope,read.revision,two)]);assert.equal(results.filter(x=>x.conflict).length,1);assert.equal(results.filter(x=>x.snapshot).length,1);assert.equal((await env.read('alice',a.scope)).revision,2);
});
test('a family backup restores the original author and recorder from canonical history even after an old client drops the metadata', async () => {
  const env = environment(), alice = await env.create(), bob = await env.join();
  let read = await env.read('bob', bob.scope);
  read.snapshot.data.recipes.push(recipe('bob-recipe'));
  read.snapshot.data.logs.push({...read.snapshot.data.logs[0], id: 'bob-log', recipeId: 'bob-recipe'});
  const saved = await env.commit('bob', bob.scope, read.revision, read.snapshot);
  const backup = clone(saved.snapshot.data);
  const recorder = {memberId: bob.family.memberId, label: '爸爸'};
  await env.call('bob', 'familyRole', bob.scope, {roleLabel: '家长'});
  const removal = saved.snapshot;
  removal.data.recipes.pop(); removal.data.logs.pop();
  removal.deleted.recipes.push({id: 'bob-recipe', updatedAt: NOW + 1, createdBy: ownerFor('alice')});
  removal.deleted.logs.push({id: 'bob-log', updatedAt: NOW + 1, recordedBy: {memberId: alice.family.memberId, label: '妈妈'}});
  const removed = await env.commit('alice', alice.scope, saved.revision, removal);
  assert.equal(removed.snapshot.deleted.recipes[0].createdBy, ownerFor('bob'));
  assert.deepEqual(removed.snapshot.deleted.logs[0].recordedBy, recorder);
  // Older clients do not store author data in deletion markers. They may also
  // omit the old markers altogether; the server retains their history.
  read = await env.read('alice', alice.scope);
  read.snapshot.deleted = {recipes: [], logs: []};
  read.snapshot.data.logs.push({...read.snapshot.data.logs[0], id: 'alice-log'});
  const intermediate = await env.commit('alice', alice.scope, read.revision, read.snapshot);
  assert.deepEqual(intermediate.snapshot.data.logs[1].recordedBy, {memberId: alice.family.memberId, label: '妈妈'});
  const restore = intermediate.snapshot;
  restore.data.recipes.push({...backup.recipes[1], updatedAt: NOW + 2});
  restore.data.logs.push({...backup.logs[1], updatedAt: NOW + 2, recordedBy: {memberId: alice.family.memberId, label: '妈妈'}});
  const restored = await env.commit('alice', alice.scope, intermediate.revision, restore);
  assert.ok(restored.snapshot, JSON.stringify(restored));
  assert.equal(restored.snapshot.data.recipes[1].createdBy, ownerFor('bob'));
  assert.deepEqual(restored.snapshot.data.logs[2].recordedBy, recorder);
});
test('restoring historical deletions without canonical provenance keeps attribution unknown and syncs unrelated records', async () => {
  const env = environment(), data = snapshot();
  data.deleted = {recipes: [{id: 'old', updatedAt: NOW}], logs: [{id: 'old-log', updatedAt: NOW}]};
  await env.create('alice', data);
  const bob = await env.join(), read = await env.read('bob', bob.scope);
  const claimed = {memberId: bob.family.memberId, label: '爸爸'};
  read.snapshot.data.recipes.push({...recipe('old'), updatedAt: NOW + 1, createdBy: ownerFor('alice')});
  read.snapshot.data.logs.push({...read.snapshot.data.logs[0], id: 'old-log', updatedAt: NOW + 1, recordedBy: claimed},
    {...read.snapshot.data.logs[0], id: 'new-log'});
  const restored = await env.commit('bob', bob.scope, read.revision, read.snapshot);
  assert.ok(restored.snapshot, JSON.stringify(restored));
  assert.equal(restored.snapshot.data.recipes[1].createdBy, undefined);
  assert.equal(restored.snapshot.data.logs[1].recordedBy, undefined);
  assert.deepEqual(restored.snapshot.data.logs[2].recordedBy, claimed);
});
test('a restored saved copy retains its source and only a fresh save of the same link credits the new actor', async () => {
  const env = environment(), alice = await env.create(), bob = await env.join();
  const source = {recipeId: 'a'.repeat(64), profileId: 'a'.repeat(32), authorName: '原作者'};
  const id = 'shared-' + source.recipeId, copy = {...recipe(id), source};
  let read = await env.read('alice', alice.scope);
  read.snapshot.data.recipes.push(copy);
  let saved = await env.commit('alice', alice.scope, read.revision, read.snapshot);
  const forged = clone(saved.snapshot);
  forged.data.recipes[1].source = {...source, recipeId: 'b'.repeat(64)};
  saved = await env.commit('bob', bob.scope, saved.revision, forged);
  assert.deepEqual(saved.snapshot.data.recipes[1].source, source);
  saved.snapshot.data.recipes.pop();
  saved = await env.commit('bob', bob.scope, saved.revision, saved.snapshot);
  saved.snapshot.data.recipes.push({...copy, createdBy: ownerFor('alice'), updatedAt: NOW + 1,
    source: {...source, profileId: 'c'.repeat(32)}});
  saved = await env.commit('bob', bob.scope, saved.revision, saved.snapshot);
  assert.deepEqual(saved.snapshot.data.recipes[1].source, source);
  assert.equal(saved.snapshot.data.recipes[1].createdBy, ownerFor('alice'));
  saved.snapshot.data.recipes.pop();
  saved = await env.commit('bob', bob.scope, saved.revision, saved.snapshot);
  saved.snapshot.data.recipes.push({...copy, updatedAt: NOW + 2});
  saved = await env.commit('bob', bob.scope, saved.revision, saved.snapshot);
  assert.equal(saved.snapshot.data.recipes[1].createdBy, ownerFor('bob'));
});
test('family photo authorization signs only exact current references and rejects private or other-family paths',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope),privatePhoto=file(`users/${ownerFor('alice')}/photos/private.jpg`);env.files.set(privatePhoto,JPG);read.snapshot.data.recipes[0].photo=privatePhoto;
  assert.equal((await env.commit('bob',b.scope,read.revision,read.snapshot)).error.code,'INVALID_SNAPSHOT');
  const ownPhoto=file(`users/${ownerFor('bob')}/photos/new.jpg`);env.files.set(ownPhoto,JPG);read.snapshot.data.recipes[0].photo=ownPhoto;const saved=await env.commit('bob',b.scope,read.revision,read.snapshot);assert.ok(saved.snapshot);const canonical=saved.snapshot.data.recipes[0].photo;
  assert.ok((await env.call('alice','familyPhotos',a.scope,{fileIDs:[canonical]})).photoURLs[canonical]);assert.equal((await env.call('alice','familyPhotos',a.scope,{fileIDs:[privatePhoto]})).error.code,'INVALID_FILE');assert.equal((await env.call('carol','familyPhotos',a.scope,{fileIDs:[canonical]})).error.code,'FAMILY_CHANGED');
  assert.equal((await env.call('alice','familyPhotos',a.scope,{fileIDs:Array(21).fill(canonical)})).error.code,'INVALID_FILE');
});
test('large family libraries sign only twenty initial photos and allow authorized continuation',async()=>{
  const env=environment(),data=snapshot();data.data.recipes=[];data.data.logs=[];for(let i=0;i<23;i++){const photo=file(`users/${ownerFor('alice')}/photos/a${i}.jpg`);env.files.set(photo,JPG);data.data.recipes.push({...recipe('r'+i),photo});}
  const a=await env.create('alice',data),read=await env.read('alice',a.scope);assert.equal(Object.keys(read.photoURLs).length,20);const rest=read.snapshot.data.recipes.slice(20).map(x=>x.photo),next=await env.call('alice','familyPhotos',a.scope,{fileIDs:rest});assert.deepEqual(Object.keys(next.photoURLs).sort(),rest.sort());assert.equal(next.owner,ownerFor('alice'));assert.deepEqual(next.scope,a.scope);
});
test('personal birthday fields reject old-client dropping and retain valid explicit clearing',async()=>{
  const env=environment(),data=snapshot();Object.assign(data.data,{babyBirthDate:'2025-01-01',babyBirthDateUpdatedAt:NOW});await env.savePersonal('alice',data);
  const old=await env.api()({action:'commit',baseRevision:1,fileID:env.staging('alice',snapshot())});assert.equal(old.error.code,'CLIENT_UPDATE_REQUIRED');
  data.data.babyBirthDate=null;data.data.babyBirthDateUpdatedAt++;const clear=await env.api()({action:'commit',baseRevision:1,fileID:env.staging('alice',data)});assert.equal(clear.revision,2);
  const invalid=clone(data);invalid.data.recipes[0].createdBy=[ownerFor('alice')];assert.equal((await env.api()({action:'commit',baseRevision:2,fileID:env.staging('alice',invalid)})).error.code,'INVALID_SNAPSHOT');
});
test('removal while signing photos discards the complete private family response',async()=>{
  const env=environment(),data=snapshot(),photo=file(`users/${ownerFor('alice')}/photos/a.jpg`);env.files.set(photo,JPG);data.data.recipes[0].photo=photo;const a=await env.create('alice',data),b=await env.join();let once=true;env.hooks.sign=async()=>{if(once){once=false;await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});}};
  const result=await env.read('bob',b.scope);assert.equal(result.error.code,'FAMILY_CHANGED');assert.equal(result.snapshot,undefined);assert.equal(result.photoURLs,undefined);
});
test('removal during new photo upload prevents a family commit and cleans only its uncommitted copies',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope),photo=file(`users/${ownerFor('bob')}/photos/new.jpg`);env.files.set(photo,JPG);read.snapshot.data.recipes[0].photo=photo;let once=true;
  env.hooks.upload=async path=>{if(once&&path.includes('/photos/')){once=false;await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});}};
  const result=await env.commit('bob',b.scope,read.revision,read.snapshot);assert.equal(result.error.code,'FAMILY_CHANGED');assert.equal((await env.read('alice',a.scope)).revision,1);assert.ok(env.calls.deleted.length>=2);assert.ok(env.files.has(photo));
});
test('birthday and allergy protections reject dropping or rolling back household settings',async()=>{
  const env=environment(),data=snapshot();Object.assign(data.data,{babyBirthDate:'2025-01-01',babyBirthDateUpdatedAt:NOW});const a=await env.create('alice',data),read=await env.read('alice',a.scope);
  for(const field of ['allergies','babyBirthDate']){const bad=clone(read.snapshot);delete bad.data[field];delete bad.data[field+'UpdatedAt'];const result=await env.commit('alice',a.scope,read.revision,bad);assert.equal(result.error.code,'CLIENT_UPDATE_REQUIRED');}
  const stale=clone(read.snapshot);stale.data.babyBirthDateUpdatedAt--;assert.equal((await env.commit('alice',a.scope,read.revision,stale)).error.code,'FAMILY_CONFLICT');
});
test('only the family recipe creator can first publish, and others obtain the exact existing author link',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();
  assert.equal((await env.socialCall('bob','previewPublication',b.scope,{sourceRecipeId:'r1'})).error.code,'RECIPE_AUTHOR_REQUIRED');
  assert.deepEqual(await env.socialCall('bob','familyRecipeLink',b.scope,{sourceRecipeId:'r1'}),{publication:null});
  const preview=await env.socialCall('alice','previewPublication',a.scope,{sourceRecipeId:'r1'});assert.ok(preview.previewToken,JSON.stringify(preview));
  const published=await env.socialCall('alice','publish',a.scope,{sourceRecipeId:'r1',previewToken:preview.previewToken});assert.ok(published.recipe,JSON.stringify(published));
  const link=await env.socialCall('bob','familyRecipeLink',b.scope,{sourceRecipeId:'r1'});assert.equal(link.publication.id,recipeIdFor(ownerFor('alice'),'r1'));assert.equal(link.publication.createdBy,ownerFor('alice'));assert.equal(env.tables.get(COLLECTIONS.recipes).get(link.publication.id).publicationScope,'family:'+a.family.id);
});
test('an author automatically associates their personal publication with a new family while retaining its author and share link',async()=>{
  const env=environment();await env.savePersonal();const preview=await env.socialCall('alice','previewPublication',personal('alice'),{sourceRecipeId:'r1'});await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1',previewToken:preview.previewToken});
  const id=recipeIdFor(ownerFor('alice'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id)),a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'scoped-create',baseRevision:1});
  assert.deepEqual(await env.socialCall('alice','syncPublications',a.scope),{updated:1,removed:0,hasMore:false});
  const migrated=env.tables.get(COLLECTIONS.recipes).get(id);assert.equal(migrated.owner,before.owner);assert.equal(migrated.profileId,before.profileId);assert.equal(migrated.publishedAt,before.publishedAt);assert.equal(migrated.sortKey,before.sortKey);assert.equal(migrated.generation,before.generation+1);assert.equal(migrated.publicationScope,'family:'+a.family.id);
  assert.equal((await env.socialCall('alice','mine',a.scope)).published.length,1);
  assert.equal((await env.socialCall('alice','familyRecipeLink',a.scope,{sourceRecipeId:'r1'})).publication.id,id);
  const sharedBefore=clone(env.tables.get(COLLECTIONS.recipes).get(id));await env.call('alice','familyLeave',a.scope);await env.socialCall('alice','syncPublications',personal('alice'));assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),sharedBefore);
});
test('another family member cannot associate the original author personal publication on their behalf',async()=>{
  const env=environment();await env.savePersonal();await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'});
  const id=recipeIdFor(ownerFor('alice'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id));
  const a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'own-migration',baseRevision:1}),b=await env.join();
  assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:0,removed:0,hasMore:false});assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);
  assert.deepEqual(await env.socialCall('bob','familyRecipeLink',b.scope,{sourceRecipeId:'r1'}),{publication:null});
  const current=await env.read('bob',b.scope);current.snapshot.data.recipes[0].name='家人一起更新的菜谱';current.snapshot.data.recipes[0].updatedAt++;await env.commit('bob',b.scope,current.revision,current.snapshot);
  await env.socialCall('alice','syncPublications',a.scope);
  assert.equal(env.tables.get(COLLECTIONS.recipes).get(id).name,'家人一起更新的菜谱');assert.equal(env.tables.get(COLLECTIONS.recipes).get(id).owner,ownerFor('alice'));
  assert.equal((await env.socialCall('bob','familyRecipeLink',b.scope,{sourceRecipeId:'r1'})).publication.id,id);
});
test('legacy direct sharing can still migrate the actual author personal publication into their current family',async()=>{
  const env=environment();await env.savePersonal();const original=await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'});
  const a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'direct-personal-migration',baseRevision:1});
  const result=await env.socialCall('alice','publish',a.scope,{sourceRecipeId:'r1'});assert.equal(result.recipe.id,original.recipe.id);
  assert.equal(env.tables.get(COLLECTIONS.recipes).get(result.recipe.id).publicationScope,'family:'+a.family.id);
});
test('the current author can migrate an old-policy personal withdrawal still present in the new family snapshot',async()=>{
  const env=environment();await env.savePersonal();await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'});
  const id=recipeIdFor(ownerFor('alice'),'r1'),record=env.tables.get(COLLECTIONS.recipes).get(id);record.published=false;record.publicationPolicyVersion=2;
  const a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'old-policy-migration',baseRevision:1});
  assert.deepEqual(await env.socialCall('alice','syncPublications',a.scope),{updated:1,removed:0,hasMore:false});
  const published=env.tables.get(COLLECTIONS.recipes).get(id);assert.equal(published.published,true);assert.equal(published.publicationScope,'family:'+a.family.id);assert.equal(published.publicationPolicyVersion,3);
});
test('automatic publication never moves an existing recipe from another family or back to personal scope',async()=>{
  const env=environment(),a=await env.create();await env.socialCall('alice','syncPublications',a.scope);
  const id=recipeIdFor(ownerFor('alice'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id));
  await env.call('alice','familyLeave',a.scope);await env.socialCall('alice','syncPublications',personal('alice'));assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);
  assert.equal((await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'})).error.code,'CONFLICT');
  const b=await env.call('alice','familyCreate',personal('alice'),{name:'新家',roleLabel:'妈妈',requestId:'other-family',baseRevision:1});
  assert.notEqual(b.family.id,a.family.id);assert.deepEqual(await env.socialCall('alice','syncPublications',b.scope),{updated:0,removed:0,hasMore:false});
  assert.equal((await env.socialCall('alice','publish',b.scope,{sourceRecipeId:'r1'})).error.code,'CONFLICT');
  assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);assert.deepEqual(await env.socialCall('alice','familyRecipeLink',b.scope,{sourceRecipeId:'r1'}),{publication:null});
});
test('leaving a family during publication migration cannot rewrite the personal publication',async()=>{
  const env=environment(),data=snapshot(),photo=file(`users/${ownerFor('alice')}/photos/migration.jpg`);data.data.recipes[0].photo=photo;env.files.set(photo,JPG);await env.savePersonal('alice',data);await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'});
  const id=recipeIdFor(ownerFor('alice'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id)),a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'migration-leave',baseRevision:1});
  let armed=true;env.hooks.upload=async path=>{if(armed&&path.startsWith('social/')){armed=false;await env.call('alice','familyLeave',a.scope);}};
  const result=await env.socialCall('alice','syncPublications',a.scope);assert.equal(result.error.code,'FAMILY_CHANGED');assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);
});
test('a concurrent newer migration wins its generation and stale copying cannot overwrite it',async()=>{
  const env=environment(),data=snapshot(),photo=file(`users/${ownerFor('alice')}/photos/migration-race.jpg`);data.data.recipes[0].photo=photo;env.files.set(photo,JPG);await env.savePersonal('alice',data);await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1'});
  const id=recipeIdFor(ownerFor('alice'),'r1'),a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'migration-generation',baseRevision:1});let armed=true,winner;
  env.hooks.upload=async path=>{if(armed&&path.startsWith('social/')){armed=false;assert.deepEqual(await env.socialCall('alice','syncPublications',a.scope),{updated:1,removed:0,hasMore:false});winner=clone(env.tables.get(COLLECTIONS.recipes).get(id));}};
  const result=await env.socialCall('alice','syncPublications',a.scope);assert.equal(result.error.code,'CONFLICT');assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),winner);
  assert.deepEqual(await env.socialCall('alice','syncPublications',a.scope),{updated:0,removed:0,hasMore:false});
});
test('stale family preview cannot publish after removal or use another membership after rejoining',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope);read.snapshot.data.recipes.push(recipe('bob-own'));await env.commit('bob',b.scope,read.revision,read.snapshot);
  const preview=await env.socialCall('bob','previewPublication',b.scope,{sourceRecipeId:'bob-own'});assert.ok(preview.previewToken);await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});const next=await env.join();
  assert.equal((await env.socialCall('bob','publish',b.scope,{sourceRecipeId:'bob-own',previewToken:preview.previewToken})).error.code,'FAMILY_CHANGED');assert.equal((await env.socialCall('bob','publish',next.scope,{sourceRecipeId:'bob-own',previewToken:preview.previewToken})).error.code,'PREVIEW_STALE');
});
test('family save receipts validate the shared committed copy while retaining personal actor identity',async()=>{
  const env=environment();await env.savePersonal('carol');const preview=await env.socialCall('carol','previewPublication',personal('carol'),{sourceRecipeId:'r1'});const published=await env.socialCall('carol','publish',personal('carol'),{sourceRecipeId:'r1',previewToken:preview.previewToken});const a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope);read.snapshot.data.recipes.push({...recipe('copy'),source:{recipeId:published.recipe.id,profileId:published.recipe.profileId,authorName:'原作者'}});await env.commit('bob',b.scope,read.revision,read.snapshot);
  const receipt = {recipeId: published.recipe.id, localRecipeId: 'copy'};
  assert.deepEqual(await env.socialCall('alice', 'recordSave', a.scope, receipt), {recorded: false});
  assert.equal(env.tables.get(COLLECTIONS.feedback).size, 0);
  assert.deepEqual(await env.socialCall('bob', 'recordSave', b.scope, receipt), {recorded: true});
  assert.deepEqual(await env.socialCall('bob', 'recordSave', b.scope, receipt), {recorded: false});
  assert.deepEqual([...env.tables.get(COLLECTIONS.feedback).values()].map(row => row.owner), [ownerFor('bob')]);
});
test('another family member updates and removes an already shared recipe under its original author',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();const preview=await env.socialCall('alice','previewPublication',a.scope,{sourceRecipeId:'r1'});const published=await env.socialCall('alice','publish',a.scope,{sourceRecipeId:'r1',previewToken:preview.previewToken});
  const read=await env.read('bob',b.scope);read.snapshot.data.recipes[0].name='爸爸调整后的南瓜粥';read.snapshot.data.recipes[0].updatedAt++;
  const saved=await env.commit('bob',b.scope,read.revision,read.snapshot);assert.ok(saved.snapshot);
  assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:1,removed:0,hasMore:false});
  const record=env.tables.get(COLLECTIONS.recipes).get(published.recipe.id);assert.equal(record.owner,ownerFor('alice'));assert.equal(record.profileId,profileIdFor(ownerFor('alice')));assert.equal(record.name,'爸爸调整后的南瓜粥');assert.equal(env.tables.get(COLLECTIONS.profiles).has(profileIdFor(ownerFor('bob'))),false);
  const removed=clone(saved.snapshot);removed.data.recipes=[];removed.data.logs=[];removed.deleted.recipes=[{id:'r1',updatedAt:NOW+2}];await env.commit('bob',b.scope,saved.revision,removed);
  assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:0,removed:1,hasMore:false});assert.equal(env.tables.get(COLLECTIONS.recipes).get(published.recipe.id).published,false);
});
test('other family members cannot first-publish or revive an author withdrawal',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:0,removed:0,hasMore:false});assert.equal(env.tables.get(COLLECTIONS.recipes).size,0);
  const preview=await env.socialCall('alice','previewPublication',a.scope,{sourceRecipeId:'r1'});const shared=await env.socialCall('alice','publish',a.scope,{sourceRecipeId:'r1',previewToken:preview.previewToken});await env.socialCall('alice','unpublish',a.scope,{sourceRecipeId:'r1'});
  const read=await env.read('bob',b.scope);read.snapshot.data.recipes[0].name='新名字';read.snapshot.data.recipes[0].updatedAt++;await env.commit('bob',b.scope,read.revision,read.snapshot);assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:0,removed:0,hasMore:false});assert.equal(env.tables.get(COLLECTIONS.recipes).get(shared.recipe.id).published,false);
});
test('automatic family publication creates only the current member own recipes under the original individual author',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();
  assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:0,removed:0,hasMore:false});
  assert.equal(env.tables.get(COLLECTIONS.profiles).size,0);
  assert.deepEqual(await env.socialCall('alice','syncPublications',a.scope),{updated:1,removed:0,hasMore:false});
  const id=recipeIdFor(ownerFor('alice'),'r1'),first=clone(env.tables.get(COLLECTIONS.recipes).get(id));
  assert.equal(first.owner,ownerFor('alice'));assert.equal(first.publicationScope,'family:'+a.family.id);
  const read=await env.read('bob',b.scope);read.snapshot.data.recipes.push(recipe('bob-own'));await env.commit('bob',b.scope,read.revision,read.snapshot);
  assert.deepEqual(await env.socialCall('bob','syncPublications',b.scope),{updated:1,removed:0,hasMore:false});
  assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),first);
  assert.equal(env.tables.get(COLLECTIONS.recipes).get(recipeIdFor(ownerFor('bob'),'bob-own')).owner,ownerFor('bob'));
});
test('removal during automatic first family publication does not create a public recipe or author profile',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope),photo=file(`users/${ownerFor('bob')}/photos/first.jpg`);env.files.set(photo,JPG);
  read.snapshot.data.recipes.push({...recipe('bob-own'),photo});await env.commit('bob',b.scope,read.revision,read.snapshot);
  let once=true;env.hooks.upload=async path=>{if(once&&path.startsWith('social/')){once=false;await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});}};
  const result=await env.socialCall('bob','syncPublications',b.scope);assert.equal(result.error.code,'FAMILY_CHANGED');
  assert.equal(env.tables.get(COLLECTIONS.recipes).size,0);assert.equal(env.tables.get(COLLECTIONS.profiles).size,0);
});
test('member removal during automatic public photo copying blocks the original author write',async()=>{
  const env=environment(),a=await env.create(),b=await env.join();const preview=await env.socialCall('alice','previewPublication',a.scope,{sourceRecipeId:'r1'});const shared=await env.socialCall('alice','publish',a.scope,{sourceRecipeId:'r1',previewToken:preview.previewToken});const before=clone(env.tables.get(COLLECTIONS.recipes).get(shared.recipe.id));
  const read=await env.read('bob',b.scope),photo=file(`users/${ownerFor('bob')}/photos/followup.jpg`);env.files.set(photo,JPG);read.snapshot.data.recipes[0].photo=photo;read.snapshot.data.recipes[0].updatedAt++;await env.commit('bob',b.scope,read.revision,read.snapshot);
  let once=true;env.hooks.upload=async path=>{if(once&&path.startsWith('social/')){once=false;await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});}};
  const result=await env.socialCall('bob','syncPublications',b.scope);assert.equal(result.error.code,'FAMILY_CHANGED');assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(shared.recipe.id),before);
});
test('commits started in personal scope cannot land after the caller joins a family',async()=>{
  const env=environment();await env.create();await env.savePersonal('bob');const invite=await env.invite(),stage=env.staging('bob',snapshot());let once=true;env.hooks.download=async id=>{if(once&&id===stage){once=false;await env.call('bob','familyJoin',personal('bob'),{token:invite.token,roleLabel:'爸爸',requestId:'join-during-commit'});}};
  const before=clone(env.tables.get(COLLECTIONS.accounts).get(ownerFor('bob')));const result=await env.call('bob','commit',personal('bob'),{baseRevision:1,fileID:stage});assert.equal(result.error.code,'FAMILY_CHANGED');assert.deepEqual(env.tables.get(COLLECTIONS.accounts).get(ownerFor('bob')),before);
});
test('both private snapshot validators reject malformed authors and recorder capabilities',()=>{
  for(const path of ['../cloudfunctions/babyBitesSync/validate','../cloudfunctions/babyBitesSocial/private-snapshot']){
    const {validateSnapshot}=require(path);
    for(const createdBy of [[ownerFor('alice')],{owner:ownerFor('alice')},null,123,'g'.repeat(64),'a'.repeat(63)]){
      const data=snapshot();data.data.recipes[0].createdBy=createdBy;
      assert.throws(()=>validateSnapshot(Buffer.from(JSON.stringify(data)),{env:ENV,owner:ownerFor('alice'),now:NOW}),path);
    }
    const data=snapshot();data.data.logs[0].recordedBy={memberId:['a'.repeat(32)],label:'妈妈'};
    assert.throws(()=>validateSnapshot(Buffer.from(JSON.stringify(data)),{env:ENV,owner:ownerFor('alice'),now:NOW}),path);
    data.data.recipes[0].createdBy=ownerFor('alice');data.data.logs[0].recordedBy={memberId:'a'.repeat(32),label:'妈妈'};
    assert.equal(validateSnapshot(Buffer.from(JSON.stringify(data)),{env:ENV,owner:ownerFor('alice'),now:NOW}).data.recipes[0].createdBy,ownerFor('alice'));
  }
});
test('family social requests cannot retarget personal publications after leaving between authorization and snapshot resolution',async()=>{
  for(const action of ['unpublish','syncPublications','previewPublication','publish']){
    const env=environment();await env.savePersonal();const preview=await env.socialCall('alice','previewPublication',personal('alice'),{sourceRecipeId:'r1'});
    await env.socialCall('alice','publish',personal('alice'),{sourceRecipeId:'r1',previewToken:preview.previewToken});
    const id=recipeIdFor(ownerFor('alice'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id));
    const a=await env.call('alice','familyCreate',personal('alice'),{name:'家',roleLabel:'妈妈',requestId:'scope-race',baseRevision:1});
    const familyPreview=await env.socialCall('alice','previewPublication',a.scope,{sourceRecipeId:'r1'});
    let reads=0,armed=true;env.hooks.read=async(name,member)=>{if(armed&&name===COLLECTIONS.memberships&&member===ownerFor('alice')&&++reads===2){armed=false;assert.ok(!(await env.call('alice','familyLeave',a.scope)).error);}};
    const result=await env.socialCall('alice',action,a.scope,{sourceRecipeId:'r1',previewToken:familyPreview.previewToken});
    assert.equal(result.error&&result.error.code,'FAMILY_CHANGED',action+JSON.stringify(result));assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);
  }
});
test('personal social requests cannot retarget a family joined after request authorization',async()=>{
  const env=environment();await env.create('carol');await env.savePersonal('bob');
  const preview=await env.socialCall('bob','previewPublication',personal('bob'),{sourceRecipeId:'r1'});await env.socialCall('bob','publish',personal('bob'),{sourceRecipeId:'r1',previewToken:preview.previewToken});
  const id=recipeIdFor(ownerFor('bob'),'r1'),before=clone(env.tables.get(COLLECTIONS.recipes).get(id)),invite=await env.invite('carol');
  let reads=0,armed=true;env.hooks.read=async(name,member)=>{if(armed&&name===COLLECTIONS.memberships&&member===ownerFor('bob')&&++reads===2){armed=false;assert.ok(!(await env.call('bob','familyJoin',personal('bob'),{token:invite.token,roleLabel:'爸爸',requestId:'join-social-race'})).error);}};
  const result=await env.socialCall('bob','unpublish',personal('bob'),{sourceRecipeId:'r1'});assert.equal(result.error.code,'FAMILY_CHANGED');assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(id),before);
});
test('family social authorization cannot survive changing families or leaving and rejoining the same family',async()=>{
  for(const rejoin of [false,true]){
    const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('bob',b.scope);read.snapshot.data.recipes.push(recipe('bob-own'));await env.commit('bob',b.scope,read.revision,read.snapshot);
    const preview=await env.socialCall('bob','previewPublication',b.scope,{sourceRecipeId:'bob-own'});const published=await env.socialCall('bob','publish',b.scope,{sourceRecipeId:'bob-own',previewToken:preview.previewToken});
    const before=clone(env.tables.get(COLLECTIONS.recipes).get(published.recipe.id));if(!rejoin)await env.create('carol');
    let reads=0,armed=true;env.hooks.read=async(name,member)=>{if(armed&&name===COLLECTIONS.memberships&&member===ownerFor('bob')&&++reads===2){armed=false;await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});const next=await env.join('bob',rejoin?'alice':'carol');assert.notDeepEqual(next.scope,b.scope);}};
    const result=await env.socialCall('bob','unpublish',b.scope,{sourceRecipeId:'bob-own'});assert.equal(result.error.code,'FAMILY_CHANGED');assert.deepEqual(env.tables.get(COLLECTIONS.recipes).get(published.recipe.id),before);
  }
});
test('save receipts cannot use a personal copy after leaving the family during snapshot resolution',async()=>{
  const env=environment();await env.savePersonal('carol');const preview=await env.socialCall('carol','previewPublication',personal('carol'),{sourceRecipeId:'r1'});const published=await env.socialCall('carol','publish',personal('carol'),{sourceRecipeId:'r1',previewToken:preview.previewToken});
  const data=snapshot();data.data.recipes[0].source={recipeId:published.recipe.id,profileId:published.recipe.profileId,authorName:'原作者'};
  const a=await env.create('alice',data);let reads=0,armed=true;env.hooks.read=async(name,member)=>{if(armed&&name===COLLECTIONS.memberships&&member===ownerFor('alice')&&++reads===2){armed=false;await env.call('alice','familyLeave',a.scope);}};
  const result=await env.socialCall('alice','recordSave',a.scope,{recipeId:published.recipe.id,localRecipeId:'r1'});assert.equal(result.error.code,'FAMILY_CHANGED');assert.equal(env.tables.get(COLLECTIONS.feedback).size,0);
});
function largeSnapshot(){const data=snapshot();data.data.logs=Array.from({length:1000},(_,i)=>({...data.data.logs[0],id:'large-'+i,note:'家'.repeat(500)}));return data;}
test('large family reads and commits use separately signed canonical snapshot downloads below the response limit',async()=>{
  const env=environment(),data=largeSnapshot();data.data.recipes=Array.from({length:25},(_,i)=>({...recipe(i?'r'+(i+1):'r1'),photo:file(`users/${ownerFor('alice')}/photos/large-${i}.jpg`)}));data.data.recipes.forEach(r=>env.files.set(r.photo,JPG));
  const a=await env.create('alice',data);env.calls.signed.length=0;const read=await env.read('alice',a.scope);
  assert.ok(env.files.get(read.fileID).length>1024*1024);assert.equal(read.snapshot,undefined);assert.equal(read.snapshotURL,'https://signed.test/'+encodeURIComponent(read.fileID));assert.equal(Object.keys(read.photoURLs).length,20);assert.ok(env.calls.signed.includes(read.fileID));assert.equal(env.calls.signed.length,21);assert.ok(Buffer.byteLength(JSON.stringify(read))<512*1024);
  const changed=JSON.parse(env.files.get(read.fileID));changed.data.nickname='家庭宝宝';const saved=await env.commit('alice',a.scope,read.revision,changed);
  assert.equal(saved.revision,read.revision+1);assert.equal(saved.snapshot,undefined);assert.equal(saved.snapshotURL,'https://signed.test/'+encodeURIComponent(saved.fileID));assert.equal(JSON.parse(env.files.get(saved.fileID)).data.nickname,'家庭宝宝');assert.equal(Object.keys(saved.photoURLs).length,20);assert.ok(Buffer.byteLength(JSON.stringify(saved))<512*1024);
});
test('large snapshot signing rechecks both membership and revision before returning a download URL',async()=>{
  for(const change of ['remove','commit']){
    const env=environment(),a=await env.create('alice',largeSnapshot()),b=await env.join(),state=env.tables.get(COLLECTIONS.families).get(a.family.id);let armed=true;
    env.hooks.sign=async list=>{assert.ok(list.every(item=>item.maxAge===300));if(armed&&list.some(item=>item.fileID===state.fileID)){armed=false;if(change==='remove')await env.call('alice','familyRemove',a.scope,{memberId:b.family.memberId});else{const updated=JSON.parse(env.files.get(state.fileID));updated.data.nickname='刚更新';assert.ok(!(await env.commit('alice',a.scope,state.revision,updated)).error);}}};
    const result=await env.read('bob',b.scope);assert.equal(result.error.code,change==='remove'?'FAMILY_CHANGED':'FAMILY_CONFLICT');assert.equal(result.snapshotURL,undefined);assert.equal(result.snapshot,undefined);
  }
});

test('family members share confirmed meal plans and unrated completions without exposing them publicly', async () => {
  const env = environment(), data = snapshot();
  const planned = {id: 'meal-2026-11-02-breakfast', date: '2026-11-02', meal: 'breakfast', recipeId: 'r1', createdAt: NOW, updatedAt: NOW};
  data.data.mealPlans = [planned, {...planned, id: 'meal-2026-11-05-lunch', date: '2026-11-05', meal: 'lunch'}];
  data.deleted.mealPlans = [];
  const alice = await env.create('alice', data), bob = await env.join();
  const read = await env.read('bob', bob.scope);
  assert.deepEqual(read.snapshot.data.mealPlans, data.data.mealPlans);
  const completion = {id: 'meal-log-' + planned.id, recipeId: 'r1', date: '2026-11-02', meal: 'breakfast',
    rating: 0, portion: '', note: '', createdAt: NOW + 1, updatedAt: NOW + 1};
  read.snapshot.data.logs.push(completion);
  const saved = await env.commit('bob', bob.scope, read.revision, read.snapshot);
  assert.ok(saved.snapshot, JSON.stringify(saved));
  const familyData = await env.read('alice', alice.scope);
  const actual = familyData.snapshot.data.logs.find(item => item.id === completion.id);
  assert.equal(actual.rating, 0); assert.equal(actual.meal, 'breakfast');
  assert.equal(actual.recordedBy.memberId, bob.family.memberId);
  assert.deepEqual(familyData.snapshot.data.mealPlans, data.data.mealPlans);
  assert.deepEqual(await env.socialCall('alice', 'syncPublications', alice.scope), {updated: 1, removed: 0, hasMore: false});
  const published = env.tables.get(COLLECTIONS.recipes).get(recipeIdFor(ownerFor('alice'), 'r1'));
  assert.ok(published);
  assert.equal(Object.hasOwn(published, 'mealPlans'), false);
  assert.equal(Object.hasOwn(published, 'logs'), false);
  assert.doesNotMatch(JSON.stringify(published), /meal-2026|meal-log/);
});

test('old family writers cannot drop an enabled meal schema and plan deletion history survives later commits', async () => {
  const env = environment(), data = snapshot();
  data.data.mealPlans = [{id: 'meal-2026-11-05-breakfast', date: '2026-11-05', meal: 'breakfast',
    recipeId: 'r1', createdAt: NOW, updatedAt: NOW}];
  data.deleted.mealPlans = [];
  const alice = await env.create('alice', data), bob = await env.join();
  const read = await env.read('bob', bob.scope), old = clone(read.snapshot);
  delete old.data.mealPlans; delete old.deleted.mealPlans;
  assert.equal((await env.commit('bob', bob.scope, read.revision, old)).error.code, 'CLIENT_UPDATE_REQUIRED');
  assert.equal((await env.read('alice', alice.scope)).revision, read.revision);
  const cleared = clone(read.snapshot); cleared.data.mealPlans = [];
  // The server retains a deletion even if a client omitted its new tombstone.
  const removed = await env.commit('bob', bob.scope, read.revision, cleared);
  assert.deepEqual(removed.snapshot.data.mealPlans, []);
  assert.deepEqual(removed.snapshot.deleted.mealPlans.map(item => item.id), ['meal-2026-11-05-breakfast']);
  const next = clone(removed.snapshot); next.deleted.mealPlans = [];
  const saved = await env.commit('alice', alice.scope, removed.revision, next);
  assert.deepEqual(saved.snapshot.deleted.mealPlans, removed.snapshot.deleted.mealPlans);
  assert.equal((await env.commit('bob', bob.scope, saved.revision, old)).error.code, 'CLIENT_UPDATE_REQUIRED');
  assert.equal((await env.read('alice', alice.scope)).revision, saved.revision);
});
