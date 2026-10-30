'use strict';

const crypto = require('crypto');
const {ownedFile, validateSnapshot, normalizeAgeGroups, reject} = require('./private-snapshot');
const {getImageKey} = require('./recipe-covers');
const {todayString, isValidBirthDate, ageInMonths} = require('./baby-age');
const {checkProfile} = require('./profile-moderation');
const COLLECTIONS = {
  accounts: 'baby_bites_accounts', profiles: 'baby_bites_profiles',
  recipes: 'baby_bites_public_recipes', follows: 'baby_bites_follows'
};
const PAGE_SIZE = 20;
const MAX_OFFSET = 1000;
const MAX_FOLLOWS = 200;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TTL = 300;
const MAX_PAGE_BYTES = 800 * 1024;
const DISCOVERY_SCAN_SIZE = 60;
const CODE_MAX_BYTES = 512 * 1024;
const CODE_ENVIRONMENTS = ['develop', 'trial', 'release'];
const SORT_KEY_PATTERN = /^\d{13}-[a-f0-9]{64}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const DEFAULT_PROFILE_NAMES = ['小胡萝卜', '小南瓜', '小番茄', '小土豆', '小西兰花', '小玉米'];
function defaultProfileName(owner) {
  const digest = hash(`public-default-name:${owner}`);
  const name = DEFAULT_PROFILE_NAMES[parseInt(digest.slice(0, 8), 16) % DEFAULT_PROFILE_NAMES.length];
  return name + String(1000 + parseInt(digest.slice(8, 16), 16) % 9000);
}
const profileIdFor = owner => hash(`public-profile:${owner}`).slice(0, 32);
const recipeIdFor = (owner, sourceId) => hash(`public-recipe:${owner}:${sourceId}`);
const isProfileId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const isRecipeId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeText = (value, max, empty = false) => typeof value === 'string' && value.length <= max &&
  (empty || Boolean(value.trim())) && !/[\u0000-\u001f\u007f]/.test(value);

function pageOffset(value, maximum = MAX_OFFSET) {
  const offset = value === undefined ? 0 : value;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) reject('分页位置不正确。', 'INVALID_REQUEST');
  return offset;
}

function sourceId(value) {
  if (!safeText(value, 100)) reject('请选择有效的个人菜谱。', 'INVALID_REQUEST');
  return value;
}

const isBabyAgeMonths = value => Number.isInteger(value) && value >= 0 && value <= 120;
const legacyBabyAge = record => record && isBabyAgeMonths(record.babyAgeMonths) ? record.babyAgeMonths : null;
// Preserve a stored calendar date through unrelated writes, including a request
// that crosses midnight while another transaction updates the birthday.
const storedBirthDate = record => record && isValidBirthDate(record.babyBirthDate, '9999-12-31') ? record.babyBirthDate : null;

function publicProfile(record, today, includeBirthDate = false) {
  const babyBirthDate = isValidBirthDate(record.babyBirthDate, today) ? record.babyBirthDate : null;
  const result = {id: record._id, name: record.name, bio: record.bio || '',
    babyAgeMonths: babyBirthDate ? ageInMonths(babyBirthDate, today) : legacyBabyAge(record), exists: true};
  if (includeBirthDate) result.babyBirthDate = babyBirthDate;
  return result;
}

function discoverSearch(value) {
  const input = value === undefined ? '' : value;
  if (!safeText(input, 60, true)) reject('搜索内容最多 60 个字，请缩短后重试。', 'INVALID_REQUEST');
  const normalized = input.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (normalized.length > 60 || (normalized && normalized.split(' ').length > 6)) {
    reject('搜索内容过长，请减少关键词后重试。', 'INVALID_REQUEST');
  }
  return normalized;
}

function discoverCursor(value, search) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') reject('分页位置不正确，请刷新搜索。', 'INVALID_REQUEST');
  const match = /^v1\.([a-f0-9]{64})\.(\d{13}-[a-f0-9]{64})$/.exec(value);
  if (!match || match[1] !== hash(search)) reject('搜索条件已变化，请从第一页重新加载。', 'INVALID_REQUEST');
  return match[2];
}

function matchesSearch(recipe, author, search) {
  if (!search) return true;
  const fields = [recipe.name, author.name].concat(Array.isArray(recipe.ingredients) ?
    recipe.ingredients.map(item => item && item.name) : [])
    .filter(value => typeof value === 'string').map(value => value.normalize('NFKC').toLowerCase());
  return search.split(' ').every(word => fields.some(value => value.includes(word)));
}

function socialCode(fileID, env, profileId, envVersion) {
  if (typeof fileID !== 'string' || fileID.length > 2000 || !CODE_ENVIRONMENTS.includes(envVersion)) return false;
  const match = /^cloud:\/\/([A-Za-z0-9_-]+)\.([A-Za-z0-9._-]+)\/(.+)$/.exec(fileID);
  if (!match || match[1] !== env) return false;
  const prefix = `social/${profileId}/codes/${envVersion}/`;
  return match[3].startsWith(prefix) && /^v1-[A-Za-z0-9_-]{1,160}\.(?:png|jpg)$/.test(match[3].slice(prefix.length));
}

function codeExtension(bytes) {
  if (Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.length <= CODE_MAX_BYTES) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  }
  reject('暂时无法生成小程序码，可以先发送给朋友。', 'SHARE_CODE_FAILED');
}

function cachedCodes(record, env) {
  const result = {};
  if (!record) return result;
  for (const version of CODE_ENVIRONMENTS) {
    const fileID = record && record.shareCodes && record.shareCodes[version];
    if (socialCode(fileID, env, record._id, version)) result[version] = fileID;
  }
  return result;
}

function rejectCodeUnavailable(error, envVersion) {
  if (error && Number(error.errCode) === 41030 && envVersion === 'release') {
    reject('正式版主页尚未发布，暂时无法生成正式版分享码。', 'SHARE_CODE_NOT_PUBLISHED');
  }
  reject('暂时无法生成小程序码，可以先发送给朋友。', 'SHARE_CODE_UNAVAILABLE');
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

  // The existing one-document-per-account schema is also the source of truth
  // for reverse edges. No second counter or follower list can drift on retries.
  const followersQuery = profileId => collection('follows').where({profileIds: db.command.in([profileId])});

  async function count(query) {
    const result = await query.count();
    if (!result || !Number.isSafeInteger(result.total) || result.total < 0) throw new Error('Invalid count result');
    return result.total;
  }

  async function followedBy(author, ownProfileId, database = db) {
    return Boolean(author && author._id !== ownProfileId &&
      followingIds(await get('follows', author.owner, database)).includes(ownProfileId));
  }

  function isPublished(recipe, author) {
    return Boolean(recipe && author && recipe.published === true && recipe.profileId === author._id &&
      recipe.owner === author.owner && isRecipeId(recipe._id) &&
      recipeIdFor(author.owner, recipe.sourceRecipeId) === recipe._id);
  }

  async function renderRecipe(recipe, env, knownAuthor) {
    const author = knownAuthor || await profile(recipe && recipe.profileId);
    if (!isPublished(recipe, author)) return null;
    const ageGroups = normalizeAgeGroups(recipe.ageGroups);
    // Only explicit whitelisted recipe fields leave the function. Private notes,
    // source IDs, account identifiers, favourites and meal logs never do.
    const result = {
      id: recipe._id, profileId: author._id, authorName: author.name,
      name: recipe.name, category: recipe.category, minutes: recipe.minutes, texture: recipe.texture,
      ...(ageGroups === undefined ? {} : {ageGroups}),
      ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})),
      steps: recipe.steps.slice(), imageKey: getImageKey(recipe.sourceRecipeId, recipe.imageKey), photoURL: '',
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
      const today = todayString(now());

      if (event.action === 'mine') {
        const ownProfile = await profile(ownProfileId);
        const published = ownProfile ? (await collection('recipes').where({profileId: ownProfileId, published: true})
          .orderBy('_id', 'asc').limit(1000).get()).data : [];
        const ownPublished = published.filter(item => isPublished(item, ownProfile));
        return {
          profile: ownProfile ? publicProfile(ownProfile, today, true) : {id: ownProfileId, name: defaultProfileName(owner), bio: '', babyAgeMonths: null, babyBirthDate: null, exists: false},
          published: ownPublished.map(item => ({
            id: item._id, sourceRecipeId: item.sourceRecipeId, sourceUpdatedAt: item.sourceUpdatedAt
          })),
          publishedCount: ownProfile ? await count(collection('recipes').where({profileId: ownProfileId, published: true})) : 0,
          followingCount: followingIds(await get('follows', owner)).length,
          followerCount: ownProfile ? await count(followersQuery(ownProfileId)) : 0
        };
      }

      if (event.action === 'updateProfile' || event.action === 'checkProfile') {
        if (!safeText(event.name, 20) || !safeText(event.bio === undefined ? '' : event.bio, 120, true)) {
          reject('主页名称需为 1–20 字，简介最多 120 字。', 'INVALID_REQUEST');
        }
        const hasBabyAge = Object.prototype.hasOwnProperty.call(event, 'babyAgeMonths');
        if (hasBabyAge && event.babyAgeMonths !== null && !isBabyAgeMonths(event.babyAgeMonths)) {
          reject('宝宝月龄需为 0–120 的整数，或清除后不显示。', 'INVALID_BABY_AGE');
        }
        const hasBirthDate = Object.prototype.hasOwnProperty.call(event, 'babyBirthDate');
        if (hasBirthDate && event.babyBirthDate !== null && !isValidBirthDate(event.babyBirthDate, today)) {
          reject('请填写 1900 年起且不晚于今天的有效生日。', 'INVALID_BABY_BIRTH_DATE');
        }
        const checkedProfile = {name: event.name.trim(), bio: (event.bio || '').trim()};
        await checkProfile(cloud, OPENID, checkedProfile);
        // Read-only preflight uses the same checks. Saving always checks again;
        // no client-provided approval can authorize a later write.
        if (event.action === 'checkProfile') return {validated: true, saved: false};
        const record = await db.runTransaction(async transaction => {
          const previous = await profile(ownProfileId, transaction);
          const record = {owner, name: checkedProfile.name, bio: checkedProfile.bio, updatedAt: now(),
            babyBirthDate: hasBirthDate ? event.babyBirthDate : storedBirthDate(previous),
            babyAgeMonths: hasBirthDate ? null : hasBabyAge ? event.babyAgeMonths : legacyBabyAge(previous)};
          const codes = cachedCodes(previous, ENV);
          if (Object.keys(codes).length) record.shareCodes = codes;
          await write('profiles', ownProfileId, record, transaction);
          return record;
        });
        return {profile: publicProfile({_id: ownProfileId, ...record}, today, true)};
      }

      if (event.action === 'shareCode') {
        if (!isProfileId(event.profileId) || !CODE_ENVIRONMENTS.includes(event.envVersion)) {
          reject('主页或小程序版本不正确，请重新打开。', 'INVALID_REQUEST');
        }
        const author = await profile(event.profileId);
        if (!author) reject('请先保存有效的公开主页，再生成分享海报。', 'PROFILE_REQUIRED');
        let fileID = cachedCodes(author, ENV)[event.envVersion];
        if (!fileID) {
          let generated;
          try {
            generated = await cloud.openapi.wxacode.getUnlimited({
              scene: author._id, page: 'pages/profile/index', envVersion: event.envVersion,
              checkPath: event.envVersion === 'release', width: 430
            });
          } catch (error) { rejectCodeUnavailable(error, event.envVersion); }
          if (generated && generated.errCode != null && generated.errCode !== 0) rejectCodeUnavailable(generated, event.envVersion);
          const bytes = generated && generated.buffer;
          const extension = codeExtension(bytes);
          const suffix = unique();
          if (!/^[A-Za-z0-9_-]{1,160}$/.test(suffix)) throw new Error('Invalid random token');
          let uploaded;
          try {
            uploaded = await cloud.uploadFile({cloudPath: `social/${author._id}/codes/${event.envVersion}/v1-${suffix}.${extension}`,
              fileContent: bytes});
          } catch (_) { reject('暂时无法保存小程序码，可以先发送给朋友。', 'SHARE_CODE_FAILED'); }
          const uploadedID = uploaded && uploaded.fileID;
          if (!socialCode(uploadedID, ENV, author._id, event.envVersion)) {
            reject('小程序码暂时无法保存，请稍后重试。', 'STORAGE_FAILED');
          }
          fileID = await db.runTransaction(async transaction => {
            const current = await profile(author._id, transaction);
            if (!current) reject('这个主页暂时不可用。', 'NOT_FOUND');
            const codes = cachedCodes(current, ENV);
            if (codes[event.envVersion]) return codes[event.envVersion];
            codes[event.envVersion] = uploadedID;
            await write('profiles', author._id, {owner: current.owner, name: current.name, bio: current.bio || '',
              babyAgeMonths: legacyBabyAge(current), babyBirthDate: storedBirthDate(current),
              updatedAt: current.updatedAt, shareCodes: codes}, transaction);
            return uploadedID;
          });
        }
        let response;
        try { response = await cloud.getTempFileURL({fileList: [{fileID, maxAge: PHOTO_TTL}]}); }
        catch (_) { reject('暂时无法读取小程序码，可以先发送给朋友。', 'SHARE_CODE_FAILED'); }
        const file = response && response.fileList && response.fileList[0];
        if (!file || file.fileID !== fileID || (file.status != null && file.status !== 0) ||
          typeof file.tempFileURL !== 'string' || !/^https:\/\//.test(file.tempFileURL)) {
          reject('小程序码暂时无法读取，请稍后重试。', 'STORAGE_FAILED');
        }
        if (!await profile(author._id)) reject('这个主页暂时不可用。', 'NOT_FOUND');
        return {profileId: author._id, envVersion: event.envVersion, codeURL: file.tempFileURL};
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
          ...(recipe.ageGroups === undefined ? {} : {ageGroups: recipe.ageGroups.slice()}),
          ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})),
          steps: recipe.steps.slice(), imageKey: getImageKey(recipe.id, recipe.imageKey), photoFileID,
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
        return await db.runTransaction(async transaction => {
          if (event.following && !await profile(ownProfileId, transaction)) {
            reject('请先设置自己的公开主页名称，再关注朋友。', 'PROFILE_REQUIRED');
          }
          const ids = followingIds(await get('follows', owner, transaction));
          const author = await profile(event.profileId, transaction);
          if (event.following && !author) reject('这个主页暂时不可用。', 'NOT_FOUND');
          const reverse = await followedBy(author, ownProfileId, transaction);
          const exists = ids.includes(event.profileId);
          if (exists === event.following) return {following: exists, followedBy: reverse};
          if (event.following && ids.length >= MAX_FOLLOWS) reject('最多可关注 200 位朋友。', 'FOLLOW_LIMIT');
          const next = event.following ? ids.concat(event.profileId) : ids.filter(id => id !== event.profileId);
          await write('follows', owner, {profileIds: next, updatedAt: now()}, transaction);
          return {following: event.following, followedBy: reverse};
        });
      }

      if (event.action === 'following') {
        const offset = pageOffset(event.offset);
        const ids = followingIds(await get('follows', owner));
        const records = await Promise.all(ids.slice(offset, offset + PAGE_SIZE).map(id => profile(id)));
        const profiles = await Promise.all(records.filter(Boolean).map(async author => ({
          ...publicProfile(author, today), following: true, followedBy: await followedBy(author, ownProfileId)
        })));
        return {profiles, nextOffset: offset + PAGE_SIZE < ids.length ? offset + PAGE_SIZE : null};
      }

      if (event.action === 'followers') {
        const offset = pageOffset(event.offset, Number.MAX_SAFE_INTEGER - PAGE_SIZE);
        // Only the caller's followers can be enumerated. Client-supplied owner
        // or profileId never selects somebody else's incoming relationships.
        if (!await profile(ownProfileId)) return {profiles: [], nextOffset: null};
        const ids = followingIds(await get('follows', owner));
        const records = (await followersQuery(ownProfileId).orderBy('_id', 'asc')
          .skip(offset).limit(PAGE_SIZE + 1).get()).data;
        const profiles = (await Promise.all(records.slice(0, PAGE_SIZE).map(async record => {
          if (!record || !/^[a-f0-9]{64}$/.test(record._id || '') || record._id === owner) return null;
          if (!followingIds(record).includes(ownProfileId)) return null;
          const author = await profile(profileIdFor(record._id));
          // Older versions allowed following before saving a public name. Such
          // accounts remain private until their owner explicitly creates one.
          if (!author) return null;
          return {...publicProfile(author, today), following: ids.includes(author._id), followedBy: true};
        }))).filter(Boolean);
        const nextOffset = offset + PAGE_SIZE;
        return {profiles, nextOffset: records.length > PAGE_SIZE ? nextOffset : null};
      }

      if (event.action === 'profile') {
        if (!isProfileId(event.profileId)) reject('主页链接不正确。', 'INVALID_REQUEST');
        const offset = pageOffset(event.offset);
        const author = await profile(event.profileId);
        if (!author) reject('这个主页暂时不可用。', 'NOT_FOUND');
        const records = (await collection('recipes').where({profileId: author._id, published: true})
          .orderBy('sortKey', 'asc').skip(offset).limit(PAGE_SIZE + 1).get()).data;
        const page = await renderPage(records.slice(0, PAGE_SIZE), ENV);
        const authorFollowing = followingIds(await get('follows', author.owner));
        const ownFollowing = author.owner === owner ? authorFollowing : followingIds(await get('follows', owner));
        return {profile: publicProfile(author, today, author._id === ownProfileId), isSelf: author._id === ownProfileId,
          following: author.owner !== owner && ownFollowing.includes(author._id),
          followedBy: author.owner !== owner && authorFollowing.includes(ownProfileId),
          followingCount: authorFollowing.length,
          followerCount: await count(followersQuery(author._id)),
          publishedCount: await count(collection('recipes').where({profileId: author._id, published: true})),
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
        return {recipe, author: publicProfile(author, today)};
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

      if (event.action === 'discover') {
        const search = discoverSearch(event.search);
        const cursor = discoverCursor(event.cursor, search);
        const condition = {published: true};
        if (cursor) condition.sortKey = db.command.gt(cursor);
        // Search a bounded window of the public index. Literal matching avoids
        // unindexed database regex scans and cannot read private snapshots.
        const scanSize = search ? DISCOVERY_SCAN_SIZE : PAGE_SIZE;
        const records = (await collection('recipes').where(condition).orderBy('sortKey', 'asc')
          .field({_id: true, profileId: true, owner: true, sourceRecipeId: true, published: true,
            sortKey: true, name: true, ingredients: true})
          .limit(scanSize + 1).get()).data;
        const candidates = records.slice(0, scanSize);
        const authors = new Map();
        const profiles = Array.from(new Set(candidates.map(item => item.profileId).filter(isProfileId)));
        await Promise.all(profiles.map(async id => { authors.set(id, await profile(id)); }));
        const recipes = [];
        let consumed = 0;
        let bytes = 0;
        for (const item of candidates) {
          if (!SORT_KEY_PATTERN.test(item.sortKey || '') || item.sortKey.slice(14) !== item._id) {
            throw new Error('Invalid public index');
          }
          const author = authors.get(item.profileId);
          let result = null;
          if (isPublished(item, author) && matchesSearch(item, author, search)) {
            const latest = await get('recipes', item._id);
            if (latest && latest.sortKey === item.sortKey && matchesSearch(latest, author, search)) {
              result = await renderRecipe(latest, ENV, author);
            }
          }
          const size = result ? Buffer.byteLength(JSON.stringify(result), 'utf8') + 1 : 0;
          if (recipes.length && bytes + size > MAX_PAGE_BYTES) break;
          consumed += 1;
          if (result) { recipes.push(result); bytes += size; }
          if (recipes.length >= PAGE_SIZE) break;
        }
        return {recipes, nextCursor: records.length > consumed && consumed > 0 ?
          `v1.${hash(search)}.${records[consumed - 1].sortKey}` : null};
      }

      reject('不支持的社交操作。', 'INVALID_REQUEST');
    } catch (error) {
      const allowed = new Set(['UNAUTHENTICATED', 'INVALID_ENV', 'INVALID_REQUEST', 'INVALID_ACCOUNT', 'INVALID_BABY_AGE', 'INVALID_BABY_BIRTH_DATE',
        'INVALID_SNAPSHOT', 'INVALID_PHOTO', 'STORAGE_FAILED', 'SYNC_REQUIRED', 'PROFILE_REQUIRED',
        'NOT_FOUND', 'CONFLICT', 'FOLLOW_LIMIT', 'ACCOUNT_CHANGED', 'SHARE_CODE_UNAVAILABLE',
        'SHARE_CODE_FAILED', 'SHARE_CODE_NOT_PUBLISHED', 'PROFILE_NAME_REJECTED',
        'PROFILE_BIO_REJECTED', 'PROFILE_MODERATION_UNAVAILABLE']);
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
