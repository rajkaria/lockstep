import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixPrBody, fixPrTitle, FIX_PR_MARKER, runFixPr } from '../src/pr/fix-pr.js';
import { worktreeTree } from '../src/lint/sources.js';
import { baseRepo, git } from './fix-helpers.js';
import { fakeGitHub } from './fix-github.js';

/** The fake GitHub knows the repository's default branch at the clone's HEAD. */
function know(gh: ReturnType<typeof fakeGitHub>, dir: string): string {
  const head = git(dir, 'rev-parse', 'HEAD');
  gh.state.refs.set('main', head);
  gh.state.commits.set(head, { tree: `tree-of-${head}`, parents: [], message: 'x' });
  return head;
}

describe('runFixPr (Renovate for docs)', () => {
  let dir: string;
  const gh = fakeGitHub('acme/fix-app');
  const client = { token: 't', fetchImpl: gh.fetch };
  const run = () => runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir, 'acme/fix-app'), fixes: { cache: false } }, client);

  beforeAll(async () => {
    ({ dir } = await baseRepo());
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('opens one pull request from staleproof/fix-docs with every verified fix', async () => {
    const head = know(gh, dir);
    const r = await run();
    expect(r.action).toBe('opened');
    expect(r.pr).toEqual({ number: 1, url: 'https://github.com/acme/fix-app/pull/1' });
    expect(r.files).toEqual(['.env.example', 'AGENTS.md', 'README.md', 'docs/usage.md', 'mypkg/client.py']);
    expect(r.fixes.map((f) => f.subject)).toContain('npm run buld');
    const pr = gh.state.pulls[0]!;
    expect(pr).toMatchObject({ title: fixPrTitle(r.fixes.length), state: 'open', head: { ref: 'staleproof/fix-docs' }, base: { ref: 'main' } });
    expect(pr.title).toBe(`Staleproof: fix ${r.fixes.length} stale docs references`);
    expect(pr.body.startsWith(FIX_PR_MARKER)).toBe(true);
    expect(pr.body).toContain('| Where | Rule | What is stale | Fix | Where Staleproof looked |');
    expect(pr.body).toContain(
      `| [\`AGENTS.md:5\`](https://github.com/acme/fix-app/blob/${head}/AGENTS.md#L5) | \`command-missing\` | \`buld\` is not a script in package.json. | Rename to \`npm run build\` (the closest script in package.json) | package.json scripts (lint:docs, test, build, dev, doc) |`,
    );
    // One commit on the default branch head, carrying the fixed files.
    const commit = gh.state.commits.get(gh.state.refs.get('staleproof/fix-docs')!)!;
    expect(commit.parents).toEqual([head]);
    const tree = gh.state.trees.get(commit.tree)!;
    expect(tree.base).toBe(`tree-of-${head}`);
    expect(tree.entries.map((e) => [e.path, e.mode])).toEqual(r.files.map((p) => [p, '100644']));
    const agents = gh.state.blobs.get(tree.entries.find((e) => e.path === 'AGENTS.md')!.sha)!;
    expect(agents).toContain('`npm run build`');
    // The clone is never written.
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('a second run with nothing new pushes nothing and opens nothing', async () => {
    const before = gh.writes().length;
    const r = await run();
    expect(r.action).toBe('unchanged');
    const writes = gh.writes().slice(before);
    expect(writes.filter((w) => !/\/git\/(blobs|trees)$/.test(w.path))).toEqual([]);
    expect(gh.state.pulls).toHaveLength(1);
  });

  it('new drift on the default branch rebuilds the branch and updates the same pull request', async () => {
    await writeFile(join(dir, 'docs', 'more.md'), '# More\n\nRun `npm run tests` and `npm run bild`.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'more docs');
    const head = know(gh, dir);
    const r = await run();
    expect(r.action).toBe('updated');
    expect(r.pr?.number).toBe(1);
    expect(r.files).toContain('docs/more.md');
    expect(gh.state.pulls).toHaveLength(1);
    expect(gh.state.pulls[0]!.title).toBe(fixPrTitle(r.fixes.length));
    expect(gh.state.commits.get(gh.state.refs.get('staleproof/fix-docs')!)!.parents).toEqual([head]);
    expect(gh.calls.some((c) => c.method === 'PATCH' && c.path === '/repos/acme/fix-app/git/refs/heads/staleproof/fix-docs' && (c.body as { force?: boolean }).force === true)).toBe(true);
  });

  it('closes the pull request once the default branch has no fixable drift left', async () => {
    // Merge the fixes: write the branch's files into the default branch.
    const tree = gh.state.trees.get(gh.state.commits.get(gh.state.refs.get('staleproof/fix-docs')!)!.tree)!;
    for (const e of tree.entries) await writeFile(join(dir, e.path), gh.state.blobs.get(e.sha)!);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'merge fixes');
    know(gh, dir);
    const r = await run();
    expect(r.action).toBe('closed');
    expect(gh.state.pulls[0]!.state).toBe('closed');
    expect(gh.state.issueComments.at(-1)!.body).toContain('Nothing left to fix');
    expect((await run()).action).toBe('none');
  });

  it('opens a pull request again when drift it closed for comes back: closing it was not a person declining it', async () => {
    // Found on rajkaria/staleproof-action-test#5: Staleproof closed it (fixed by hand), and the same drift coming back
    // (a revert of the hand fix) was then taken as "closed without merging" and never proposed again.
    expect(gh.state.pulls[0]!.body).toContain('<!-- staleproof:fix-docs closed-by-staleproof -->');
    expect(gh.state.pulls[0]!.body).not.toMatch(/staleproof:fix-docs fixes=/);
    git(dir, 'revert', '--no-edit', 'HEAD');
    know(gh, dir);
    const r = await run();
    expect(r.action).toBe('opened');
    expect(r.pr?.number).toBe(2);
    expect(gh.state.pulls.map((p) => p.state)).toEqual(['closed', 'open']);
  });
});

describe('runFixPr: a closed pull request and the branch guard', () => {
  let dir: string;
  beforeAll(async () => {
    ({ dir } = await baseRepo());
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('does not reopen fixes someone declined, until they change', async () => {
    const gh = fakeGitHub('acme/fix-app');
    know(gh, dir);
    const client = { token: 't', fetchImpl: gh.fetch };
    const run = () => runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir, 'acme/fix-app'), fixes: { cache: false } }, client);
    expect((await run()).action).toBe('opened');
    gh.state.pulls[0]!.state = 'closed';
    const declined = await run();
    expect(declined).toMatchObject({ action: 'declined', pr: { number: 1 } });
    expect(gh.state.pulls).toHaveLength(1);
    await writeFile(join(dir, 'docs', 'extra.md'), '# Extra\n\nRun `npm run bild`.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'extra');
    know(gh, dir);
    expect((await run()).action).toBe('opened');
    expect(gh.state.pulls).toHaveLength(2);
  });

  it('says which setting to change when the repository does not let GitHub Actions open pull requests', async () => {
    // Found on rajkaria/staleproof-action-test: GitHub's default refuses the workflow token's `POST /pulls` with 403,
    // and the Action only said "the job needs contents: write and pull-requests: write", which it had.
    const gh = fakeGitHub('acme/fix-app');
    know(gh, dir);
    gh.state.actionsMayOpenPulls = false;
    const client = { token: 't', fetchImpl: gh.fetch };
    const run = () => runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir, 'acme/fix-app'), fixes: { cache: false } }, client);
    const err = (await run().catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^GitHub Actions may not open pull requests in acme\/fix-app, so the fixes wait on the branch staleproof\/fix-docs: /);
    expect(err.message).toContain('"Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General → Workflow permissions');
    expect(err.message).toContain('or pass a GitHub App or personal access token as `github-token`');
    expect(err.message).toContain('https://github.com/acme/fix-app/compare/main...staleproof/fix-docs?expand=1');
    // The branch is pushed; only the pull request is missing.
    expect(gh.state.refs.has('staleproof/fix-docs')).toBe(true);
    expect(gh.state.pulls).toHaveLength(0);
    // Once the setting is on, the next run opens it from the branch already there.
    gh.state.actionsMayOpenPulls = true;
    expect((await run()).action).toBe('opened');
    expect(gh.state.pulls).toHaveLength(1);
    // Any other refusal is passed on as it is.
    const other = fakeGitHub('acme/fix-app');
    know(other, dir);
    const fetch403 = (async (input: string | URL | Request, init: RequestInit = {}) =>
      String(input).endsWith('/pulls') && init.method === 'POST' ? new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 }) : other.fetch(input, init)) as typeof fetch;
    await expect(runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir, 'acme/fix-app'), fixes: { cache: false } }, { token: 't', fetchImpl: fetch403 })).rejects.toThrow(
      /^GitHub POST \/repos\/acme\/fix-app\/pulls failed: 403 .*Resource not accessible by integration/,
    );
  });

  it('commits a linked agent file as the file it points to', async () => {
    const { dir: linked } = await baseRepo();
    try {
      await symlink('AGENTS.md', join(linked, 'CLAUDE.md'));
      git(linked, 'add', 'CLAUDE.md');
      git(linked, 'commit', '-q', '-m', 'link');
      const gh = fakeGitHub('acme/fix-app');
      know(gh, linked);
      const r = await runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(linked, 'acme/fix-app'), fixes: { cache: false, rules: ['command-missing'] } }, { token: 't', fetchImpl: gh.fetch });
      expect(r.files).toEqual(['AGENTS.md']);
      const tree = gh.state.trees.get(gh.state.commits.get(gh.state.refs.get('staleproof/fix-docs')!)!.tree)!;
      expect(tree.entries.map((e) => e.path)).toEqual(['AGENTS.md']);
    } finally {
      await rm(linked, { recursive: true, force: true });
    }
  });

  it('refuses a branch outside staleproof/ and plans without writing on a dry run', async () => {
    const gh = fakeGitHub('acme/fix-app');
    know(gh, dir);
    const client = { token: 't', fetchImpl: gh.fetch };
    await expect(runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir), branch: 'main' }, client)).rejects.toThrow(/under staleproof\//);
    const r = await runFixPr({ repo: 'acme/fix-app', tree: worktreeTree(dir), dryRun: true, fixes: { cache: false } }, client);
    expect(r.action).toBe('opened');
    expect(r.fixes.length).toBeGreaterThan(0);
    expect(gh.writes()).toEqual([]);
  });

  it('writes the body with links to the evidence when the finding has them', () => {
    const body = fixPrBody(
      [
        {
          rule: 'link-broken', severity: 'error', message: 'The link target `docs/a|b.md` does not exist.', path: 'README.md', line: 3, column: 1, endLine: 3, endColumn: 2, surface: 'readme', subject: 'docs/a.md', fingerprint: 'f1',
          evidence: { looked: 'docs/a.md', url: 'https://github.com/acme/x/blob/abc/README.md#L3' },
          fix: { description: 'Rename to `docs/b.md` (renamed in this change)', edits: [{ path: 'README.md', line: 3, column: 1, endLine: 3, endColumn: 2, newText: 'b' }], verified: true },
        },
      ],
      { branch: 'main', sha: 'abcdef1234' },
    );
    expect(body).toContain('| [`README.md:3`](https://github.com/acme/x/blob/abc/README.md#L3) | `link-broken` | The link target `docs/a\\|b.md` does not exist. |');
    // One fix: singular wording (seen on the e2e fix pull request, "1 docs reference ... that no longer match").
    expect(body).toContain('Staleproof found 1 docs reference in 1 file that no longer matches the code at `main` (abcdef1), and its fix. The fix was re-checked before it was proposed');
  });
});

describe('fix PR files', () => {
  it('ships an example workflow with a weekly schedule, manual runs and the write permissions', async () => {
    const yml = await readFile(join(import.meta.dirname, '..', 'examples', 'staleproof-fix.yml'), 'utf8');
    expect(yml).toMatch(/schedule:\s*\n\s*- cron: /);
    expect(yml).toContain('workflow_dispatch:');
    expect(yml).toMatch(/contents: write/);
    expect(yml).toMatch(/pull-requests: write/);
    expect(yml).toMatch(/mode: fix/);
  });
});
