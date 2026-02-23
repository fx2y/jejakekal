import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Buffer } from 'node:buffer';
import { assertAllowedObjectKey } from '../ingest/keys.mjs';

const DEFAULT_REGION = 'us-east-1';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9000';
const DEFAULT_BUCKET = 'mem';
const DEFAULT_ACCESS_KEY = 'any';
const DEFAULT_SECRET_KEY = 'any';

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function asNonEmptyString(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * @param {unknown} chunk
 */
function toChunkBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  throw new Error('blob_payload_chunk_invalid');
}

/**
 * @param {unknown} body
 */
async function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (!body || typeof body !== 'object' || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new Error('blob_payload_invalid');
  }
  const stream = /** @type {AsyncIterable<unknown>} */ (body);
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(toChunkBuffer(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function defaultS3BlobStoreConfig(env = process.env) {
  return {
    endpoint: asNonEmptyString(env.BLOB_ENDPOINT, DEFAULT_ENDPOINT),
    bucket: asNonEmptyString(env.BLOB_BUCKET, DEFAULT_BUCKET),
    region: asNonEmptyString(env.BLOB_REGION, DEFAULT_REGION),
    accessKeyId: asNonEmptyString(env.BLOB_ACCESS_KEY, DEFAULT_ACCESS_KEY),
    secretAccessKey: asNonEmptyString(env.BLOB_SECRET_KEY, DEFAULT_SECRET_KEY)
  };
}

/**
 * @param {string} bucket
 * @param {string} key
 */
export function makeS3ArtifactUri(bucket, key) {
  return `s3://${encodeURIComponent(bucket)}/${key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/**
 * @param {{
 *  endpoint: string,
 *  bucket: string,
 *  region?: string,
 *  accessKeyId?: string,
 *  secretAccessKey?: string,
 *  client?: { send: (command: unknown) => Promise<any> }
 * }} config
 */
export function createS3BlobStore(config) {
  const endpoint = asNonEmptyString(config.endpoint, DEFAULT_ENDPOINT);
  const bucket = asNonEmptyString(config.bucket, DEFAULT_BUCKET);
  const region = asNonEmptyString(config.region, DEFAULT_REGION);
  const accessKeyId = asNonEmptyString(config.accessKeyId, DEFAULT_ACCESS_KEY);
  const secretAccessKey = asNonEmptyString(config.secretAccessKey, DEFAULT_SECRET_KEY);

  const client =
    config.client ??
    new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey }
    });

  return {
    bucket,
    endpoint,
    /**
     * @param {{key: string, payload: Buffer, contentType: string}} params
     */
    async putObjectChecked(params) {
      const key = assertAllowedObjectKey(params.key);
      const payload = params.payload;
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: payload,
          ContentType: params.contentType
        })
      );
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const contentLength = Number(head.ContentLength ?? 0);
      if (contentLength !== payload.length) {
        throw new Error('blob_size_mismatch');
      }
      return {
        key,
        bucket,
        uri: makeS3ArtifactUri(bucket, key),
        etag: typeof head.ETag === 'string' ? head.ETag : null,
        contentLength
      };
    },
    /**
     * @param {{bucket?: string, key: string}} params
     */
    async getObjectBytes(params) {
      const resolvedBucket = asNonEmptyString(params.bucket, bucket);
      const key = assertAllowedObjectKey(params.key);
      const out = await client.send(
        new GetObjectCommand({
          Bucket: resolvedBucket,
          Key: key
        })
      );
      return toBuffer(out.Body);
    },
    /**
     * @param {{bucket?: string, key: string}} params
     */
    async headObject(params) {
      const resolvedBucket = asNonEmptyString(params.bucket, bucket);
      const key = assertAllowedObjectKey(params.key);
      return client.send(
        new HeadObjectCommand({
          Bucket: resolvedBucket,
          Key: key
        })
      );
    }
  };
}
