import { readFile } from 'node:fs/promises';
import { DBOS, DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';
import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { normalizeMarkerToBlocks } from '../../../packages/pipeline/src/docir/normalize-marker.mjs';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { makeClient } from './db.mjs';
import { resolveWithinRoot } from './artifact-uri.mjs';
import { buildArtifactProvenance } from './artifacts/provenance.mjs';
import { countArtifactsByRunId, insertArtifact } from './artifacts/repository.mjs';
import {
  buildAssetObjectKey,
  buildParseObjectKey,
  buildRawObjectKey,
  buildRunObjectKey,
  makeRunArtifactId
} from './ingest/keys.mjs';
import { createS3BlobStore, defaultS3BlobStoreConfig } from './blob/s3-store.mjs';
import { MARKER_CONFIG_PLACEHOLDER_SHA, reserveDocVersion } from './ingest/doc-repository.mjs';
import { buildExecMemoMarkdown } from './ingest/exec-memo.mjs';
import { listBlocksByDocVersion, populateBlockTsv, upsertBlockLedger } from './search/block-repository.mjs';
import { callIdempotentEffect } from './effects.mjs';
import { buildIngestEffectKey } from './ingest/effect-key.mjs';
import { defaultBundlesRootPath } from './bundles-root.mjs';
import { resolveOcrPolicy } from './ocr/config.mjs';
import { runDefaultTextLane } from './workflows/default-text-lane.mjs';

let workflowsRegistered = false;
/** @type {((input: { value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }) => Promise<unknown>) | undefined} */
let defaultWorkflowFn;
/** @type {((input: { failUntilAttempt?: number }) => Promise<unknown>) | undefined} */
let flakyRetryWorkflowFn;
const flakyAttemptByWorkflow = new Map();
let s3BlobStore;
const storeRawFailpointByWorkflow = new Set();

function getS3BlobStore() {
  if (!s3BlobStore) {
    s3BlobStore = createS3BlobStore(defaultS3BlobStoreConfig());
  }
  return s3BlobStore;
}

async function withAppClient(run) {
  const client = makeClient();
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/**
 * @template {Record<string, unknown>} T
 * @param {string} effectKey
 * @param {(client: import('pg').Client) => Promise<T>} effectFn
 */
async function runIdempotentExternalEffect(effectKey, effectFn) {
  return withAppClient(async (client) =>
    callIdempotentEffect(client, effectKey, () => effectFn(client))
  );
}

/**
 * @param {string} workflowId
 */
function shouldFailAfterStoreRawEffectOnce(workflowId) {
  if (process.env.JEJAKEKAL_FAIL_AFTER_STORE_RAW_EFFECT_ONCE !== '1') {
    return false;
  }
  if (storeRawFailpointByWorkflow.has(workflowId)) {
    return false;
  }
  storeRawFailpointByWorkflow.add(workflowId);
  return true;
}

/**
 * @param {{source: string}} input
 */
async function reserveDocStep(input) {
  return withAppClient(async (client) => {
    const payload = Buffer.from(input.source, 'utf8');
    const rawSha = sha256(payload);
    const reserved = await reserveDocVersion(client, {
      rawSha,
      filename: 'inline.txt',
      mime: 'text/plain',
      byteLength: payload.length,
      markerConfigSha: MARKER_CONFIG_PLACEHOLDER_SHA
    });
    return {
      source: input.source,
      raw_sha: reserved.rawSha,
      doc_id: reserved.docId,
      ver: reserved.version,
      marker_config_sha: reserved.markerConfigSha
    };
  });
}

/**
 * @param {{workflowId: string, source: string, rawSha: string, docId: string, version: number}} input
 */
async function storeRawArtifactStep(input) {
  const store = getS3BlobStore();
  const payload = Buffer.from(input.source, 'utf8');
  const key = buildRawObjectKey(input.rawSha);
  const effectKey = buildIngestEffectKey({
    workflowId: input.workflowId,
    step: 'store-raw',
    docId: input.docId,
    version: input.version,
    sha256: input.rawSha
  });
  const effect = await runIdempotentExternalEffect(effectKey, async (client) => {
    const blob = await store.putObjectChecked({
      key,
      payload,
      contentType: 'text/plain; charset=utf-8'
    });
    const artifactId = makeRunArtifactId(input.workflowId, 'raw');
    const prov = buildArtifactProvenance({
      runId: input.workflowId,
      artifactType: 'raw',
      artifactSha256: input.rawSha,
      sourceSha256: input.rawSha,
      producerStep: 'store-raw',
      inputs: [
        { kind: 'doc', id: input.docId },
        { kind: 'doc_ver', id: `${input.docId}:${input.version}` },
        { kind: 'raw_sha', sha256: input.rawSha }
      ],
      objectKeys: {
        raw: key
      }
    });
    await insertArtifact(client, {
      id: artifactId,
      run_id: input.workflowId,
      type: 'raw',
      format: 'text/plain',
      uri: blob.uri,
      sha256: input.rawSha,
      title: 'Raw Source',
      prov
    });
    return {
      artifact_id: artifactId,
      uri: blob.uri,
      key
    };
  });
  if (shouldFailAfterStoreRawEffectOnce(input.workflowId) && !effect.replayed) {
    throw new Error('fail_after_store_raw_effect_once');
  }
  return {
    ...effect.response,
    effect_replayed: effect.replayed
  };
}

/**
 * @param {{workflowId:string, source:string, bundlesRoot:string, docId:string, version:number, useLlm?:boolean}} input
 */
async function markerConvertStep(input) {
  const ingestDir = resolveWithinRoot(input.bundlesRoot, input.workflowId, 'ingest');
  const sourceSha = sha256(Buffer.from(input.source, 'utf8'));
  const effectKey = buildIngestEffectKey({
    workflowId: input.workflowId,
    step: 'marker-convert',
    docId: input.docId,
    version: input.version,
    sha256: sourceSha
  });
  const effect = await runIdempotentExternalEffect(effectKey, async () => {
    const ingest = await ingestDocument({
      docId: input.docId,
      source: input.source,
      outDir: ingestDir,
      useLlm: input.useLlm
    });
    return {
      doc_id: input.docId,
      ver: input.version,
      paths: ingest.paths,
      marker: ingest.marker,
      assets: ingest.assets,
      chunk_count: ingest.memo.chunkCount
    };
  });
  return {
    ...effect.response,
    effect_replayed: effect.replayed
  };
}

/**
 * @param {{workflowId:string,rawSha:string,docId:string,version:number,markerConfigSha:string,parsed:{paths:{docir:string,chunkIndex:string,memo:string,markerMd:string},marker_json:Record<string, unknown>,marker:Record<string, unknown>,assets:Array<{path:string,sha256:string,byteLength:number}>}}} input
 */
async function storeParseOutputsStep(input) {
  const store = getS3BlobStore();
  const effectKey = buildIngestEffectKey({
    workflowId: input.workflowId,
    step: 'store-parse-outputs',
    docId: input.docId,
    version: input.version,
    sha256: input.rawSha
  });
  const effect = await runIdempotentExternalEffect(effectKey, async (client) => {
    const parseRows = [
      {
        type: 'docir',
        format: 'application/json',
        title: 'DocIR',
        sourcePath: input.parsed.paths.docir,
        key: buildParseObjectKey({ docId: input.docId, version: input.version, filename: 'marker.json' })
      },
      {
        type: 'chunk-index',
        format: 'application/json',
        title: 'Chunk Index',
        sourcePath: input.parsed.paths.chunkIndex,
        key: buildParseObjectKey({ docId: input.docId, version: input.version, filename: 'chunks.json' })
      },
      {
        type: 'marker-md',
        format: 'text/markdown',
        sourcePath: input.parsed.paths.markerMd,
        key: buildParseObjectKey({ docId: input.docId, version: input.version, filename: 'marker.md' })
      }
    ];
    const persistedParse = [];
    for (const row of parseRows) {
      const payload = await readFile(row.sourcePath);
      const artifactSha = sha256(payload);
      const object = await store.putObjectChecked({
        key: row.key,
        payload,
        contentType: row.format === 'text/markdown' ? 'text/markdown; charset=utf-8' : row.format
      });
      persistedParse.push({ ...row, artifactSha, uri: object.uri });
    }

    const persistedAssets = [];
    for (const asset of input.parsed.assets) {
      const key = buildAssetObjectKey(asset.sha256);
      const payload = await readFile(asset.path);
      await store.putObjectChecked({
        key,
        payload,
        contentType: 'application/octet-stream'
      });
      persistedAssets.push({ key, sha256: asset.sha256, byteLength: asset.byteLength });
    }

    const rawKey = buildRawObjectKey(input.rawSha);
    let inserted = 0;
    for (const row of persistedParse) {
      if (row.type === 'marker-md') {
        continue;
      }
      const artifactId = makeRunArtifactId(
        input.workflowId,
        /** @type {'docir'|'chunk-index'} */ (row.type)
      );
      const prov = buildArtifactProvenance({
        runId: input.workflowId,
        artifactType: row.type,
        artifactSha256: row.artifactSha,
        sourceSha256: input.rawSha,
        producerStep: 'store-parse-outputs',
        inputs: [
          { kind: 'doc', id: input.docId },
          { kind: 'doc_ver', id: `${input.docId}:${input.version}` },
          { kind: 'raw_sha', sha256: input.rawSha },
          { kind: 'parse_object', id: row.key, sha256: row.artifactSha }
        ],
        parser: {
          engine: input.parsed.marker.engine,
          version: input.parsed.marker.version,
          mode: input.parsed.marker.mode,
          marker_cfg_sha: input.parsed.marker.marker_cfg_sha,
          stdout_sha256: input.parsed.marker.stdout_sha256,
          stderr_sha256: input.parsed.marker.stderr_sha256,
          timing_ms: input.parsed.marker.timing_ms,
          use_llm: input.parsed.marker.use_llm
        },
        objectKeys: {
          raw: rawKey,
          parse: persistedParse.map((file) => file.key),
          assets: persistedAssets.map((asset) => ({ key: asset.key, sha256: asset.sha256 }))
        }
      });
      const persisted = await insertArtifact(client, {
        id: artifactId,
        run_id: input.workflowId,
        type: row.type,
        format: row.format,
        uri: row.uri,
        sha256: row.artifactSha,
        title: row.title,
        prov
      });
      if (persisted) inserted += 1;
    }

    const parseShaByKey = Object.fromEntries(persistedParse.map((row) => [row.key, row.artifactSha]));
    return {
      inserted,
      total: inserted,
      parse_keys: persistedParse.map((row) => row.key),
      parse_sha_by_key: parseShaByKey,
      asset_count: persistedAssets.length,
      asset_keys: persistedAssets.map((asset) => asset.key),
      marker_cfg_sha: input.parsed.marker.marker_cfg_sha,
      marker_version: input.parsed.marker.version,
      marker_timing_ms:
        typeof input.parsed.marker.timing_ms === 'number'
          ? Math.max(0, Math.trunc(input.parsed.marker.timing_ms))
          : null,
      marker_stdout_sha: input.parsed.marker.stdout_sha256,
      marker_stderr_sha: input.parsed.marker.stderr_sha256
    };
  });
  return {
    ...effect.response,
    effect_replayed: effect.replayed
  };
}

/**
 * @param {{docId:string,version:number,rawSha:string,markerConfigSha:string,markerJson:Record<string, unknown>,marker:{version?:string,stdout_sha256?:string,stderr_sha256?:string},parseKeys:string[],parseShaByKey:Record<string,string>}} input
 */
async function normalizeDocirStep(input) {
  const blocks = normalizeMarkerToBlocks({
    docId: input.docId,
    version: input.version,
    markerJson: input.markerJson
  });
  const rawKey = buildRawObjectKey(input.rawSha);
  const provenance = {
    version: 1,
    doc_id: input.docId,
    ver: input.version,
    hash: {
      raw_sha256: input.rawSha
    },
    parser: {
      marker_cfg_sha: input.markerConfigSha,
      version: typeof input.marker.version === 'string' ? input.marker.version : null,
      stdout_sha256: typeof input.marker.stdout_sha256 === 'string' ? input.marker.stdout_sha256 : null,
      stderr_sha256: typeof input.marker.stderr_sha256 === 'string' ? input.marker.stderr_sha256 : null
    },
    object_keys: {
      raw: rawKey,
      parse: input.parseKeys,
      parse_sha256: input.parseShaByKey
    }
  };
  return withAppClient(async (client) => {
    await client.query('BEGIN');
    try {
      const inserted = await upsertBlockLedger(client, {
        docId: input.docId,
        version: input.version,
        blocks,
        provenance
      });
      await client.query('COMMIT');
      return {
        block_count: inserted.upserted,
        block_ids: blocks.map((block) => block.block_id),
        block_shas: blocks.map((block) => block.block_sha)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,language?:string}} input
 */
async function indexFtsStep(input) {
  return withAppClient(async (client) => {
    await client.query('BEGIN');
    try {
      const indexed = await populateBlockTsv(client, {
        docId: input.docId,
        version: input.version,
        language: input.language
      });
      await client.query('COMMIT');
      return indexed;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,rawSha:string,markerConfigSha:string}} input
 */
async function emitExecMemoStep(input) {
  const effectKey = buildIngestEffectKey({
    workflowId: input.workflowId,
    step: 'emit-exec-memo',
    docId: input.docId,
    version: input.version,
    sha256: input.rawSha
  });
  const effect = await runIdempotentExternalEffect(effectKey, async (client) => {
    const blocks = await listBlocksByDocVersion(client, {
      docId: input.docId,
      version: input.version
    });
    const markdown = buildExecMemoMarkdown({
      docId: input.docId,
      version: input.version,
      rawSha: input.rawSha,
      markerConfigSha: input.markerConfigSha,
      blocks
    });
    const payload = Buffer.from(markdown, 'utf8');
    const artifactSha = sha256(payload);
    const key = buildRunObjectKey({
      runId: input.workflowId,
      relativePath: 'artifact/exec_memo.md'
    });
    const store = getS3BlobStore();
    const object = await store.putObjectChecked({
      key,
      payload,
      contentType: 'text/markdown; charset=utf-8'
    });
    const artifactId = makeRunArtifactId(input.workflowId, 'memo');
    const prov = buildArtifactProvenance({
      runId: input.workflowId,
      artifactType: 'memo',
      artifactSha256: artifactSha,
      sourceSha256: input.rawSha,
      producerStep: 'emit-exec-memo',
      inputs: [
        { kind: 'doc', id: input.docId },
        { kind: 'doc_ver', id: `${input.docId}:${input.version}` },
        { kind: 'raw_sha', sha256: input.rawSha }
      ],
      parser: {
        marker_cfg_sha: input.markerConfigSha
      },
      objectKeys: {
        raw: buildRawObjectKey(input.rawSha)
      }
    });
    await insertArtifact(client, {
      id: artifactId,
      run_id: input.workflowId,
      type: 'memo',
      format: 'text/markdown',
      uri: object.uri,
      sha256: artifactSha,
      title: 'Pipeline Memo',
      prov
    });
    return {
      artifact_id: artifactId,
      uri: object.uri,
      key,
      sha256: artifactSha,
      block_count: blocks.length
    };
  });
  return {
    ...effect.response,
    effect_replayed: effect.replayed
  };
}

/**
 * @param {string} workflowId
 */
async function countArtifactsStep(workflowId) {
  return withAppClient(async (client) => countArtifactsByRunId(client, workflowId));
}

async function flakyStep(failUntilAttempt) {
  const workflowId = DBOS.workflowID ?? 'unknown-workflow';
  const currentAttempt = (flakyAttemptByWorkflow.get(workflowId) ?? 0) + 1;
  flakyAttemptByWorkflow.set(workflowId, currentAttempt);
  if (currentAttempt <= failUntilAttempt) {
    throw new Error(`flaky-attempt-${currentAttempt}`);
  }
  flakyAttemptByWorkflow.delete(workflowId);
  return { attempt: currentAttempt };
}

/**
 * @param {{value: string}} input
 */
async function runS0ReserveDoc(input) {
  return DBOS.runStep(() => reserveDocStep({ source: input.value }), { name: 'reserve-doc' });
}

/**
 * @param {{workflowId: string, source: string, rawSha: string, docId: string, version: number}} input
 */
async function runS1StoreRaw(input) {
  return DBOS.runStep(() => storeRawArtifactStep(input), {
    name: 'store-raw',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{sleepMs?: number}} input
 */
async function runS1Sleep(input) {
  await DBOS.sleep(Math.max(1, Number(input.sleepMs ?? 1)));
}

/**
 * @param {{workflowId:string, source:string, docId:string, version:number, bundlesRoot:string, useLlm?:boolean}} input
 */
async function runS2MarkerConvert(input) {
  return DBOS.runStep(() => markerConvertStep(input), {
    name: 'marker-convert',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{workflowId:string,rawSha:string,docId:string,version:number,markerConfigSha:string,parsed:any}} input
 */
async function runS3StoreParseOutputs(input) {
  return DBOS.runStep(() => storeParseOutputsStep(input), {
    name: 'store-parse-outputs',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{docId:string,version:number,rawSha:string,markerConfigSha:string,markerJson:Record<string, unknown>,marker:{version?:string,stdout_sha256?:string,stderr_sha256?:string},parseKeys:string[],parseShaByKey:Record<string,string>}} input
 */
async function runS4NormalizeDocir(input) {
  return DBOS.runStep(() => normalizeDocirStep(input), {
    name: 'normalize-docir',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,language?:string}} input
 */
async function runS5IndexFts(input) {
  return DBOS.runStep(() => indexFtsStep(input), {
    name: 'index-fts',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,rawSha:string,markerConfigSha:string}} input
 */
async function runS6EmitExecMemo(input) {
  return DBOS.runStep(() => emitExecMemoStep(input), {
    name: 'emit-exec-memo',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {string} workflowId
 */
async function runS7ArtifactCount(workflowId) {
  return DBOS.runStep(() => countArtifactsStep(workflowId), { name: 'artifact-count' });
}

/**
 * @param {number} artifactCount
 */
function runS8ArtifactPostcondition(artifactCount) {
  if (artifactCount < 1) {
    throw new Error('FAILED_NO_ARTIFACT');
  }
}

/**
 * @param {unknown} value
 */
function normalizeOptionalPauseMs(value) {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(1, Math.trunc(parsed));
}

/**
 * @param {string | undefined} bundlesRoot
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveWorkflowBundlesRoot(bundlesRoot, env = process.env) {
  if (typeof bundlesRoot === 'string' && bundlesRoot.length > 0) {
    return bundlesRoot;
  }
  return env.JEJAKEKAL_BUNDLES_ROOT ?? defaultBundlesRootPath();
}

/**
 * @param {number | undefined} pauseAfterS4Ms
 */
async function runS4ToS5Pause(pauseAfterS4Ms) {
  const pauseMs = normalizeOptionalPauseMs(pauseAfterS4Ms);
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return;
  await DBOS.sleep(pauseMs);
}

async function defaultWorkflowImpl(input) {
  return runDefaultTextLane(input, {
    workflowId: DBOS.workflowID ?? 'unknown-workflow',
    readTextFile: readFile,
    runS0ReserveDoc,
    runS1StoreRaw,
    runS1Sleep,
    runS2MarkerConvert,
    runS3StoreParseOutputs,
    runS4NormalizeDocir,
    runS4ToS5Pause,
    runS5IndexFts,
    runS6EmitExecMemo,
    runS7ArtifactCount,
    runS8ArtifactPostcondition
  });
}

async function flakyRetryWorkflowImpl(input) {
  const failUntilAttempt = Math.max(0, Number(input.failUntilAttempt ?? 2));
  const flaky = await DBOS.runStep(() => flakyStep(failUntilAttempt), {
    name: 'flaky',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: failUntilAttempt + 1
  });
  return { workflowId: DBOS.workflowID, flaky };
}

/**
 * @template T
 * @param {(input: T) => Promise<unknown>} workflowFn
 * @param {{workflowId?: string}} params
 * @param {T} input
 */
async function startWorkflowWithConflictRecovery(workflowFn, params, input) {
  try {
    return await DBOS.startWorkflow(
      workflowFn,
      params.workflowId ? { workflowID: params.workflowId } : undefined
    )(input);
  } catch (error) {
    if (params.workflowId && error instanceof DBOSWorkflowConflictError) {
      return DBOS.retrieveWorkflow(params.workflowId);
    }
    throw error;
  }
}

export function registerDbosWorkflows() {
  if (workflowsRegistered) {
    return;
  }
  defaultWorkflowFn = DBOS.registerWorkflow(defaultWorkflowImpl, { name: 'defaultWorkflow' });
  flakyRetryWorkflowFn = DBOS.registerWorkflow(flakyRetryWorkflowImpl, { name: 'flakyRetryWorkflow' });
  workflowsRegistered = true;
}

/**
 * @param {{workflowId?: string, value: string, sleepMs?: number, bundlesRoot?: string, useLlm?: boolean, ocrPolicy?: Record<string, unknown>}} params
 */
export async function startDefaultWorkflowRun(params) {
  registerDbosWorkflows();
  const workflowFn =
    /** @type {(input: { value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }) => Promise<unknown>} */ (
      defaultWorkflowFn
    );
  const pauseAfterS4Ms = normalizeOptionalPauseMs(process.env.JEJAKEKAL_PAUSE_AFTER_S4_MS);
  const bundlesRoot = resolveWorkflowBundlesRoot(params.bundlesRoot);
  const ocrPolicy = params.ocrPolicy ?? resolveOcrPolicy(process.env);
  return startWorkflowWithConflictRecovery(workflowFn, params, {
    value: params.value,
    sleepMs: params.sleepMs,
    bundlesRoot,
    useLlm: params.useLlm,
    pauseAfterS4Ms,
    ocrPolicy
  });
}

/**
 * @param {{workflowId?: string, failUntilAttempt?: number}} params
 */
export async function startFlakyRetryWorkflowRun(params) {
  registerDbosWorkflows();
  const workflowFn =
    /** @type {(input: { failUntilAttempt?: number }) => Promise<unknown>} */ (flakyRetryWorkflowFn);
  return startWorkflowWithConflictRecovery(workflowFn, params, {
    failUntilAttempt: params.failUntilAttempt
  });
}
