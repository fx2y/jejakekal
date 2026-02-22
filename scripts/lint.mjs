import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const includeExt = new Set(['.mjs', '.md', '.json', '.yaml', '.yml', '.toml', '.sh', '.txt', '.sql']);
const truthLeakToken = 'assistant' + 'Answer';
const truthLeakScanPrefixes = ['apps/', 'packages/', 'scripts/'];
const truthLeakAllowPaths = new Set(['apps/ui/src/ui-render.mjs']);

function extname(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? '' : path.slice(idx);
}

function lintContent(path, source) {
  const issues = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/\s+$/.test(line) && line.length > 0) {
      issues.push(`${path}:${i + 1}: trailing-whitespace`);
    }
    if (/^\t+/.test(line)) {
      issues.push(`${path}:${i + 1}: leading-tab`);
    }
  }
  if (shouldCheckTruthLeak(path) && source.includes(truthLeakToken) && !truthLeakAllowPaths.has(path)) {
    issues.push(`${path}: truth-leak`);
  }
  return issues;
}

function shouldCheckTruthLeak(path) {
  return (
    path.endsWith('.mjs') &&
    truthLeakScanPrefixes.some((prefix) => path.startsWith(prefix)) &&
    !path.includes('/test/')
  );
}

async function main() {
  const { stdout } = await exec('rg', ['--files']);
  const files = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((path) => includeExt.has(extname(path)))
    .filter((path) => !path.startsWith('.git/'));
  const issues = [];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    issues.push(...lintContent(path, source));
  }

  await mkdir('.cache', { recursive: true });
  await writeFile('.cache/lint.stamp', `${Date.now()}\n`, 'utf8');

  if (issues.length > 0) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`lint ok (${files.length} files)\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
