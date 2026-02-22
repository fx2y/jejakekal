import { createServer } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestDocument } from '../../../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../../../packages/core/src/run-bundle.mjs';
import { applySchema, makeClient } from './db.mjs';
import { defaultWorkflow, readTimeline } from './workflow.mjs';

/**
 * @param {number} port
 */
export async function startApiServer(port = 4010) {
  const client = makeClient();
  await client.connect();
  await applySchema(client);

  const bundlesRoot = await mkdtemp(join(tmpdir(), 'jejakekal-run-bundles-'));

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }

      if (req.method === 'POST' && req.url === '/api/run') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        const payload = JSON.parse(body || '{}');
        const workflowId = payload.workflowId ?? `wf-${Date.now()}`;
        const source = payload.source ?? 'default doc';
        const outDir = join(bundlesRoot, workflowId, 'ingest');

        const ingest = await ingestDocument({ docId: workflowId, source, outDir });
        await defaultWorkflow({ client, workflowId, value: source });
        const timeline = await readTimeline(client, workflowId);

        const bundleDir = join(bundlesRoot, workflowId, 'bundle');
        const manifest = makeManifest({ workflowId, root: bundleDir });
        const artifacts = [
          { id: 'raw', path: ingest.paths.raw },
          { id: 'docir', path: ingest.paths.docir },
          { id: 'chunk-index', path: ingest.paths.chunkIndex },
          { id: 'memo', path: ingest.paths.memo }
        ];
        await writeRunBundle(bundleDir, {
          manifest,
          timeline,
          toolIO: [{ tool: 'pipeline.ingest', workflowId }],
          artifacts,
          citations: [{ source: 'local', confidence: 1, text: source.slice(0, 24) }]
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ workflowId, bundleDir, timeline, artifacts }));
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/timeline/')) {
        const workflowId = req.url.replace('/api/timeline/', '');
        const timeline = await readTimeline(client, workflowId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ workflowId, timeline }));
        return;
      }

      if (req.method === 'GET' && req.url.startsWith('/api/artifacts/')) {
        const workflowId = req.url.replace('/api/artifacts/', '');
        const artifactDir = join(bundlesRoot, workflowId, 'bundle');
        const files = await readdir(artifactDir).catch(() => []);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ workflowId, files }));
        return;
      }

      if (req.method === 'GET' && req.url === '/healthz') {
        await client.query('SELECT 1');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }

      res.writeHead(404).end('not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });

  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });

  return {
    port,
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
