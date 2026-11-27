'use strict';

const {isBuiltInRecipe} = require('./recipe-origin');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const localId = value => typeof value === 'string' && value.length <= 100 && Boolean(value.trim()) &&
  !/[\u0000-\u001f\u007f]/.test(value);

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));

// Mini Programs have neither Node crypto nor a guaranteed TextEncoder. Encode
// invalid UTF-16 as U+FFFD, matching Node's UTF-8 hashing on the server.
function utf8(value) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    const next = value.charCodeAt(i + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      code = 0x10000 + ((code - 0xd800) << 10) + next - 0xdc00;
      i++;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | code >>> 6, 0x80 | code & 0x3f);
    else if (code < 0x10000) bytes.push(0xe0 | code >>> 12, 0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
    else bytes.push(0xf0 | code >>> 18, 0x80 | code >>> 12 & 0x3f, 0x80 | code >>> 6 & 0x3f, 0x80 | code & 0x3f);
  }
  return bytes;
}

function sha256(value) {
  const bytes = utf8(value), bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (const word of [Math.floor(bitLength / 0x100000000), bitLength >>> 0]) {
    bytes.push(word >>> 24 & 0xff, word >>> 16 & 0xff, word >>> 8 & 0xff, word & 0xff);
  }
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const start = offset + i * 4;
      words[i] = (bytes[start] << 24 | bytes[start + 1] << 16 | bytes[start + 2] << 8 | bytes[start + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3;
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10;
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = e & f ^ ~e & g;
      const t1 = (h + s1 + choose + ROUND_CONSTANTS[i] + words[i]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const t2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const block = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < hash.length; i++) hash[i] = (hash[i] + block[i]) >>> 0;
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('');
}

function publicRecipeId(creator, id) {
  if (!id64(creator) || !localId(id)) return '';
  return sha256('public-recipe:' + creator + ':' + id);
}

function matchesPublicRecipe(recipe, publicId, syncInfo) {
  if (!object(recipe) || !localId(recipe.id) || !id64(publicId) || isBuiltInRecipe(recipe)) return false;
  // Imported recipes retain their original identity after renaming or editing.
  if (recipe.source != null) return object(recipe.source) && recipe.source.recipeId === publicId;
  if (!object(syncInfo) || !id64(syncInfo.owner)) return false;
  const scope = syncInfo.scope;
  if (scope != null && (!object(scope) || !['personal', 'family'].includes(scope.kind))) return false;
  if (scope && scope.kind === 'personal' && scope.id != null && scope.id !== syncInfo.owner) return false;
  // Family creation attribution is verified by synchronization; a missing
  // author must not be guessed from whichever family member is viewing it.
  const creator = scope && scope.kind === 'family' ? recipe.createdBy : syncInfo.owner;
  return publicRecipeId(creator, recipe.id) === publicId;
}

module.exports = {publicRecipeId, matchesPublicRecipe};
