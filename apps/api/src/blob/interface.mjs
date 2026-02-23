import { readFile } from 'node:fs/promises';

/**
 * @typedef {{
 *  readFile: (path: string) => Promise<Buffer>
 * }} BlobPayloadReader
 */

/** @type {BlobPayloadReader} */
export const defaultBlobPayloadReader = Object.freeze({
  readFile: (path) => readFile(path)
});

/**
 * @param {BlobPayloadReader} reader
 * @param {string} path
 */
export async function readBlobPayload(reader, path) {
  if (!reader || typeof reader.readFile !== 'function') {
    throw new Error('blob_payload_reader_missing');
  }
  return reader.readFile(path);
}
