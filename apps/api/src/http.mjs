/**
 * @param {import('node:http').IncomingMessage} req
 */
export async function readRequestBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export async function readJsonRequest(req) {
  const body = await readRequestBody(req);
  return JSON.parse(body || '{}');
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {string} [contentType]
 */
export function sendText(res, status, body, contentType = 'text/plain') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 */
export async function listenLocal(server, port) {
  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
}

/**
 * @param {import('node:http').Server} server
 */
export async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
}
