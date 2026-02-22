import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema, makeClient } from './db.mjs';
import { ensureDbosRuntime, shutdownDbosRuntime } from './dbos-runtime.mjs';
import { closeServer, listenLocal, sendJson } from './http.mjs';
import { handleLegacyApiRoute } from './legacy-api-routes.mjs';
import { handleRunsRoute } from './runs-routes.mjs';

/**
 * @param {number} port
 */
export async function startApiServer(port = 4010) {
  const client = makeClient();
  await client.connect();
  await applySchema(client);
  await ensureDbosRuntime();

  const bundlesRoot = await mkdtemp(join(tmpdir(), 'jejakekal-run-bundles-'));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }

      const handled =
        (await handleRunsRoute(req, res, { client })) ||
        (await handleLegacyApiRoute(req, res, { client, bundlesRoot }));
      if (handled) {
        return;
      }

      res.writeHead(404).end('not found');
    } catch (error) {
      sendJson(res, 500, { error: String(error) });
    }
  });

  const boundPort = await listenLocal(server, port);

  return {
    port: boundPort,
    close: async () => {
      await closeServer(server);
      await shutdownDbosRuntime();
      await client.end();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? '4010');
  startApiServer(port).then(() => {
    process.stdout.write(`api listening on ${port}\n`);
  });
}
