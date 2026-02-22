import { DBOS, DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeClient } from './db.mjs';
import { callIdempotentEffect } from './effects.mjs';
import { makeBundleArtifactUri, resolveWithinRoot } from './artifact-uri.mjs';
import { defaultBundlesRootPath } from './bundles-root.mjs';
import { buildArtifactProvenance, hashSource } from './artifacts/provenance.mjs';
import { countArtifactsByRunId, insertArtifact } from './artifacts/repository.mjs';

let workflowsRegistered = false;
/** @type {((input: { value: string, sleepMs?: number }) => Promise<unknown>) | undefined} */
let defaultWorkflowFn;
/** @type {((input: { failUntilAttempt?: number }) => Promise<unknown>) | undefined} */
let flakyRetryWorkflowFn;
const flakyAttemptByWorkflow = new Map();

async function withAppClient(run) {
  const client = makeClient();
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function prepareStep(value) {
  return { source: value, prepared: value.toUpperCase() };
}

async function sideEffectStep() {
  return withAppClient(async (client) => {
    const workflowId = DBOS.workflowID ?? 'unknown-workflow';
    const result = await callIdempotentEffect(client, `${workflowId}:side-effect:email`, async () => ({
      sent: true,
      timestamp: Date.now()
    }));
    return { sent: result.response.sent, replayed: result.replayed };
  });
}

async function finalizeStep() {
  return { ok: true };
}

/**
 * @param {{workflowId:string, source:string, bundlesRoot:string}} input
 */
async function persistArtifactsStep(input) {
  const ingestDir = resolveWithinRoot(input.bundlesRoot, input.workflowId, 'ingest');
  const ingest = await ingestDocument({
    docId: input.workflowId,
    source: input.source,
    outDir: ingestDir
  });
  const sourceSha256 = hashSource(input.source);
  const rows = [
    {
      type: 'raw',
      format: 'text/plain',
      title: 'Raw Source',
      path: ingest.paths.raw
    },
    {
      type: 'docir',
      format: 'application/json',
      title: 'DocIR',
      path: ingest.paths.docir
    },
    {
      type: 'chunk-index',
      format: 'application/json',
      title: 'Chunk Index',
      path: ingest.paths.chunkIndex
    },
    {
      type: 'memo',
      format: 'application/json',
      title: 'Pipeline Memo',
      path: ingest.paths.memo
    }
  ];

  return withAppClient(async (client) => {
    let inserted = 0;
    for (const row of rows) {
      const artifactId = `${input.workflowId}:${row.type}`;
      const payload = await readFile(row.path);
      const artifactSha256 = sha256(payload);
      const uri = makeBundleArtifactUri({
        runId: input.workflowId,
        artifactId,
        relativePath: `ingest/${basename(row.path)}`
      });
      const prov = buildArtifactProvenance({
        runId: input.workflowId,
        artifactType: row.type,
        artifactSha256,
        sourceSha256
      });
      const persisted = await insertArtifact(client, {
        id: artifactId,
        run_id: input.workflowId,
        type: row.type,
        format: row.format,
        uri,
        sha256: artifactSha256,
        title: row.title,
        prov
      });
      if (persisted) inserted += 1;
    }
    return { inserted, total: rows.length };
  });
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

async function defaultWorkflowImpl(input) {
  await DBOS.runStep(async () => prepareStep(input.value), { name: 'prepare' });
  await DBOS.sleep(Math.max(1, Number(input.sleepMs ?? 1)));
  const sideEffect = await DBOS.runStep(sideEffectStep, { name: 'side-effect' });
  const finalize = await DBOS.runStep(finalizeStep, { name: 'finalize' });
  const workflowId = DBOS.workflowID ?? 'unknown-workflow';
  const bundlesRoot =
    typeof input.bundlesRoot === 'string' && input.bundlesRoot.length > 0
      ? input.bundlesRoot
      : process.env.JEJAKEKAL_BUNDLES_ROOT ?? defaultBundlesRootPath();
  const persisted = await DBOS.runStep(
    () =>
      persistArtifactsStep({
        workflowId,
        source: input.value,
        bundlesRoot
      }),
    {
      name: 'persist-artifacts',
      retriesAllowed: true,
      intervalSeconds: 1,
      backoffRate: 2,
      maxAttempts: 3
    }
  );
  const artifactCount = await DBOS.runStep(() => countArtifactsStep(workflowId), { name: 'artifact-count' });
  if (artifactCount < 1) {
    throw new Error('FAILED_NO_ARTIFACT');
  }
  return { workflowId, sideEffect, finalize, persisted };
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
 * @param {{workflowId?: string, value: string, sleepMs?: number, bundlesRoot?: string}} params
 */
export async function startDefaultWorkflowRun(params) {
  registerDbosWorkflows();
  const workflowFn =
    /** @type {(input: { value: string, sleepMs?: number, bundlesRoot?: string }) => Promise<unknown>} */ (
      defaultWorkflowFn
    );
  return startWorkflowWithConflictRecovery(workflowFn, params, {
    value: params.value,
    sleepMs: params.sleepMs,
    bundlesRoot: params.bundlesRoot
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
