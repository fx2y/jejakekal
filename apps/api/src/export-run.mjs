import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { readRun } from './runs-service.mjs';
import { toBundleTimeline } from './runs-projections.mjs';
import { parsePersistedArtifactUri, resolveWithinRoot } from './artifact-uri.mjs';
import { assertArtifactBlobsReadable } from './artifact-blobs.mjs';
import { listArtifactsByRunId } from './artifacts/repository.mjs';
import { assertFrozenArtifactType } from './contracts.mjs';
import { buildIngestManifestSummary } from './export/ingest-summary.mjs';
import { buildOcrBundleSidecars } from './export/ocr-sidecars.mjs';
import { buildRetrievalBundleSidecars } from './export/retrieval-sidecars.mjs';

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
  const artifacts = mapPersistedArtifactsForExport(persistedArtifacts, params.bundlesRoot);
  if (artifacts.length < 1) {
    throw new Error('missing_persisted_artifacts');
  }
  await assertArtifactBlobsReadable(artifacts, params.bundlesRoot, {
    s3Store: params.s3Store
  });
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
    citations: [],
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
