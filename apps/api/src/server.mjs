import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema, makeClient } from './db.mjs';
import { ensureDbosRuntime, shutdownDbosRuntime } from './dbos-runtime.mjs';
import { closeServer, listenLocal, sendJson } from './http.mjs';
import { handleRunsRoute } from './runs-routes.mjs';
import { handleArtifactsRoute } from './artifacts-routes.mjs';
import { handleSystemRoute } from './system-routes.mjs';
import { isRequestError } from './request-errors.mjs';
import { onceAsync } from '../../../packages/core/src/once-async.mjs';

/**
 * @param {number} port
 */
export async function startApiServer(port = 4010) {
  const keepBundles = process.env.JEJAKEKAL_BUNDLES_RETAIN === '1';
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
        (await handleRunsRoute(req, res, { client, bundlesRoot })) ||
        (await handleArtifactsRoute(req, res, { client, bundlesRoot })) ||
        (await handleSystemRoute(req, res, { client }));
      if (handled) {
        return;
      }

      res.writeHead(404).end('not found');
    } catch (error) {
      if (isRequestError(error)) {
        sendJson(res, error.status, error.payload);
        return;
      }
      sendJson(res, 500, { error: 'internal_error' });
    }
  });

  const boundPort = await listenLocal(server, port);
  const close = onceAsync(async () => {
    await closeServer(server);
    await shutdownDbosRuntime();
    await client.end();
    if (!keepBundles) {
      await rm(bundlesRoot, { recursive: true, force: true });
    }
  });

  return {
    port: boundPort,
    bundlesRoot,
    close
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.API_PORT ?? '4010');
  startApiServer(port)
    .then((api) => {
      process.stdout.write(`api listening on ${api.port}\n`);
      const handleSignal = async (signal) => {
        process.stdout.write(`api shutdown (${signal})\n`);
        await api.close();
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
