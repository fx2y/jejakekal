import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveHardDocTimeoutMs,
  deriveHardDocWorkflowId,
  normalizeRunStartPayload,
  resolveWorkflowStartPlan,
  startRunDurably
} from '../src/runs-service.mjs';
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

test('runs-service: source-intent args support additive locator/mime for hard-doc path', () => {
  const normalized = normalizeRunStartPayload({
    intent: 'doc',
    args: {
      locator: 's3://bucket/invoice.pdf',
      mime: 'Application/PDF'
    }
  });
  assert.equal(normalized.compat, false);
  assert.deepEqual(normalized.args, {
    locator: 's3://bucket/invoice.pdf',
    mime: 'application/pdf'
  });
});

test('runs-service: hard-doc start plan derives deterministic workflowId + timeout budget', () => {
  const params = {
    intent: 'doc',
    args: {
      locator: 's3://bucket/invoice.pdf',
      mime: 'application/pdf'
    },
    ocrPolicy: {
      timeoutMs: 2500,
      maxPages: 8
    }
  };
  const plan = resolveWorkflowStartPlan(params);
  assert.equal(plan.hardDoc, true);
  assert.equal(plan.workflowId, deriveHardDocWorkflowId(params));
  assert.equal(plan.timeoutMs, deriveHardDocTimeoutMs(params.ocrPolicy));
});

test('runs-service: non-hard-doc plan keeps workflow defaults', () => {
  const plan = resolveWorkflowStartPlan({
    intent: 'doc',
    args: { source: 'plain text source' },
    ocrPolicy: { timeoutMs: 1000, maxPages: 1 }
  });
  assert.equal(plan.hardDoc, false);
  assert.equal(plan.workflowId, undefined);
  assert.equal(plan.timeoutMs, undefined);
});

test('runs-service: invalid OCR policy from client input fails typed 400', async () => {
  await assert.rejects(
    () =>
      startRunDurably(
        /** @type {import('pg').Client} */ ({}),
        {
          intent: 'doc',
          args: { source: 'abc' },
          ocrPolicy: {
            enabled: true,
            engine: 'vllm',
            model: '',
            baseUrl: 'http://127.0.0.1:8000',
            timeoutMs: 1000,
            maxPages: 1
          }
        }
      ),
    {
      name: 'RequestError',
      payload: { error: 'invalid_run_payload', field: 'ocrPolicy' }
    }
  );
});
