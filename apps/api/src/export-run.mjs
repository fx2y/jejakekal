import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { readRun } from './runs-service.mjs';
import { toBundleTimeline } from './runs-projections.mjs';
import { unprocessable } from './request-errors.mjs';
import { resolveBundleArtifactUri, resolveWithinRoot } from './artifact-uri.mjs';
import { listArtifactsByRunId } from './artifacts/repository.mjs';

function trimPreview(source) {
  return source.replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * @param {{ paths: { raw: string, docir: string, chunkIndex: string, memo: string } }} ingest
 */
export function buildIngestArtifacts(ingest) {
  return [
    { id: 'raw', path: ingest.paths.raw },
    { id: 'docir', path: ingest.paths.docir },
    { id: 'chunk-index', path: ingest.paths.chunkIndex },
    { id: 'memo', path: ingest.paths.memo }
  ];
}

/**
 * @param {Array<{type:string, uri:string}>} rows
 * @param {string} bundlesRoot
 */
function mapPersistedArtifactsForExport(rows, bundlesRoot) {
  const order = ['raw', 'docir', 'chunk-index', 'memo'];
  const byType = new Map(rows.map((row) => [row.type, row]));
  return order
    .map((type) => byType.get(type))
    .filter(Boolean)
    .map((row) => ({
      id: row.type,
      path: resolveBundleArtifactUri(bundlesRoot, row.uri)
    }));
}

/**
 * Recover original source from DBOS step outputs.
 * C3 encodes exact input on `prepare` step output to avoid app-side shadow storage.
 * @param {Array<{function_name?: string, output?: any}>} timeline
 */
export function sourceFromRunTimeline(timeline) {
  for (const row of timeline) {
    if (
      row.function_name === 'prepare' &&
      row.output &&
      typeof row.output === 'object' &&
      typeof row.output.source === 'string'
    ) {
      return row.output.source;
    }
  }
  return null;
}

/**
 * @param {{client: import('pg').Client, bundlesRoot: string, runId: string}} params
 */
export async function exportRunBundle(params) {
  const run = await readRun(params.client, params.runId);
  if (!run) return null;

  const bundleDir = resolveWithinRoot(params.bundlesRoot, params.runId, 'bundle');
  const persistedArtifacts = await listArtifactsByRunId(params.client, params.runId);
  let artifacts = mapPersistedArtifactsForExport(persistedArtifacts, params.bundlesRoot);
  let source = sourceFromRunTimeline(run.timeline);
  if (artifacts.length === 0) {
    if (!source) {
      throw unprocessable('source_unrecoverable', { run_id: params.runId });
    }
    const ingestDir = resolveWithinRoot(params.bundlesRoot, params.runId, 'ingest');
    const ingest = await ingestDocument({
      docId: params.runId,
      source,
      outDir: ingestDir
    });
    artifacts = buildIngestArtifacts(ingest);
  } else if (!source) {
    source = '';
  }
  const bundleTimeline = toBundleTimeline(run.timeline);
  const manifest = makeManifest({
    workflowId: params.runId,
    root: '<run-bundle-root>'
  });

  await writeRunBundle(bundleDir, {
    manifest,
    timeline: bundleTimeline,
    toolIO: [{ tool: 'pipeline.ingest', workflowId: params.runId }],
    artifacts,
    citations: source ? [{ source: 'local', confidence: 1, text: trimPreview(source) }] : [],
    extraJsonFiles: {
      'workflow_status.json': run.header,
      'operation_outputs.json': run.timeline
    }
  });

  return {
    run_id: params.runId,
    status: run.status,
    dbos_status: run.dbos_status,
    header: run.header,
    timeline: run.timeline,
    artifacts,
    run_bundle_path: bundleDir
  };
}
