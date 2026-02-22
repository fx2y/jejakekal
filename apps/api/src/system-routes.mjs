import { sendJson } from './http.mjs';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{client: import('pg').Client}} ctx
 */
export async function handleSystemRoute(req, res, ctx) {
  if (req.method === 'GET' && req.url === '/healthz') {
    await ctx.client.query('SELECT 1');
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
