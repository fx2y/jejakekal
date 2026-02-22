import { makeClient, resetAppTables } from '../src/db.mjs';

export async function setupDbOrSkip(t) {
  const client = makeClient();
  try {
    await client.connect();
  } catch {
    t.skip('postgres unavailable; run mise run up first');
    return null;
  }

  await resetAppTables(client);
  t.after(async () => {
    await client.end();
  });
  return client;
}
