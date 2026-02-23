import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createS3BlobStore, makeS3ArtifactUri } from '../src/blob/s3-store.mjs';

test('s3 store: putObjectChecked enforces PUT+HEAD content-length contract', async () => {
  const calls = [];
  const store = createS3BlobStore({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'mem',
    client: {
      async send(command) {
        calls.push(command);
        if (command instanceof PutObjectCommand) return {};
        if (command instanceof HeadObjectCommand) return { ContentLength: 3, ETag: '"abc"' };
        throw new Error('unexpected_command');
      }
    }
  });

  const out = await store.putObjectChecked({
    key: 'raw/sha256/abc',
    payload: Buffer.from('hey'),
    contentType: 'text/plain'
  });

  assert.equal(out.key, 'raw/sha256/abc');
  assert.equal(out.contentLength, 3);
  assert.equal(out.uri, 's3://mem/raw/sha256/abc');
  assert.equal(calls.length, 2);
});

test('s3 store: putObjectChecked fails closed on HEAD mismatch', async () => {
  const store = createS3BlobStore({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'mem',
    client: {
      async send(command) {
        if (command instanceof PutObjectCommand) return {};
        if (command instanceof HeadObjectCommand) return { ContentLength: 999 };
        throw new Error('unexpected_command');
      }
    }
  });

  await assert.rejects(
    () =>
      store.putObjectChecked({
        key: 'raw/sha256/abc',
        payload: Buffer.from('ok'),
        contentType: 'text/plain'
      }),
    { message: 'blob_size_mismatch' }
  );
});

test('s3 store: getObjectBytes uses strict key parser and resolves body stream', async () => {
  const store = createS3BlobStore({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'mem',
    client: {
      async send(command) {
        if (command instanceof GetObjectCommand) {
          return { Body: Readable.from(['abc']) };
        }
        throw new Error('unexpected_command');
      }
    }
  });

  const payload = await store.getObjectBytes({ key: 'parse/doc-1/1/marker.json' });
  assert.equal(payload.toString('utf8'), 'abc');
  assert.equal(makeS3ArtifactUri('mem', 'raw/sha256/abc'), 's3://mem/raw/sha256/abc');
});
