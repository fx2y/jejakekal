import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRunStartPayload } from '../src/runs-service.mjs';
import {
  ALLOW_SOURCE_COMPAT_UNTIL,
  JEJAKEKAL_COMPAT_TODAY,
  getSourceCompatTelemetry,
  resetSourceCompatTelemetryForTest
} from '../src/source-compat.mjs';

function withEnv(t, key, value) {
  const prev = process.env[key];
  if (value == null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (prev == null) {
      delete process.env[key];
      return;
    }
    process.env[key] = prev;
  });
}

test('runs-service: /runs ingestion rejects non-source intents', () => {
  assert.throws(() => normalizeRunStartPayload({ cmd: '/run wf-1' }), {
    name: 'RequestError',
    payload: { error: 'invalid_command', cmd: '/run' }
  });
  assert.throws(() => normalizeRunStartPayload({ intent: 'open', args: { artifact_id: 'wf-1:raw' } }), {
    name: 'RequestError',
    payload: { error: 'invalid_command', cmd: '/open' }
  });
});

test('runs-service: source compat path is allowed before sunset and emits telemetry', (t) => {
  withEnv(t, ALLOW_SOURCE_COMPAT_UNTIL, '2026-06-30');
  withEnv(t, JEJAKEKAL_COMPAT_TODAY, '2026-06-29');
  resetSourceCompatTelemetryForTest();
  const normalized = normalizeRunStartPayload({ source: 'legacy-source' });
  assert.equal(normalized.compat, true);
  assert.equal(normalized.intent, 'doc');
  const telemetry = getSourceCompatTelemetry();
  assert.equal(telemetry.count, 1);
  assert.equal(telemetry.last_day, '2026-06-29');
  assert.equal(telemetry.until, '2026-06-30');
});

test('runs-service: source compat path hard-fails after sunset', (t) => {
  withEnv(t, ALLOW_SOURCE_COMPAT_UNTIL, '2026-06-30');
  withEnv(t, JEJAKEKAL_COMPAT_TODAY, '2026-07-01');
  resetSourceCompatTelemetryForTest();
  assert.throws(() => normalizeRunStartPayload({ source: 'legacy-source' }), {
    name: 'RequestError',
    payload: { error: 'source_compat_expired', until: '2026-06-30' }
  });
  const telemetry = getSourceCompatTelemetry();
  assert.equal(telemetry.count, 0);
});
