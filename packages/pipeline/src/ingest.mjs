import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChunkIndex } from './docir.mjs';
import { runDocirParser } from './parser/docir-runner.mjs';
import { sha256 } from '../../core/src/hash.mjs';

/**
 * @param {{docId:string, source:string, outDir:string, useOCR?:boolean}} opts
 */
export async function ingestDocument(opts) {
  await mkdir(opts.outDir, { recursive: true });
  const { doc, ocrRequired } = runDocirParser({ source: opts.source });
  const ocrUsed = Boolean(opts.useOCR) && ocrRequired;
  const chunks = buildChunkIndex(doc);

  const rawPath = join(opts.outDir, `${opts.docId}.txt`);
  const docIrPath = join(opts.outDir, `${opts.docId}.docir.json`);
  const chunkPath = join(opts.outDir, `${opts.docId}.chunks.json`);
  const memoPath = join(opts.outDir, `${opts.docId}.memo.json`);

  const raw = `${opts.source.trim()}\n`;
  await writeFile(rawPath, raw, 'utf8');
  await writeFile(docIrPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await writeFile(chunkPath, `${JSON.stringify(chunks, null, 2)}\n`, 'utf8');

  const memo = {
    docId: opts.docId,
    rawHash: sha256(raw),
    chunkCount: chunks.length,
    ocrRequired,
    ocrUsed,
    deterministicOrder: chunks.map((chunk) => chunk.chunkId)
  };
  await writeFile(memoPath, `${JSON.stringify(memo, null, 2)}\n`, 'utf8');

  return {
    paths: {
      raw: rawPath,
      docir: docIrPath,
      chunkIndex: chunkPath,
      memo: memoPath
    },
    doc,
    chunks,
    memo
  };
}
