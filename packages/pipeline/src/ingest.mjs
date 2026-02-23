import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../../core/src/hash.mjs';
import { runMarker } from './marker/runner.mjs';

/**
 * @param {string} value
 */
function toMarkdownLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * @param {{docId:string, source:string, outDir:string, useOCR?:boolean, useLlm?: boolean}} opts
 */
export async function ingestDocument(opts) {
  await mkdir(opts.outDir, { recursive: true });
  const rawPath = join(opts.outDir, `${opts.docId}.txt`);
  const raw = `${opts.source.trim()}\n`;
  await writeFile(rawPath, raw, 'utf8');

  const markerResult = await runMarker({
    source: opts.source,
    outDir: opts.outDir,
    useLlm: Boolean(opts.useLlm ?? opts.useOCR)
  });

  const chunks = Array.isArray(markerResult.chunks) ? markerResult.chunks : [];
  const memoPath = join(opts.outDir, `${opts.docId}.memo.md`);
  const memoLines = [
    `# Pipeline memo: ${opts.docId}`,
    `- raw_sha: ${sha256(raw)}`,
    `- marker_cfg_sha: ${markerResult.marker.marker_cfg_sha}`,
    `- marker_mode: ${markerResult.marker.mode}`,
    `- chunk_count: ${chunks.length}`,
    '## Excerpts',
    ...chunks.slice(0, 5).map((chunk) => {
      const chunkId = typeof chunk?.chunk_id === 'string' ? chunk.chunk_id : 'chunk-unknown';
      const text = toMarkdownLine(chunk?.text ?? '');
      return `- [${chunkId}] ${text}`;
    })
  ];
  await writeFile(memoPath, `${memoLines.join('\n').trim()}\n`, 'utf8');

  const assets = [];
  for (const imagePath of markerResult.paths.imageFiles) {
    const payload = await readFile(imagePath);
    assets.push({ path: imagePath, sha256: sha256(payload), byteLength: payload.length });
  }

  return {
    paths: {
      raw: rawPath,
      docir: markerResult.paths.markerJson,
      chunkIndex: markerResult.paths.chunks,
      memo: memoPath,
      markerMd: markerResult.paths.markerMarkdown,
      markerHtml: markerResult.paths.markerHtml,
      imagesDir: markerResult.paths.imagesDir
    },
    marker: markerResult.marker,
    chunks,
    assets,
    memo: {
      chunkCount: chunks.length,
      markerMode: markerResult.marker.mode,
      markerUseLlm: markerResult.marker.use_llm === 1
    }
  };
}
