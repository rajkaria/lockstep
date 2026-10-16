import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('GitHub Action', () => {
  it('lives at the repository root, so `uses: rajkaria/staleproof@v1` works', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    expect(yml).toContain('using: composite');
    // Zero configuration: no input is required.
    expect(yml).not.toMatch(/required: true/);
    for (const input of ['also-index:', 'anthropic-api-key:', 'model:', 'base-url:', 'runs:', 'fail-on:', 'comment:', 'pr-url:', 'falkordb-url:', 'org:', 'reindex:', 'github-token:', 'version:']) {
      expect(yml).toContain(`\n  ${input}`);
    }
  });

  it('calls real CLI commands and flags', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    for (const cmd of ['index', 'check']) expect(cli).toContain(`.command('${cmd}')`);
    for (const flag of ['--no-agent', '--format', '--out', '--runs', '--with']) {
      expect(yml).toContain(flag);
      expect(cli).toContain(`'${flag}`);
    }
  });

  it('runs the published version of this commit by default', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(yml).toMatch(new RegExp(`version:\\n    description: [^\\n]+\\n    default: '${pkg.version.replace(/\./g, '\\.')}'`));
  });

  it('updates its own comment, found by the marker the report starts with', async () => {
    const yml = await readFile(join(root, 'action.yml'), 'utf8');
    const { COMMENT_MARKER } = await import('../src/format/markdown.js');
    expect(COMMENT_MARKER).toBe('<!-- staleproof -->');
    expect(yml).toContain(`startswith("${COMMENT_MARKER}")`);
    // The breaks output counts the rows the report marks as breaking.
    expect(yml).toContain("grep -c '| \\*\\*breaks\\*\\*'");
  });

  it('the install workflow in examples/ uses the root action and needs no secrets', async () => {
    const wf = await readFile(join(root, 'examples', 'staleproof.yml'), 'utf8');
    expect(wf).toMatch(/uses: rajkaria\/staleproof@v\d/);
    expect(wf).toContain('pull-requests: write');
    expect(wf).not.toMatch(/^\s+[a-z-]+: \$\{\{ secrets\./m);
  });
});
