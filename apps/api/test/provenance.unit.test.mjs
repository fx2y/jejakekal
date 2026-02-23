import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactProvenance, hashSource } from '../src/artifacts/provenance.mjs';

test('provenance: builds ids+hashes-only payload', () => {
  const sourceSha = hashSource('hello world');
  const prov = buildArtifactProvenance({
    runId: 'run-1',
    artifactType: 'memo',
    artifactSha256: 'a'.repeat(64),
    sourceSha256: sourceSha,
    inputs: [{ kind: 'timeline', id: 'prepare', sha256: 'b'.repeat(64) }]
  });

  assert.equal(prov.version, 1);
  assert.equal(prov.run_id, 'run-1');
  assert.equal(prov.artifact_type, 'memo');
  assert.equal(typeof prov.hash.artifact_sha256, 'string');
  assert.equal(typeof prov.hash.source_sha256, 'string');
  assert.equal(Object.hasOwn(prov, 'source'), false);
  assert.equal(Object.hasOwn(prov, 'content'), false);
});

test('provenance: rejects invalid hashes at boundary', () => {
  assert.throws(
    () =>
      buildArtifactProvenance({
        runId: 'run-1',
        artifactType: 'memo',
        artifactSha256: 'not-a-sha',
        sourceSha256: 'a'.repeat(64)
      }),
    /invalid_artifact_sha256/
  );
});
