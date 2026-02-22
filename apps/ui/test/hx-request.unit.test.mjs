import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldServeFullDocument } from '../src/hx-request.mjs';

test('hx-request: non-HX requests render full document', () => {
  assert.equal(shouldServeFullDocument({}), true);
});

test('hx-request: HX request without history-restore uses fragment mode', () => {
  assert.equal(shouldServeFullDocument({ 'hx-request': 'true' }), false);
});

test('hx-request: HX history-restore forces full document', () => {
  assert.equal(
    shouldServeFullDocument({
      'hx-request': 'true',
      'hx-history-restore-request': 'true'
    }),
    true
  );
});
