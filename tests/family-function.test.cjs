'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
test('concurrent family commits use one revision and stale writers receive current scope without overwriting',async()=>{
  const env=environment(),a=await env.create(),b=await env.join(),read=await env.read('alice',a.scope),one=clone(read.snapshot),two=clone(read.snapshot);one.data.recipes[0].name='甲';two.data.recipes[0].name='乙';
  const results=await Promise.all([env.commit('alice',a.scope,read.revision,one),env.commit('bob',b.scope,read.revision,two)]);assert.equal(results.filter(x=>x.conflict).length,1);assert.equal(results.filter(x=>x.snapshot).length,1);assert.equal((await env.read('alice',a.scope)).revision,2);
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
  assert.deepEqual(await env.socialCall('bob','recordSave',b.scope,{recipeId:published.recipe.id,localRecipeId:'copy'}),{recorded:true});assert.deepEqual(await env.socialCall('bob','recordSave',b.scope,{recipeId:published.recipe.id,localRecipeId:'copy'}),{recorded:false});assert.equal([...env.tables.get(COLLECTIONS.feedback).values()][0].owner,ownerFor('bob'));
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
