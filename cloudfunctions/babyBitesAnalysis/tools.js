'use strict';

const {createMcpHandler} = require('./mcp');
const template = require('./openapi.json');

// This entry point is mounted independently of the mini-program management function.
// Accept both CloudBase's stripped path and its full path when forwarding is enabled.
function createToolsRouter({apiBaseUrl, readFeedingContext, safeError}) {
  const publicOrigin = apiBaseUrl ? new URL(apiBaseUrl).origin : '';
  const handleMcp = createMcpHandler({publicOrigin, readFeedingContext, safeError});
  const response = (statusCode, data, headers) => ({
    statusCode, isBase64Encoded: false,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...headers},
    body: JSON.stringify(data)
  });
  const specification = {...template,
    info: {...template.info, description: '读取用户授权的辅食记录。令牌仅通过 Authorization 请求头提供。'},
    servers: [{url: apiBaseUrl}]};
  return async event => {
    const path = event && event.path;
    if (path === '/mcp' || path === '/baby-bites-tools/mcp') return handleMcp(event);
    if (path !== '/openapi.json' && path !== '/baby-bites-tools/openapi.json') {
      return response(404, safeError({code: 'NOT_FOUND'}));
    }
    if (event.httpMethod !== 'GET') return response(405, safeError({code: 'METHOD_NOT_ALLOWED'}), {Allow: 'GET'});
    if (!apiBaseUrl) return response(503, safeError({code: 'API_NOT_CONFIGURED'}));
    return response(200, specification, {'Access-Control-Allow-Origin': '*'});
  };
}

module.exports = {createToolsRouter};
