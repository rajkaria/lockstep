import { accessSync, constants, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dirname, '..');

interface Hook {
  id: string;
  name: string;
  entry: string;
  language: string;
  pass_filenames?: boolean;
  stages?: string[];
  minimum_pre_commit_version?: string;
}

describe('.pre-commit-hooks.yaml', () => {
  it('defines the commit and push hooks pre-commit loads from this repository', async () => {
    const hooks = parseYaml(await readFile(join(ROOT, '.pre-commit-hooks.yaml'), 'utf8')) as Hook[];
    expect(hooks.map((h) => h.id)).toEqual(['staleproof', 'staleproof-predicted']);
    const [commit, push] = hooks as [Hook, Hook];
    expect(commit).toMatchObject({ language: 'script', pass_filenames: false, stages: ['pre-commit'] });
    expect(commit.entry).toBe('plugins/claude-code/scripts/staleproof.mjs lint --new --staged');
    expect(push).toMatchObject({ language: 'script', pass_filenames: false, stages: ['pre-push'] });
    expect(push.entry).toBe('plugins/claude-code/scripts/staleproof.mjs check --fail-on-predicted');
    for (const h of hooks) {
      // `language: script` runs the entry from this repository: it must be there and executable.
      const script = join(ROOT, h.entry.split(' ')[0]!);
      expect(existsSync(script)).toBe(true);
      accessSync(script, constants.X_OK);
      // The `pre-commit` and `pre-push` stage names need pre-commit 3.2.
      expect(h.minimum_pre_commit_version).toBe('3.2.0');
    }
  });

  it('runs real CLI commands and flags', async () => {
    const cli = await readFile(join(ROOT, 'src', 'cli.ts'), 'utf8');
    for (const flag of ['--new', '--staged', '--fail-on-predicted']) expect(cli).toContain(`'${flag}`);
  });
});
