import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {string | undefined} value
 */
function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function defaultBundlesRootPath() {
  return join(process.cwd(), '.cache', 'run-bundles');
}

/**
 * @param {{bundlesRoot?: string}} [opts]
 */
export function resolveBundlesRootPath(opts = {}) {
  return (
    normalizeNonEmptyString(opts.bundlesRoot) ??
    normalizeNonEmptyString(process.env.JEJAKEKAL_BUNDLES_ROOT) ??
    defaultBundlesRootPath()
  );
}

/**
 * @param {{cleanupBundlesOnClose?: boolean}} [opts]
 */
export function shouldCleanupBundlesRootOnClose(opts = {}) {
  if (typeof opts.cleanupBundlesOnClose === 'boolean') {
    return opts.cleanupBundlesOnClose;
  }
  return process.env.JEJAKEKAL_BUNDLES_CLEANUP_ON_CLOSE === '1';
}

/**
 * @param {{bundlesRoot?: string}} [opts]
 */
export async function ensureBundlesRoot(opts = {}) {
  const bundlesRoot = resolveBundlesRootPath(opts);
  await mkdir(bundlesRoot, { recursive: true });
  return bundlesRoot;
}
