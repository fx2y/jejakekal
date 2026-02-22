import { mkdir, readFile } from 'node:fs/promises';
import { ingestDocument } from '../packages/pipeline/src/ingest.mjs';
import { makeManifest, writeRunBundle } from '../packages/core/src/run-bundle.mjs';

async function main() {
  await mkdir('golden/expected', { recursive: true });
  const source = await readFile('golden/corpus/doc-a.txt', 'utf8');
  const ingest = await ingestDocument({
    docId: 'golden-doc-a',
    source,
    outDir: 'golden/generated'
  });

  const timeline = [
    { step: 'ingest', phase: 'completed', payload: { docId: 'golden-doc-a' } },
    { step: 'index', phase: 'completed', payload: { chunks: ingest.chunks.length } }
  ];

  await writeRunBundle('golden/expected', {
    manifest: makeManifest({ workflowId: 'golden-workflow', root: 'golden/bundle' }),
    timeline,
    toolIO: [{ tool: 'pipeline.ingest', input: 'doc-a.txt' }],
    artifacts: [
      { id: 'raw', path: ingest.paths.raw },
      { id: 'docir', path: ingest.paths.docir },
      { id: 'chunks', path: ingest.paths.chunkIndex },
      { id: 'memo', path: ingest.paths.memo }
    ],
    citations: [{ source: 'golden/corpus/doc-a.txt', confidence: 1 }]
  });

  process.stdout.write('golden baseline recorded\n');
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
