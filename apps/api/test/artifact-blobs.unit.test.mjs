import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../../../packages/core/src/hash.mjs';
import { artifactBlobPath, readVerifiedArtifactBlob } from '../src/artifact-blobs.mjs';

test('artifact blobs: bundle uri resolves to bundle-root path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-blobs-'));
  try {
    const path = artifactBlobPath(
      { uri: 'bundle://run-1/run-1%3Amemo/ingest/memo.md' },
      root
    );
    assert.ok(path.endsWith('/run-1/ingest/memo.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact blobs: s3 uri read path requires resolver and verifies hash', async () => {
  const payload = Buffer.from('hello-s3');
  const artifact = {
    uri: 's3://mem/raw/sha256/abc',
    sha256: sha256(payload)
  };
  const got = await readVerifiedArtifactBlob(artifact, '/tmp/bundles', {
    s3Store: {
      async getObjectBytes() {
        return payload;
      }
    }
  });
  assert.equal(got.toString('utf8'), 'hello-s3');

  await assert.rejects(() => readVerifiedArtifactBlob(artifact, '/tmp/bundles'), {
    message: 'artifact_uri_scheme_not_supported'
  });
});
