import { readJsonRequest, sendJson } from './http.mjs';
import { readRun, normalizeRunStartPayload, startRunDurably } from './runs-service.mjs';

function getPathname(url) {
  return new URL(url, 'http://127.0.0.1').pathname;
}

function decodeRunId(pathname) {
  const prefix = '/runs/';
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeURIComponent(raw);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{client: import('pg').Client}} ctx
 */
export async function handleRunsRoute(req, res, ctx) {
  if (!req.url) return false;
  const pathname = getPathname(req.url);

  if (req.method === 'POST' && pathname === '/runs') {
    const payload = normalizeRunStartPayload(await readJsonRequest(req));
    const { runId } = await startRunDurably(payload);
    const run = await readRun(ctx.client, runId);
    sendJson(res, 202, {
      run_id: runId,
      status: run?.status ?? 'running',
      dbos_status: run?.dbos_status ?? null
    });
    return true;
  }

  if (req.method === 'GET') {
    const runId = decodeRunId(pathname);
    if (runId) {
      const run = await readRun(ctx.client, runId);
      if (!run) {
        sendJson(res, 404, { error: 'run_not_found', run_id: runId });
        return true;
      }
      sendJson(res, 200, run);
      return true;
    }
  }

  return false;
}

