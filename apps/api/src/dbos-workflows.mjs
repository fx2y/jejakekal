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
import { buildIngestEffectKey, buildOcrPageEffectKey, buildOcrPageRenderEffectKey } from './ingest/effect-key.mjs';
import { defaultBundlesRootPath } from './bundles-root.mjs';
import { resolveOcrPolicy } from './ocr/config.mjs';
import { runDefaultTextLane } from './workflows/default-text-lane.mjs';
import { runOcrGateSeam } from './ocr/gate-seam.mjs';
import { insertOcrJob, insertOcrPatch, updateOcrPageRender, updateOcrPageResult, upsertOcrPage } from './ocr/repository.mjs';
import { runOcrRenderSeam } from './ocr/render-seam.mjs';
import { runOcrEngineSeam } from './ocr/engine-seam.mjs';

let workflowsRegistered = false;
/** @type {((input: { value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }) => Promise<unknown>) | undefined} */
let defaultWorkflowFn;
/** @type {((input: { value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }) => Promise<unknown>) | undefined} */
let hardDocWorkflowFn;
/** @type {((input: { failUntilAttempt?: number }) => Promise<unknown>) | undefined} */
let flakyRetryWorkflowFn;
const flakyAttemptByWorkflow = new Map();
let s3BlobStore;
const storeRawFailpointByWorkflow = new Set();
const ocrEffectFailpointByPage = new Set();
const OCR_PROMPT = 'Text Recognition:';

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
 * @param {string} workflowId
 * @param {number} pageIdx
 */
function shouldFailAfterOcrEffectOnce(workflowId, pageIdx) {
  if (process.env.JEJAKEKAL_FAIL_AFTER_OCR_EFFECT_ONCE !== '1') {
    return false;
  }
  const key = `${workflowId}|p${pageIdx}`;
  if (ocrEffectFailpointByPage.has(key)) {
    return false;
  }
  ocrEffectFailpointByPage.add(key);
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

/**
 * @param {{workflowId:string,docId:string,version:number,markerJson:unknown,ocrPolicy?:Record<string, unknown>}} input
 */
async function persistOcrGateStep(input) {
  const gate = await runOcrGateSeam({
    markerJson: input.markerJson,
    gateCfg: {
      maxPages: input.ocrPolicy?.maxPages
    }
  });
  return withAppClient(async (client) => {
    await client.query('BEGIN');
    try {
      const insertedJob = await insertOcrJob(client, {
        job_id: input.workflowId,
        doc_id: input.docId,
        ver: input.version,
        gate_rev: gate.gate_rev,
        policy: {
          max_pages: input.ocrPolicy?.maxPages ?? null
        }
      });
      const hardSet = new Set(gate.hard_pages);
      for (let pageIdx = 0; pageIdx < gate.score_by_page.length; pageIdx += 1) {
        await upsertOcrPage(client, {
          job_id: input.workflowId,
          page_idx: pageIdx,
          status: hardSet.has(pageIdx) ? 'gated' : 'skipped',
          gate_score: gate.score_by_page[pageIdx],
          gate_reasons: gate.reasons[String(pageIdx)] ?? []
        });
      }
      await client.query('COMMIT');
      return {
        job_id: input.workflowId,
        gate_rev: gate.gate_rev,
        code_rev: gate.code_rev,
        hard_pages: gate.hard_pages,
        score_by_page: gate.score_by_page,
        reasons: gate.reasons,
        job_inserted: Boolean(insertedJob)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,markerJson:unknown,ocrPolicy?:Record<string, unknown>}} input
 */
async function runS5PersistOcrGate(input) {
  return DBOS.runStep(() => persistOcrGateStep(input), {
    name: 'ocr-persist-gate',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,pdfPath?:string,hardPages:number[]}} input
 */
async function renderAndStoreOcrPagesStep(input) {
  const rendered = await runOcrRenderSeam({
    hard_pages: input.hardPages,
    pdf_path: input.pdfPath
  });
  if (!Array.isArray(rendered.pages) || rendered.pages.length < 1) {
    return { rendered_pages: [] };
  }
  const store = getS3BlobStore();
  /** @type {Array<{page_idx:number,png_uri:string,png_sha:string,effect_replayed:boolean}>} */
  const persisted = [];
  for (const page of rendered.pages) {
    if (!Buffer.isBuffer(page.png) || typeof page.png_sha !== 'string') {
      continue;
    }
    const objectKey = buildRunObjectKey({
      runId: input.workflowId,
      relativePath: `ocr/pages/p${page.page_idx}/${page.png_sha}.png`
    });
    const effectKey = buildOcrPageRenderEffectKey({
      workflowId: input.workflowId,
      docId: input.docId,
      version: input.version,
      pageIdx: page.page_idx,
      pngSha256: page.png_sha
    });
    const effect = await runIdempotentExternalEffect(effectKey, async () => {
      const blob = await store.putObjectChecked({
        key: objectKey,
        payload: page.png,
        contentType: page.mime ?? 'image/png'
      });
      return {
        page_idx: page.page_idx,
        png_uri: blob.uri,
        png_sha: page.png_sha
      };
    });
    persisted.push({
      page_idx: Number(effect.response.page_idx),
      png_uri: String(effect.response.png_uri),
      png_sha: String(effect.response.png_sha),
      effect_replayed: effect.replayed
    });
  }
  return withAppClient(async (client) => {
    await client.query('BEGIN');
    try {
      const updated = [];
      for (const page of persisted) {
        const row = await updateOcrPageRender(client, {
          job_id: input.workflowId,
          page_idx: page.page_idx,
          status: 'rendered',
          png_uri: page.png_uri,
          png_sha: page.png_sha
        });
        updated.push({ ...row, effect_replayed: page.effect_replayed });
      }
      await client.query('COMMIT');
      return {
        rendered_pages: updated.map((row) => ({
          page_idx: row.page_idx,
          png_uri: row.png_uri,
          png_sha: row.png_sha,
          effect_replayed: row.effect_replayed
        }))
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * @param {{workflowId:string,docId:string,version:number,pdfPath?:string,hardPages:number[]}} input
 */
async function runS6RenderStoreOcrPages(input) {
  return DBOS.runStep(() => renderAndStoreOcrPagesStep(input), {
    name: 'ocr-render-store-pages',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
}

/**
 * @param {{
 *   workflowId:string,
 *   docId:string,
 *   version:number,
 *   gateRev:string,
 *   renderedPages:Array<{page_idx:number,png_uri:string|null,png_sha:string|null}>,
 *   ocrPolicy?: Record<string, unknown>
 * }} input
 */
async function persistOcrPagesStep(input) {
  const ocrEnabled = input.ocrPolicy?.enabled !== false;
  if (!ocrEnabled) {
    return { ocr_pages: [], skipped: 'ocr_disabled' };
  }
  const store = getS3BlobStore();
  /** @type {Array<{page_idx:number,raw_uri:string,raw_sha:string,patch_sha:string,patch:Record<string, unknown>,effect_replayed:boolean}>} */
  const persisted = [];

  for (const page of input.renderedPages ?? []) {
    if (typeof page.png_uri !== 'string' || typeof page.png_sha !== 'string') {
      continue;
    }
    const effectKey = buildOcrPageEffectKey({
      workflowId: input.workflowId,
      docId: input.docId,
      version: input.version,
      pageIdx: page.page_idx,
      model: String(input.ocrPolicy?.model ?? ''),
      gateRev: input.gateRev,
      pngSha256: page.png_sha
    });
    const effect = await runIdempotentExternalEffect(effectKey, async () => {
      const out = await runOcrEngineSeam({
        pages: [
          {
            doc_id: input.docId,
            ver: input.version,
            page_idx: page.page_idx,
            png_uri: page.png_uri,
            prompt: OCR_PROMPT
          }
        ],
        ocrPolicy: input.ocrPolicy
      });
      const first = out.patches[0];
      if (!first) {
        throw new Error('ocr_patch_missing');
      }
      const rawPayload = Buffer.from(JSON.stringify(first.raw), 'utf8');
      const rawSha = sha256(rawPayload);
      const rawKey = buildRunObjectKey({
        runId: input.workflowId,
        relativePath: `ocr/raw/p${page.page_idx}/${rawSha}.json`
      });
      const blob = await store.putObjectChecked({
        key: rawKey,
        payload: rawPayload,
        contentType: 'application/json'
      });
      const rawVerify = await store.getObjectBytes({ key: rawKey });
      if (sha256(rawVerify) !== rawSha) {
        throw new Error('ocr_raw_blob_checksum_mismatch');
      }
      const patch = {
        text_md: String(first.text_md ?? ''),
        tables: Array.isArray(first.tables) ? first.tables : [],
        confidence: first.confidence == null ? null : Number(first.confidence),
        engine_meta:
          first.engine_meta && typeof first.engine_meta === 'object' && !Array.isArray(first.engine_meta)
            ? first.engine_meta
            : {}
      };
      const patchSha = sha256(
        JSON.stringify({
          page_idx: page.page_idx,
          patch,
          raw_sha: rawSha
        })
      );
      return {
        page_idx: page.page_idx,
        raw_uri: blob.uri,
        raw_sha: rawSha,
        patch_sha: patchSha,
        patch
      };
    });
    if (shouldFailAfterOcrEffectOnce(input.workflowId, page.page_idx)) {
      throw new Error('failpoint_after_ocr_effect');
    }
    persisted.push({
      page_idx: Number(effect.response.page_idx),
      raw_uri: String(effect.response.raw_uri),
      raw_sha: String(effect.response.raw_sha),
      patch_sha: String(effect.response.patch_sha),
      patch:
        effect.response.patch &&
        typeof effect.response.patch === 'object' &&
        !Array.isArray(effect.response.patch)
          ? /** @type {Record<string, unknown>} */ (effect.response.patch)
          : {},
      effect_replayed: effect.replayed
    });
  }

  return withAppClient(async (client) => {
    await client.query('BEGIN');
    try {
      const pages = [];
      for (const row of persisted) {
        const pageRow = await updateOcrPageResult(client, {
          job_id: input.workflowId,
          page_idx: row.page_idx,
          status: 'ocr_ready',
          raw_uri: row.raw_uri,
          raw_sha: row.raw_sha
        });
        await insertOcrPatch(client, {
          doc_id: input.docId,
          ver: input.version,
          page_idx: row.page_idx,
          patch_sha: row.patch_sha,
          patch: row.patch,
          source_job_id: input.workflowId
        });
        pages.push({
          page_idx: pageRow.page_idx,
          raw_uri: pageRow.raw_uri,
          raw_sha: pageRow.raw_sha,
          patch_sha: row.patch_sha,
          effect_replayed: row.effect_replayed
        });
      }
      await client.query('COMMIT');
      return { ocr_pages: pages };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * @param {{
 *   workflowId:string,
 *   docId:string,
 *   version:number,
 *   gateRev:string,
 *   renderedPages:Array<{page_idx:number,png_uri:string|null,png_sha:string|null}>,
 *   ocrPolicy?: Record<string, unknown>
 * }} input
 */
async function runS7PersistOcrPages(input) {
  return DBOS.runStep(() => persistOcrPagesStep(input), {
    name: 'ocr-pages',
    retriesAllowed: true,
    intervalSeconds: 1,
    backoffRate: 2,
    maxAttempts: 3
  });
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

async function hardDocWorkflowImpl(input) {
  return runDefaultTextLane(input, {
    workflowId: DBOS.workflowID ?? 'unknown-workflow',
    readTextFile: readFile,
    runS0ReserveDoc,
    runS1StoreRaw,
    runS1Sleep,
    runS2MarkerConvert,
    runS3StoreParseOutputs,
    runS4NormalizeDocir,
    runS4xAfterNormalize: async (ctx) => {
      const gate = await runS5PersistOcrGate({
        workflowId: ctx.workflowId,
        docId: ctx.reserved.doc_id,
        version: ctx.reserved.ver,
        markerJson: ctx.markerJson,
        ocrPolicy: input.ocrPolicy
      });
      const rendered = await runS6RenderStoreOcrPages({
        workflowId: ctx.workflowId,
        docId: ctx.reserved.doc_id,
        version: ctx.reserved.ver,
        pdfPath: ctx.marker?.paths?.sourcePdf,
        hardPages: gate.hard_pages
      });
      const ocr = await runS7PersistOcrPages({
        workflowId: ctx.workflowId,
        docId: ctx.reserved.doc_id,
        version: ctx.reserved.ver,
        gateRev: gate.gate_rev,
        renderedPages: rendered.rendered_pages,
        ocrPolicy: input.ocrPolicy
      });
      return { gate, rendered, ocr };
    },
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
  hardDocWorkflowFn = DBOS.registerWorkflow(hardDocWorkflowImpl, { name: 'hardDocWorkflow' });
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
 * @param {{workflowId?: string, value: string, sleepMs?: number, bundlesRoot?: string, useLlm?: boolean, ocrPolicy?: Record<string, unknown>}} params
 */
export async function startHardDocWorkflowRun(params) {
  registerDbosWorkflows();
  const workflowFn =
    /** @type {(input: { value: string, sleepMs?: number, bundlesRoot: string, useLlm?: boolean, pauseAfterS4Ms?: number, ocrPolicy?: Record<string, unknown> }) => Promise<unknown>} */ (
      hardDocWorkflowFn
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
