import { DBOS, DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';
import { makeClient } from './db.mjs';
import { callIdempotentEffect } from './effects.mjs';

let workflowsRegistered = false;
/** @type {((input: { value: string, sleepMs?: number }) => Promise<unknown>) | undefined} */
let defaultWorkflowFn;

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

async function defaultWorkflowImpl(input) {
  await DBOS.runStep(async () => prepareStep(input.value), { name: 'prepare' });
  await DBOS.sleep(Math.max(1, Number(input.sleepMs ?? 1)));
  const sideEffect = await DBOS.runStep(sideEffectStep, { name: 'side-effect' });
  const finalize = await DBOS.runStep(finalizeStep, { name: 'finalize' });
  return { workflowId: DBOS.workflowID, sideEffect, finalize };
}

export function registerDbosWorkflows() {
  if (workflowsRegistered) {
    return;
  }
  defaultWorkflowFn = DBOS.registerWorkflow(defaultWorkflowImpl, { name: 'defaultWorkflow' });
  workflowsRegistered = true;
}

/**
 * @param {{workflowId?: string, value: string, sleepMs?: number}} params
 */
export async function startDefaultWorkflowRun(params) {
  registerDbosWorkflows();
  const workflowFn =
    /** @type {(input: { value: string, sleepMs?: number }) => Promise<unknown>} */ (defaultWorkflowFn);
  try {
    return await DBOS.startWorkflow(
      workflowFn,
      params.workflowId ? { workflowID: params.workflowId } : undefined
    )({
      value: params.value,
      sleepMs: params.sleepMs
    });
  } catch (error) {
    if (params.workflowId && error instanceof DBOSWorkflowConflictError) {
      return DBOS.retrieveWorkflow(params.workflowId);
    }
    throw error;
  }
}
