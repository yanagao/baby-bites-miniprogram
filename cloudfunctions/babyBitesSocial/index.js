'use strict';

const crypto = require('crypto');
const {ownedFile, validateSnapshot, normalizeAgeGroups, reject} = require('./private-snapshot');
const {getImageKey, isBuiltinRecipeId} = require('./recipe-covers');
const {todayString, isValidBirthDate, ageInMonths} = require('./baby-age');
const {checkProfile} = require('./profile-moderation');
const {ACTIONS: FEEDBACK_ACTIONS, createFeedback} = require('./feedback');
const {createFamily, COLLECTIONS: FAMILY_COLLECTIONS, scopeKey, personalScope} = require('./family');
const COLLECTIONS = {
  accounts: 'baby_bites_accounts', profiles: 'baby_bites_profiles',
  recipes: 'baby_bites_public_recipes', follows: 'baby_bites_follows', feedback: 'baby_bites_recipe_feedback', ...FAMILY_COLLECTIONS
};
const PAGE_SIZE = 20;
const MAX_OFFSET = 1000;
const MAX_FOLLOWS = 200;
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_TTL = 300;
const MAX_PAGE_BYTES = 800 * 1024;
const DISCOVERY_SCAN_SIZE = 60;
const DISCOVERY_CONCURRENCY = 5;
const PUBLICATION_BATCH_SIZE = 8;
const PUBLICATION_POLICY_VERSION = 3;
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
  const families = createFamily({cloud, db, now, validateSnapshot, ownedFile, reject});
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
      recipeIdFor(author.owner, recipe.sourceRecipeId) === recipe._id &&
      !recipe.isExample && !recipe.builtin && !isBuiltinRecipeId(recipe.sourceRecipeId));
  }

  // Old clients removed isExample when editing a starter recipe. Its fixed ID
  // remains authoritative. Follow saved-copy attribution too, including retired
  // records, so a former public starter cannot re-enter through a shared copy.
  function builtinChecker() {
    const cache = new Map();
    const originals = new Map();
    const knownBuiltins = new Set();
    async function check(recipe, visited = new Set()) {
      if (!recipe) return false;
      if (recipe.isExample === true || recipe.builtin === true ||
        knownBuiltins.has(recipe._id) || isBuiltinRecipeId(recipe.sourceRecipeId || recipe.id)) return true;
      const source = recipe.source;
      const shared = /^shared-([a-f0-9]{64})$/.exec(recipe.sourceRecipeId || recipe.id || '');
      // A saved copy has a stable shared- ID. Forged or stale attribution must
      // not hide the builtin identity already encoded in that ID.
      if (shared && source && await check({id: 'shared-' + shared[1]}, visited)) return true;
      const id = source && source.recipeId || shared && shared[1];
      if (!isRecipeId(id) || visited.has(id)) return false;
      if (knownBuiltins.has(id)) return true;
      if (cache.has(id)) return cache.get(id);
      if (visited.size >= 1000) reject('菜谱来源过长，请联系开发者。', 'INVALID_ACCOUNT');
      // Deduplicate only document reads, not recursive result promises: shared
      // sources may form a cycle and must retain each walk's own visited set.
      if (!originals.has(id)) originals.set(id, get('recipes', id));
      const original = await originals.get(id);
      if (!original || !/^[a-f0-9]{64}$/.test(original.owner || '') ||
        recipeIdFor(original.owner, original.sourceRecipeId) !== id ||
        (source && original.profileId !== source.profileId)) { cache.set(id, false); return false; }
      const next = new Set(visited); next.add(id);
      const result = await check(original, next);
      cache.set(id, result);
      return result;
    }
    check.markBuiltin = id => { knownBuiltins.add(id); cache.set(id, true); };
    return check;
  }

  async function renderRecipe(recipe, env, knownAuthor, isBuiltin = builtinChecker()) {
    const author = knownAuthor || await profile(recipe && recipe.profileId);
    if (!isPublished(recipe, author) || await isBuiltin(recipe)) return null;
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
    if (!isPublished(latest, author) || latest.generation !== recipe.generation || await isBuiltin(latest)) return null;
    return result;
  }

  async function renderPage(records, env, knownAuthors = [], isBuiltin = builtinChecker()) {
    // Reuse validated authors only inside this request; account and publication
    // permissions are still read afresh on the next request.
    const authorCache = new Map(knownAuthors);
    await Promise.all(Array.from(new Set(records.map(item => item.profileId))).filter(id => !authorCache.has(id)).map(async id => {
      authorCache.set(id, await profile(id));
    }));
    const results = await Promise.all(records.map(item => authorCache.get(item.profileId) ?
      renderRecipe(item, env, authorCache.get(item.profileId), isBuiltin) : null));
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

  async function committedSnapshot(owner, env, allowMissing = false, knownAccount, expectedScope) {
    // Authorization must remain bound to the scope accepted at request entry.
    // Resolving whichever scope happens to be current here would retarget a
    // pending family deletion/publication into the caller's personal account.
    const state = expectedScope ? await families.current(owner, env, expectedScope) : await families.resolve(owner, env);
    if (state.family) {
      const snapshot = await families.snapshot(state, env);
      await families.assertCurrent(owner, env, state);
      return {snapshot, account: {...state.family, __scope: state.scope, __actor: owner}};
    }
    const account = knownAccount === undefined ? await get('accounts', owner) : knownAccount;
    if (!account && allowMissing) return {account: null, snapshot: {data: {recipes: []}, deleted: {recipes: []}}};
    if (!account || !Number.isSafeInteger(account.revision) || account.revision < 1 ||
      !ownedFile(account.fileID, env, owner, 'snapshots')) {
      reject('请先完成微信账号同步，再公开这道菜谱。', 'SYNC_REQUIRED');
    }
    const downloaded = await cloud.downloadFile({fileID: account.fileID});
    if (downloaded.statusCode != null && downloaded.statusCode !== 200) reject('菜谱同步文件暂时无法读取。', 'STORAGE_FAILED');
    const snapshot = validateSnapshot(downloaded.fileContent, {env, owner, now: now()});
    return {snapshot, account: {...account, __scope: state.scope}};
  }

  function activeRecipe(snapshot, id) {
    const recipe = snapshot.data.recipes.find(item => item.id === id);
    const deleted = snapshot.deleted.recipes.find(item => item.id === id);
    return recipe && !(deleted && deleted.updatedAt >= (recipe.updatedAt || recipe.createdAt || 0)) ? recipe : null;
  }

  async function committedRecipe(owner, env, id, expectedScope) {
    const {snapshot, account} = await committedSnapshot(owner, env, false, undefined, expectedScope);
    const recipe = activeRecipe(snapshot, id);
    if (!recipe) {
      reject('这道个人菜谱已不存在，请刷新后重试。', 'NOT_FOUND');
    }
    return {recipe, account};
  }

  function previewAuthor(author, owner) {
    return author ? publicProfile(author, todayString(now())) : {
      id: profileIdFor(owner), name: defaultProfileName(owner), bio: '', babyAgeMonths: null, exists: false
    };
  }

  async function shareableFields(recipe, source = db) {
    const fields = {
      name: recipe.name, category: recipe.category, minutes: recipe.minutes, texture: recipe.texture,
      ...(recipe.ageGroups === undefined ? {} : {ageGroups: recipe.ageGroups.slice()}),
      ingredients: recipe.ingredients.map(item => ({name: item.name, amount: item.amount})),
      steps: recipe.steps.slice(), imageKey: getImageKey(recipe.id, recipe.imageKey)
    };
    if (recipe.source) {
      const original = await get('recipes', recipe.source.recipeId, source);
      const originalAuthor = await profile(recipe.source.profileId, source);
      if (originalAuthor && original && original.profileId === originalAuthor._id &&
        original.owner === originalAuthor.owner && recipeIdFor(original.owner, original.sourceRecipeId) === original._id) {
        fields.source = {profileId: originalAuthor._id, recipeId: original._id, authorName: originalAuthor.name};
      }
    }
    return fields;
  }

  function publicationPreviewToken({owner, account, recipe, fields, author, previous}) {
    // Bind confirmation to the exact owner, committed version, displayed fields,
    // photo and author. This is a content/version capability, not a claim that
    // the server can observe whether a human actually read the client preview.
    return hash(JSON.stringify({version: 2, owner, scope: account.__scope || personalScope(owner), revision: account.revision, fileID: account.fileID,
      sourceRecipeId: recipe.id, sourceUpdatedAt: recipe.updatedAt || recipe.createdAt || 0,
      photo: recipe.photo || '', fields, author,
      generation: previous ? previous.generation : 0, published: Boolean(previous && previous.published)}));
  }

  function rejectStalePreview() {
    reject('菜谱或分享资料已变化，请重新预览后确认。', 'PREVIEW_STALE');
  }

  async function publicInventory(profileId, allowPartial = false, publicationScope) {
    const records = [];
    let last = '';
    let hasMore = false;
    // A current snapshot has at most 1000 recipes. Two windows leave room to
    // retire stale historical rows without an unbounded request. Reconciliation
    // can keep consuming eight stale rows per call until the excess is gone.
    for (let window = 0; window < 2; window++) {
      const condition = publicationScope ? {publicationScope, published: true} : {profileId, published: true};
      if (last) condition._id = db.command.gt(last);
      const page = (await collection('recipes').where(condition).orderBy('_id', 'asc')
        .field({_id: true, owner: true, profileId: true, sourceRecipeId: true, sourceUpdatedAt: true,
          published: true, generation: true, isExample: true, builtin: true, source: true, publicationScope: true}).limit(1000).get()).data;
      records.push(...page);
      hasMore = page.length === 1000;
      if (!hasMore) break;
      last = page[page.length - 1]._id;
    }
    if (hasMore && !allowPartial) reject('历史菜谱需要整理，请作者同步后重试。', 'SYNC_REQUIRED');
    return {records, hasMore};
  }

  async function assertCommitted(transaction, owner, account) {
    if (account && account.__scope && account.__scope.kind === 'family') {
      const state = await families.current(account.__actor || owner, account.fileID.split('://')[1].split('.')[0], account.__scope, transaction);
      if (state.family.revision !== account.revision || state.family.fileID !== account.fileID) reject('家庭菜谱刚有更新，请同步后重试。', 'SYNC_REQUIRED');
      return state.family;
    }
    // Recheck scope inside the same transaction: switching into a family must
    // not permit an in-flight personal publication to commit afterward.
    const env = account && account.fileID ? account.fileID.split('://')[1].split('.')[0] : cloud.getWXContext().ENV;
    await families.current(owner, env, personalScope(owner), transaction);
    const current = await get('accounts', owner, transaction);
    if (account ? !current || current.revision !== account.revision || current.fileID !== account.fileID : current) {
      reject('菜谱刚有更新，请同步完成后重试。', 'SYNC_REQUIRED');
    }
    return current;
  }

  async function writeDefaultProfile(transaction, owner, ownProfileId) {
    const raw = await get('profiles', ownProfileId, transaction);
    if (raw) {
      const author = await profile(ownProfileId, transaction);
      if (!author) reject('公开主页信息暂时无法读取。', 'INVALID_ACCOUNT');
      return;
    }
    await write('profiles', ownProfileId, {owner, name: defaultProfileName(owner), bio: '', updatedAt: now()}, transaction);
  }

  async function retirePublication({owner, account, previous, builtin}) {
    if (!previous || previous.published !== true) return false;
    if ((previous.publicationScope || 'personal') !== scopeKey(account && account.__scope)) return false;
    if (previous.owner !== owner || previous.profileId !== profileIdFor(owner) ||
      recipeIdFor(owner, previous.sourceRecipeId) !== previous._id) reject('菜谱索引暂时无法读取。', 'INVALID_ACCOUNT');
    const generation = previous.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) reject('菜谱版本暂时无法读取。', 'INVALID_ACCOUNT');
    return db.runTransaction(async transaction => {
      const current = await get('recipes', previous._id, transaction);
      if (!current || current.published !== true) return false;
      if (current.generation !== generation) reject('菜谱刚有变化，请重新同步。', 'CONFLICT');
      await assertCommitted(transaction, owner, account);
      await write('recipes', previous._id, {owner, profileId: profileIdFor(owner),
        sourceRecipeId: previous.sourceRecipeId, published: false, generation: generation + 1, updatedAt: now(),
        publicationScope: current.publicationScope || 'personal', publicationPolicyVersion: current.publicationPolicyVersion || 0,
        ...(builtin ? {builtin: true} : {}), ...(current.source ? {source: current.source} : {})}, transaction);
      return true;
    });
  }

  async function savePublication({owner, env, recipe, account, previous, automatic, allowCreate, firstOnly = false, migratePersonal = false, isBuiltin, previewToken}) {
    if (await isBuiltin(recipe)) reject('内置菜谱仅供自己使用。', 'NOT_FOUND');
    if (recipe.source) reject('已收藏的菜谱请分享原作者的链接。', 'SOURCE_RECIPE_ONLY');
    if (account && account.__scope && account.__scope.kind === 'family' && recipe.createdBy !== owner) reject('请由添加这道菜的家人先完成同步。', 'RECIPE_AUTHOR_REQUIRED');
    const publicationScope = scopeKey(account && account.__scope);
    const id = recipe.id, ownProfileId = profileIdFor(owner), publicId = recipeIdFor(owner, id);
    const canMigratePersonal = record => migratePersonal && account && account.__scope && account.__scope.kind === 'family' &&
      account.__actor === owner && recipe.createdBy === owner && record && record.owner === owner && record.profileId === ownProfileId &&
      record.sourceRecipeId === id && (record.publicationScope || 'personal') === 'personal';
    if (migratePersonal && !canMigratePersonal(previous)) reject('菜谱关联已变化，请重新同步。', 'CONFLICT');
    if (firstOnly && previous && (previous.published === true || previous.publicationPolicyVersion === PUBLICATION_POLICY_VERSION ||
      (previous.publicationScope || 'personal') !== publicationScope && !canMigratePersonal(previous))) return {updated: false};
    if (previous && (previous.publicationScope || 'personal') !== publicationScope && !canMigratePersonal(previous)) {
      if (allowCreate) reject('这份公开菜谱属于另一个家庭，请返回原家庭查看。', 'CONFLICT');
      return {updated: false};
    }
    if (automatic && !allowCreate && (!previous || previous.published !== true)) return {updated: false};
    const author = await profile(ownProfileId);
    if (automatic && !allowCreate && !author) reject('分享资料暂时无法读取，请稍后重试。', 'INVALID_ACCOUNT');
    const fields = await shareableFields(recipe);
    const authorView = previewAuthor(author, owner);
    if (previewToken !== undefined && publicationPreviewToken({owner, account, recipe, fields, author: authorView, previous}) !== previewToken) {
      rejectStalePreview();
    }
    const generation = previous ? previous.generation : 0;
    if (!Number.isSafeInteger(generation) || generation < 0 || (previous &&
      (previous.owner !== owner || previous.profileId !== ownProfileId || previous.sourceRecipeId !== id))) {
      reject('菜谱版本暂时无法读取。', 'INVALID_ACCOUNT');
    }
    const sourceUpdatedAt = recipe.updatedAt || recipe.createdAt || 0;
    const sourcePhotoHash = recipe.photo ? hash(recipe.photo) : '';
    const unchangedPreview = previewToken === undefined || (previous && previous.sourcePhotoHash === sourcePhotoHash &&
      ['name', 'category', 'minutes', 'texture', 'ageGroups', 'ingredients', 'steps', 'imageKey', 'source']
        .every(key => JSON.stringify(previous[key]) === JSON.stringify(fields[key])));
    if (automatic && isPublished(previous, author) && previous.sourceUpdatedAt === sourceUpdatedAt && unchangedPreview && (previous.publicationScope || 'personal') === publicationScope) return {updated: false};
    let photoFileID = '';
    let copiedPhoto = '';
    if (automatic && previous && sourcePhotoHash && previous.sourcePhotoHash === sourcePhotoHash &&
      socialPhoto(previous.photoFileID, env, ownProfileId, publicId)) {
      photoFileID = previous.photoFileID;
    } else if (recipe.photo) {
      const photo = await cloud.downloadFile({fileID: recipe.photo});
      if (photo.statusCode != null && photo.statusCode !== 200) reject('照片暂时无法读取。', 'STORAGE_FAILED');
      const extension = photoExtension(photo.fileContent);
      const suffix = unique();
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(suffix)) throw new Error('Invalid random token');
      const uploaded = await cloud.uploadFile({cloudPath: `social/${ownProfileId}/${publicId}/${suffix}.${extension}`, fileContent: photo.fileContent});
      photoFileID = uploaded && uploaded.fileID;
      if (!socialPhoto(photoFileID, env, ownProfileId, publicId)) reject('照片上传失败，请重试。', 'STORAGE_FAILED');
      copiedPhoto = photoFileID;
    }
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0 || time > 9999999999999) throw new Error('Invalid clock');
    const keepOrder = automatic && previous && previous.published === true;
    const record = {
      owner, profileId: ownProfileId, sourceRecipeId: id, sourceUpdatedAt, publicationScope, publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
      ...fields, photoFileID, sourcePhotoHash,
      published: true, publishedAt: keepOrder ? previous.publishedAt : time, updatedAt: time, generation: generation + 1,
      sortKey: keepOrder ? previous.sortKey : `${String(9999999999999 - time).padStart(13, '0')}-${publicId}`
    };
    let written;
    try { written = await db.runTransaction(async transaction => {
      const current = await get('recipes', publicId, transaction);
      // Only the canonical recipe's actual author can associate their own
      // personal publication with this family. Recheck the source association
      // inside the same CAS transaction; no family-to-family migration exists.
      if (migratePersonal && !canMigratePersonal(current)) reject('菜谱关联已变化，请重新同步。', 'CONFLICT');
      // Automatic first publication must never revive a concurrent withdrawal
      // or take over a record already associated with another data scope.
      if (firstOnly && current && (current.published === true || current.publicationPolicyVersion === PUBLICATION_POLICY_VERSION ||
        (current.publicationScope || 'personal') !== publicationScope && !canMigratePersonal(current))) return false;
      if (automatic && !allowCreate && (!current || current.published !== true)) return false;
      if ((current ? current.generation : 0) !== generation) reject('菜谱刚有变化，请重新同步。', 'CONFLICT');
      await assertCommitted(transaction, owner, account);
      const currentAuthor = await profile(ownProfileId, transaction);
      if (previewToken !== undefined && (JSON.stringify(previewAuthor(currentAuthor, owner)) !== JSON.stringify(authorView) ||
        JSON.stringify(await shareableFields(recipe, transaction)) !== JSON.stringify(fields))) {
        rejectStalePreview();
      }
      if (allowCreate) await writeDefaultProfile(transaction, owner, ownProfileId);
      else if (!currentAuthor) reject('分享资料暂时无法读取，请稍后重试。', 'INVALID_ACCOUNT');
      await write('recipes', publicId, record, transaction);
      return true;
    }); } catch (error) {
      // These are our explicit pre-commit rejections. Do not delete after an
      // ambiguous transport failure: the transaction may have committed.
      if (copiedPhoto && ['CONFLICT', 'SYNC_REQUIRED', 'INVALID_ACCOUNT', 'PREVIEW_STALE', 'FAMILY_CHANGED', 'FAMILY_CONFLICT', 'INVALID_FAMILY'].includes(error && error.code) &&
        typeof cloud.deleteFile === 'function') {
        try { await cloud.deleteFile({fileList: [copiedPhoto]}); } catch (_) { /* best-effort orphan cleanup */ }
      }
      if (previewToken !== undefined && ['CONFLICT', 'SYNC_REQUIRED'].includes(error && error.code)) rejectStalePreview();
      throw error;
    }
    if (!written && copiedPhoto && typeof cloud.deleteFile === 'function') {
      try { await cloud.deleteFile({fileList: [copiedPhoto]}); } catch (_) { /* best-effort orphan cleanup */ }
    }
    return written ? {updated: true, record: {_id: publicId, ...record}} : {updated: false};
  }

  const feedback = createFeedback({cloud, db, get, write, collection, profile, isPublished, profileIdFor,
    defaultProfileName, committedSnapshot, activeRecipe, assertCommitted, publicInventory, now, unique});

  return async function handle(event) {
    const progress = {updated: 0, removed: 0};
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
      const isBuiltin = builtinChecker();
      const scopedActions = ['mine', 'previewPublication', 'familyRecipeLink', 'publish', 'updatePublished', 'unpublish', 'syncPublications',
        'follow', 'shareCode', 'recordSave', 'addCooksnap', 'deleteCooksnap'];
      let scopeState;
      if ((event.expectedScope !== undefined && !['updateProfile', 'checkProfile'].includes(event.action)) || scopedActions.includes(event.action)) {
        scopeState = await families.resolve(owner, ENV);
        families.expect(event, scopeState, false);
      }

      const assertScope = transaction => scopeState ? families.current(owner, ENV, scopeState.scope, transaction || db) : Promise.resolve();
      if (FEEDBACK_ACTIONS.has(event.action)) return await feedback(event, {owner, env: ENV, openid: OPENID, isBuiltin, assertScope,
        expectedScope: scopeState && scopeState.scope});

      if (event.action === 'familyRecipeLink') {
        if (!scopeState.family) return {publication: null};
        const {recipe, account} = await committedRecipe(owner, ENV, sourceId(event.sourceRecipeId), scopeState.scope);
        if (await isBuiltin(recipe) || !/^[a-f0-9]{64}$/.test(recipe.createdBy || '')) return {publication: null};
        const publication = await get('recipes', recipeIdFor(recipe.createdBy, recipe.id));
        const author = await profile(profileIdFor(recipe.createdBy));
        await assertCommitted(db, owner, account);
        if (!isPublished(publication, author) || (publication.publicationScope || 'personal') !== scopeKey(account.__scope)) return {publication: null};
        return {publication: {id: publication._id, sourceRecipeId: recipe.id, sourceUpdatedAt: publication.sourceUpdatedAt, createdBy: recipe.createdBy}};
      }

      if (event.action === 'mine') {
        const [ownProfile, follows] = await Promise.all([profile(ownProfileId), get('follows', owner)]);
        const [inventory, followerCount] = ownProfile ? await Promise.all([
          publicInventory(ownProfileId),
          count(followersQuery(ownProfileId))
        ]) : [{records: []}, 0];
        const published = inventory.records.filter(item => (item.publicationScope || 'personal') === scopeKey(scopeState && scopeState.scope));
        const visible = await Promise.all(published.map(async item => isPublished(item, ownProfile) && !await isBuiltin(item)));
        const ownPublished = published.filter((item, index) => visible[index]);
        return {
          profile: ownProfile ? publicProfile(ownProfile, today, true) : {id: ownProfileId, name: defaultProfileName(owner), bio: '', babyAgeMonths: null, babyBirthDate: null, exists: false},
          published: ownPublished.map(item => ({
            id: item._id, sourceRecipeId: item.sourceRecipeId, sourceUpdatedAt: item.sourceUpdatedAt
          })),
          publishedCount: ownPublished.length, followingCount: followingIds(follows).length, followerCount
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
        scopeState = await families.resolve(owner, ENV);
        families.expect(event, scopeState, false);
        const record = await db.runTransaction(async transaction => {
          await assertScope(transaction);
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
            await assertScope(transaction);
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

      if (event.action === 'syncPublications') {
        const knownAccount = scopeState.family || await get('accounts', owner);
        if (!knownAccount) return {...progress, hasMore: false};
        if (!scopeState.family && Number.isSafeInteger(knownAccount.revision) && knownAccount.revision > 0 &&
          ownedFile(knownAccount.fileID, ENV, owner, 'snapshots') &&
          knownAccount.publicationPolicyVersion === PUBLICATION_POLICY_VERSION &&
          knownAccount.publicationRevision === knownAccount.revision) return {...progress, hasMore: false};
        const {snapshot, account} = await committedSnapshot(owner, ENV, false, knownAccount, scopeState.scope);
        const {records: allExisting, hasMore: inventoryHasMore} = await publicInventory(ownProfileId, true, scopeState.family ? scopeKey(account.__scope) : undefined);
        const existing = allExisting.filter(item => (item.publicationScope || 'personal') === scopeKey(account.__scope));
        // Register all known starter identities before following any saved-copy
        // source. Historical records omitted isExample; retain that knowledge
        // when retiring them so copies in other accounts remain identifiable.
        for (const recipe of snapshot.data.recipes) {
          if (recipe.isExample === true || isBuiltinRecipeId(recipe.id)) isBuiltin.markBuiltin(recipeIdFor(owner, recipe.id));
        }
        const eligible = new Map();
        for (const recipe of snapshot.data.recipes) {
          if (activeRecipe(snapshot, recipe.id) && !recipe.source && !await isBuiltin(recipe)) eligible.set(recipe.id, recipe);
        }
        const indexed = new Map(existing.map(item => [item.sourceRecipeId, item]));
        const work = [];
        for (const previous of existing) {
          if ((!scopeState.family && previous.owner !== owner) || !/^[a-f0-9]{64}$/.test(previous.owner || '') || recipeIdFor(previous.owner, previous.sourceRecipeId) !== previous._id) {
            reject('菜谱索引暂时无法读取。', 'INVALID_ACCOUNT');
          }
          const builtin = await isBuiltin(previous);
          if (builtin || !eligible.has(previous.sourceRecipeId) || (scopeState.family && eligible.get(previous.sourceRecipeId).createdBy !== previous.owner)) work.push({previous, builtin});
        }
        const authors = new Map();
        const authorFor = async id => { if (!authors.has(id)) authors.set(id, profile(profileIdFor(id))); return authors.get(id); };
        for (const recipe of eligible.values()) {
          // At most one extra candidate is needed to signal another batch.
          if (work.length > PUBLICATION_BATCH_SIZE) break;
          const previous = indexed.get(recipe.id);
          if (previous && (!scopeState.family || recipe.createdBy === previous.owner) && (!isPublished(previous, await authorFor(previous.owner)) || await isBuiltin(previous) ||
            previous.sourceUpdatedAt !== (recipe.updatedAt || recipe.createdAt || 0))) work.push({recipe, previous, publicationOwner: previous.owner});
          else if (!previous && (!scopeState.family || recipe.createdBy === owner)) {
            // Family author stamps come from canonical snapshots. A member may
            // first-publish their own recipes, never manufacture another
            // member's public identity. Existing shared recipes remain editable
            // by all current members through the update-only path above.
            const record = await get('recipes', recipeIdFor(owner, recipe.id));
            if (!record || (record.published === false && record.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION &&
              (record.publicationScope || 'personal') === scopeKey(account.__scope))) {
              work.push({recipe, previous: record, publicationOwner: owner, firstOnly: true});
            } else if (scopeState.family && record.owner === owner && (record.publicationScope || 'personal') === 'personal' &&
              (record.published === true || record.published === false && record.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION)) {
              work.push({recipe, previous: record, publicationOwner: owner, migratePersonal: true, firstOnly: record.published !== true});
            }
          }
        }
        for (const item of work.slice(0, PUBLICATION_BATCH_SIZE)) {
          if (!item.recipe) {
            if (await retirePublication({owner: item.previous.owner, account, previous: item.previous, builtin: item.builtin})) progress.removed++;
          } else {
            const publicationOwner = item.publicationOwner;
            const previous = await get('recipes', recipeIdFor(publicationOwner, item.recipe.id));
            const saved = await savePublication({owner: publicationOwner, env: ENV, recipe: item.recipe, account, previous,
              automatic: true, allowCreate: item.firstOnly === true, firstOnly: item.firstOnly === true,
              migratePersonal: item.migratePersonal === true, isBuiltin});
            if (saved.updated) progress.updated++;
          }
        }
        const hasMore = inventoryHasMore || work.length > PUBLICATION_BATCH_SIZE;
        if (!hasMore && !scopeState.family) {
          await db.runTransaction(async transaction => {
            const current = await assertCommitted(transaction, owner, account);
            const {_id, ...data} = current;
            await write('accounts', owner, {...data, publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
              publicationRevision: current.revision}, transaction);
          });
        }
        return {...progress, hasMore};
      }

      if (event.action === 'previewPublication') {
        const id = sourceId(event.sourceRecipeId);
        if (isBuiltinRecipeId(id)) reject('内置菜谱仅供自己使用。', 'NOT_FOUND');
        const {recipe, account} = await committedRecipe(owner, ENV, id, scopeState.scope);
        if (await isBuiltin(recipe)) reject('内置菜谱仅供自己使用。', 'NOT_FOUND');
        if (account.__scope && account.__scope.kind === 'family' && recipe.createdBy !== owner) reject('请由添加这道菜的家人先完成同步。', 'RECIPE_AUTHOR_REQUIRED');
        const previous = await get('recipes', recipeIdFor(owner, id));
        const author = await profile(ownProfileId);
        const authorView = previewAuthor(author, owner);
        const fields = await shareableFields(recipe);
        let photoURL = '';
        if (recipe.photo) {
          // This owner-only URL previews the actual saved photograph. Nothing
          // is copied to a shared location before explicit confirmation.
          const response = await cloud.getTempFileURL({fileList: [{fileID: recipe.photo, maxAge: PHOTO_TTL}]});
          const file = response && response.fileList && response.fileList[0];
          if (!file || file.fileID !== recipe.photo || (file.status != null && file.status !== 0) ||
            typeof file.tempFileURL !== 'string' || !/^https:\/\//.test(file.tempFileURL)) {
            reject('照片预览暂时无法读取，请稍后重试。', 'STORAGE_FAILED');
          }
          photoURL = file.tempFileURL;
        }
        await assertCommitted(db, owner, account);
        if (JSON.stringify(previewAuthor(await profile(ownProfileId), owner)) !== JSON.stringify(authorView)) rejectStalePreview();
        const current = await get('recipes', recipeIdFor(owner, id));
        if ((current ? current.generation : 0) !== (previous ? previous.generation : 0)) rejectStalePreview();
        return {recipe: {id: recipeIdFor(owner, id), profileId: ownProfileId, authorName: authorView.name,
          ...fields, photoURL, updatedAt: recipe.updatedAt || recipe.createdAt || 0,
          publishedAt: previous && previous.publishedAt || 0}, author: authorView,
        previewToken: publicationPreviewToken({owner, account, recipe, fields, author: authorView, previous}),
        alreadyPublished: isPublished(previous, author) && (previous.publicationScope || 'personal') === scopeKey(account.__scope)};
      }

      if (event.action === 'publish' || event.action === 'updatePublished') {
        const automatic = event.action === 'updatePublished';
        const id = sourceId(event.sourceRecipeId);
        if (isBuiltinRecipeId(id)) reject('内置菜谱仅供自己使用。', 'NOT_FOUND');
        if (!automatic && event.previewToken !== undefined && (typeof event.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(event.previewToken))) {
          reject('分享参数不正确，请刷新后重试。', 'INVALID_REQUEST');
        }
        const previous = await get('recipes', recipeIdFor(owner, id));
        // Old update-only clients retain their narrower operation. Current
        // clients use syncPublications for automatic first publication too.
        if (automatic && (!previous || previous.published !== true)) return {updated: false};
        const {recipe, account} = await committedRecipe(owner, ENV, id, scopeState.scope);
        if (recipe.source) {
          // A saved public recipe is already shareable under its original
          // author. Returning that link avoids duplicate publications even
          // when an older client still calls publish for a saved copy.
          if (automatic) return {updated: false};
          const source = await get('recipes', recipe.source.recipeId);
          const original = source && source.profileId === recipe.source.profileId && await renderRecipe(source, ENV, undefined, isBuiltin);
          await assertCommitted(db, owner, account);
          if (!original) reject('原作者的菜谱暂时不可用。', 'NOT_FOUND');
          return {recipe: original};
        }
        const saved = await savePublication({owner, env: ENV, recipe, account, previous,
          automatic: true, allowCreate: !automatic, isBuiltin,
          migratePersonal: !automatic && Boolean(account.__scope && account.__scope.kind === 'family' && previous && (previous.publicationScope || 'personal') === 'personal'),
          ...(automatic ? {} : {previewToken: event.previewToken})});
        if (!saved.updated && automatic) return {updated: false};
        const rendered = await renderRecipe(saved.record || previous, ENV, undefined, isBuiltin);
        if (!rendered) reject('菜谱刚有变化，请重新同步。', 'CONFLICT');
        return automatic ? {updated: true, recipe: rendered} : {recipe: rendered};
      }

      if (event.action === 'unpublish') {
        const sourceRecipeId = sourceId(event.sourceRecipeId);
        const {snapshot, account} = await committedSnapshot(owner, ENV, true, undefined, scopeState.scope);
        const recipe = activeRecipe(snapshot, sourceRecipeId);
        const previous = await get('recipes', recipeIdFor(owner, sourceRecipeId));
        if (previous && (previous.publicationScope || 'personal') !== scopeKey(account && account.__scope)) reject('当前家庭中没有这份分享。', 'NOT_FOUND');
        await retirePublication({owner, account, previous, builtin: await isBuiltin(recipe || previous)});
        return {ok: true};
      }

      if (event.action === 'follow') {
        if (!isProfileId(event.profileId) || typeof event.following !== 'boolean') reject('请选择有效的主页。', 'INVALID_REQUEST');
        if (event.profileId === ownProfileId) reject('不能关注自己的主页。', 'INVALID_REQUEST');
        return await db.runTransaction(async transaction => {
          await assertScope(transaction);
          const ids = followingIds(await get('follows', owner, transaction));
          const author = await profile(event.profileId, transaction);
          if (event.following && !author) reject('这个主页暂时不可用。', 'NOT_FOUND');
          const reverse = await followedBy(author, ownProfileId, transaction);
          const exists = ids.includes(event.profileId);
          if (event.following) {
            if (!exists && ids.length >= MAX_FOLLOWS) reject('最多可关注 200 位朋友。', 'FOLLOW_LIMIT');
            const ownRecord = await get('profiles', ownProfileId, transaction);
            if (!ownRecord) {
              // Following uses the same safe default name already shown in mine.
              // Create it atomically with the relationship so followers can follow
              // back, without copying private account or baby information.
              await write('profiles', ownProfileId, {owner, name: defaultProfileName(owner), bio: '', updatedAt: now()}, transaction);
            } else if (!await profile(ownProfileId, transaction)) {
              reject('账号资料暂时无法读取，请稍后重试。', 'INVALID_ACCOUNT');
            }
          }
          if (exists === event.following) return {following: exists, followedBy: reverse};
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
          // Older unnamed accounts stay hidden until they save a profile or
          // actively follow again, which creates their default profile.
          if (!author) return null;
          return {...publicProfile(author, today), following: ids.includes(author._id), followedBy: true};
        }))).filter(Boolean);
        const nextOffset = offset + PAGE_SIZE;
        return {profiles, nextOffset: records.length > PAGE_SIZE ? nextOffset : null};
      }

      if (event.action === 'profile' || event.action === 'profileSummary') {
        if (!isProfileId(event.profileId)) reject('主页链接不正确。', 'INVALID_REQUEST');
        const offset = pageOffset(event.offset);
        const author = await profile(event.profileId);
        if (!author) reject('这个主页暂时不可用。', 'NOT_FOUND');
        if (event.action === 'profileSummary') {
          const isSelf = author._id === ownProfileId;
          const [authorFollows, ownFollows] = isSelf ? [null, null] : await Promise.all([
            get('follows', author.owner), get('follows', owner)
          ]);
          return {profile: publicProfile(author, today, isSelf), isSelf,
            following: !isSelf && followingIds(ownFollows).includes(author._id),
            followedBy: !isSelf && followingIds(authorFollows).includes(ownProfileId)};
        }
        const [rendered, authorFollows, ownFollows, followerCount, publishedCount] = await Promise.all([
          collection('recipes').where({profileId: author._id, published: true})
            .orderBy('sortKey', 'asc').skip(offset).limit(PAGE_SIZE + 1).get().then(async ({data: records}) => ({
              records, page: await renderPage(records.slice(0, PAGE_SIZE), ENV, [[author._id, author]], isBuiltin)
            })),
          get('follows', author.owner),
          author.owner === owner ? null : get('follows', owner),
          count(followersQuery(author._id)),
          publicInventory(author._id).then(async ({records}) => (await Promise.all(records.map(async item =>
            isPublished(item, author) && !await isBuiltin(item)))).filter(Boolean).length)
        ]);
        const {records, page} = rendered;
        const authorFollowing = followingIds(authorFollows);
        const ownFollowing = author.owner === owner ? authorFollowing : followingIds(ownFollows);
        return {profile: publicProfile(author, today, author._id === ownProfileId), isSelf: author._id === ownProfileId,
          following: author.owner !== owner && ownFollowing.includes(author._id),
          followedBy: author.owner !== owner && authorFollowing.includes(ownProfileId),
          followingCount: authorFollowing.length,
          followerCount, publishedCount,
          recipes: page.recipes,
          nextOffset: records.length > page.consumed ? offset + page.consumed : null};
      }

      if (event.action === 'recipe') {
        if (!isRecipeId(event.recipeId)) reject('菜谱链接不正确。', 'INVALID_REQUEST');
        const record = await get('recipes', event.recipeId);
        const author = record && await profile(record.profileId);
        if (!isPublished(record, author)) reject('这道菜谱已取消公开或不存在。', 'NOT_FOUND');
        const recipe = await renderRecipe(record, ENV, author, isBuiltin);
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
        const page = await renderPage(records.slice(0, PAGE_SIZE), ENV, [], isBuiltin);
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
        // Fetch at most five candidates ahead. Consume completed results in
        // index order so a byte-limited page never skips a prefetched recipe.
        discovery: for (let start = 0; start < candidates.length; start += DISCOVERY_CONCURRENCY) {
          const batch = await Promise.all(candidates.slice(start, start + DISCOVERY_CONCURRENCY).map(async item => {
            try {
              if (!SORT_KEY_PATTERN.test(item.sortKey || '') || item.sortKey.slice(14) !== item._id) {
                throw new Error('Invalid public index');
              }
              const author = authors.get(item.profileId);
              let result = null;
              if (isPublished(item, author) && matchesSearch(item, author, search)) {
                const latest = await get('recipes', item._id);
                if (latest && latest.sortKey === item.sortKey && matchesSearch(latest, author, search)) {
                  result = await renderRecipe(latest, ENV, author, isBuiltin);
                }
              }
              return {result};
            } catch (error) {
              // Errors from speculative rows belong to the page that consumes
              // them, just like the previous sequential scan.
              return {error};
            }
          }));
          for (const entry of batch) {
            if (Object.hasOwn(entry, 'error')) throw entry.error;
            const result = entry.result;
            const size = result ? Buffer.byteLength(JSON.stringify(result), 'utf8') + 1 : 0;
            if (recipes.length && bytes + size > MAX_PAGE_BYTES) break discovery;
            consumed += 1;
            if (result) { recipes.push(result); bytes += size; }
            if (recipes.length >= PAGE_SIZE) break discovery;
          }
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
        'PROFILE_BIO_REJECTED', 'PROFILE_MODERATION_UNAVAILABLE', 'SELF_FEEDBACK', 'INVALID_COOKSNAP',
        'INVALID_COOKSNAP_PHOTO', 'COOKSNAP_TEXT_REJECTED', 'COOKSNAP_PHOTO_REJECTED',
        'COOKSNAP_MODERATION_UNAVAILABLE', 'FEEDBACK_NOT_SAVED', 'CLIENT_UPDATE_REQUIRED', 'PREVIEW_REQUIRED', 'PREVIEW_STALE',
        'FAMILY_CHANGED', 'INVALID_FAMILY', 'FAMILY_CONFLICT', 'RECIPE_AUTHOR_REQUIRED', 'SOURCE_RECIPE_ONLY']);
      const extra = event && event.action === 'syncPublications' ? {...progress, hasMore: true} : {};
      if (allowed.has(error && error.code)) return {...extra, error: {code: error.code, message: error.message}};
      return {...extra, error: {code: 'SOCIAL_FAILED', message: '暂时无法完成，请稍后重试。'}};
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
