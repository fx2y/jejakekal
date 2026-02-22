import test from 'node:test';
import assert from 'node:assert/strict';
import { getRequestPathname, decodeRunExportRouteId, decodeRunRouteId } from '../src/routes/runs-paths.mjs';

test('runs-paths: pathname stripping keeps raw encoded segments', () => {
  assert.equal(getRequestPathname('/runs/abc-123?x=1'), '/runs/abc-123');
  assert.equal(getRequestPathname('/runs/%2E%2E/export?x=1'), '/runs/%2E%2E/export');
});

test('runs-paths: decode run and export ids', () => {
  assert.equal(decodeRunRouteId('/runs/abc-123'), 'abc-123');
  assert.equal(decodeRunExportRouteId('/runs/abc-123/export'), 'abc-123');
  assert.equal(decodeRunRouteId('/runs/abc-123/export'), null);
  assert.equal(decodeRunExportRouteId('/runs/abc-123'), null);
});
