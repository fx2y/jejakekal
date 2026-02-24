import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBudgets } from '../src/perf-budget.mjs';

test('perf budget checker flags only breaches', () => {
  const failures = checkBudgets(
    { ingest_p95_ms: 1200, query_p95_ms: 300 },
    { ingest_p95_ms: 1100, query_p95_ms: 320 }
  );
  assert.deepEqual(failures, ['query_p95_ms:320>300']);
});

test('perf budget checker fails closed on missing keys', () => {
  const failures = checkBudgets({ retr_fuse_p95_ms: 150 }, {});
  assert.deepEqual(failures, ['retr_fuse_p95_ms:missing']);
});
