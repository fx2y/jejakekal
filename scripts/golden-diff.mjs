import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ingestDocument } from '../packages/pipeline/src/ingest.mjs';
import { diffRunBundles, makeManifest, writeRunBundle } from '../packages/core/src/run-bundle.mjs';

async function main() {
  const source = await readFile('golden/corpus/doc-a.txt', 'utf8');
  const ingest = await ingestDocument({
    docId: 'golden-doc-a',
    source,
    outDir: 'golden/generated'
  });

  await mkdir('golden/actual', { recursive: true });
  await writeRunBundle('golden/actual', {
    manifest: makeManifest({ workflowId: 'golden-workflow', root: 'golden/bundle' }),
    timeline: [
      { step: 'ingest', phase: 'completed', payload: { docId: 'golden-doc-a' } },
      { step: 'index', phase: 'completed', payload: { chunks: ingest.chunks.length } }
    ],
    toolIO: [{ tool: 'pipeline.ingest', input: 'doc-a.txt' }],
    artifacts: [
      { id: 'raw', path: ingest.paths.raw },
      { id: 'docir', path: ingest.paths.docir },
      { id: 'chunks', path: ingest.paths.chunkIndex },
      { id: 'memo', path: ingest.paths.memo }
    ],
    citations: [{ source: 'golden/corpus/doc-a.txt', confidence: 1 }]
  });

  const diffs = await diffRunBundles('golden/expected', 'golden/actual');

  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/golden-diff.stamp', `${Date.now()}\n`, 'utf8');

  if (diffs.length) {
    process.stderr.write(`golden mismatch:\n${JSON.stringify(diffs, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('golden diff clean\n');
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
