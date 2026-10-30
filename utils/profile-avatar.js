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

function getProfileAvatar(profileId) {
  if (typeof profileId !== 'string' || !/^[a-f0-9]{32}$/i.test(profileId)) return fallback;
  // Reduce each hex digit before reading the next, avoiding 128-bit precision loss.
  let remainder = 0;
  for (let index = 0; index < profileId.length; index++) {
    remainder = (remainder * 16 + parseInt(profileId[index], 16)) % avatars.length;
  }
  return avatars[remainder];
}

module.exports = {getProfileAvatar};
