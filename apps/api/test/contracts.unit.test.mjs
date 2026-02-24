import test from 'node:test';
import assert from 'node:assert/strict';
import {
  API_TOP_LEVEL_ROUTE_PREFIXES,
  ARTIFACT_TYPE_VOCABULARY,
  RETRIEVAL_SURFACE_DECISION,
  RUN_PROJECTION_FROZEN_KEYS,
  RUNS_COMPAT_WINDOW_END,
  assertFrozenArtifactType
} from '../src/contracts.mjs';
import { ALLOW_SOURCE_COMPAT_UNTIL, resolveSourceCompatUntil } from '../src/source-compat.mjs';

test('contracts: frozen artifact vocabulary is explicit and strict', () => {
  assert.deepEqual(ARTIFACT_TYPE_VOCABULARY, ['raw', 'docir', 'chunk-index', 'memo']);
  assert.equal(Object.isFrozen(ARTIFACT_TYPE_VOCABULARY), true);
  assert.equal(assertFrozenArtifactType('memo'), 'memo');
  assert.throws(() => assertFrozenArtifactType('exec-memo'), {
    message: 'artifact_type_contract_violation'
  });
});

test('contracts: run projection frozen keys remain stable', () => {
  assert.deepEqual(RUN_PROJECTION_FROZEN_KEYS, ['run_id', 'status', 'dbos_status', 'header', 'timeline']);
  assert.equal(Object.isFrozen(RUN_PROJECTION_FROZEN_KEYS), true);
});

test('contracts: top-level API surface remains frozen', () => {
  assert.deepEqual(API_TOP_LEVEL_ROUTE_PREFIXES, ['/runs', '/artifacts', '/healthz']);
  assert.equal(Object.isFrozen(API_TOP_LEVEL_ROUTE_PREFIXES), true);
});

test('contracts: retrieval route decision stays internal/runs-scoped', () => {
  assert.deepEqual(RETRIEVAL_SURFACE_DECISION, {
    strategy: 'internal_first_runs_scoped_only',
    allowed_http_prefixes: ['/runs'],
    blocked_top_level_prefixes: ['/search']
  });
});

test('contracts: compat window reminder is date-pinned', () => {
  assert.equal(RUNS_COMPAT_WINDOW_END, '2026-06-30');
});

test('contracts: source compat env default is pinned to frozen compat window', (t) => {
  const prev = process.env[ALLOW_SOURCE_COMPAT_UNTIL];
  delete process.env[ALLOW_SOURCE_COMPAT_UNTIL];
  t.after(() => {
    if (prev == null) {
      delete process.env[ALLOW_SOURCE_COMPAT_UNTIL];
      return;
    }
    process.env[ALLOW_SOURCE_COMPAT_UNTIL] = prev;
  });
  assert.equal(resolveSourceCompatUntil(), RUNS_COMPAT_WINDOW_END);
});
