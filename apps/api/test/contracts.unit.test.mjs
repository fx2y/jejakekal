import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_TYPE_VOCABULARY,
  RUN_PROJECTION_FROZEN_KEYS,
  RUNS_COMPAT_WINDOW_END,
  assertFrozenArtifactType
} from '../src/contracts.mjs';

test('contracts: frozen artifact vocabulary is explicit and strict', () => {
  assert.deepEqual(ARTIFACT_TYPE_VOCABULARY, ['raw', 'docir', 'chunk-index', 'memo']);
  assert.equal(assertFrozenArtifactType('memo'), 'memo');
  assert.throws(() => assertFrozenArtifactType('exec-memo'), {
    message: 'artifact_type_contract_violation'
  });
});

test('contracts: run projection frozen keys remain stable', () => {
  assert.deepEqual(RUN_PROJECTION_FROZEN_KEYS, ['run_id', 'status', 'dbos_status', 'header', 'timeline']);
});

test('contracts: compat window reminder is date-pinned', () => {
  assert.equal(RUNS_COMPAT_WINDOW_END, '2026-06-30');
});
