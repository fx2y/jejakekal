import { sha256 } from '../../../../packages/core/src/hash.mjs';
import { makeBundleArtifactUri } from '../artifact-uri.mjs';
import { defaultBlobPayloadReader, readBlobPayload } from './interface.mjs';

/**
 * @param {{
 *  runId: string,
 *  artifactId: string,
 *  relativePath: string,
 *  sourcePath: string,
 *  reader?: import('./interface.mjs').BlobPayloadReader
 * }} params
 */
export async function materializeBundleArtifact(params) {
  const payload = await readBlobPayload(params.reader ?? defaultBlobPayloadReader, params.sourcePath);
  return {
    payload,
    sha256: sha256(payload),
    uri: makeBundleArtifactUri({
      runId: params.runId,
      artifactId: params.artifactId,
      relativePath: params.relativePath
    })
  };
}
