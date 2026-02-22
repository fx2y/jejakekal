import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createDeterministicZip } from '../../../packages/core/src/deterministic-zip.mjs';

/**
 * @param {string} bundleDir
 */
export async function buildRunBundleZip(bundleDir) {
  const names = (await readdir(bundleDir)).filter((name) => name.endsWith('.json')).sort();
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      data: await readFile(join(bundleDir, name))
    }))
  );
  return createDeterministicZip(entries);
}

/**
 * @param {string} runId
 */
export function bundleZipFilename(runId) {
  const safe = basename(runId).replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return `${safe}.bundle.zip`;
}
