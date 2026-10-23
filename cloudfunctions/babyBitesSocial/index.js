'use strict';

const crypto = require('crypto');
const {ownedFile, validateSnapshot, reject} = require('./private-snapshot');
const COLLECTIONS = {
  accounts: 'baby_bites_accounts', profiles: 'baby_bites_profiles',
  recipes: 'baby_bites_public_recipes', follows: 'baby_bites_follows'
};
const PAGE_SIZE = 20;
const MAX_FOLLOWS = 200;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TTL = 300;
const MAX_PAGE_BYTES = 800 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const profileIdFor = owner => hash(`public-profile:${owner}`).slice(0, 32);
const recipeIdFor = (owner, sourceId) => hash(`public-recipe:${owner}:${sourceId}`);
const isProfileId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const isRecipeId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max, empty = false) => typeof value === 'string' && value.length <= max &&
  (empty || Boolean(value.trim())) && !/[\u0000-\u001f\u007f]/.test(value);

function pageOffset(value) {
  const offset = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000) reject('分页位置不正确。', 'INVALID_REQUEST');
  return offset;
}

function sourceId(value) {
  if (!safeText(value, 100)) reject('请选择有效的个人菜谱。', 'INVALID_REQUEST');
  return value;
}

function publicProfile(record) {
  return {id: record._id, name: record.name, bio: record.bio || '', exists: true};
}

function photoExtension(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PHOTO_BYTES) {
    reject('照片为空或超过 2 MB，请更换照片后重新公开。', 'INVALID_PHOTO');
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  reject('照片格式暂不支持，请使用 JPG、PNG 或 WebP。', 'INVALID_PHOTO');
}

function socialPhoto(fileID, env, profileId, recipeId) {
  if (typeof fileID !== 'string' || fileID.length > 2000) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  if (!match || match[1] !== env) return false;
  const prefix = `social/${profileId}/${recipeId}/`;
  return match[3].startsWith(prefix) && /^[A-Za-z0-9_-]{1,160}\.(?:png|jpg|webp)$/.test(match[3].slice(prefix.length));
}

function createHandler({cloud, now = Date.now, unique = () => crypto.randomBytes(16).toString('hex')}) {
  const db = cloud.database({throwOnNotFound: false});
  const collection = (name, database = db) => database.collection(COLLECTIONS[name]);
  const get = async (name, id, database = db) => (await collection(name, database).doc(id).get()).data;
  const write = (name, id, data, database = db) => collection(name, database).doc(id).set({data});

  async function profile(id, database = db) {
    const record = await get('profiles', id, database);
    if (!record || record._id !== id || !isProfileId(record._id) || !safeText(record.name, 20) ||
      !safeText(record.bio || '', 120, true) || !/^[a-f0-9]{64}$/.test(record.owner || '') ||
      profileIdFor(record.owner) !== id) return null;
    return record;
  }

  function followingIds(record) {
    if (!record) return [];
    if (!Array.isArray(record.profileIds) || record.profileIds.length > MAX_FOLLOWS ||
      !record.profileIds.every(isProfileId) || new Set(record.profileIds).size !== record.profileIds.length) {
      reject('关注列表暂时无法读取，请稍后重试。', 'INVALID_ACCOUNT');
    }
    return record.profileIds;
  }

  function isPublished(recipe, author) {
    return Boolean(recipe && author && recipe.published === true && recipe.profileId === author._id &&
      recipe.owner === author.owner && isRecipeId(recipe._id) &&
      recipeIdFor(author.owner, recipe.sourceRecipeId) === recipe._id);
  }

  async function renderRecipe(recipe, env, knownAuthor) {
    const author = knownAuthor || await profile(recipe && recipe.profileId);
    if (!isPublished(recipe, author)) return null;
    // Only explicit whitelisted recipe fields leave the function. Private notes,
    // source IDs, account identifiers, favourites and meal logs never do.
    const result = {
      id: recipe._id, profileId: author._id, authorName: author.name,
      name: recipe.name, category: recipe.category, minutes: recipe.minutes, texture: recipe.texture,
      ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})),
      steps: recipe.steps.slice(), imageKey: recipe.imageKey || '', photoURL: '',
      updatedAt: recipe.updatedAt, publishedAt: recipe.publishedAt
    };
    if (recipe.source) result.source = {
      profileId: recipe.source.profileId, recipeId: recipe.source.recipeId, authorName: recipe.source.authorName
    };
    if (recipe.photoFileID) {
      if (!socialPhoto(recipe.photoFileID, env, author._id, recipe._id)) reject('公开照片暂时不可用。', 'INVALID_PHOTO');
      const response = await cloud.getTempFileURL({fileList: [{fileID: recipe.photoFileID, maxAge: PHOTO_TTL}]});
      const file = response && response.fileList && response.fileList[0];
      if (!file || file.fileID !== recipe.photoFileID || (file.status != null && file.status !== 0) ||
        typeof file.tempFileURL !== 'string' || !/^https:\/\//.test(file.tempFileURL)) {
        reject('公开照片暂时无法读取，请稍后重试。', 'STORAGE_FAILED');
      }
      result.photoURL = file.tempFileURL;
    }
    // A withdrawal while a signed URL was being prepared must not return the
    // recipe. Previously issued links expire after PHOTO_TTL seconds.
    const latest = await get('recipes', recipe._id);
    if (!isPublished(latest, author) || latest.generation !== recipe.generation) return null;
    return result;
  }

  async function renderPage(records, env) {
    const authorCache = new Map();
    await Promise.all(Array.from(new Set(records.map(item => item.profileId)), async id => {
      authorCache.set(id, await profile(id));
    }));
    const results = await Promise.all(records.map(item => authorCache.get(item.profileId) ?
      renderRecipe(item, env, authorCache.get(item.profileId)) : null));
    const recipes = [];
    let bytes = 0;
    let consumed = 0;
    for (const result of results) {
      const size = result ? Buffer.byteLength(JSON.stringify(result), 'utf8') + 1 : 0;
      // The mini-program response link is limited to 1 MiB. Keep large but
      // valid recipes intact and advance pagination only past returned rows.
      if (recipes.length && bytes + size > MAX_PAGE_BYTES) break;
      consumed += 1;
      if (result) { recipes.push(result); bytes += size; }
    }
    return {recipes, consumed};
  }

  async function committedRecipe(owner, env, id) {
    const account = await get('accounts', owner);
    if (!account || !Number.isSafeInteger(account.revision) || account.revision < 1 ||
      !ownedFile(account.fileID, env, owner, 'snapshots')) {
      reject('请先完成微信账号同步，再公开这道菜谱。', 'SYNC_REQUIRED');
    }
    const downloaded = await cloud.downloadFile({fileID: account.fileID});
    if (downloaded.statusCode != null && downloaded.statusCode !== 200) reject('菜谱同步文件暂时无法读取。', 'STORAGE_FAILED');
    const snapshot = validateSnapshot(downloaded.fileContent, {env, owner, now: now()});
    const recipe = snapshot.data.recipes.find(item => item.id === id);
    const deleted = snapshot.deleted.recipes.find(item => item.id === id);
    if (!recipe || (deleted && deleted.updatedAt >= (recipe.updatedAt || recipe.createdAt || 0))) {
      reject('这道个人菜谱已不存在，请刷新后重试。', 'NOT_FOUND');
    }
    return {recipe, account};
  }

  return async function handle(event) {
    try {
      const {OPENID, APPID, ENV} = cloud.getWXContext() || {};
      if (typeof OPENID !== 'string' || !OPENID || typeof APPID !== 'string' || !APPID) {
        reject('未能识别当前微信账号，请在微信中重试。', 'UNAUTHENTICATED');
      }
      if (typeof ENV !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ENV)) reject('云环境尚未配置完成。', 'INVALID_ENV');
      if (!object(event) || typeof event.action !== 'string') reject('请求不正确。', 'INVALID_REQUEST');
      const owner = hash(`${APPID}:${OPENID}`);
      if (event.expectedOwner !== undefined && event.expectedOwner !== owner) {
        reject('微信账号已切换，请刷新后重试。', 'ACCOUNT_CHANGED');
      }
      const ownProfileId = profileIdFor(owner);

      if (event.action === 'mine') {
        const ownProfile = await profile(ownProfileId);
        const published = ownProfile ? (await collection('recipes').where({profileId: ownProfileId, published: true})
          .orderBy('_id', 'asc').limit(1000).get()).data : [];
        return {
          profile: ownProfile ? publicProfile(ownProfile) : {id: ownProfileId, name: '口袋小厨', bio: '', exists: false},
          published: published.filter(item => isPublished(item, ownProfile)).map(item => ({
            id: item._id, sourceRecipeId: item.sourceRecipeId, sourceUpdatedAt: item.sourceUpdatedAt
          })),
          followingCount: followingIds(await get('follows', owner)).length
        };
      }

      if (event.action === 'updateProfile') {
        if (!safeText(event.name, 20) || !safeText(event.bio === undefined ? '' : event.bio, 120, true)) {
          reject('主页名称需为 1–20 字，简介最多 120 字。', 'INVALID_REQUEST');
        }
        const record = {owner, name: event.name.trim(), bio: (event.bio || '').trim(), updatedAt: now()};
        await write('profiles', ownProfileId, record);
        return {profile: publicProfile({_id: ownProfileId, ...record})};
      }

      if (event.action === 'publish') {
        const id = sourceId(event.sourceRecipeId);
        const publicId = recipeIdFor(owner, id);
        const author = await profile(ownProfileId);
        if (!author) reject('请先设置自己的公开主页名称。', 'PROFILE_REQUIRED');
        const previous = await get('recipes', publicId);
        const generation = previous ? previous.generation : 0;
        if (!Number.isSafeInteger(generation) || generation < 0) reject('公开版本暂时无法读取。', 'INVALID_ACCOUNT');
        const {recipe, account} = await committedRecipe(owner, ENV, id);
        let photoFileID = '';
        if (recipe.photo) {
          const photo = await cloud.downloadFile({fileID: recipe.photo});
          if (photo.statusCode != null && photo.statusCode !== 200) reject('照片暂时无法读取。', 'STORAGE_FAILED');
          const extension = photoExtension(photo.fileContent);
          const suffix = unique();
          if (!/^[A-Za-z0-9_-]{1,160}$/.test(suffix)) throw new Error('Invalid random token');
          const cloudPath = `social/${ownProfileId}/${publicId}/${suffix}.${extension}`;
          const uploaded = await cloud.uploadFile({cloudPath, fileContent: photo.fileContent});
          photoFileID = uploaded && uploaded.fileID;
          if (!socialPhoto(photoFileID, ENV, ownProfileId, publicId)) reject('照片公开失败，请重试。', 'STORAGE_FAILED');
        }
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0 || time > 9999999999999) throw new Error('Invalid clock');
        const record = {
          owner, profileId: ownProfileId, sourceRecipeId: id, sourceUpdatedAt: recipe.updatedAt || recipe.createdAt || 0,
          name: recipe.name, category: recipe.category, minutes: recipe.minutes, texture: recipe.texture,
          ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})),
          steps: recipe.steps.slice(), imageKey: recipe.imageKey || '', photoFileID,
          published: true, publishedAt: time, updatedAt: time, generation: generation + 1,
          sortKey: `${String(9999999999999 - time).padStart(13, '0')}-${publicId}`
        };
        if (recipe.source) {
          const original = await get('recipes', recipe.source.recipeId);
          const originalAuthor = await profile(recipe.source.profileId);
          if (originalAuthor && original && original.profileId === originalAuthor._id &&
            original.owner === originalAuthor.owner && recipeIdFor(original.owner, original.sourceRecipeId) === original._id) {
            record.source = {profileId: originalAuthor._id, recipeId: original._id, authorName: originalAuthor.name};
          }
        }
        await db.runTransaction(async transaction => {
          const current = await get('recipes', publicId, transaction);
          if ((current ? current.generation : 0) !== generation) reject('公开状态刚有变化，请刷新后重试。', 'CONFLICT');
          const currentAccount = await get('accounts', owner, transaction);
          if (!currentAccount || currentAccount.revision !== account.revision || currentAccount.fileID !== account.fileID) {
            reject('个人菜谱刚有更新，请同步完成后重新公开。', 'SYNC_REQUIRED');
          }
          if (!await profile(ownProfileId, transaction)) reject('请先设置自己的公开主页名称。', 'PROFILE_REQUIRED');
          await write('recipes', publicId, record, transaction);
        });
        const rendered = await renderRecipe({_id: publicId, ...record}, ENV);
        if (!rendered) reject('公开状态刚有变化，请刷新后重试。', 'CONFLICT');
        return {recipe: rendered};
      }

      if (event.action === 'unpublish') {
        const id = recipeIdFor(owner, sourceId(event.sourceRecipeId));
        await db.runTransaction(async transaction => {
          const current = await get('recipes', id, transaction);
          const generation = current ? current.generation : 0;
          if (!Number.isSafeInteger(generation) || generation < 0) reject('公开版本暂时无法读取。', 'INVALID_ACCOUNT');
          // Retain a tombstone to prevent an older, in-flight publish from
          // bringing back a recipe after the user withdraws it.
          await write('recipes', id, {owner, profileId: ownProfileId, sourceRecipeId: event.sourceRecipeId,
            published: false, generation: generation + 1, updatedAt: now()}, transaction);
        });
        return {ok: true};
      }

      if (event.action === 'follow') {
        if (!isProfileId(event.profileId) || typeof event.following !== 'boolean') reject('请选择有效的主页。', 'INVALID_REQUEST');
        if (event.profileId === ownProfileId) reject('不能关注自己的主页。', 'INVALID_REQUEST');
        await db.runTransaction(async transaction => {
          const ids = followingIds(await get('follows', owner, transaction));
          if (event.following && !await profile(event.profileId, transaction)) reject('这个主页暂时不可用。', 'NOT_FOUND');
          const exists = ids.includes(event.profileId);
          if (exists === event.following) return;
          if (event.following && ids.length >= MAX_FOLLOWS) reject('最多可关注 200 位朋友。', 'FOLLOW_LIMIT');
          const next = event.following ? ids.concat(event.profileId) : ids.filter(id => id !== event.profileId);
          await write('follows', owner, {profileIds: next, updatedAt: now()}, transaction);
        });
        return {following: event.following};
      }

      if (event.action === 'following') {
        const offset = pageOffset(event.offset);
        const ids = followingIds(await get('follows', owner));
        const records = await Promise.all(ids.slice(offset, offset + PAGE_SIZE).map(id => profile(id)));
        return {profiles: records.filter(Boolean).map(publicProfile), nextOffset: offset + PAGE_SIZE < ids.length ? offset + PAGE_SIZE : null};
      }

      if (event.action === 'profile') {
        if (!isProfileId(event.profileId)) reject('主页链接不正确。', 'INVALID_REQUEST');
        const offset = pageOffset(event.offset);
        const author = await profile(event.profileId);
        if (!author) reject('这个主页暂时不可用。', 'NOT_FOUND');
        const records = (await collection('recipes').where({profileId: author._id, published: true})
          .orderBy('sortKey', 'asc').skip(offset).limit(PAGE_SIZE + 1).get()).data;
        const page = await renderPage(records.slice(0, PAGE_SIZE), ENV);
        return {profile: publicProfile(author), isSelf: author._id === ownProfileId,
          following: followingIds(await get('follows', owner)).includes(author._id),
          recipes: page.recipes,
          nextOffset: records.length > page.consumed ? offset + page.consumed : null};
      }

      if (event.action === 'recipe') {
        if (!isRecipeId(event.recipeId)) reject('菜谱链接不正确。', 'INVALID_REQUEST');
        const record = await get('recipes', event.recipeId);
        const author = record && await profile(record.profileId);
        if (!isPublished(record, author)) reject('这道菜谱已取消公开或不存在。', 'NOT_FOUND');
        const recipe = await renderRecipe(record, ENV, author);
        if (!recipe) reject('这道菜谱已取消公开或不存在。', 'NOT_FOUND');
        return {recipe, author: publicProfile(author)};
      }

      if (event.action === 'feed') {
        const cursor = event.cursor === undefined ? '' : event.cursor;
        if (typeof cursor !== 'string' || (cursor && !/^\d{13}-[a-f0-9]{64}$/.test(cursor))) {
          reject('分页位置不正确。', 'INVALID_REQUEST');
        }
        const ids = followingIds(await get('follows', owner));
        const batches = [];
        for (let index = 0; index < ids.length; index += 20) {
          const condition = {profileId: db.command.in(ids.slice(index, index + 20)), published: true};
          if (cursor) condition.sortKey = db.command.gt(cursor);
          batches.push(collection('recipes').where(condition).orderBy('sortKey', 'asc').limit(PAGE_SIZE + 1).get());
        }
        const records = (await Promise.all(batches)).flatMap(result => result.data)
          .sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
        const page = await renderPage(records.slice(0, PAGE_SIZE), ENV);
        return {recipes: page.recipes,
          nextCursor: records.length > page.consumed ? records[page.consumed - 1].sortKey : null};
      }

      reject('不支持的社交操作。', 'INVALID_REQUEST');
    } catch (error) {
      const allowed = new Set(['UNAUTHENTICATED', 'INVALID_ENV', 'INVALID_REQUEST', 'INVALID_ACCOUNT',
        'INVALID_SNAPSHOT', 'INVALID_PHOTO', 'STORAGE_FAILED', 'SYNC_REQUIRED', 'PROFILE_REQUIRED',
        'NOT_FOUND', 'CONFLICT', 'FOLLOW_LIMIT', 'ACCOUNT_CHANGED']);
      if (allowed.has(error && error.code)) return {error: {code: error.code, message: error.message}};
      return {error: {code: 'SOCIAL_FAILED', message: '暂时无法完成，请稍后重试。'}};
    }
  };
}

let handler;
exports.main = async event => {
  if (!handler) {
    const cloud = require('wx-server-sdk');
    cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});
    handler = createHandler({cloud});
  }
  return handler(event);
};
exports.createHandler = createHandler;
exports.profileIdFor = profileIdFor;
exports.recipeIdFor = recipeIdFor;
exports.COLLECTIONS = COLLECTIONS;
exports.PAGE_SIZE = PAGE_SIZE;
