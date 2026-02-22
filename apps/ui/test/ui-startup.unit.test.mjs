import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUiStartupConfig } from '../src/ui-startup.mjs';

test('ui-startup: defaults to embedded api on API_PORT', () => {
  const config = resolveUiStartupConfig({}, { API_PORT: '4010' });
  assert.deepEqual(config, { apiPort: 4010, embedApi: true });
});

test('ui-startup: disables embedded api when UI_EMBED_API is false-like', () => {
  const config = resolveUiStartupConfig({}, { API_PORT: '4010', UI_EMBED_API: 'false' });
  assert.deepEqual(config, { apiPort: 4010, embedApi: false });
});

test('ui-startup: explicit opts override env', () => {
  const config = resolveUiStartupConfig(
    { apiPort: 4999, embedApi: false },
    { API_PORT: '4010', UI_EMBED_API: 'true' }
  );
  assert.deepEqual(config, { apiPort: 4999, embedApi: false });
});

test('ui-startup: rejects invalid api port', () => {
  assert.throws(() => resolveUiStartupConfig({}, { API_PORT: '-1' }), /invalid api port/);
});

