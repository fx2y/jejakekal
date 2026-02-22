import { badRequest } from '../request-errors.mjs';
import { assertValidRunId } from '../run-id.mjs';
import { sha256 } from '../../../../packages/core/src/hash.mjs';

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
 * @param {unknown} value
 * @returns {unknown}
 */
function sortDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortDeep(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
      out[key] = sortDeep(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * @param {{cmd:string,args:Record<string, unknown>,run_id:string}} event
 */
function chatEventId(event) {
  return sha256(
    JSON.stringify({
      run_id: event.run_id,
      cmd: event.cmd,
      args: sortDeep(event.args)
    })
  );
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
  const id = chatEventId({ ...event, run_id: runId, args });
  await client.query(
    `INSERT INTO chat_event (id, cmd, args, run_id)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, event.cmd, JSON.stringify(args), runId]
  );
}
