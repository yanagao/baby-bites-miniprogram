'use strict';

const crypto = require('crypto');
const COLLECTIONS = {families: 'baby_bites_families', memberships: 'baby_bites_family_memberships', invites: 'baby_bites_family_invites'};
const ACTIONS = new Set(['familyState', 'familyCreate', 'familyInvite', 'familyPreview', 'familyJoin', 'familyRole', 'familyRemove', 'familyTransfer', 'familyLeave', 'familyRead', 'familyPhotos']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id32 = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const personalScope = owner => ({kind: 'personal', id: owner});
const scopeKey = scope => scope && scope.kind === 'family' ? 'family:' + scope.id : 'personal';
const sameScope = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id && (a.kind !== 'family' || a.membershipId === b.membershipId));
function familyFile(fileID, env, familyId, kind) {
  const match = typeof fileID === 'string' && /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  const prefix = `families/${familyId}/${kind}/`;
  if (!match || match[1] !== env || !id64(familyId) || !match[3].startsWith(prefix)) return false;
  return (kind === 'snapshots' ? /^[A-Za-z0-9_-]{1,160}\.json$/ : /^[A-Za-z0-9_-]{1,160}\.(?:jpg|png|webp)$/).test(match[3].slice(prefix.length));
}
function createFamily({cloud, db, now = Date.now, random = size => crypto.randomBytes(size), validateSnapshot, ownedFile, reject}) {
  const get = async (name, id, database = db) => (await database.collection(COLLECTIONS[name] || name).doc(id).get()).data;
  const put = (name, id, data, database = db) => database.collection(COLLECTIONS[name] || name).doc(id).set({data});
  const clean = value => { const {_id, ...rest} = value; return rest; };
  const changed = () => reject('家庭已发生变化，请重新同步后再操作。', 'FAMILY_CHANGED');
  function validFamily(record, env) {
    if (!record || !id64(record._id) || record.closed || !text(record.name, 30) || !Array.isArray(record.members) || !record.members.length || record.members.length > 20 ||
      !record.members.every(member => member && id64(member.owner) && id32(member.id) && id32(member.membershipId) && text(member.label, 20)) ||
      new Set(record.members.map(member => member.owner)).size !== record.members.length ||
      new Set(record.members.map(member => member.id)).size !== record.members.length || !record.members.some(member => member.owner === record.managerOwner) ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 || !familyFile(record.fileID, env, record._id, 'snapshots')) {
      reject('家庭资料暂时无法读取，请稍后重试。', 'INVALID_FAMILY');
    }
    return record;
  }
  function needsRecorderCheck(family) {
    // Families created by V1 cleared all imported recorder claims at creation.
    // Families migrated by V1 retain the original, potentially tainted snapshot.
    return family.legacyRecordersChecked !== true && (!family.attributionV1Revision || Boolean(family.originalAttributionFileID));
  }
  function needsUpgrade(family) {
    return family.attributionV1Revision !== family.revision || needsRecorderCheck(family);
  }
  async function resolve(owner, env, database = db) {
    const membership = await get('memberships', owner, database);
    if (!membership || membership.active === false) return {scope: personalScope(owner), family: null, member: null};
    if (!id64(membership.familyId) || !id32(membership.membershipId)) reject('家庭成员资料无效。', 'INVALID_FAMILY');
    const family = validFamily(await get('families', membership.familyId, database), env);
    const member = family.members.find(item => item.owner === owner && item.membershipId === membership.membershipId);
    if (!member) changed();
    const state = {scope: {kind: 'family', id: family._id, membershipId: member.membershipId}, family, member};
    // Old function instances may spread unknown fields into a later revision.
    // Bind the schema marker to this exact snapshot, not just the family.
    if (database === db && needsUpgrade(family)) return upgradeAttribution(state, env);
    return state;
  }
  function expect(event, state, protocolRequired = true) {
    if ((state.family || protocolRequired) && event.protocolVersion !== 2) reject('请更新小程序后使用家庭共享，已有数据已保留。', 'CLIENT_UPDATE_REQUIRED');
    if (event.expectedScope !== undefined && !sameScope(event.expectedScope, state.scope)) changed();
    if (state.family && event.expectedScope === undefined && event.action !== 'identity' && event.action !== 'familyState') changed();
  }
  function view(owner, state) {
    const family = state.family;
    return {owner, scope: state.scope, family: !family ? null : {id: family._id, name: family.name,
      isManager: family.managerOwner === owner, memberId: state.member.id, membershipId: state.member.membershipId,
      memberCount: family.members.length, members: family.members.map(member => ({id: member.id, label: member.label,
        isManager: member.owner === family.managerOwner, isSelf: member.owner === owner}))}};
  }
  function result(owner, state) { return {owner, scope: state.scope, revision: state.family.revision, fileID: state.family.fileID}; }
  async function current(owner, env, expectedScope, database = db) {
    const state = await resolve(owner, env, database);
    if (!sameScope(state.scope, expectedScope)) changed();
    return state;
  }
  async function snapshot(state, env) {
    const downloaded = await cloud.downloadFile({fileID: state.family.fileID});
    if (!downloaded || downloaded.statusCode != null && downloaded.statusCode !== 200) reject('家庭数据暂时无法读取。', 'STORAGE_FAILED');
    return validateSnapshot(downloaded.fileContent, {env, owner: state.member.owner, now: now(), familyTombstones: true,
      photoAllowed: id => familyFile(id, env, state.family._id, 'photos')});
  }
  async function verifyLegacyAuthors(state, data) {
    const {family} = state;
    const candidates = new Map();
    for (const recipe of data.data.recipes) {
      if (family.revision === 1 && id64(family.createdBy)) recipe.createdBy = family.createdBy;
      else if (recipe.createdBy && recipe.createdBy !== family.createdBy) {
        if (!recipe.source) candidates.set(hash(`public-recipe:${recipe.createdBy}:${recipe.id}`), recipe);
        delete recipe.createdBy;
      }
    }
    // A publication first generated by the vulnerable family code cannot
    // attest to itself. Only a personal publication predating this family and
    // already associated with it independently corroborates authorship.
    const ids = [...candidates.keys()];
    for (let offset = 0; offset < ids.length; offset += 20) {
      const {data: rows} = await db.collection('baby_bites_public_recipes').where({_id: db.command.in(ids.slice(offset, offset + 20))})
        .field({_id: true, owner: true, profileId: true, sourceRecipeId: true, publicationScope: true, publishedAt: true}).limit(20).get();
      for (const row of rows) {
        const recipe = candidates.get(row._id);
        if (recipe && id64(row.owner) && recipe.id === row.sourceRecipeId && hash(`public-recipe:${row.owner}:${recipe.id}`) === row._id &&
          row.profileId === hash(`public-profile:${row.owner}`).slice(0, 32) && row.publicationScope === scopeKey(state.scope) &&
          Number.isSafeInteger(row.publishedAt) && row.publishedAt > 0 && row.publishedAt < family.createdAt) recipe.createdBy = row.owner;
      }
    }
  }
  async function verifyLegacyRecorders(state, data, env) {
    const {family} = state;
    // Family member IDs are random and minted after the personal backup was
    // sealed. Later commits stamped new logs on the server. A nickname alone
    // cannot establish membership, and a renamed member's current label does
    // not attest to a different label in a legacy backup.
    const labels = new Map(family.members.map(member => [member.id, member.label]));
    const unverified = data.data.logs.concat(data.deleted.logs).filter(({recordedBy}) =>
      recordedBy && (family.revision === 1 || labels.get(recordedBy.memberId) !== recordedBy.label));
    if (!unverified.length) return;
    let originalClaims;
    const claimKey = ({id, recordedBy}) => JSON.stringify([id, recordedBy.memberId, recordedBy.label]);
    if (familyFile(family.originalAttributionFileID, env, family._id, 'snapshots')) {
      // V1 only allowed a legacy claim to survive unchanged. A recorder absent
      // from the pre-migration file was assigned by subsequent server commits,
      // and remains valid even if the member has since changed roles or left.
      const original = await snapshot({...state, family: {...family, fileID: family.originalAttributionFileID}}, env);
      originalClaims = new Set(original.data.logs.concat(original.deleted.logs).filter(log => log.recordedBy).map(claimKey));
    }
    for (const log of unverified) {
      if (!originalClaims || originalClaims.has(claimKey(log))) delete log.recordedBy;
    }
  }
  async function upgradeAttribution(state, env) {
    const {family, member} = state, data = await snapshot(state, env);
    if (family.attributionV1Revision !== family.revision) await verifyLegacyAuthors(state, data);
    if (needsRecorderCheck(family)) await verifyLegacyRecorders(state, data, env);
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > 5 * 1024 * 1024) reject('家庭数据超过 5 MB，请先整理记录。', 'INVALID_SNAPSHOT');
    const fileID = await upload(bytes, family._id, 'snapshots', 'json', env);
    let migrated;
    try {
      migrated = await db.runTransaction(async transaction => {
        const latest = await current(member.owner, env, state.scope, transaction);
        if (!needsUpgrade(latest.family)) return latest;
        if (latest.family.revision !== family.revision || latest.family.fileID !== family.fileID) reject('家人刚更新了记录，请同步后重试。', 'FAMILY_CONFLICT');
        const revision = family.revision + 1;
        const updated = {...latest.family, revision, fileID, attributionV1Revision: revision, legacyRecordersChecked: true, updatedAt: now(),
          originalAttributionFileID: latest.family.originalAttributionFileID || family.fileID};
        await put('families', family._id, clean(updated), transaction);
        return {...latest, family: updated};
      });
    } catch (error) {
      if (['FAMILY_CONFLICT', 'FAMILY_CHANGED', 'INVALID_FAMILY'].includes(error.code)) await cleanup([fileID]);
      throw error;
    }
    if (migrated.family.fileID !== fileID) await cleanup([fileID]);
    return migrated;
  }
  async function assertCurrent(owner, env, state, database = db, revision = true) {
    const latest = await current(owner, env, state.scope, database);
    if (revision && (latest.family.revision !== state.family.revision || latest.family.fileID !== state.family.fileID)) reject('家人刚更新了记录，请同步后重试。', 'FAMILY_CONFLICT');
    return latest;
  }
  async function checkPublicationsBeforeClose(state, env) {
    const condition = {publicationScope: scopeKey(state.scope), published: true};
    let authors;
    for (;;) {
      const {data: rows} = await db.collection('baby_bites_public_recipes').where(condition)
        .orderBy('_id', 'asc').field({_id: true, owner: true, sourceRecipeId: true}).limit(1000).get();
      if (!rows.length) return;
      if (!authors) {
        const data = await snapshot(state, env);
        const deleted = new Map(data.deleted.recipes.map(item => [item.id, item.updatedAt]));
        const active = data.data.recipes.filter(recipe => !recipe.source && !recipe.isExample &&
          !(deleted.get(recipe.id) >= (recipe.updatedAt || recipe.createdAt || 0)));
        authors = new Map(active.map(recipe => [recipe.id, recipe.createdBy]));
      }
      if (rows.some(row => !authors.has(row.sourceRecipeId) || authors.get(row.sourceRecipeId) !== row.owner)) {
        reject('已删除的公开菜谱尚未撤回，请稍后重试退出家庭。', 'PUBLICATION_PENDING');
      }
      if (rows.length < 1000) return;
      condition._id = db.command.gt(rows[rows.length - 1]._id);
    }
  }
  async function sign(fileIDs) {
    const photoURLs = {};
    for (let i = 0; i < fileIDs.length; i += 20) {
      const ids = fileIDs.slice(i, i + 20);
      const response = await cloud.getTempFileURL({fileList: ids.map(fileID => ({fileID, maxAge: 300}))});
      for (const id of ids) {
        const file = response && response.fileList && response.fileList.find(item => item.fileID === id);
        if (!file || file.status != null && file.status !== 0 || typeof file.tempFileURL !== 'string' || !/^https:\/\//.test(file.tempFileURL)) reject('家庭照片暂时无法读取。', 'STORAGE_FAILED');
        photoURLs[id] = file.tempFileURL;
      }
    }
    return photoURLs;
  }
  async function snapshotPayload(data, state) {
    // Mini-program callFunction responses have a 1 MiB limit. Keep room for
    // metadata and the first photo batch; larger (at most 5 MiB) snapshots use
    // a separately signed download of this exact canonical revision.
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= 512 * 1024) return {snapshot: data};
    const urls = await sign([state.family.fileID]);
    return {snapshotURL: urls[state.family.fileID]};
  }
  async function upload(bytes, familyId, kind, extension, env) {
    const name = random(16).toString('hex');
    const response = await cloud.uploadFile({cloudPath: `families/${familyId}/${kind}/${name}.${extension}`, fileContent: bytes});
    if (!response || !familyFile(response.fileID, env, familyId, kind)) reject('家庭文件尚未保存，请重试。', 'STORAGE_FAILED');
    return response.fileID;
  }
  function imageType(bytes) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024) reject('家庭照片为空或超过 2 MB。', 'INVALID_FILE');
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    reject('家庭照片格式不正确。', 'INVALID_FILE');
  }
  async function canonical(input, familyId, env, newFiles) {
    const data = clone(input), copied = new Map();
    const photos = [...new Set(data.data.recipes.map(recipe => recipe.photo).filter(id => id && !familyFile(id, env, familyId, 'photos')))];
    for (let start = 0; start < photos.length; start += 5) {
      await Promise.all(photos.slice(start, start + 5).map(async id => {
        const download = await cloud.downloadFile({fileID: id});
        if (!download || download.statusCode != null && download.statusCode !== 200) reject('家庭照片暂时无法读取。', 'STORAGE_FAILED');
        const file = await upload(download.fileContent, familyId, 'photos', imageType(download.fileContent), env);
        copied.set(id, file); newFiles.push(file);
      }));
    }
    data.data.recipes.forEach(recipe => { if (copied.has(recipe.photo)) recipe.photo = copied.get(recipe.photo); });
    const bytes = Buffer.from(JSON.stringify(data));
    if (bytes.length > 5 * 1024 * 1024) reject('家庭数据超过 5 MB，请先整理记录。', 'INVALID_SNAPSHOT');
    const fileID = await upload(bytes, familyId, 'snapshots', 'json', env); newFiles.push(fileID);
    return {snapshot: data, fileID};
  }
  async function cleanup(files) { if (files.length && typeof cloud.deleteFile === 'function') { try { await cloud.deleteFile({fileList: files}); } catch (_) {} } }
  function protectedFields(previous, incoming) {
    if (previous.mealPlans !== undefined && incoming.mealPlans === undefined) reject('请更新小程序后同步，家庭餐单和用餐记录已保留。', 'CLIENT_UPDATE_REQUIRED');
    for (const [field, time] of [['allergies', 'allergiesUpdatedAt'], ['babyBirthDate', 'babyBirthDateUpdatedAt']]) {
      if (previous[field] !== undefined && incoming[field] === undefined) reject('请更新小程序后同步，宝宝资料已保留。', 'CLIENT_UPDATE_REQUIRED');
      if (previous[time] !== undefined && incoming[time] < previous[time]) reject('家人刚更新了宝宝资料，请同步后重试。', 'FAMILY_CONFLICT');
    }
  }
  // Only the previous, server-written snapshot can attest to the identity of
  // a deleted item. Clients (including older versions) only need to send IDs
  // and times; they cannot erase history or supply an author by editing it.
  function keepDeletionHistory(previous, incoming, kind, fields) {
    const history = new Map((previous.deleted[kind] || []).map(item => [item.id, item]));
    const tombstones = new Map(history);
    for (const {id, updatedAt} of incoming.deleted[kind] || []) {
      const old = tombstones.get(id);
      if (!old || updatedAt > old.updatedAt) tombstones.set(id, {...old, id, updatedAt});
    }
    const live = new Set(incoming.data[kind].map(item => item.id));
    for (const item of previous.data[kind] || []) {
      if (live.has(item.id)) continue;
      const old = tombstones.get(item.id);
      const tombstone = {id: item.id, updatedAt: Math.max(old ? old.updatedAt : now(), item.updatedAt || item.createdAt || 0)};
      for (const field of fields) if (item[field] !== undefined) tombstone[field] = item[field];
      tombstones.set(item.id, tombstone);
    }
    if (tombstones.size > (kind === 'recipes' ? 10000 : kind === 'mealPlans' ? 30000 : 100000)) reject('删除记录超过同步限制。', 'INVALID_SNAPSHOT');
    incoming.deleted[kind] = [...tombstones.values()];
    return history;
  }
  function retainSource(recipe, authoritative) {
    if (!authoritative.source) delete recipe.source;
    else if (!recipe.source || recipe.source.recipeId !== authoritative.source.recipeId ||
      recipe.source.profileId !== authoritative.source.profileId) recipe.source = authoritative.source;
  }
  async function commit(event, owner, env, state) {
    expect(event, state);
    if (!ownedFile(event.fileID, env, owner, 'snapshots')) reject('同步暂存文件不属于当前微信账号。', 'INVALID_FILE');
    if (!Number.isSafeInteger(event.baseRevision) || event.baseRevision < 0) reject('同步版本不正确。', 'INVALID_REQUEST');
    if (event.baseRevision !== state.family.revision) return {...result(owner, state), conflict: true};
    const previous = await snapshot(state, env);
    const allowed = new Set(previous.data.recipes.map(recipe => recipe.photo).filter(Boolean));
    const downloaded = await cloud.downloadFile({fileID: event.fileID});
    if (!downloaded || downloaded.statusCode != null && downloaded.statusCode !== 200) reject('同步暂存文件暂时无法读取。', 'STORAGE_FAILED');
    const incoming = validateSnapshot(downloaded.fileContent, {env, owner, now: now(), familyTombstones: true, photoAllowed: id =>
      ownedFile(id, env, owner, 'photos') || familyFile(id, env, state.family._id, 'photos') && allowed.has(id)});
    protectedFields(previous.data, incoming.data);
    if (incoming.data.mealPlans !== undefined) keepDeletionHistory(previous, incoming, 'mealPlans', []);
    const deletedRecipes = keepDeletionHistory(previous, incoming, 'recipes', ['createdBy', 'source']);
    const oldRecipes = new Map(previous.data.recipes.map(recipe => [recipe.id, recipe]));
    incoming.data.recipes.forEach(recipe => {
      const existing = oldRecipes.get(recipe.id);
      const deleted = deletedRecipes.get(recipe.id);
      // A fresh save of a previously removed shared copy uses the same stable
      // ID. Unlike restoring its backup it has no creator and has a source URL.
      const newSave = !existing && !recipe.createdBy && recipe.source && recipe.id === 'shared-' + recipe.source.recipeId &&
        (!deleted || !deleted.createdBy || deleted.source && deleted.source.recipeId === recipe.source.recipeId && deleted.source.profileId === recipe.source.profileId);
      if (existing && existing.createdBy && recipe.createdBy && recipe.createdBy !== existing.createdBy) reject('菜谱作者不能修改。', 'INVALID_SNAPSHOT');
      const prior = existing || (!newSave && deleted);
      if (prior) {
        if (prior.createdBy) recipe.createdBy = prior.createdBy;
        else delete recipe.createdBy;
        if (existing || prior.createdBy || prior.source) retainSource(recipe, prior);
      } else if (!recipe.createdBy || recipe.createdBy === owner) recipe.createdBy = owner;
      else delete recipe.createdBy; // Imported item with no verifiable family author.
    });
    const deletedLogs = keepDeletionHistory(previous, incoming, 'logs', ['recordedBy']);
    const oldLogs = new Map(previous.data.logs.map(log => [log.id, log]));
    incoming.data.logs.forEach(log => {
      const existing = oldLogs.get(log.id);
      const prior = existing || deletedLogs.get(log.id);
      if (existing && existing.recordedBy && log.recordedBy && (log.recordedBy.memberId !== existing.recordedBy.memberId ||
        log.recordedBy.label !== existing.recordedBy.label)) reject('历史记录人不能修改。', 'INVALID_SNAPSHOT');
      if (prior && prior.recordedBy) log.recordedBy = prior.recordedBy;
      else if (prior || log.recordedBy) delete log.recordedBy;
      else log.recordedBy = {memberId: state.member.id, label: state.member.label};
    });
    const files = [];
    let prepared;
    try { prepared = await canonical(incoming, state.family._id, env, files); }
    catch (error) { await cleanup(files); throw error; }
    let committed;
    try {
      committed = await db.runTransaction(async transaction => {
        const latest = await current(owner, env, state.scope, transaction);
        if (latest.family.revision !== event.baseRevision) return {...result(owner, latest), conflict: true};
        const revision = latest.family.revision + 1;
        const data = {...clean(latest.family), revision, attributionV1Revision: revision, fileID: prepared.fileID, updatedAt: now()};
        await put('families', state.family._id, data, transaction);
        return {owner, scope: state.scope, revision: data.revision, fileID: data.fileID};
      });
    } catch (error) {
      if (['FAMILY_CHANGED', 'INVALID_FAMILY', 'CLIENT_UPDATE_REQUIRED'].includes(error.code)) await cleanup(files);
      throw error;
    }
    if (committed.conflict) { await cleanup(files); return committed; }
    // The canonical snapshot may stamp author/record metadata and new photo IDs.
    const committedState = {...state, family: {...state.family, revision: committed.revision, fileID: committed.fileID}};
    await assertCurrent(owner, env, committedState);
    const payload = await snapshotPayload(prepared.snapshot, committedState);
    const photoURLs = await sign([...new Set(prepared.snapshot.data.recipes.map(recipe => recipe.photo).filter(Boolean))].slice(0, 20));
    await assertCurrent(owner, env, committedState);
    return {...committed, ...payload, photoURLs};
  }
  async function handle(event, owner, env) {
    const state = await resolve(owner, env);
    if (event.action === 'familyState') { expect(event, state); return view(owner, state); }
    if (event.action === 'familyPreview') {
      expect(event, state);
      if (typeof event.token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(event.token)) reject('邀请已失效，请家人重新邀请。', 'INVITE_INVALID');
      const invitation = await get('invites', hash(event.token));
      if (!invitation || invitation.revoked || invitation.usedBy || invitation.expiresAt <= now()) reject('邀请已失效，请家人重新邀请。', 'INVITE_INVALID');
      const family = validFamily(await get('families', invitation.familyId), env);
      if (family.inviteId !== hash(event.token)) reject('邀请已更新，请使用新邀请。', 'INVITE_INVALID');
      const member = family.members.find(item => item.owner === family.managerOwner);
      const data = await snapshot({family, member}, env);
      const latest = validFamily(await get('families', family._id), env);
      const refreshed = await get('invites', hash(event.token));
      if (latest.inviteId !== hash(event.token) || !refreshed || refreshed.usedBy || refreshed.expiresAt <= now()) reject('邀请已失效。', 'INVITE_INVALID');
      return {owner, scope: state.scope, name: family.name, nickname: data.data.nickname, memberCount: family.members.length, expiresAt: invitation.expiresAt};
    }
    if (event.action === 'familyCreate' || event.action === 'familyJoin') {
      if (!text(event.roleLabel, 20) || typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(event.requestId)) reject('请填写家庭称谓后重试。', 'INVALID_REQUEST');
      if (event.action === 'familyCreate') {
        const id = hash(`family:${owner}:${event.requestId}`);
        if (state.family && state.family._id === id && state.family.createdBy === owner) return view(owner, state);
        expect(event, state);
        if (state.family) reject('请先退出当前家庭。', 'ALREADY_IN_FAMILY');
        if (!text(event.name, 30)) reject('家庭名称请填写 1–30 字。', 'INVALID_REQUEST');
        const account = await get('baby_bites_accounts', owner);
        if (account ? !Number.isSafeInteger(account.revision) || account.revision !== event.baseRevision || !ownedFile(account.fileID, env, owner, 'snapshots') : event.baseRevision !== 0) reject('请先同步自己的数据，再创建家庭。', 'SYNC_REQUIRED');
        const download = account ? await cloud.downloadFile({fileID: account.fileID}) : null;
        const data = download ? validateSnapshot(download.fileContent, {env, owner, now: now()}) :
          {version: 1, data: {version: 1, nickname: '宝宝', profileUpdatedAt: 0, recipes: [], logs: []}, deleted: {recipes: [], logs: []}};
        // Personal backups are editable. Only this authenticated account is
        // known to have supplied the recipes; no family recorders exist yet.
        data.data.recipes.forEach(recipe => { recipe.createdBy = owner; });
        data.data.logs.forEach(log => { delete log.recordedBy; });
        if (data.data.babyBirthDate === undefined) {
          const profile = await get('baby_bites_profiles', hash(`public-profile:${owner}`).slice(0, 32));
          if (profile && profile.owner === owner && typeof profile.babyBirthDate === 'string') {
            const candidate = clone(data); candidate.data.babyBirthDate = profile.babyBirthDate; candidate.data.babyBirthDateUpdatedAt = now();
            try { validateSnapshot(Buffer.from(JSON.stringify(candidate)), {env, owner, now: now()}); Object.assign(data.data, {babyBirthDate: candidate.data.babyBirthDate, babyBirthDateUpdatedAt: candidate.data.babyBirthDateUpdatedAt}); } catch (_) {}
          }
        }
        const files = []; let prepared;
        try { prepared = await canonical(data, id, env, files); } catch (error) { await cleanup(files); throw error; }
        let created;
        try {
          created = await db.runTransaction(async transaction => {
            const latest = await resolve(owner, env, transaction);
            if (latest.family) { if (latest.family._id === id) return false; reject('你已经加入另一个家庭。', 'ALREADY_IN_FAMILY'); }
            const currentAccount = await get('baby_bites_accounts', owner, transaction);
            if (account ? !currentAccount || currentAccount.revision !== account.revision || currentAccount.fileID !== account.fileID : currentAccount) reject('个人数据刚有变化，请同步后重新创建家庭。', 'FAMILY_CONFLICT');
            if (await get('families', id, transaction)) reject('这次创建已失效，请重新创建。', 'FAMILY_CHANGED');
            const member = {owner, id: random(16).toString('hex'), membershipId: random(16).toString('hex'), label: event.roleLabel.trim(), joinedAt: now()};
            await put('families', id, {name: event.name.trim(), createdBy: owner, managerOwner: owner, members: [member], revision: 1,
              attributionV1Revision: 1, fileID: prepared.fileID, createdAt: now(), updatedAt: now()}, transaction);
            await put('memberships', owner, {familyId: id, membershipId: member.membershipId, active: true}, transaction);
            return true;
          });
        } catch (error) { if (['ALREADY_IN_FAMILY', 'FAMILY_CONFLICT', 'FAMILY_CHANGED'].includes(error.code)) await cleanup(files); throw error; }
        if (!created) await cleanup(files);
        return view(owner, await resolve(owner, env));
      }
      if (typeof event.token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(event.token)) reject('邀请已失效。', 'INVITE_INVALID');
      const inviteId = hash(event.token), invitation = await get('invites', inviteId);
      if (invitation && invitation.usedBy === owner && invitation.usedRequestId === event.requestId && state.family && state.family._id === invitation.familyId && state.member.membershipId === invitation.usedMembershipId) return view(owner, state);
      expect(event, state);
      if (state.family) reject('请先退出当前家庭。', 'ALREADY_IN_FAMILY');
      await db.runTransaction(async transaction => {
        const latest = await resolve(owner, env, transaction);
        const invite = await get('invites', inviteId, transaction);
        if (latest.family) {
          if (invite && invite.usedBy === owner && invite.usedRequestId === event.requestId && latest.family._id === invite.familyId && latest.member.membershipId === invite.usedMembershipId) return;
          reject('你已经加入一个家庭。', 'ALREADY_IN_FAMILY');
        }
        if (!invite || invite.revoked || invite.usedBy || invite.expiresAt <= now()) reject('邀请已失效，请家人重新邀请。', 'INVITE_INVALID');
        const family = validFamily(await get('families', invite.familyId, transaction), env);
        if (family.inviteId !== inviteId) reject('邀请已更新，请使用新邀请。', 'INVITE_INVALID');
        if (family.members.length >= 20) reject('家庭成员已达到 20 人。', 'FAMILY_MEMBER_LIMIT');
        const member = {owner, id: random(16).toString('hex'), membershipId: random(16).toString('hex'), label: event.roleLabel.trim(), joinedAt: now()};
        await put('families', family._id, {...clean(family), members: family.members.concat(member), inviteId: '', updatedAt: now()}, transaction);
        await put('memberships', owner, {familyId: family._id, membershipId: member.membershipId, active: true}, transaction);
        await put('invites', inviteId, {...clean(invite), usedBy: owner, usedRequestId: event.requestId, usedMembershipId: member.membershipId, usedAt: now()}, transaction);
      });
      return view(owner, await resolve(owner, env));
    }
    expect(event, state);
    if (!state.family) reject('请先创建或加入一个家庭。', 'FAMILY_REQUIRED');
    if (event.action === 'familyRead' || event.action === 'familyPhotos') {
      const data = await snapshot(state, env);
      const all = [...new Set(data.data.recipes.map(recipe => recipe.photo).filter(Boolean))];
      // Return the first visible batch; the client requests remaining referenced
      // images on demand through familyPhotos, avoiding megabytes of signed URLs.
      let ids = all.slice(0, 20);
      if (event.action === 'familyPhotos') {
        if (!Array.isArray(event.fileIDs) || event.fileIDs.length > 20 || !event.fileIDs.every(id => all.includes(id))) reject('只能读取当前家庭菜谱中使用的照片。', 'INVALID_FILE');
        ids = [...new Set(event.fileIDs)];
      }
      const payload = event.action === 'familyRead' ? await snapshotPayload(data, state) : null;
      const photoURLs = await sign(ids); await assertCurrent(owner, env, state);
      return event.action === 'familyPhotos' ? {owner, scope: state.scope, photoURLs} : {...result(owner, state), ...payload, photoURLs};
    }
    if (event.action === 'familyInvite') {
      const token = random(16).toString('base64url'), inviteId = hash(token), expiresAt = now() + 24 * 60 * 60 * 1000;
      await db.runTransaction(async transaction => {
        const latest = await current(owner, env, state.scope, transaction);
        if (latest.family.managerOwner !== owner) reject('只有家庭管理员可以邀请家人。', 'FAMILY_FORBIDDEN');
        await put('families', state.family._id, {...clean(latest.family), inviteId, updatedAt: now()}, transaction);
        await put('invites', inviteId, {familyId: state.family._id, expiresAt, createdAt: now(), createdBy: owner}, transaction);
      });
      return {owner, scope: state.scope, token, expiresAt};
    }
    const closing = event.action === 'familyLeave' && state.family.members.length === 1;
    if (closing) await checkPublicationsBeforeClose(state, env);
    await db.runTransaction(async transaction => {
      const latest = await current(owner, env, state.scope, transaction), family = latest.family;
      if (event.action === 'familyRole') {
        if (!text(event.roleLabel, 20)) reject('称谓请填写 1–20 字。', 'INVALID_REQUEST');
        const members = family.members.map(member => member.owner === owner ? {...member, label: event.roleLabel.trim()} : member);
        await put('families', family._id, {...clean(family), members, updatedAt: now()}, transaction); return;
      }
      if (event.action === 'familyLeave') {
        if (family.managerOwner === owner && family.members.length > 1) reject('请先将管理员转让给家人，再退出家庭。', 'FAMILY_TRANSFER_REQUIRED');
        // Another member may have left or committed a deletion since preflight.
        if (family.members.length === 1 && (!closing || family.revision !== state.family.revision || family.fileID !== state.family.fileID)) {
          reject('家庭记录刚有变化，请重试退出家庭。', 'FAMILY_CONFLICT');
        }
        await put('memberships', owner, {active: false, previousFamilyId: family._id, updatedAt: now()}, transaction);
        const members = family.members.filter(member => member.owner !== owner);
        await put('families', family._id, {...clean(family), members, inviteId: '', closed: members.length === 0, updatedAt: now()}, transaction); return;
      }
      if (family.managerOwner !== owner) reject('只有家庭管理员可以管理成员。', 'FAMILY_FORBIDDEN');
      const target = family.members.find(member => member.id === event.memberId && member.owner !== owner);
      if (!target) reject('请选择另一位家庭成员。', 'INVALID_REQUEST');
      if (event.action === 'familyTransfer') {
        await put('families', family._id, {...clean(family), managerOwner: target.owner, inviteId: '', updatedAt: now()}, transaction); return;
      }
      if (event.action === 'familyRemove') {
        await put('memberships', target.owner, {active: false, previousFamilyId: family._id, updatedAt: now()}, transaction);
        await put('families', family._id, {...clean(family), members: family.members.filter(member => member.id !== target.id), updatedAt: now()}, transaction); return;
      }
      reject('不支持的家庭操作。', 'INVALID_REQUEST');
    });
    return view(owner, await resolve(owner, env));
  }
  return {resolve, expect, view, result, current, snapshot, assertCurrent, commit, handle, protectedFields};
}
module.exports = {COLLECTIONS, ACTIONS, createFamily, familyFile, personalScope, scopeKey, sameScope};
