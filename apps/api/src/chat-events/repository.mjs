import { randomUUID } from 'node:crypto';
import { badRequest } from '../request-errors.mjs';
import { assertValidRunId } from '../run-id.mjs';

/**
 * @param {unknown} value
 */
function normalizeArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  throw badRequest('invalid_run_payload');
}

/**
 * @param {import('pg').Client} client
 * @param {{cmd:string, args:Record<string, unknown>, run_id:string}} event
 */
export async function insertChatEvent(client, event) {
  if (typeof event.cmd !== 'string' || !event.cmd.startsWith('/')) {
    throw badRequest('invalid_command', { cmd: event.cmd ?? '' });
  }
  const runId = assertValidRunId(event.run_id, 'run_id');
  const args = normalizeArgs(event.args);
  const id = randomUUID();
  await client.query(
    `INSERT INTO chat_event (id, cmd, args, run_id)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [id, event.cmd, JSON.stringify(args), runId]
  );
}
