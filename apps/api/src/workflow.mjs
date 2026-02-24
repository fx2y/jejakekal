import { ensureDbosRuntime } from './dbos-runtime.mjs';
import { startDefaultWorkflowRun, startHardDocWorkflowRun } from './dbos-workflows.mjs';
import {
  getRunHeader as readWorkflowStatus,
  getRunSteps as readOperationOutputs,
  toBundleTimeline
} from './runs-projections.mjs';

/**
 * Projection used by workflow facade/tests that expect step/phase rows.
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function readTimeline(client, workflowId) {
  const rows = await readOperationOutputs(client, workflowId);
  return toBundleTimeline(rows);
}

/**
 * @param {{client: import('pg').Client, workflowId:string, value:string, sleepMs?: number, bundlesRoot?: string}} params
 */
export async function defaultWorkflow(params) {
  await ensureDbosRuntime();
  const handle = await startDefaultWorkflowRun({
    workflowId: params.workflowId,
    value: params.value,
    sleepMs: params.sleepMs,
    bundlesRoot: params.bundlesRoot
  });
  await handle.getResult();
  return readTimeline(params.client, handle.workflowID);
}

/**
 * @param {{client: import('pg').Client, workflowId:string, value:string, sleepMs?: number, bundlesRoot?: string}} params
 */
export async function hardDocWorkflow(params) {
  await ensureDbosRuntime();
  const handle = await startHardDocWorkflowRun({
    workflowId: params.workflowId,
    value: params.value,
    sleepMs: params.sleepMs,
    bundlesRoot: params.bundlesRoot
  });
  await handle.getResult();
  return readTimeline(params.client, handle.workflowID);
}

/**
 * Legacy custom-engine hook intentionally removed in C1 substrate swap.
 */
export async function runWorkflow(_params) {
  throw new Error('runWorkflow removed in C1; use DBOS-backed workflow facade');
}

export { startDefaultWorkflowRun };
export { startHardDocWorkflowRun };
export { readWorkflowStatus, readOperationOutputs };
