import { lstat, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFixCommand } from '../src/lint/fix-command.js';
import { baseRepo, git, headChange } from './fix-helpers.js';

const dirs: string[] = [];
async function repo(head = true): Promise<{ dir: string; base: string }> {
  const r = await baseRepo();
  dirs.push(r.dir);
  if (head) await headChange(r.dir);
  return r;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('staleproof fix', () => {
  it('--dry-run prints the unified diff and writes nothing', async () => {
    const { dir } = await repo();
    const before = git(dir, 'status', '--porcelain');
    const r = await runFixCommand({ dir, dryRun: true, cache: false });
    expect(git(dir, 'status', '--porcelain')).toBe(before);
    expect(r.diff).toContain('--- a/AGENTS.md\n+++ b/AGENTS.md\n');
    expect(r.diff).toContain('\n-- Check the docs with `npm run lint:docs` and `make check-docs`.\n');
    expect(r.diff).toContain('\n+- Check the docs with `npm run docs:lint` and `make docs-check`.\n');
    expect(r.output).toContain('would fix  AGENTS.md:4:24  command-missing  Rename to `npm run docs:lint` (renamed in package.json)');
    expect(r.output).toMatch(/Would fix 13 findings in 5 files \(dry run: nothing written\); 3 findings left\.$/);
    expect(r.output).toContain('hint   AGENTS.md:3:66  path-missing  Rename to `src/config/defaults.ts` (renamed in this change) (not applied: the fix did not pass re-checking)');
    expect(r.files.sort()).toEqual(['.env.example', 'AGENTS.md', 'README.md', 'docs/usage.md', 'mypkg/client.py']);
    expect(r.base).toMatchObject({ ref: 'HEAD', why: 'the uncommitted changes against the last commit' });
    // `npm run tset`, `npm run dov` and the path with a line past the end are left: errors, so exit 1.
    expect(r.exitCode).toBe(1);
  });

  it('applies the verified fixes; a second run has nothing to do', async () => {
    const { dir } = await repo();
    const first = await runFixCommand({ dir, cache: false });
    expect(first.applied).toHaveLength(13);
    expect(first.output).toMatch(/^Fixed 13 findings in 5 files; 3 findings left\.$/m);
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('- Defaults live in `src/config/defaults.ts`; retries are set at `src/settings/defaults.ts:40`.');
    expect(agents).toContain('- Check the docs with `npm run docs:lint` and `make docs-check`.');
    expect(agents).toContain('`npm run build`, test with `npm run tset`');
    expect(agents).toContain('`mytool --color auto --silent`');
    expect(await readFile(join(dir, '.env.example'), 'utf8')).toContain('\nREDIS_HOST=localhost\n');
    expect(await readFile(join(dir, 'mypkg/client.py'), 'utf8')).toContain('            timeout: How long to wait.\n');
    expect(first.remaining.findings.map((f) => `${f.rule} ${f.subject}`)).toEqual(['path-missing src/settings/defaults.ts', 'command-missing npm run tset', 'command-missing npm run dov']);

    const status = git(dir, 'status', '--porcelain');
    const second = await runFixCommand({ dir, cache: false });
    expect(second.applied).toEqual([]);
    expect(second.files).toEqual([]);
    expect(second.output).toContain('Nothing to fix automatically; 3 findings left (run staleproof lint to see them).');
    expect(git(dir, 'status', '--porcelain')).toBe(status);
    expect(second.exitCode).toBe(1);
    expect((await runFixCommand({ dir, cache: false, failOn: 'never' })).exitCode).toBe(0);
  });

  it('--rule fixes only those rules', async () => {
    const { dir } = await repo();
    const r = await runFixCommand({ dir, rules: ['env-unused'], cache: false });
    expect(r.applied.map((f) => `${f.path} ${f.rule}`)).toEqual(['README.md env-unused', '.env.example env-unused']);
    expect(r.files.sort()).toEqual(['.env.example', 'README.md']);
  });

  it('--new fixes only the drift the changes introduced', async () => {
    const { dir, base } = await repo(false);
    await headChange(dir);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'rename things');
    const r = await runFixCommand({ dir, new: true, base, cache: false, format: 'json' });
    // `npm run buld` and the other typos were there at the base: not this change's drift.
    expect(r.applied.map((f) => `${f.rule} ${f.subject}`).sort()).toEqual(
      ['command-missing make check-docs', 'command-missing npm run lint:docs', 'cli-flag-unknown mytool --quiet', 'link-broken docs/old-guide.md', 'path-missing src/settings/defaults.ts'].sort(),
    );
    const json = JSON.parse(r.output) as { version: number; dryRun: boolean; files: string[]; remaining: unknown[]; base: { ref: string } };
    expect(json).toMatchObject({ version: 1, dryRun: false, base: { ref: base } });
    expect(json.files.sort()).toEqual(['AGENTS.md', 'docs/usage.md']);
    // Left: the new path reference with a line past the end of the moved file.
    expect(json.remaining).toHaveLength(1);
  });

  it('edits a linked agent file once, through the file it points to, and keeps the link', async () => {
    const { dir } = await repo(false);
    await symlink('AGENTS.md', join(dir, 'CLAUDE.md'));
    git(dir, 'add', 'CLAUDE.md');
    git(dir, 'commit', '-q', '-m', 'link');
    const r = await runFixCommand({ dir, rules: ['command-missing'], cache: false });
    expect(r.skipped).toEqual([]);
    expect(r.files).toEqual(['AGENTS.md']);
    expect(r.applied.map((f) => `${f.path} ${f.subject}`).sort()).toEqual(['AGENTS.md npm run buld', 'CLAUDE.md npm run buld']);
    expect((await lstat(join(dir, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('`npm run build`, test with');
    expect(r.output).not.toContain('skipped');
  });

  it('outside git, fixes without a base; --new needs git', async () => {
    const { dir } = await repo(false);
    await rm(join(dir, '.git'), { recursive: true, force: true });
    const r = await runFixCommand({ dir, dryRun: true, cache: false });
    expect(r.base).toBeUndefined();
    expect(r.applied.map((f) => f.subject)).toContain('npm run buld');
    await expect(runFixCommand({ dir, new: true, cache: false })).rejects.toThrow(/--new needs a git checkout/);
  });
});
