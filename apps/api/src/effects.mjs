/**
 * @param {import('pg').Client} client
 * @param {string} effectKey
 * @param {() => Promise<Record<string, unknown>>} effectFn
 */
export async function callIdempotentEffect(client, effectKey, effectFn) {
  const cached = await client.query('SELECT response_json FROM side_effects WHERE effect_key = $1', [effectKey]);
  if (cached.rowCount && cached.rows[0]) {
    return { response: cached.rows[0].response_json, replayed: true };
  }

  const response = await effectFn();
  await client.query(
    'INSERT INTO side_effects (effect_key, response_json) VALUES ($1, $2::jsonb) ON CONFLICT (effect_key) DO NOTHING',
    [effectKey, JSON.stringify(response)]
  );

  const stored = await client.query('SELECT response_json FROM side_effects WHERE effect_key = $1', [effectKey]);
  return { response: stored.rows[0].response_json, replayed: false };
}
