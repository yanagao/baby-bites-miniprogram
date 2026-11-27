'use strict';

// Keep this order stable: a public profile ID selects the same mascot on every device.
const avatars = [
  '/assets/cute/avatar-broccoli.png',
  '/assets/cute/avatar-pea.png',
  '/assets/cute/pantry-bowl.png',
  '/assets/cute/avatar-eggplant.png',
  '/assets/cute/pocket-mascot.png'
];
const fallback = avatars[4];

function isSafeAvatarURL(value) {
  return typeof value === 'string' && value.length <= 8000 && !/[\s\\\u0000-\u001f\u007f]/.test(value) &&
    /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?(?:[/?#]|$)/i.test(value);
}

function getProfileAvatar(profileId, avatarURL) {
  if (isSafeAvatarURL(avatarURL)) return avatarURL;
  if (typeof profileId !== 'string' || !/^[a-f0-9]{32}$/i.test(profileId)) return fallback;
  // Reduce each hex digit before reading the next, avoiding 128-bit precision loss.
  let remainder = 0;
  for (let index = 0; index < profileId.length; index++) {
    remainder = (remainder * 16 + parseInt(profileId[index], 16)) % avatars.length;
  }
  return avatars[remainder];
}

module.exports = {getProfileAvatar, isSafeAvatarURL};
