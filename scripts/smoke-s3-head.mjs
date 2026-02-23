import { randomUUID } from 'node:crypto';
import { createS3BlobStore, defaultS3BlobStoreConfig } from '../apps/api/src/blob/s3-store.mjs';

async function main() {
  const store = createS3BlobStore(defaultS3BlobStoreConfig());
  const key = `run/smoke-${Date.now()}-${randomUUID()}/probe.txt`;
  const payload = Buffer.from(`smoke-${Date.now()}\n`, 'utf8');
  await store.putObjectChecked({
    key,
    payload,
    contentType: 'text/plain; charset=utf-8'
  });
  const got = await store.getObjectBytes({ key });
  if (!Buffer.isBuffer(got) || got.length !== payload.length || got.compare(payload) !== 0) {
    throw new Error('smoke_s3_roundtrip_failed');
  }
  process.stdout.write(`smoke-s3-head ok key=${key}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
