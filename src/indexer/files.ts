import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { trackedFiles } from './repo.js';

/** Git-tracked files when `dir` is a git checkout, else every non-hidden file. */
export async function trackedOrWalked(dir: string): Promise<string[]> {
  return existsSync(join(dir, '.git')) ? trackedFiles(dir) : walk(dir, dir);
}

async function walk(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, full)));
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out.sort();
}
