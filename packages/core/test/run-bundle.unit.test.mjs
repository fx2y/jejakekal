import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/hash.mjs';
import { createDeterministicZip, listZipEntries } from '../src/deterministic-zip.mjs';
import { diffRunBundles, makeManifest, writeRunBundle } from '../src/run-bundle.mjs';
import { freezeDeterminism } from '../src/determinism.mjs';

test('run-bundle diff ignores timestamps and checks structure', async () => {
  const unfreeze = freezeDeterminism({ now: Date.parse('2026-02-20T00:00:00.000Z') });
  const leftDir = await mkdtemp(join(tmpdir(), 'bundle-left-'));
  const rightDir = await mkdtemp(join(tmpdir(), 'bundle-right-'));

  try {
    await writeRunBundle(leftDir, {
      manifest: makeManifest({ workflowId: 'wf-1', root: '/tmp/a/wf-1' }),
      timeline: [{ step: 'a', phase: 'completed' }],
      toolIO: [],
      artifacts: [{ id: 'memo' }],
      citations: [{ source: 'x' }],
      extraJsonFiles: { 'workflow_status.json': { workflow_uuid: 'wf-1', status: 'SUCCESS' } }
    });

    unfreeze();
    await writeRunBundle(rightDir, {
      manifest: makeManifest({ workflowId: 'wf-1', root: '/private/tmp/b/wf-1' }),
      timeline: [{ step: 'a', phase: 'completed' }],
      toolIO: [],
      artifacts: [{ id: 'memo' }],
      citations: [{ source: 'x' }],
      extraJsonFiles: { 'workflow_status.json': { workflow_uuid: 'wf-1', status: 'SUCCESS' } }
    });

    const diffs = await diffRunBundles(leftDir, rightDir);
    assert.equal(diffs.length, 0);
  } finally {
    await rm(leftDir, { recursive: true, force: true });
    await rm(rightDir, { recursive: true, force: true });
  }
});

test('deterministic-zip keeps byte identity and sorted entry list', () => {
  const first = createDeterministicZip([
    { name: 'b.txt', data: 'B' },
    { name: 'a.txt', data: 'A' }
  ]);
  const second = createDeterministicZip([
    { name: 'a.txt', data: 'A' },
    { name: 'b.txt', data: 'B' }
  ]);

  assert.equal(sha256(first), sha256(second));
  assert.deepEqual(
    listZipEntries(first).map((entry) => entry.name),
    ['a.txt', 'b.txt']
  );
});
