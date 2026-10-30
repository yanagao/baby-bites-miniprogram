'use strict';

const {reject} = require('./private-snapshot');
const TIMEOUT_MS = 8000;
const UNAVAILABLE = '内容审核暂时不可用，资料尚未保存，请稍后重试。';

function rejected(field) {
  reject(field === 'name' ? '昵称未通过内容审核，请修改后重试。' : '简介未通过内容审核，请修改后重试。',
    field === 'name' ? 'PROFILE_NAME_REJECTED' : 'PROFILE_BIO_REJECTED');
}

async function checkField(cloud, openid, field, content) {
  let response, timer;
  try {
    const security = cloud.openapi && cloud.openapi.security;
    if (!security || typeof security.msgSecCheck !== 'function') throw Error('Moderation unavailable');
    const request = {openid, version: 2, scene: 1, content};
    if (field === 'name') request.nickname = content;
    else request.signature = content;
    response = await Promise.race([
      security.msgSecCheck(request),
      new Promise((_, fail) => { timer = setTimeout(() => fail(Error('Moderation timeout')), TIMEOUT_MS); })
    ]);
  } catch (error) {
    if (error && [error.errCode, error.errcode].some(code => code === 87014 || code === '87014')) rejected(field);
    reject(UNAVAILABLE, 'PROFILE_MODERATION_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
  // Cloud SDK versions use either errCode or errcode. Require an explicit
  // successful response and the v2 aggregate verdict; an empty v1 result cannot pass.
  const codes = response && [response.errCode, response.errcode].filter(code => code !== undefined);
  if (codes && codes.some(code => code === 87014 || code === '87014')) rejected(field);
  if (!codes || !codes.length || !codes.every(code => code === 0 || code === '0')) {
    reject(UNAVAILABLE, 'PROFILE_MODERATION_UNAVAILABLE');
  }
  const verdict = response.result && response.result.suggest;
  if (verdict === 'risky' || verdict === 'review') rejected(field);
  if (verdict !== 'pass') reject(UNAVAILABLE, 'PROFILE_MODERATION_UNAVAILABLE');
}

async function checkProfile(cloud, openid, profile) {
  // Complete moderation before starting any database transaction. Only public
  // text is sent; birthdays and private baby nicknames never enter this request.
  await checkField(cloud, openid, 'name', profile.name);
  if (profile.bio) await checkField(cloud, openid, 'bio', profile.bio);
}

module.exports = {checkProfile};
