import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sendJson } from './http.mjs';
import { resolveBundleArtifactUri } from './artifact-uri.mjs';
import {
  getArtifactById,
  listArtifactsByFilters,
  toArtifactListItem
} from './artifacts/repository.mjs';
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
 * @param {string} format
 * @param {Buffer} payload
 */
function decodeArtifactContent(format, payload) {
  if (format === 'application/json') {
    const text = payload.toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (format.startsWith('text/')) {
    return payload.toString('utf8');
  }
  return payload.toString('base64');
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
 * @param {{client: import('pg').Client, bundlesRoot: string}} ctx
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
    sendJson(
      res,
      200,
      artifacts.map((artifact) => toArtifactListItem(artifact))
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
      const filePath = resolveBundleArtifactUri(ctx.bundlesRoot, artifact.uri);
      const payload = await readFile(filePath);
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
      const filePath = resolveBundleArtifactUri(ctx.bundlesRoot, artifact.uri);
      const payload = await readFile(filePath);
      sendJson(res, 200, {
        meta: toArtifactListItem(artifact),
        content: decodeArtifactContent(artifact.format, payload),
        prov: artifact.prov
      });
      return true;
    }
  }

  return false;
}
