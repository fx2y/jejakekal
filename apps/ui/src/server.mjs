import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApiServer } from '../../api/src/server.mjs';

/**
 * @param {number} uiPort
 */
export async function startUiServer(uiPort = 4110) {
  const api = await startApiServer(Number(process.env.API_PORT ?? '4010'));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }

      if (req.url.startsWith('/api/')) {
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

      const file = req.url === '/styles.css'
        ? 'styles.css'
        : req.url === '/app.js'
          ? 'app.mjs'
          : 'index.html';
      const contentType = file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.mjs')
          ? 'text/javascript'
          : 'text/html';
      const payload = await readFile(join(process.cwd(), 'apps/ui/src', file), 'utf8');
      res.writeHead(200, { 'content-type': contentType });
      res.end(payload);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise((resolve) => {
    server.listen(uiPort, '127.0.0.1', () => resolve(undefined));
  });

  return {
    uiPort,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
      await api.close();
    }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.UI_PORT ?? '4110');
  startUiServer(port).then(() => {
    process.stdout.write(`ui listening on ${port}\n`);
  });
}
