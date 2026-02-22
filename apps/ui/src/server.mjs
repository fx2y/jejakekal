import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApiServer } from '../../api/src/server.mjs';
import { closeServer, listenLocal } from '../../api/src/http.mjs';
import { onceAsync } from '../../../packages/core/src/once-async.mjs';

/**
 * @param {number} uiPort
 * @param {{apiPort?: number}} [opts]
 */
export async function startUiServer(uiPort = 4110, opts = {}) {
  const api = await startApiServer(Number(opts.apiPort ?? process.env.API_PORT ?? '4010'));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }

      if (shouldProxy(req.url)) {
        const upstream = await fetch(`http://127.0.0.1:${api.port}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'POST' ? await readRequest(req) : undefined
        });
        const body = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(body);
        return;
      }

      const file = resolveStaticFile(req.url);
      const contentType = contentTypeFor(file);
      const payload = await readFile(join(process.cwd(), 'apps/ui/src', file), 'utf8');
      res.writeHead(200, { 'content-type': contentType });
      res.end(payload);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  const boundUiPort = await listenLocal(server, uiPort);
  const close = onceAsync(async () => {
    await closeServer(server);
    await api.close();
  });

  return {
    uiPort: boundUiPort,
    apiPort: api.port,
    close
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
async function readRequest(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

/**
 * @param {string} url
 */
function resolveStaticFile(url) {
  if (url === '/app.js') return 'app.mjs';
  if (url === '/' || url === '/index.html') return 'index.html';

  const name = url.startsWith('/') ? url.slice(1) : url;
  if (!name.includes('/') && (name.endsWith('.css') || name.endsWith('.mjs'))) {
    return name;
  }
  return 'index.html';
}

/**
 * @param {string} url
 */
function shouldProxy(url) {
  return url.startsWith('/runs') || url === '/healthz';
}

/**
 * @param {string} file
 */
function contentTypeFor(file) {
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.mjs')) return 'text/javascript';
  return 'text/html';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.UI_PORT ?? '4110');
  startUiServer(port)
    .then((ui) => {
      process.stdout.write(`ui listening on ${ui.uiPort}\n`);
      const handleSignal = async (signal) => {
        process.stdout.write(`ui shutdown (${signal})\n`);
        await ui.close();
        process.exit(0);
      };
      process.once('SIGINT', () => {
        void handleSignal('SIGINT');
      });
      process.once('SIGTERM', () => {
        void handleSignal('SIGTERM');
      });
    })
    .catch((error) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
