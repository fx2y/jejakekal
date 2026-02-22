import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '../src/loader.mjs';

test('skill loader discovers skill folders with SKILL.md', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skills-'));
  try {
    await mkdir(join(root, 'alpha'));
    await writeFile(join(root, 'alpha', 'SKILL.md'), '# alpha\n');
    await mkdir(join(root, 'beta'));
    const skills = await loadSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'alpha');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
