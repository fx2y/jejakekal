import { callIdempotentEffect } from './effects.mjs';

/**
 * @typedef {{
 * name: string,
 * run: (ctx: {workflowId:string, client: import('pg').Client, stepName:string, sideEffectKey:(suffix:string)=>string}) => Promise<Record<string, unknown>>
 * }} WorkflowStep
 */

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 * @param {string} stepName
 */
async function checkpoint(client, workflowId, stepName) {
  const row = await client.query(
    'SELECT status, output_json FROM workflow_steps WHERE workflow_id = $1 AND step_name = $2',
    [workflowId, stepName]
  );
  return row.rows[0] ?? null;
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 * @param {string} stepName
 * @param {string} phase
 * @param {Record<string, unknown>} payload
 */
async function logEvent(client, workflowId, stepName, phase, payload) {
  await client.query(
    'INSERT INTO workflow_events (workflow_id, step_name, phase, payload_json) VALUES ($1, $2, $3, $4::jsonb)',
    [workflowId, stepName, phase, JSON.stringify(payload)]
  );
}

/**
 * @param {{client: import('pg').Client, workflowId: string, steps: WorkflowStep[], crashAfterStep?: string}} params
 */
export async function runWorkflow(params) {
  const timeline = [];

  for (const step of params.steps) {
    const existing = await checkpoint(params.client, params.workflowId, step.name);
    if (existing && existing.status === 'completed') {
      timeline.push({ step: step.name, phase: 'resume-skip', output: existing.output_json });
      await logEvent(params.client, params.workflowId, step.name, 'resume-skip', existing.output_json ?? {});
      continue;
    }

    await logEvent(params.client, params.workflowId, step.name, 'start', {});

    const output = await step.run({
      workflowId: params.workflowId,
      client: params.client,
      stepName: step.name,
      sideEffectKey: (suffix) => `${params.workflowId}:${step.name}:${suffix}`
    });

    await params.client.query(
      `INSERT INTO workflow_steps (workflow_id, step_name, status, output_json)
       VALUES ($1, $2, 'completed', $3::jsonb)
       ON CONFLICT (workflow_id, step_name)
       DO UPDATE SET status = EXCLUDED.status, output_json = EXCLUDED.output_json, updated_at = NOW()`,
      [params.workflowId, step.name, JSON.stringify(output)]
    );

    await logEvent(params.client, params.workflowId, step.name, 'completed', output);
    timeline.push({ step: step.name, phase: 'completed', output });

    if (params.crashAfterStep && params.crashAfterStep === step.name) {
      throw new Error(`forced-crash:${step.name}`);
    }
  }

  return timeline;
}

/**
 * @param {{client: import('pg').Client, workflowId:string, value:string}} params
 */
export function defaultWorkflow(params) {
  /** @type {WorkflowStep[]} */
  const steps = [
    {
      name: 'prepare',
      run: async () => ({ prepared: params.value.toUpperCase() })
    },
    {
      name: 'side-effect',
      run: async ({ client, sideEffectKey }) => {
        const result = await callIdempotentEffect(client, sideEffectKey('email'), async () => ({
          sent: true,
          timestamp: Date.now()
        }));
        return { sent: result.response.sent, replayed: result.replayed };
      }
    },
    {
      name: 'finalize',
      run: async () => ({ ok: true })
    }
  ];

  return runWorkflow({ client: params.client, workflowId: params.workflowId, steps });
}

/**
 * @param {import('pg').Client} client
 * @param {string} workflowId
 */
export async function readTimeline(client, workflowId) {
  const res = await client.query(
    'SELECT event_index, step_name, phase, payload_json FROM workflow_events WHERE workflow_id = $1 ORDER BY event_index ASC',
    [workflowId]
  );
  return res.rows.map((row) => ({
    index: Number(row.event_index),
    step: row.step_name,
    phase: row.phase,
    payload: row.payload_json
  }));
}
