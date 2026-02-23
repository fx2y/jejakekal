import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDbosMigrationDuplicateKeyError,
  launchDbosRuntimeSerialized,
  withDbosStartupAdvisoryLock
} from '../src/dbos-runtime.mjs';

test('dbos-runtime: duplicate migration error matcher is strict to dbos_migrations PK', () => {
  assert.equal(
    isDbosMigrationDuplicateKeyError(
      new Error('duplicate key value violates unique constraint "dbos_migrations_pkey"')
    ),
    true
  );
  assert.equal(
    isDbosMigrationDuplicateKeyError(
      new Error('duplicate key value violates unique constraint "other_table_pkey"')
    ),
    false
  );
  assert.equal(isDbosMigrationDuplicateKeyError(new Error('timeout')), false);
});

test('dbos-runtime: advisory lock helper acquires and releases PG lock around callback', async () => {
  const calls = [];
  const fakeClient = {
    async connect() {
      calls.push(['connect']);
    },
    async query(sql, params = []) {
      calls.push(['query', sql, params]);
      return { rows: [] };
    },
    async end() {
      calls.push(['end']);
    }
  };
  const out = await withDbosStartupAdvisoryLock(
    'postgresql://postgres:postgres@127.0.0.1:55440/jejakekal',
    async () => {
      calls.push(['run']);
      return 'ok';
    },
    { clientFactory: () => fakeClient }
  );
  assert.equal(out, 'ok');
  assert.deepEqual(calls.map((row) => row[0]), ['connect', 'query', 'run', 'query', 'end']);
  assert.match(String(calls[1][1]), /pg_advisory_lock/);
  assert.match(String(calls[3][1]), /pg_advisory_unlock/);
});

test('dbos-runtime: serialized launch retries once on dbos migration duplicate key race', async () => {
  const lockCalls = [];
  let attempts = 0;
  const fakeDbos = {
    async launch() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('duplicate key value violates unique constraint "dbos_migrations_pkey"');
      }
    }
  };
  await launchDbosRuntimeSerialized(fakeDbos, 'postgres://ignored', {
    withLock: async (_url, run) => {
      lockCalls.push('lock');
      return run();
    }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(lockCalls, ['lock', 'lock']);
});

test('dbos-runtime: serialized launch does not mask non-retryable errors', async () => {
  const fakeDbos = {
    async launch() {
      throw new Error('boom');
    }
  };
  await assert.rejects(
    () =>
      launchDbosRuntimeSerialized(fakeDbos, 'postgres://ignored', {
        withLock: async (_url, run) => run()
      }),
    /boom/
  );
});
