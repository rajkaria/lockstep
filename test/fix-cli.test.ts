import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseRepo, git, headChange } from './fix-helpers.js';

// `staleproof fix` through src/cli.ts.

const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

function cli(args: string[], cwd?: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(TSX, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STALEPROOF_CACHE: 'off' }, ...(cwd ? { cwd } : {}) });
    return { code: 0, out, err: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout, err: e.stderr };
  }
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('staleproof fix (CLI)', () => {
  it('--dry-run prints the diff and the fixes, writes nothing, exits 1 for the errors left', async () => {
    const { dir } = await baseRepo();
    dirs.push(dir);
    await headChange(dir);
    const before = git(dir, 'status', '--porcelain');
    const r = cli(['fix', dir, '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--- a/AGENTS.md\n+++ b/AGENTS.md\n');
    expect(r.out).toContain('would fix  AGENTS.md:4:24  command-missing  Rename to `npm run docs:lint` (renamed in package.json)');
    expect(r.out).toMatch(/Would fix 13 findings in 5 files \(dry run: nothing written\); 3 findings left\./);
    expect(r.err).toContain('renames detected against HEAD');
    expect(git(dir, 'status', '--porcelain')).toBe(before);
  });

  it('applies the fixes, is idempotent, and --format json and --fail-on never work', async () => {
    const { dir } = await baseRepo();
    dirs.push(dir);
    await headChange(dir);
    expect(cli(['fix', dir]).out).toMatch(/Fixed 13 findings in 5 files; 3 findings left\./);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('`npm run docs:lint`');
    const again = cli(['fix', dir, '--format', 'json', '--fail-on', 'never']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ version: 1, dryRun: false, applied: [], files: [] });
  });

  it('refuses unknown rules and formats, as lint does', async () => {
    const { dir } = await baseRepo();
    dirs.push(dir);
    const rule = cli(['fix', dir, '--rule', 'no-such-rule']);
    expect(rule.code).not.toBe(0);
    expect(rule.err).toContain('unknown rule no-such-rule');
    const format = cli(['fix', dir, '--format', 'sarif']);
    expect(format.code).not.toBe(0);
    expect(format.err).toContain('unknown --format sarif (text, json)');
  });

  it('lists suggest and fix-pr, which need a token', () => {
    const help = cli(['--help']).out;
    expect(help).toMatch(/^ {2}fix \[options\] \[dir\]/m);
    expect(help).toMatch(/^ {2}suggest \[options\] <pr-url>/m);
    expect(help).toMatch(/^ {2}fix-pr \[options\] <repo>/m);
    const noToken = execFileSync('bash', ['-c', `env -u GITHUB_TOKEN -u GH_TOKEN ${TSX} ${CLI} fix-pr acme/x 2>&1 || true`], { encoding: 'utf8' });
    expect(noToken).toContain('fix-pr needs GITHUB_TOKEN');
  });
});
