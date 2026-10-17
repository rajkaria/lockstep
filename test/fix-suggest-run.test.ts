import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintRepo } from '../src/lint/engine.js';
import { runFixPrCommand } from '../src/pr/fix-pr.js';
import { runSuggestCommand } from '../src/pr/suggest.js';
import { baseRepo, edit, git } from './fix-helpers.js';
import { fakeGitHub } from './fix-github.js';

/** Per-file patches of `git diff base head`, as `GET /pulls/{n}/files` returns them. */
function prFiles(dir: string, base: string, head: string): { filename: string; status: string; patch?: string }[] {
  const names = git(dir, 'diff', '--name-status', base, head).split('\n').filter(Boolean);
  return names.map((l) => {
    const [status, filename] = l.split('\t') as [string, string];
    const patch = git(dir, 'diff', '-U3', base, head, '--', filename).split('\n').slice(4).join('\n');
    return { filename, status: status === 'M' ? 'modified' : status === 'A' ? 'added' : 'removed', patch };
  });
}

describe('runSuggestCommand (Action check mode)', () => {
  let dir: string;
  let home: string;
  let base: string;
  let head: string;
  beforeAll(async () => {
    ({ dir, base } = await baseRepo());
    home = await mkdtemp(join(tmpdir(), 'staleproof-suggest-home-'));
    // The pull request renames a script and adds a line that still runs the old name.
    git(dir, 'checkout', '-q', '-b', 'rename-script');
    await edit(dir, 'package.json', (t) => t.replace('"lint:docs"', '"docs:lint"'));
    await edit(dir, 'README.md', (t) => t.replace('See the [usage guide]', 'Run `npm run lint:docs` before pushing.\n\nSee the [usage guide]'));
    git(dir, 'commit', '-q', '-am', 'rename lint:docs');
    head = git(dir, 'rev-parse', 'HEAD');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('suggests the fix on the diff line; committing the suggestion clears the finding', async () => {
    const gh = fakeGitHub('acme/fix-app');
    gh.state.prInfo.set(3, { base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'rename-script' } });
    gh.state.prFiles.set(3, prFiles(dir, base, head));
    const r = await runSuggestCommand({ pr: 'acme/fix-app#3', token: 't', home, clone: dir, fetchImpl: gh.fetch });
    // New at the head: the README line and the untouched AGENTS.md line both run the old script.
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.subject} ${f.fix?.verified}`)).toEqual(['AGENTS.md:4 npm run lint:docs true', 'README.md:5 npm run lint:docs true']);
    expect(r.plan.comments.map((c) => `${c.path}:${c.line}`)).toEqual(['README.md:5']);
    expect(r.markdown).toBe('One verified fix is outside this diff. Run `npx staleproof fix` to apply it:\n\n- `AGENTS.md:4` Rename to `npm run docs:lint` (renamed in package.json)');
    expect(r.posted).toMatchObject({ created: 1 });
    expect(gh.state.reviews).toEqual([expect.objectContaining({ pull: 3, commit_id: head, comments: 1 })]);

    // Commit the suggestion as GitHub would: its block replaces the commented line.
    const comment = gh.state.reviewComments[0]!;
    const replacement = /```suggestion\n([\s\S]*?)\n```/.exec(comment.body)![1]!;
    const lines = (await readFile(join(dir, 'README.md'), 'utf8')).split('\n');
    lines.splice(comment.line! - 1, 1, replacement);
    await writeFile(join(dir, 'README.md'), lines.join('\n'));
    const after = await lintRepo({ dir, rules: ['command-missing'] });
    expect(after.findings.filter((f) => f.path === 'README.md')).toEqual([]);

    // The next push: the same suggestion is not posted twice.
    const again = await runSuggestCommand({ pr: 'acme/fix-app#3', token: 't', home, clone: dir, fetchImpl: gh.fetch, dryRun: true });
    expect(again.posted).toBeUndefined();
  });

  it('reports a read-only token instead of failing', async () => {
    const gh = fakeGitHub('acme/fix-app');
    gh.state.prInfo.set(3, { base: { sha: base, ref: 'main' }, head: { sha: head, ref: 'rename-script' } });
    gh.state.prFiles.set(3, prFiles(dir, base, head));
    const denied: typeof fetch = async (input, init) => ((init?.method ?? 'GET') === 'POST' ? new Response('{"message":"Resource not accessible by integration"}', { status: 403 }) : gh.fetch(input, init));
    git(dir, 'checkout', '-q', '--', 'README.md');
    const r = await runSuggestCommand({ pr: 'acme/fix-app#3', token: 't', home, clone: dir, fetchImpl: denied });
    expect(r.posted).toBeUndefined();
    expect(r.warning).toMatch(/read-only token/);
  });
});

describe('runFixPrCommand (Action mode: fix)', () => {
  it('opens the fix pull request from a given checkout and says so', async () => {
    const { dir } = await baseRepo();
    try {
      const gh = fakeGitHub('acme/fix-app');
      const sha = git(dir, 'rev-parse', 'HEAD');
      gh.state.refs.set('main', sha);
      gh.state.commits.set(sha, { tree: 't0', parents: [], message: 'x' });
      const r = await runFixPrCommand({ repo: 'acme/fix-app', token: 't', home: dir, dir, fetchImpl: gh.fetch });
      expect(r.action).toBe('opened');
      expect(r.output).toMatch(/^Opened the fix pull request with \d+ verified fixes in 5 files: https:\/\/github.com\/acme\/fix-app\/pull\/1$/);
      const dry = await runFixPrCommand({ repo: 'acme/fix-app', token: 't', home: dir, dir, fetchImpl: gh.fetch, dryRun: true });
      expect(dry.output).toMatch(/^Would update the fix pull request/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
