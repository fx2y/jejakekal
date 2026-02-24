import { createServer } from 'node:http';
import { closeServer, listenLocal } from '../apps/api/src/http.mjs';

/**
 * @param {{text?:string}} [opts]
 */
export async function startMockOcrServer(opts = {}) {
  const text = typeof opts.text === 'string' && opts.text.trim().length > 0 ? opts.text.trim() : 'ocr text';
  /** @type {string[]} */
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}\n');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: [{ type: 'text', text }]
            }
          }
        ]
      })
    );
  });
  const port = await listenLocal(server, 0);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server)
  };
}
