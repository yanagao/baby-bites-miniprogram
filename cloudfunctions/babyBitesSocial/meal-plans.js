'use strict';

const catalog = require('./meal-plan-catalog');
const ACTIONS = new Set(['profileMealPlans', 'mealPlan', 'shareMealPlan']);
const MEALS = [{meal: 'breakfast', label: '早餐'}, {meal: 'lunch', label: '午餐'}, {meal: 'dinner', label: '晚餐'}];
const PAGE_SIZE = 20;
const MAX_OFFSET = 3000;
const version = value => value && (value.updatedAt || value.createdAt || 0);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number), date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1000 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function createMealPlans({get, profile, profileIdFor, recipeIdFor, isPublished, renderRecipe, committedSnapshot,
  activeRecipe, publicProfile, scopeKey, isProfileId, pageOffset, reject, assertCommitted, ensureProfile}) {
  return async function handle(event, {owner, env, today, isBuiltin, assertScope, expectedScope}) {
    const sharing = event.action === 'shareMealPlan', listing = event.action === 'profileMealPlans';
    if (sharing ? event.profileId !== undefined : !isProfileId(event.profileId)) reject('主页链接不正确。', 'INVALID_REQUEST');
    const offset = listing ? pageOffset(event.offset, MAX_OFFSET) : 0;
    if (!listing && !validDate(event.date)) reject('餐单日期不正确。', 'INVALID_REQUEST');
    let author = sharing ? null : await profile(event.profileId);
    if (!sharing && !author) reject('这个主页暂时不可用。', 'NOT_FOUND');
    const targetOwner = sharing ? owner : author.owner;
    const {snapshot, account} = await committedSnapshot(targetOwner, env, true, undefined,
      sharing ? expectedScope : undefined, !sharing);
    const deleted = new Map((snapshot.deleted.mealPlans || []).map(plan => [plan.id, plan.updatedAt]));
    const days = new Map();
    for (const plan of snapshot.data.mealPlans || []) {
      if (deleted.has(plan.id) && deleted.get(plan.id) >= version(plan)) continue;
      if (!listing && plan.date !== event.date) continue;
      if (!days.has(plan.date)) days.set(plan.date, new Map());
      days.get(plan.date).set(plan.meal, plan);
    }
    const dates = [...days.keys()].sort().reverse();
    if (!listing && !dates.length) reject('这一天还没有已确认的餐单。', 'NOT_FOUND');
    const selected = listing ? dates.slice(offset, offset + PAGE_SIZE) : dates;
    const scope = account && account.__scope;
    const family = scope && scope.kind === 'family';
    const summaries = new Map();

    async function summary(recipe) {
      if (!recipe) return null;
      // A fixed ID points to the immutable public original. Never send a local
      // edit, private photo or private cooking note with this link.
      if (hasOwn(catalog, recipe.id)) return {...catalog[recipe.id], photoURL: '', kind: 'builtin'};
      if (await isBuiltin(recipe)) return null;
      let publication, publicationAuthor;
      if (recipe.source) {
        const stableCopy = /^shared-([a-f0-9]{64})$/.exec(recipe.id);
        if (stableCopy && stableCopy[1] !== recipe.source.recipeId) return null;
        publication = await get('recipes', recipe.source.recipeId);
        publicationAuthor = await profile(recipe.source.profileId);
        if (!publication || publication.profileId !== recipe.source.profileId) return null;
      } else {
        // Legacy family authors are not attested until the owner's next sync.
        // Public visitors must neither migrate that private data nor trust it.
        if (family && account.attributionV1Revision !== account.revision) return null;
        const creator = family ? recipe.createdBy : targetOwner;
        if (typeof creator !== 'string' || !/^[a-f0-9]{64}$/.test(creator)) return null;
        publication = await get('recipes', recipeIdFor(creator, recipe.id));
        publicationAuthor = await profile(profileIdFor(creator));
        if (!publication || publication.sourceRecipeId !== recipe.id ||
          (publication.publicationScope || 'personal') !== scopeKey(scope)) return null;
      }
      if (!isPublished(publication, publicationAuthor)) return null;
      const rendered = await renderRecipe(publication, env, publicationAuthor, isBuiltin);
      return rendered ? {id: rendered.id, name: rendered.name, minutes: rendered.minutes,
        texture: rendered.texture, imageKey: rendered.imageKey, photoURL: rendered.photoURL, kind: 'public'} : null;
    }

    const ids = [...new Set(selected.flatMap(date => [...days.get(date).values()].map(plan => plan.recipeId)))];
    // A page contains at most 60 recipes. Limit parallel storage/signing work
    // and resolve a recipe used on several dates only once in this request.
    for (let index = 0; index < ids.length; index += 5) {
      await Promise.all(ids.slice(index, index + 5).map(async id => {
        summaries.set(id, await summary(activeRecipe(snapshot, id)));
      }));
    }
    const rendered = selected.map(date => ({date, meals: MEALS.filter(({meal}) => days.get(date).has(meal)).map(({meal, label}) =>
      ({meal, label, recipe: summaries.get(days.get(date).get(meal).recipeId) || null}))}));

    await assertScope();
    if (sharing) author = await ensureProfile(owner, account);
    else author = await profile(author._id);
    if (!author) reject('这个主页暂时不可用。', 'NOT_FOUND');
    // Author/profile reads can also await storage. Check the source revision
    // after every projection await, immediately before returning this view.
    await assertCommitted(targetOwner, account, !sharing);
    if (listing) return {days: rendered, nextOffset: offset + PAGE_SIZE < dates.length ? offset + PAGE_SIZE : null};
    return {author: publicProfile(author, today), date: event.date, meals: rendered[0].meals};
  };
}

module.exports = {ACTIONS, createMealPlans};
