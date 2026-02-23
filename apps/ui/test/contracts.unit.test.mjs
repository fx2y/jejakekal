import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_ALIAS_IDS, UI_PLANE_IDS, UI_RUN_STATUS_STATES } from '../src/contracts.mjs';
import { statusModel } from '../src/ui-view-model.mjs';

test('ui contracts: plane and alias ids are frozen', () => {
  assert.deepEqual(UI_PLANE_IDS, {
    conversation: 'conversation-plane',
    execution: 'execution-plane',
    artifact: 'artifact-plane'
  });
  assert.deepEqual(UI_ALIAS_IDS, {
    conversation: 'conv',
    execution: 'exec',
    artifacts: 'artifacts'
  });
});

test('ui contracts: run status FSM states are fixed', () => {
  assert.deepEqual(UI_RUN_STATUS_STATES, ['idle', 'running', 'done', 'error']);
  const states = [
    statusModel(null).state,
    statusModel({ run_id: 'r1', status: 'running' }).state,
    statusModel({ run_id: 'r1', status: 'done' }).state,
    statusModel({ run_id: 'r1', status: 'error', dbos_status: 'ERROR' }).state,
    statusModel({ run_id: 'r1', status: 'unknown' }).state
  ];
  assert.deepEqual(states, ['idle', 'running', 'done', 'error', 'error']);
});
