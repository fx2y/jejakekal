/**
 * @param {number} apiPort
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function callApi(apiPort, path, init) {
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, init);
  const text = await response.text();
  /** @type {unknown} */
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * @param {number} apiPort
 * @param {{cmd: string, sleepMs?: number}} payload
 */
export async function startRun(apiPort, payload) {
  return callApi(apiPort, '/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * @param {number} apiPort
 * @param {string} runId
 */
export async function getRun(apiPort, runId) {
  return callApi(apiPort, `/runs/${encodeURIComponent(runId)}`);
}

/**
 * @param {number} apiPort
 * @param {string} query
 */
export async function listArtifacts(apiPort, query = '') {
  const suffix = query.length > 0 ? `?${query}` : '';
  return callApi(apiPort, `/artifacts${suffix}`);
}

/**
 * @param {number} apiPort
 * @param {string} artifactId
 */
export async function getArtifact(apiPort, artifactId) {
  return callApi(apiPort, `/artifacts/${encodeURIComponent(artifactId)}`);
}
