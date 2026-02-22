/**
 * @param {string | undefined} raw
 * @param {boolean} fallback
 */
function parseBooleanEnv(raw, fallback) {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * @param {number} value
 * @param {string} label
 */
function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

/**
 * @param {{apiPort?: number, embedApi?: boolean}} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveUiStartupConfig(opts = {}, env = process.env) {
  const apiPort = Number(opts.apiPort ?? env.API_PORT ?? '4010');
  const embedApi = opts.embedApi ?? parseBooleanEnv(env.UI_EMBED_API, true);
  assertPort(apiPort, 'api port');
  return {
    apiPort,
    embedApi
  };
}

