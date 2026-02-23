import { basename } from 'node:path';
import { sendJson } from './http.mjs';
import { artifactBlobPath, decodeArtifactContentStrict, readVerifiedArtifactBlob } from './artifact-blobs.mjs';
import {
  getArtifactById,
  listArtifactsByFilters,
  toArtifactListItem
} from './artifacts/repository.mjs';
import {
  enrichArtifactsWithProducerFunctionId,
  withProducerFunctionId
} from './artifacts/producer-function-id.mjs';
import {
  decodeArtifactDownloadRouteId,
  decodeArtifactRouteId
} from './routes/artifacts-paths.mjs';
import { getRequestPathname } from './routes/runs-paths.mjs';

/**
 * @param {string} format
 */
function contentTypeForFormat(format) {
  if (format === 'application/json') return 'application/json';
  if (format === 'text/plain') return 'text/plain; charset=utf-8';
  if (format === 'text/markdown') return 'text/markdown; charset=utf-8';
  if (format === 'text/csv') return 'text/csv; charset=utf-8';
  if (format === 'text/html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * @param {URLSearchParams} params
 * @param {string} key
 */
function readOptionalQueryValue(params, key) {
  const raw = params.get(key);
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{client: import('pg').Client, bundlesRoot: string, s3Store?: {getObjectBytes: (params: {bucket?: string, key: string}) => Promise<Buffer>}}} ctx
 */
export async function handleArtifactsRoute(req, res, ctx) {
  if (!req.url) return false;
  const pathname = getRequestPathname(req.url);
  const queryIndex = req.url.indexOf('?');
  const query =
    queryIndex === -1 ? new URLSearchParams() : new URLSearchParams(req.url.slice(queryIndex + 1));

  if (req.method === 'GET' && pathname === '/artifacts') {
    const artifacts = await listArtifactsByFilters(ctx.client, {
      type: readOptionalQueryValue(query, 'type'),
      visibility: readOptionalQueryValue(query, 'visibility'),
      q: readOptionalQueryValue(query, 'q')
    });
    const enriched = await enrichArtifactsWithProducerFunctionId(ctx.client, artifacts);
    sendJson(
      res,
      200,
      enriched.map((artifact) => toArtifactListItem(artifact))
    );
    return true;
  }

  if (req.method === 'GET') {
    const downloadArtifactId = decodeArtifactDownloadRouteId(pathname);
    if (downloadArtifactId) {
      const artifact = await getArtifactById(ctx.client, downloadArtifactId);
      if (!artifact) {
        sendJson(res, 404, { error: 'artifact_not_found', artifact_id: downloadArtifactId });
        return true;
      }
      const filePath = artifactBlobPath(artifact, ctx.bundlesRoot);
      const payload = await readVerifiedArtifactBlob(artifact, ctx.bundlesRoot, {
        s3Store: ctx.s3Store
      });
      res.writeHead(200, {
        'content-type': contentTypeForFormat(artifact.format),
        'content-disposition': `attachment; filename="${basename(filePath)}"`
      });
      res.end(payload);
      return true;
    }

    const artifactId = decodeArtifactRouteId(pathname);
    if (artifactId) {
      const artifact = await getArtifactById(ctx.client, artifactId);
      if (!artifact) {
        sendJson(res, 404, { error: 'artifact_not_found', artifact_id: artifactId });
        return true;
      }
      const enriched = await withProducerFunctionId(ctx.client, new Map(), artifact);
      const payload = await readVerifiedArtifactBlob(artifact, ctx.bundlesRoot, {
        s3Store: ctx.s3Store
      });
      sendJson(res, 200, {
        meta: toArtifactListItem(enriched),
        content: decodeArtifactContentStrict(artifact.format, payload),
        prov: enriched.prov
      });
      return true;
    }
  }

  return false;
}
