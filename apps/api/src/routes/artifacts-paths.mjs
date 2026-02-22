import { decodeAndValidateArtifactId } from '../artifacts/artifact-id.mjs';

/**
 * @param {string} pathname
 */
export function decodeArtifactRouteId(pathname) {
  const prefix = '/artifacts/';
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeAndValidateArtifactId(raw);
}

/**
 * @param {string} pathname
 */
export function decodeArtifactDownloadRouteId(pathname) {
  const prefix = '/artifacts/';
  const suffix = '/download';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (!raw || raw.includes('/')) return null;
  return decodeAndValidateArtifactId(raw);
}
