import { DBOS } from '@dbos-inc/dbos-sdk';
import { Client } from 'pg';
import { registerDbosWorkflows } from './dbos-workflows.mjs';

let startPromise = null;
const DBOS_STARTUP_LOCK_NS = 1246055489; // 'JEJA'
const DBOS_STARTUP_LOCK_KEY = 1145192787; // 'DBOS'

function getSystemDatabaseUrl() {
  const url = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!url) {
    throw new Error('DBOS_SYSTEM_DATABASE_URL is required');
  }
  return url;
}

/**
 * @param {unknown} error
 */
export function isDbosMigrationDuplicateKeyError(error) {
  const message = String(error ?? '');
  return (
    message.includes('duplicate key value violates unique constraint') &&
    message.includes('dbos_migrations_pkey')
  );
}

/**
 * Cross-process guard for DBOS launch/migrations. DBOS launch is process-local guarded below,
 * but concurrent processes can still race on `dbos_migrations`.
 * @template T
 * @param {string} systemDatabaseUrl
 * @param {() => Promise<T>} run
 * @param {{clientFactory?: (config: {connectionString: string}) => {connect: () => Promise<void>, query: (sql: string, params?: unknown[]) => Promise<unknown>, end: () => Promise<void>}}} [opts]
 * @returns {Promise<T>}
 */
export async function withDbosStartupAdvisoryLock(systemDatabaseUrl, run, opts = {}) {
  const client = opts.clientFactory
    ? opts.clientFactory({ connectionString: systemDatabaseUrl })
    : new Client({ connectionString: systemDatabaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [DBOS_STARTUP_LOCK_NS, DBOS_STARTUP_LOCK_KEY]);
    return await run();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        DBOS_STARTUP_LOCK_NS,
        DBOS_STARTUP_LOCK_KEY
      ]);
    } finally {
      await client.end();
    }
  }
}

/**
 * @param {{launch: () => Promise<void>}} dbos
 * @param {string} systemDatabaseUrl
 * @param {{withLock?: typeof withDbosStartupAdvisoryLock, maxDuplicateRetries?: number}} [opts]
 */
export async function launchDbosRuntimeSerialized(dbos, systemDatabaseUrl, opts = {}) {
  const withLock = opts.withLock ?? withDbosStartupAdvisoryLock;
  const maxDuplicateRetries = Math.max(0, Number(opts.maxDuplicateRetries ?? 1));
  let duplicateRetries = 0;
  for (;;) {
    try {
      await withLock(systemDatabaseUrl, async () => {
        await dbos.launch();
      });
      return;
    } catch (error) {
      if (isDbosMigrationDuplicateKeyError(error) && duplicateRetries < maxDuplicateRetries) {
        duplicateRetries += 1;
        continue;
      }
      throw error;
    }
  }
}

export async function ensureDbosRuntime() {
  if (DBOS.isInitialized()) {
    return;
  }
  if (startPromise) {
    await startPromise;
    return;
  }

  startPromise = (async () => {
    registerDbosWorkflows();
    const systemDatabaseUrl = getSystemDatabaseUrl();
    DBOS.setConfig({
      name: 'jejakekal-kernel',
      systemDatabaseUrl,
      runAdminServer: false
    });
    if (typeof DBOS.logRegisteredEndpoints === 'function') {
      DBOS.logRegisteredEndpoints();
    }
    await launchDbosRuntimeSerialized(DBOS, systemDatabaseUrl);
  })();

  try {
    await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function shutdownDbosRuntime() {
  if (!DBOS.isInitialized()) {
    return;
  }
  await DBOS.shutdown();
}
