import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { defaultWorkflow, readTimeline } from './workflow.mjs';
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
    const payload = await readJsonRequest(req);
    const workflowId = payload.workflowId ?? `wf-${Date.now()}`;
    const source = payload.source ?? 'default doc';
    const outDir = join(ctx.bundlesRoot, workflowId, 'ingest');

    const ingest = await ingestDocument({ docId: workflowId, source, outDir });
    await defaultWorkflow({ client: ctx.client, workflowId, value: source });
    const timeline = await readTimeline(ctx.client, workflowId);

    const bundleDir = join(ctx.bundlesRoot, workflowId, 'bundle');
    const manifest = makeManifest({ workflowId, root: bundleDir });
    const artifacts = buildArtifacts(ingest);
    await writeRunBundle(bundleDir, {
      manifest,
      timeline,
      toolIO: [{ tool: 'pipeline.ingest', workflowId }],
      artifacts,
      citations: [{ source: 'local', confidence: 1, text: source.slice(0, 24) }]
    });

    sendJson(res, 200, { workflowId, bundleDir, timeline, artifacts });
    return true;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/timeline/')) {
    const workflowId = req.url.replace('/api/timeline/', '');
    const timeline = await readTimeline(ctx.client, workflowId);
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
