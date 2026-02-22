import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const defaults = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? '55440'),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'jejakekal'
};

/**
 * @param {Partial<typeof defaults>} config
 */
export function makeClient(config = {}) {
  return new Client({ ...defaults, ...config });
}

/**
 * @param {Client} client
 */
export async function applySchema(client) {
  const sql = await readFile(join(process.cwd(), 'infra/sql/schema.sql'), 'utf8');
  await client.query(sql);
}

/**
 * @param {Client} client
 */
export async function resetAppTables(client) {
  await applySchema(client);
  await client.query('TRUNCATE side_effects, workflow_input_claims RESTART IDENTITY CASCADE');
}

/**
 * @param {Client} client
 */
export async function resetSchema(client) {
  await resetAppTables(client);
}
