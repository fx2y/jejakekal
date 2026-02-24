import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { readRun } from './runs-service.mjs';
import { toBundleTimeline } from './runs-projections.mjs';
import { unprocessable } from './request-errors.mjs';
import { parsePersistedArtifactUri, resolveWithinRoot } from './artifact-uri.mjs';
import { assertArtifactBlobsReadable } from './artifact-blobs.mjs';
import { listArtifactsByRunId } from './artifacts/repository.mjs';
import { assertFrozenArtifactType } from './contracts.mjs';
import { buildIngestManifestSummary } from './export/ingest-summary.mjs';
import { buildOcrBundleSidecars } from './export/ocr-sidecars.mjs';
import { buildRetrievalBundleSidecars } from './export/retrieval-sidecars.mjs';

function trimPreview(source) {
  return source.replace(/\s+/g, ' ').trim().slice(0, 24);
}

/**
 * @typedef {{
 *   id: string,
 *   path: string,
 *   type?: string,
 *   uri?: string,
 *   sha256?: string,
 *   prov?: Record<string, unknown>
 * }} ExportArtifactRef
 */

/**
 * @param {{ paths: { raw: string, docir: string, chunkIndex: string, memo: string } }} ingest
 * @returns {ExportArtifactRef[]}
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
 * @param {Array<{id:string,type:string,uri:string,sha256:string,prov:Record<string, unknown>}>} rows
 * @param {string} bundlesRoot
 * @returns {ExportArtifactRef[]}
 */
function mapPersistedArtifactsForExport(rows, bundlesRoot) {
  const order = ['raw', 'docir', 'chunk-index', 'memo'];
  for (const row of rows) {
    assertFrozenArtifactType(String(row.type));
  }
  const byType = new Map(rows.map((row) => [row.type, row]));
  return order
    .map((type) => byType.get(type))
    .filter(Boolean)
    .map((row) => {
      const parsed = parsePersistedArtifactUri(row.uri);
      const path =
        parsed.scheme === 'bundle'
          ? resolveWithinRoot(bundlesRoot, parsed.runId, parsed.relativePath)
          : `s3://${parsed.bucket}/${parsed.key}`;
      return {
        id: row.type,
        type: row.type,
        path,
        uri: row.uri,
        sha256: row.sha256,
        prov: row.prov
      };
    });
}

/**
 * Recover original source from DBOS step outputs.
 * Legacy-only fallback: modern runs intentionally avoid source text in timeline outputs.
 * @param {Array<{function_name?: string, output?: any}>} timeline
 */
export function sourceFromRunTimeline(timeline) {
  for (const row of timeline) {
    if (
      (row.function_name === 'prepare' || row.function_name === 'reserve-doc') &&
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
 * @param {{
 *  client: import('pg').Client,
 *  bundlesRoot: string,
 *  runId: string,
 *  s3Store?: {getObjectBytes: (params: {bucket?: string, key: string}) => Promise<Buffer>}
 * }} params
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
  } else {
    await assertArtifactBlobsReadable(artifacts, params.bundlesRoot, {
      s3Store: params.s3Store
    });
  }
  if (artifacts.length > 0 && !source) {
    source = '';
  }
  const bundleTimeline = toBundleTimeline(run.timeline);
  const stepSummaries = run.timeline.map((row) => ({
    function_id: row.function_id,
    function_name: row.function_name,
    status: row.error ? 'error' : 'ok',
    attempt: row.attempt ?? 1,
    duration_ms: row.duration_ms ?? null,
    io_hashes: Array.isArray(row.io_hashes) ? row.io_hashes : []
  }));
  const artifactRefs = artifacts.map((artifact) => ({
    id: artifact.id,
    type: artifact.type ?? artifact.id,
    sha256: artifact.sha256 ?? null,
    uri: artifact.uri ?? null
  }));
  const ingestSummary = buildIngestManifestSummary(run.timeline);
  const retrievalSidecars = buildRetrievalBundleSidecars(run.timeline);
  const manifest = makeManifest({
    workflowId: params.runId,
    root: '<run-bundle-root>',
    createdAt:
      typeof run.header?.created_at === 'string' && run.header.created_at.length > 0
        ? run.header.created_at
        : undefined,
    artifactRefs,
    stepSummaries,
    ingest: ingestSummary,
    retrieval: retrievalSidecars?.retrieval_summary
  });
  const ocrSidecars = await buildOcrBundleSidecars(params.client, params.runId);

  await writeRunBundle(bundleDir, {
    manifest,
    timeline: bundleTimeline,
    toolIO: [{ tool: 'pipeline.ingest', workflowId: params.runId }],
    artifacts,
    citations: source ? [{ source: 'local', confidence: 1, text: trimPreview(source) }] : [],
    extraJsonFiles: {
      'workflow_status.json': run.header,
      'operation_outputs.json': run.timeline,
      'artifact_provenance.json': artifacts.map((artifact) => ({
        id: artifact.id,
        type: artifact.type ?? artifact.id,
        sha256: artifact.sha256 ?? null,
        uri: artifact.uri ?? null,
        prov: artifact.prov ?? {}
      })),
      ...(retrievalSidecars ? { 'retrieval_results.json': retrievalSidecars.retrieval_results } : {}),
      ...(ocrSidecars ? { 'ocr_pages.json': ocrSidecars.ocr_pages } : {})
    },
    extraTextFiles: {
      ...(ocrSidecars ? { 'ocr_report.md': ocrSidecars.ocr_report_md } : {}),
      ...(ocrSidecars?.diff_summary_md ? { 'diff_summary.md': ocrSidecars.diff_summary_md } : {})
    }
  });

  return {
    run_id: params.runId,
    status: run.status,
    dbos_status: run.dbos_status,
    header: run.header,
    timeline: run.timeline,
    artifacts,
    ingest: ingestSummary,
    run_bundle_path: bundleDir
  };
}
