import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOcrPolicy } from '../src/ocr/config.mjs';

test('ocr config: defaults are deterministic and pinned', () => {
  const policy = resolveOcrPolicy({});
  assert.deepEqual(policy, {
    enabled: true,
    engine: 'vllm',
    model: 'zai-org/GLM-OCR',
    baseUrl: 'http://127.0.0.1:8000',
    timeoutMs: 120000,
    maxPages: 10
  });
  assert.equal(Object.isFrozen(policy), true);
});

test('ocr config: env override parsing is strict', () => {
  const policy = resolveOcrPolicy({
    OCR_ENABLED: '0',
    OCR_ENGINE: 'ollama',
    OCR_MODEL: 'glm-ocr-mini',
    OCR_BASE_URL: 'http://127.0.0.1:11434',
    OCR_TIMEOUT_MS: '30000',
    OCR_MAX_PAGES: '3'
  });
  assert.deepEqual(policy, {
    enabled: false,
    engine: 'ollama',
    model: 'glm-ocr-mini',
    baseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 30000,
    maxPages: 3
  });
});

test('ocr config: invalid engine and timeout fail closed', () => {
  assert.throws(() => resolveOcrPolicy({ OCR_ENGINE: 'unknown' }), {
    message: 'invalid_ocr_policy_engine'
  });
  assert.throws(() => resolveOcrPolicy({ OCR_TIMEOUT_MS: '0' }), {
    message: 'invalid_ocr_policy_timeout_ms'
  });
});
