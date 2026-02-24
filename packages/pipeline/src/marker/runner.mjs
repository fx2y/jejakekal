import { access, mkdir, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../../../core/src/hash.mjs';

const execFile = promisify(execFileCb);
const REQUIRED_OUTPUT_FILES = Object.freeze(['marker.json', 'marker.md', 'chunks.json', 'marker.html']);

/**
 * @param {string} value
 */
function escapePdfText(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replace(/[^\x20-\x7E]/g, '?');
}

/**
 * Deterministic minimal PDF emitter used for C2 page-render integration tests and
 * hard-doc fallback plumbing while raw ingest remains text-first.
 * @param {string} source
 */
function buildDeterministicPdf(source) {
  const lines = source
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const pageTexts = lines.length > 0 ? lines : ['(empty)'];
  const pageCount = pageTexts.length;
  const fontObjNum = 3 + pageCount * 2;
  /** @type {Map<number, string>} */
  const objects = new Map();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = [];
  for (let idx = 0; idx < pageCount; idx += 1) {
    const pageObjNum = 3 + idx * 2;
    const contentObjNum = pageObjNum + 1;
    kids.push(`${pageObjNum} 0 R`);
    const escaped = escapePdfText(pageTexts[idx]);
    const stream = `BT /F1 14 Tf 36 756 Td (${escaped}) Tj ET`;
    const streamLength = Buffer.byteLength(stream, 'utf8');
    objects.set(
      pageObjNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`
    );
    objects.set(contentObjNum, `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`);
  }
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);
  objects.set(fontObjNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const header = '%PDF-1.4\n';
  let body = '';
  /** @type {number[]} */
  const offsets = [0];
  for (let objNum = 1; objNum <= fontObjNum; objNum += 1) {
    offsets[objNum] = Buffer.byteLength(header + body, 'utf8');
    body += `${objNum} 0 obj\n${objects.get(objNum) ?? '<<>>'}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(header + body, 'utf8');
  let xref = `xref\n0 ${fontObjNum + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let objNum = 1; objNum <= fontObjNum; objNum += 1) {
    xref += `${String(offsets[objNum]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${fontObjNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${body}${xref}${trailer}`, 'utf8');
}

/**
 * @param {string} value
 */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {{useLlm?: boolean}} opts
 */
export function resolveMarkerRunConfig(opts = {}) {
  const envUseLlm = asTrimmedString(process.env.JEJAKEKAL_MARKER_USE_LLM) === '1';
  const useLlm = Boolean(opts.useLlm ?? envUseLlm);
  const markerBin = asTrimmedString(process.env.MARKER_BIN) || 'python';
  const markerScript =
    asTrimmedString(process.env.MARKER_SCRIPT) ||
    new URL('../../scripts/marker_stub.py', import.meta.url).pathname;
  const argv = Object.freeze([
    markerScript,
    '--in',
    '<input>',
    '--out',
    '<output>',
    `--use_llm=${useLlm ? 1 : 0}`
  ]);
  const config = Object.freeze({
    runner: 'marker-local-stub',
    marker_bin: markerBin,
    marker_script: basename(markerScript),
    use_llm: useLlm ? 1 : 0,
    argv
  });
  return {
    markerBin,
    markerScript,
    useLlm,
    mode: useLlm ? 'hybrid' : 'deterministic',
    config,
    configSha256: sha256(JSON.stringify(config))
  };
}

/**
 * @param {string} markerBin
 */
async function assertMarkerBinary(markerBin) {
  const knownBins = new Set(['python', 'python3']);
  if (knownBins.has(markerBin)) {
    return;
  }
  await access(markerBin, constants.X_OK);
}

/**
 * @param {string} outputDir
 */
async function assertRequiredOutputs(outputDir) {
  for (const file of REQUIRED_OUTPUT_FILES) {
    const path = join(outputDir, file);
    const info = await stat(path);
    if (!info.isFile() || info.size < 1) {
      throw new Error(`marker_output_missing:${file}`);
    }
  }
  const imagesDir = join(outputDir, 'images');
  const imagesInfo = await stat(imagesDir);
  if (!imagesInfo.isDirectory()) {
    throw new Error('marker_output_missing:images');
  }
  return imagesDir;
}

/**
 * @param {string} imagesDir
 */
async function listImagePaths(imagesDir) {
  const entries = await readdir(imagesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(imagesDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * @param {{source:string, outDir:string, useLlm?: boolean}} opts
 */
export async function runMarker(opts) {
  await mkdir(opts.outDir, { recursive: true });
  const marker = resolveMarkerRunConfig({ useLlm: opts.useLlm });
  try {
    await assertMarkerBinary(marker.markerBin);
  } catch (error) {
    const wrapped = new Error('marker_binary_not_found');
    wrapped.cause = error;
    throw wrapped;
  }

  const inputPath = join(opts.outDir, '_marker-input.txt');
  await writeFile(inputPath, opts.source, 'utf8');
  const sourcePdfPath = join(opts.outDir, '_marker-input.pdf');
  await writeFile(sourcePdfPath, buildDeterministicPdf(opts.source));

  const startedAt = performance.now();
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFile(
      marker.markerBin,
      [marker.markerScript, '--in', inputPath, '--out', opts.outDir, `--use_llm=${marker.useLlm ? 1 : 0}`],
      {
        env: process.env,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
  } catch (error) {
    const stdoutBuffer =
      error && typeof error === 'object' && 'stdout' in error ? /** @type {any} */ (error).stdout : '';
    const stderrBuffer =
      error && typeof error === 'object' && 'stderr' in error ? /** @type {any} */ (error).stderr : '';
    stdout = String(stdoutBuffer ?? '');
    stderr = String(stderrBuffer ?? '');
    const wrapped = /** @type {any} */ (new Error('marker_run_failed'));
    wrapped.cause = error;
    wrapped.stdout = stdout;
    wrapped.stderr = stderr;
    throw wrapped;
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  const imagesDir = await assertRequiredOutputs(opts.outDir);
  const markerJsonPath = join(opts.outDir, 'marker.json');
  const markerMarkdownPath = join(opts.outDir, 'marker.md');
  const chunksPath = join(opts.outDir, 'chunks.json');
  const markerHtmlPath = join(opts.outDir, 'marker.html');

  const markerJsonText = await readFile(markerJsonPath, 'utf8');
  const chunksText = await readFile(chunksPath, 'utf8');
  const markerJson = JSON.parse(markerJsonText);
  const chunks = JSON.parse(chunksText);
  const imagePaths = await listImagePaths(imagesDir);

  return {
    paths: {
      markerJson: markerJsonPath,
      markerMarkdown: markerMarkdownPath,
      chunks: chunksPath,
      markerHtml: markerHtmlPath,
      imagesDir,
      imageFiles: imagePaths,
      sourcePdf: sourcePdfPath
    },
    markerJson,
    chunks,
    marker: {
      engine: 'marker-local-stub',
      version: String(markerJson?.version ?? 'unknown'),
      mode: marker.mode,
      use_llm: marker.useLlm ? 1 : 0,
      marker_cfg_sha: marker.configSha256,
      marker_cfg: marker.config,
      stdout_sha256: sha256(stdout),
      stderr_sha256: sha256(stderr),
      timing_ms: durationMs,
      stdout,
      stderr
    }
  };
}
