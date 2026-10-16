import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('GitHub Action', () => {
  it('is a composite action whose steps call real CLI commands and flags', async () => {
    const yml = await readFile(join(root, 'action', 'action.yml'), 'utf8');
    expect(yml).toContain('using: composite');
    for (const input of ['falkordb-url:', 'org:', 'github-token:', 'anthropic-api-key:', 'reindex:', 'version:']) expect(yml).toContain(`  ${input}`);
    // Every staleproof invocation in the action must use commands and options the CLI defines.
    const cli = await readFile(join(root, 'src', 'cli.ts'), 'utf8');
    for (const cmd of ['index', 'check']) expect(cli).toContain(`.command('${cmd}')`);
    for (const flag of ['--no-agent', '--format', '--out']) expect(cli).toContain(`'${flag}`);
    expect(yml).toContain('startswith("<!-- staleproof -->")');
    const { COMMENT_MARKER } = await import('../src/format/markdown.js');
    expect(COMMENT_MARKER).toBe('<!-- staleproof -->');
  });
});
