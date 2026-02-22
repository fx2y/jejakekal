import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { readRun, normalizeRunStartPayload, startRunDurably } from './runs-service.mjs';
import { toLegacyTimeline } from './runs-projections.mjs';
import { readJsonRequest, sendJson } from './http.mjs';

/**
 * @param {{ paths: { raw: string, docir: string, chunkIndex: string, memo: string } }} ingest
 */
function buildArtifacts(ingest) {
  return [
    { id: 'raw', path: ingest.paths.raw },
    { id: 'docir', path: ingest.paths.docir },
    { id: 'chunk-index', path: ingest.paths.chunkIndex },
    { id: 'memo', path: ingest.paths.memo }
  ];
}

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
    const outDir = join(ctx.bundlesRoot, runId, 'ingest');

    const ingest = await ingestDocument({ docId: runId, source: payload.source, outDir });
    await handle.getResult();
    const run = await readRun(ctx.client, runId);
    const timeline = toLegacyTimeline(run?.timeline ?? []);

    const bundleDir = join(ctx.bundlesRoot, runId, 'bundle');
    const manifest = makeManifest({ workflowId: runId, root: bundleDir });
    const artifacts = buildArtifacts(ingest);
    await writeRunBundle(bundleDir, {
      manifest,
      timeline,
      toolIO: [{ tool: 'pipeline.ingest', workflowId: runId }],
      artifacts,
      citations: [{ source: 'local', confidence: 1, text: payload.source.slice(0, 24) }]
    });

    sendJson(res, 200, { workflowId: runId, bundleDir, timeline, artifacts });
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
