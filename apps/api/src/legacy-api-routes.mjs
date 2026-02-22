import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { exportRunBundle } from './export-run.mjs';
import { readRun, normalizeRunStartPayload, startRunDurably } from './runs-service.mjs';
import { toLegacyTimeline } from './runs-projections.mjs';
import { readJsonRequest, sendJson } from './http.mjs';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{client: import('pg').Client, bundlesRoot: string}} ctx
 */
export async function handleLegacyApiRoute(req, res, ctx) {
  if (!req.url) return false;

  if (req.method === 'POST' && req.url === '/api/run') {
    const payload = normalizeRunStartPayload(await readJsonRequest(req));
    const { handle, runId } = await startRunDurably(payload);
    await handle.getResult();
    const exported = await exportRunBundle({ client: ctx.client, bundlesRoot: ctx.bundlesRoot, runId });
    const timeline = toLegacyTimeline(exported?.timeline ?? []);
    sendJson(res, 200, {
      workflowId: runId,
      bundleDir: exported?.run_bundle_path ?? join(ctx.bundlesRoot, runId, 'bundle'),
      timeline,
      artifacts: exported?.artifacts ?? []
    });
    return true;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/timeline/')) {
    const workflowId = req.url.replace('/api/timeline/', '');
    const run = await readRun(ctx.client, workflowId);
    const timeline = toLegacyTimeline(run?.timeline ?? []);
    sendJson(res, 200, { workflowId, timeline });
    return true;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/artifacts/')) {
    const workflowId = req.url.replace('/api/artifacts/', '');
    const artifactDir = join(ctx.bundlesRoot, workflowId, 'bundle');
    const files = await readdir(artifactDir).catch(() => []);
    sendJson(res, 200, { workflowId, files });
    return true;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    await ctx.client.query('SELECT 1');
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
