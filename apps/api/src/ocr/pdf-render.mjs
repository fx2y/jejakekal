import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../../../../packages/core/src/hash.mjs';

const execFile = promisify(execFileCb);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {unknown} value
 */
function parsePageIdx0(value) {
  const page = Number(value);
  if (!Number.isFinite(page)) return null;
  return Math.max(0, Math.trunc(page));
}

/**
 * @param {unknown[]} values
 */
function normalizePageIdx0(values) {
  return [...new Set(values.map((value) => parsePageIdx0(value)).filter((value) => value != null))].sort(
    (a, b) => a - b
  );
}

/**
 * @param {number} pageIdx0
 */
export function toPdfPageIndex(pageIdx0) {
  return Math.max(0, Math.trunc(pageIdx0)) + 1;
}

/**
 * @param {number} pageNo1
 */
export function toPageIdx0(pageNo1) {
  return Math.max(0, Math.trunc(pageNo1) - 1);
}

/**
 * @param {Buffer} payload
 */
function assertPngPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < PNG_SIGNATURE.length) {
    throw new Error('ocr_render_png_invalid');
  }
  if (!payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('ocr_render_png_invalid');
  }
}

/**
 * @param {{pdftoppmBin?: string}} [opts]
 */
export async function assertPdfRenderDependency(opts = {}) {
  const pdftoppmBin = typeof opts.pdftoppmBin === 'string' && opts.pdftoppmBin.trim() ? opts.pdftoppmBin.trim() : process.env.PDFTOPPM_BIN ?? 'pdftoppm';
  try {
    await access(pdftoppmBin, constants.X_OK);
    return pdftoppmBin;
  } catch {}
  try {
    await execFile('sh', ['-lc', `command -v ${JSON.stringify(pdftoppmBin)} >/dev/null`], {
      maxBuffer: 1024 * 1024
    });
    return pdftoppmBin;
  } catch {
    throw new Error('ocr_render_missing_pdftoppm');
  }
}

/**
 * @param {{pdfPath:string,pageIdx0:number[],dpi?:number,pdftoppmBin?:string}} params
 */
export async function renderPdfPages(params) {
  const pages = normalizePageIdx0(params.pageIdx0 ?? []);
  if (pages.length < 1) return [];
  const pdftoppmBin = await assertPdfRenderDependency({ pdftoppmBin: params.pdftoppmBin });
  const dpi = Number.isFinite(Number(params.dpi)) ? Math.max(72, Math.trunc(Number(params.dpi))) : 300;
  const scratch = await mkdtemp(join(tmpdir(), 'jejakekal-ocr-render-'));
  try {
    /** @type {Array<{page_idx:number,png:Buffer,png_sha:string,mime:'image/png'}>} */
    const rendered = [];
    for (const pageIdx of pages) {
      const page1 = toPdfPageIndex(pageIdx);
      const prefix = join(scratch, `p${String(pageIdx).padStart(4, '0')}`);
      await execFile(
        pdftoppmBin,
        [params.pdfPath, prefix, '-png', '-f', String(page1), '-l', String(page1), '-singlefile', '-rx', String(dpi), '-ry', String(dpi)],
        {
          maxBuffer: 8 * 1024 * 1024
        }
      );
      const png = await readFile(`${prefix}.png`);
      assertPngPayload(png);
      rendered.push({
        page_idx: pageIdx,
        png,
        png_sha: sha256(png),
        mime: 'image/png'
      });
    }
    return rendered;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
