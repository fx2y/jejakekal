import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {string} root
 */
export async function loadSkills(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(root, entry.name, 'SKILL.md');
    try {
      const body = await readFile(skillPath, 'utf8');
      skills.push({ name: entry.name, body });
    } catch {
      // Ignore directories without a skill descriptor.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
