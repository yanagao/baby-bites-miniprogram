'use strict';

const crypto = require('crypto');
const {reject, ownedFile} = require('./private-snapshot');
const {photoInfo, checkCooksnap} = require('./feedback-moderation');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const isId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const PAGE_SIZE = 20;
const ACTIONS = new Set(['recordSave', 'recipeFeedback', 'feedbackInbox', 'addCooksnap', 'deleteCooksnap']);
function offsetFor(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000) reject('分页位置不正确。', 'INVALID_REQUEST');
  return value;
}
function publicPhoto(fileID, env, profileId, id) {
  if (typeof fileID !== 'string' || fileID.length > 2000) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  const prefix = `social/${profileId}/cooksnaps/${id}/`;
  return Boolean(match && match[1] === env && match[3].startsWith(prefix) &&
    /^[A-Za-z0-9_-]{1,160}\.(?:jpg|png)$/.test(match[3].slice(prefix.length)));
}
function createFeedback({cloud, db, get, write, collection, profile, isPublished, profileIdFor,
  defaultProfileName, committedSnapshot, activeRecipe, assertCommitted, publicInventory, now, unique}) {
  async function visible(id, isBuiltin, database = db) {
    const recipe = await get('recipes', id, database);
    if (!recipe) return null;
    const author = await profile(recipe.profileId, database);
    return isPublished(recipe, author) && !await isBuiltin(recipe) ? recipe : null;
  }
  async function requireRecipe(id, isBuiltin, database = db) {
    if (!isId(id)) reject('菜谱信息不正确。', 'INVALID_REQUEST');
    const recipe = await visible(id, isBuiltin, database);
    if (!recipe) reject('这道菜谱已移除，或暂时无法查看。', 'NOT_FOUND');
    return recipe;
  }
  async function count(condition) {
    const result = await collection('feedback').where(condition).count();
    if (!result || !Number.isSafeInteger(result.total) || result.total < 0) throw Error('Invalid feedback count');
    return result.total;
  }
  function nextOffset(rows, offset) {
    return rows.length > PAGE_SIZE && offset + PAGE_SIZE <= 1000 ? offset + PAGE_SIZE : null;
  }
  async function renderCooksnap(record, {owner, env, isBuiltin}) {
    if (!record || record.type !== 'cooksnap' || record.active !== true || !isId(record.owner) ||
      !isId(record._id) || !await visible(record.recipeId, isBuiltin)) return null;
    const profileId = profileIdFor(record.owner);
    if (!publicPhoto(record.photoFileID, env, profileId, record._id)) reject('成品照暂时无法读取。', 'STORAGE_FAILED');
    const [actor, response] = await Promise.all([profile(profileId), cloud.getTempFileURL({fileList: [{fileID: record.photoFileID, maxAge: 300}]})]);
    const file = response && response.fileList && response.fileList[0];
    if (!file || file.fileID !== record.photoFileID || file.status != null && file.status !== 0 ||
      typeof file.tempFileURL !== 'string' || !/^https:\/\//.test(file.tempFileURL)) reject('成品照暂时无法读取。', 'STORAGE_FAILED');
    const current = await get('feedback', record._id);
    if (!current || current.active !== true || current.photoFileID !== record.photoFileID || !await visible(record.recipeId, isBuiltin)) return null;
    return {id: record._id, recipeId: record.recipeId, author: {id: profileId, name: actor ? actor.name : defaultProfileName(record.owner)},
      photoURL: file.tempFileURL, text: record.text, createdAt: record.createdAt, isSelf: record.owner === owner};
  }
  async function cleanup(fileID) {
    if (fileID && typeof cloud.deleteFile === 'function') {
      try { await cloud.deleteFile({fileList: [fileID]}); } catch (_) {}
    }
  }
  return async function handle(event, session) {
    const {owner, env, openid, isBuiltin} = session;
    if (event.action === 'recordSave') {
      const recipe = await requireRecipe(event.recipeId, isBuiltin);
      if (recipe.owner === owner) reject('这是你自己的菜谱。', 'SELF_FEEDBACK');
      if (typeof event.localRecipeId !== 'string' || event.localRecipeId.length > 100) reject('保存记录不正确。', 'INVALID_REQUEST');
      const {account, snapshot} = await committedSnapshot(owner, env, false, undefined, session.expectedScope);
      const local = activeRecipe(snapshot, event.localRecipeId);
      if (!local || !local.source || local.source.recipeId !== recipe._id || local.source.profileId !== recipe.profileId || await isBuiltin(local)) {
        reject('请先将这道菜谱保存并完成同步。', 'FEEDBACK_NOT_SAVED');
      }
      // Everyone in the family can read the copy. Only its server-stamped
      // creator can use it as proof of their own save.
      if (account.__scope.kind === 'family' && local.createdBy !== owner) return {recorded: false};
      const id = hash(`recipe-save:${owner}:${recipe._id}`);
      const recorded = await db.runTransaction(async transaction => {
        if (session.assertScope) await session.assertScope(transaction);
        await assertCommitted(transaction, owner, account);
        const current = await requireRecipe(recipe._id, isBuiltin, transaction);
        if (current.owner !== recipe.owner) reject('菜谱刚有变化，请重试。', 'CONFLICT');
        if (await get('feedback', id, transaction)) return false;
        await write('feedback', id, {type: 'save', owner, authorOwner: recipe.owner, recipeId: recipe._id,
          active: true, createdAt: now()}, transaction);
        return true;
      });
      return {recorded};
    }
    if (event.action === 'addCooksnap') {
      const recipe = await requireRecipe(event.recipeId, isBuiltin);
      if (recipe.owner === owner) reject('可以邀请其他家长来跟做你的菜谱。', 'SELF_FEEDBACK');
      if (typeof event.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(event.requestId) ||
        typeof event.text !== 'string' || !event.text.trim() || event.text.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(event.text)) {
        reject('请放上一张成品照，写下 1–120 字做后反馈。', 'INVALID_COOKSNAP');
      }
      if (!ownedFile(event.photoFileID, env, owner, 'photos')) reject('请重新选择自己的成品照。', 'INVALID_COOKSNAP_PHOTO');
      const downloaded = await cloud.downloadFile({fileID: event.photoFileID});
      if (!downloaded || downloaded.statusCode != null && downloaded.statusCode !== 200) reject('成品照暂时无法读取。', 'STORAGE_FAILED');
      const bytes = downloaded.fileContent, info = photoInfo(bytes), text = event.text.trim();
      const id = hash(`recipe-cooksnap:${owner}:${event.requestId}`);
      const fingerprint = hash(JSON.stringify({recipeId: recipe._id, text, photoHash: hash(bytes)}));
      const same = previous => {
        if (previous.owner !== owner || previous.fingerprint !== fingerprint || previous.active !== true) {
          reject('这次跟做已经变化，请重新确认后提交。', 'CONFLICT');
        }
        return previous;
      };
      const previous = await get('feedback', id);
      if (previous) {
        const cooksnap = await renderCooksnap(same(previous), session);
        if (!cooksnap) reject('这次跟做已移除。', 'NOT_FOUND');
        return {cooksnap};
      }
      await checkCooksnap(cloud, openid, text, bytes, info);
      const suffix = unique();
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(suffix)) throw Error('Invalid photo suffix');
      const profileId = profileIdFor(owner);
      const uploaded = await cloud.uploadFile({cloudPath: `social/${profileId}/cooksnaps/${id}/${suffix}.${info.type}`, fileContent: bytes});
      const photoFileID = uploaded && uploaded.fileID;
      if (!publicPhoto(photoFileID, env, profileId, id)) reject('成品照尚未保存，请重试。', 'STORAGE_FAILED');
      let written;
      try {
        written = await db.runTransaction(async transaction => {
          if (session.assertScope) await session.assertScope(transaction);
          const currentRecipe = await requireRecipe(recipe._id, isBuiltin, transaction);
          if (currentRecipe.owner !== recipe.owner || currentRecipe.generation !== recipe.generation) reject('菜谱刚有变化，请重新打开后分享跟做。', 'CONFLICT');
          const existing = await get('feedback', id, transaction);
          if (existing) return same(existing);
          const record = {type: 'cooksnap', owner, authorOwner: recipe.owner, recipeId: recipe._id,
            active: true, createdAt: now(), text, photoFileID, fingerprint};
          await write('feedback', id, record, transaction);
          return {_id: id, ...record};
        });
      } catch (error) {
        // Only explicit validation/transaction aborts prove the new photo is
        // unreferenced. An ambiguous network error may have committed.
        if (error && ['CONFLICT', 'NOT_FOUND', 'INVALID_ACCOUNT'].includes(error.code)) await cleanup(photoFileID);
        throw error;
      }
      if (written.photoFileID !== photoFileID) await cleanup(photoFileID);
      const cooksnap = await renderCooksnap(written, session);
      if (!cooksnap) reject('这道菜谱已移除，跟做暂时无法查看。', 'NOT_FOUND');
      return {cooksnap};
    }
    if (event.action === 'deleteCooksnap') {
      if (!isId(event.id)) reject('跟做信息不正确。', 'INVALID_REQUEST');
      const retiredPhoto = await db.runTransaction(async transaction => {
        if (session.assertScope) await session.assertScope(transaction);
        const previous = await get('feedback', event.id, transaction);
        if (!previous || previous.type !== 'cooksnap' || previous.owner !== owner) reject('这条跟做暂时无法删除。', 'NOT_FOUND');
        if (previous.active === true) {
          const {_id, ...record} = previous;
          await write('feedback', event.id, {...record, active: false, deletedAt: now()}, transaction);
        }
        return previous.photoFileID;
      });
      // The committed tombstone makes the copied photo unreferenced. A repeat
      // delete can retry cleanup, while old submissions cannot revive the row.
      if (publicPhoto(retiredPhoto, env, profileIdFor(owner), event.id)) await cleanup(retiredPhoto);
      return {deleted: true};
    }
    if (event.action === 'recipeFeedback') {
      const recipe = await requireRecipe(event.recipeId, isBuiltin);
      const offset = offsetFor(event.offset);
      const condition = {recipeId: recipe._id, active: true};
      const [saveCount, cooksnapCount, result] = await Promise.all([
        count({...condition, type: 'save'}), count({...condition, type: 'cooksnap'}),
        collection('feedback').where({...condition, type: 'cooksnap'}).orderBy('createdAt', 'desc').orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE + 1).get()
      ]);
      const cooksnapRows = await Promise.all(result.data.slice(0, PAGE_SIZE).map(item => renderCooksnap(item, session)));
      await requireRecipe(recipe._id, isBuiltin);
      return {saveCount, cooksnapCount, cooksnaps: cooksnapRows.filter(Boolean), nextOffset: nextOffset(result.data, offset)};
    }
    if (event.action === 'feedbackInbox') {
      const offset = offsetFor(event.offset), ownProfileId = profileIdFor(owner);
      const ownProfile = await profile(ownProfileId);
      if (!ownProfile) return {saveCount: 0, cooksnapCount: 0, items: [], nextOffset: null};
      const inventory = await publicInventory(ownProfileId);
      const allowed = new Set();
      for (const row of inventory.records) if (isPublished(row, ownProfile) && !await isBuiltin(row)) allowed.add(row._id);
      if (!allowed.size) return {saveCount: 0, cooksnapCount: 0, items: [], nextOffset: null};
      let saveCount = 0, cooksnapCount = 0;
      const ids = Array.from(allowed);
      // Bound each membership query and avoid one count query per recipe.
      for (let i = 0; i < ids.length; i += 20) {
        const condition = {authorOwner: owner, active: true, recipeId: db.command.in(ids.slice(i, i + 20))};
        const counts = await Promise.all([count({...condition, type: 'save'}), count({...condition, type: 'cooksnap'})]);
        saveCount += counts[0]; cooksnapCount += counts[1];
      }
      const result = await collection('feedback').where({authorOwner: owner, active: true})
        .orderBy('createdAt', 'desc').orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE + 1).get();
      const rows = await Promise.all(result.data.slice(0, PAGE_SIZE).map(async record => {
        if (!allowed.has(record.recipeId)) return null;
        const recipe = await visible(record.recipeId, isBuiltin);
        if (!recipe || recipe.owner !== owner) return null;
        const base = {id: record._id, type: record.type, recipeId: recipe._id, recipeName: recipe.name, createdAt: record.createdAt};
        if (record.type === 'save') return {...base, photoURL: '', text: ''};
        const snap = await renderCooksnap(record, session);
        return snap ? {...base, actorName: snap.author.name, photoURL: snap.photoURL, text: snap.text} : null;
      }));
      return {saveCount, cooksnapCount, items: rows.filter(Boolean), nextOffset: nextOffset(result.data, offset)};
    }
  };
}
module.exports = {ACTIONS, createFeedback};
