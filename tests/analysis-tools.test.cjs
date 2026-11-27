'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {fakeEnvironment, snapshot, ownerFor, fileFor, ENV} = require('./helpers/analysis-cloud.cjs');

const version = '2026-07-28';
const legacyVersion = '2025-11-25';
const namespace = 'io.modelcontextprotocol/';
const apiBase = 'https://analysis.example.test/baby-bites-ai';
const toolName = 'get_feeding_context';

function rpc(method, params = {}, {token, modern = true, id = 1, path = '/mcp'} = {}) {
  const headers = {Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json'};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (modern) {
    headers['MCP-Protocol-Version'] = version;
    headers['Mcp-Method'] = method;
    if (method === 'tools/call') headers['Mcp-Name'] = params.name;
    params = {...params, _meta: {[namespace + 'protocolVersion']: version, [namespace + 'clientCapabilities']: {}}};
  } else if (method !== 'initialize') {
    headers['MCP-Protocol-Version'] = legacyVersion;
  }
  const message = {jsonrpc: '2.0', method, params};
  if (id !== null) message.id = id;
  return {httpMethod: 'POST', path, headers, body: JSON.stringify(message)};
}

function call(token, args = {}, options = {}) {
  return rpc('tools/call', {name: toolName, arguments: args}, {token, ...options});
}

test('public OpenAPI can be imported from either gateway path and advertises only the first-party authenticated GET', async () => {
  const app = fakeEnvironment();
  const handle = app.toolsHandler();
  app.context({ENV});
  for (const path of ['/openapi.json', '/baby-bites-tools/openapi.json']) {
    const response = await handle({httpMethod: 'GET', path, headers: {Host: 'ignored.example.test'}});
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['Content-Type'], /application\/json/);
    const spec = JSON.parse(response.body);
    assert.equal(spec.openapi, '3.0.3');
    assert.deepEqual(spec.servers.map(server => server.url), [apiBase]);
    assert.deepEqual(Object.keys(spec.paths), ['/v1/feeding-context']);
    assert.deepEqual(Object.keys(spec.paths['/v1/feeding-context']), ['get']);
    const get = spec.paths['/v1/feeding-context'].get;
    assert.equal(get.operationId, 'getFeedingContext');
    assert.deepEqual(get.security, [{BabyReadToken: []}]);
    assert.equal(spec.components.securitySchemes.BabyReadToken.scheme, 'bearer');
  }
  assert.equal((await handle({httpMethod: 'POST', path: '/openapi.json'})).statusCode, 405);
  for (const path of ['/', '/v1/feeding-context', '/mcp/extra']) {
    assert.equal((await handle({httpMethod: 'GET', path})).statusCode, 404);
  }
  assert.equal(app.writes, 0);
  assert.deepEqual(app.downloads, []);
});

test('modern MCP discovery works without a handshake or private reads and lists only the read-only tool', async () => {
  const app = fakeEnvironment();
  const handle = app.toolsHandler();
  const response = await handle(rpc('server/discover', {}, {path: '/baby-bites-tools/mcp', id: 'discovery'}));
  assert.equal(response.statusCode, 200);
  const discovery = JSON.parse(response.body);
  assert.equal(discovery.id, 'discovery');
  assert.equal(discovery.result.resultType, 'complete');
  assert.ok(discovery.result.supportedVersions.includes(version));
  assert.ok(discovery.result.supportedVersions.includes(legacyVersion));
  assert.deepEqual(Object.keys(discovery.result.capabilities), ['tools']);
  const future = rpc('server/discover');
  const offered = '2099-01-01';
  const message = JSON.parse(future.body);
  message.params._meta[namespace + 'protocolVersion'] = offered;
  future.headers['MCP-Protocol-Version'] = offered;
  const unsupported = await handle({...future, body: JSON.stringify(message)});
  assert.equal(unsupported.statusCode, 400);
  const {error} = JSON.parse(unsupported.body);
  assert.equal(error.code, -32022);
  assert.deepEqual(error.data.supported, discovery.result.supportedVersions);
  assert.equal(error.data.requested, offered);
  const {result} = JSON.parse((await handle(rpc('tools/list'))).body);
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.tools.map(tool => tool.name), [toolName]);
  const [tool] = result.tools;
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['days', 'endDate', 'limit', 'offset', 'revision', 'startDate']);
  assert.equal(app.writes, 0);
  assert.deepEqual(app.downloads, []);
});

test('legacy MCP initializes, acknowledges its notification, lists tools and reads the same seven-day data as modern MCP', async () => {
  const app = fakeEnvironment();
  const handle = app.toolsHandler();
  const data = snapshot();
  data.data.logs.push({...data.data.logs[0], id: 'old-log', date: '2026-11-20'});
  app.seed('alice', data);
  const {token} = await app.internal('createGrant');
  app.context({ENV});
  const initialized = await handle(rpc('initialize', {protocolVersion: legacyVersion, capabilities: {},
    clientInfo: {name: 'fixture', version: '1'}}, {modern: false}));
  assert.equal(initialized.statusCode, 200);
  assert.equal(JSON.parse(initialized.body).result.protocolVersion, legacyVersion);
  const ack = await handle(rpc('notifications/initialized', {}, {modern: false, id: null}));
  assert.equal(ack.statusCode, 202);
  assert.equal(ack.body, '');
  const listed = await handle(rpc('tools/list', {}, {modern: false}));
  assert.deepEqual(JSON.parse(listed.body).result.tools.map(tool => tool.name), [toolName]);

  const expected = JSON.parse((await app.http(token, {queryStringParameters: {days: '7'}})).body);
  assert.equal(expected.period.days, 7);
  assert.equal(expected.records.length, 1);
  assert.equal(expected.records[0].recipe.name, '南瓜粥');
  for (const modern of [false, true]) {
    const response = await handle(call(token, {days: 7}, {modern}));
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    const {result} = JSON.parse(response.body);
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
    for (const sensitive of [token, ownerFor(), fileFor(), 'PRIVATE BABY NAME', 'PRIVATE RECIPE NOTE', 'private-log-id', '2026-01-27']) {
      assert.equal(response.body.includes(sensitive), false, sensitive);
    }
  }
  assert.equal(app.grantRecord().dayCount, 3);
});

test('MCP denies unauthenticated and revoked reads without loading any private snapshots', async () => {
  const app = fakeEnvironment();
  const handle = app.toolsHandler();
  const {token} = await app.internal('createGrant');
  const duplicate = call(token);
  duplicate.headers.authorization = 'Bearer ' + token;
  const misplaced = call(undefined, {token});
  const query = {...call(undefined), queryStringParameters: {token}};
  assert.equal((await handle(query)).statusCode, 400);
  for (const request of [call(undefined), misplaced, duplicate]) {
    assert.equal((await handle(request)).statusCode, 401);
  }
  assert.equal((await app.internal('revokeGrant')).revoked, true);
  const denied = await handle(call(token));
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body.includes('南瓜粥'), false);
  assert.deepEqual(app.downloads, []);
});

test('revoking during a download or changing family scope prevents MCP from returning records', async () => {
  const app = fakeEnvironment();
  const handle = app.toolsHandler();
  const {token} = await app.internal('createGrant');
  app.onDownload(async () => { assert.equal((await app.internal('revokeGrant')).revoked, true); });
  const response = await handle(call(token));
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.includes('南瓜粥'), false);
  assert.equal(app.downloads.length, 1);

  app.tick(5000);
  const personal = await app.internal('createGrant');
  app.joinFamily();
  assert.equal((await handle(call(personal.token))).statusCode, 401);
  assert.equal(app.downloads.length, 1);
});

test('modern MCP checks request headers, protocol metadata and origins before returning records', async () => {
  const app = fakeEnvironment();
  const {token} = await app.internal('createGrant');
  const handle = app.toolsHandler();
  const invalidOrigin = call(token);
  invalidOrigin.headers.Origin = 'https://untrusted.example.test';
  assert.equal((await handle(invalidOrigin)).statusCode, 403);
  for (const [header, value] of [['Mcp-Name', 'another_tool'], ['Mcp-Method', 'tools/list'], ['MCP-Protocol-Version', legacyVersion]]) {
    const request = call(token);
    request.headers[header] = value;
    const response = await handle(request);
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error.code, -32020);
  }
  const request = call(token);
  const message = JSON.parse(request.body);
  delete message.params._meta[namespace + 'clientCapabilities'];
  const invalidMeta = await handle({...request, body: JSON.stringify(message)});
  assert.equal(invalidMeta.statusCode, 400);
  assert.equal(JSON.parse(invalidMeta.body).error.code, -32602);
  assert.deepEqual(app.downloads, []);
});

test('tools gateway exposes no management calls and rejects unknown tools or argument fields before reading data', async () => {
  const app = fakeEnvironment();
  const {token} = await app.internal('createGrant');
  const before = app.grantRecord();
  const handle = app.toolsHandler();
  for (const action of ['createGrant', 'revokeGrant']) {
    const direct = await handle({action, protocolVersion: 2, expectedOwner: ownerFor(), expectedScope: app.scopeFor()});
    assert.equal(direct.statusCode, 404);
    const method = await handle(rpc(action, {}, {token}));
    assert.equal(method.statusCode, 404);
    assert.equal(JSON.parse(method.body).error.code, -32601);
    const unknown = await handle(rpc('tools/call', {name: action, arguments: {}}, {token}));
    assert.equal(JSON.parse(unknown.body).error.code, -32602);
  }
  for (const args of [{owner: ownerFor('bob')}, {days: '7'}, {token}]) {
    const response = await handle(call(token, args));
    assert.equal(JSON.parse(response.body).result.isError, true);
  }
  assert.deepEqual(app.grantRecord(), before);
  assert.deepEqual(app.downloads, []);
});
