import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../packages/core/src/hash.mjs';

const exec = promisify(execFile);

async function main() {
  const { stdout } = await exec('rg', ['--files', 'apps', 'packages']);
  const files = stdout.split(/\r?\n/).filter(Boolean).filter((name) => name.endsWith('.mjs'));

  const manifest = [];
  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8');
    manifest.push({ file, hash: sha256(content) });
  }

  await mkdir('dist', { recursive: true });
  await writeFile('dist/build-manifest.json', `${JSON.stringify({ files: manifest }, null, 2)}\n`, 'utf8');
  process.stdout.write(`build manifest updated (${manifest.length} modules)\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
