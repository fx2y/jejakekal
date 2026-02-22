/** @type {Map<string, Promise<unknown>>} */
const localEffectQueue = new Map();

/**
 * Serialize by effect key within the process so same-client concurrent callers
 * cannot interleave pre-insert checks.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
function serializeByEffectKey(key, run) {
  const previous = localEffectQueue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  localEffectQueue.set(
    key,
    next.finally(() => {
      if (localEffectQueue.get(key) === next) {
        localEffectQueue.delete(key);
      }
    })
  );
  return next;
}

/**
 * @param {import('pg').Client} client
 * @param {string} effectKey
 * @param {() => Promise<Record<string, unknown>>} effectFn
 */
async function executeIdempotentEffect(client, effectKey, effectFn) {
  await client.query('BEGIN');
  try {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [effectKey]
    );
    const cached = await client.query(
      'SELECT response_json FROM side_effects WHERE effect_key = $1',
      [effectKey]
    );
    if (cached.rowCount && cached.rows[0]) {
      await client.query('COMMIT');
      return { response: cached.rows[0].response_json, replayed: true };
    }

    const response = await effectFn();
    await client.query(
      'INSERT INTO side_effects (effect_key, response_json) VALUES ($1, $2::jsonb)',
      [effectKey, JSON.stringify(response)]
    );
    await client.query('COMMIT');
    return { response, replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * @param {import('pg').Client} client
 * @param {string} effectKey
 * @param {() => Promise<Record<string, unknown>>} effectFn
 */
export async function callIdempotentEffect(client, effectKey, effectFn) {
  return serializeByEffectKey(effectKey, () =>
    executeIdempotentEffect(client, effectKey, effectFn)
  );
}
