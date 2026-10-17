import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { GitHubAppEnv } from '../src/app/env.js';
import { isPrivateGraph } from '../src/app/guard.js';
import { PrivateWorkspaces } from '../src/app/private-workspaces.js';
import { AppRegistry } from '../src/app/registry.js';
import { registerGitHubAppRoutes } from '../src/app/routes.js';
import type { HandleResult } from '../src/app/service.js';
import { signBody } from '../src/app/webhook.js';
import type { Config } from '../src/config.js';
import { COMMENT_MARKER, NEW_FINDINGS_HEADING } from '../src/format/markdown.js';
import { GraphStore } from '../src/graph/client.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import { FakeGitHub, ghPull, testKeys } from './fixtures/github-app/fake-github.js';
import { testConfig } from './helpers.js';

/**
 * Private repositories, end to end with the real check: the archive is read with the
 * installation token (codeload refuses it), indexed into `ghp-<installation>` and never
 * into the owner's public workspace, and the pull request's new findings come back on
 * the check run. Nothing the hosted service can list or locate holds it.
 */

const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `sp6corp${U}`;
const REPO = `${OWNER}/secret-app`;
const APP_ID = '4343';
const INST = 800_000_000 + Math.floor(Math.random() * 1e8);
const REGISTRY = `test-sp6-app-priv-${U}`;
const HOSTED_REGISTRY = `test-sp6-hosted-priv-${U}`;
const CURATED = `test-sp6-curated-priv-${U}`;
const keys = testKeys();
const ENV: GitHubAppEnv = { appId: APP_ID, privateKey: keys.privateKey, webhookSecret: 'whsec-private', slug: 'staleproof-test' };

let store: GraphStore;
let config: Config;
let home: string;
let root: string;
const graphsToDrop = new Set<string>([REGISTRY, HOSTED_REGISTRY, CURATED, `ghp-${INST}`, `gh-${OWNER}`]);

const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository with a base commit on main and a pull request branch that renames a script and a page the docs name. */
async function makeRepo(name: string): Promise<{ dir: string; base: string; head: string }> {
  const dir = join(root, name);
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, scripts: { 'lint:docs': 'node scripts/lint.js', build: 'tsc' } }, null, 2));
  await writeFile(join(dir, 'README.md'), '# Secret app\n\nRun `npm run lint:docs` before pushing.\n\nSee the [setup guide](docs/setup.md).\n');
  await writeFile(join(dir, 'AGENTS.md'), '# Agents\n\nRun `npm run lint:docs` to check the docs.\n');
  await writeFile(join(dir, 'docs', 'setup.md'), '# Setup\n\nInstall it.\n');
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  const base = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', '-b', 'feature');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, scripts: { 'lint-docs': 'node scripts/lint.js', build: 'tsc' } }, null, 2));
  await rename(join(dir, 'docs', 'setup.md'), join(dir, 'docs', 'install.md'));
  // The pull request also touches the README (below the stale lines), so they are in its diff.
  await writeFile(join(dir, 'README.md'), '# Secret app\n\nRun `npm run lint:docs` before pushing.\n\nSee the [setup guide](docs/setup.md).\n\nAsk in #docs.\n');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'rename the docs script and the setup page');
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', 'main');
  return { dir, base, head };
}

beforeAll(async () => {
  store = await GraphStore.connect(inject('falkordbUrl'));
  home = await mkdtemp(join(tmpdir(), 'staleproof-app-home-'));
  root = await mkdtemp(join(tmpdir(), 'staleproof-app-repos-'));
  config = testConfig({ home });
});

afterAll(async () => {
  for (const g of graphsToDrop) await store.org(g).drop();
  await store.close();
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

function harness() {
  const gh = new FakeGitHub(APP_ID, keys.publicKey, 'staleproof-test');
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const workspaces = new Workspaces(store, config, store.org(CURATED), { registry: HOSTED_REGISTRY, fetchImpl: gh.fetch });
  const app = new Hono();
  registerGitHubAppRoutes(app, { store, config, workspaces, env: ENV, registry: REGISTRY, fetchImpl: gh.fetch, waitUntil: (p) => pending.push(p), log: (m) => logs.push(m) });
  const run = async (event: string, payload: unknown): Promise<HandleResult> => {
    const body = JSON.stringify(payload);
    const res = await app.request('/api/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signBody(ENV.webhookSecret, body) },
      body,
    });
    expect(res.status).toBe(202);
    return (await pending.shift()) as HandleResult;
  };
  return { gh, logs, workspaces, run };
}

describe('a private repository', () => {
  it('is read with the installation token, indexed into ghp-<installation>, and checked: the new findings land on the check run', async () => {
    const h = harness();
    const { dir, base, head } = await makeRepo('secret-app');
    h.gh.gitRepos.set(REPO.toLowerCase(), { dir, private: true, installation: INST });
    const pull = { ...ghPull({ repo: REPO, number: 3, base, head }), base: { sha: base, ref: 'main', repo: { full_name: REPO, private: true, default_branch: 'main' } } };
    pull.head.repo = { full_name: REPO, private: true, default_branch: 'main' };
    h.gh.pulls.set(`${REPO.toLowerCase()}#3`, pull);
    const result = await h.run('pull_request', { action: 'opened', number: 3, pull_request: pull, repository: { full_name: REPO, private: true, default_branch: 'main' }, installation: { id: INST } });
    expect(h.logs.join('\n')).not.toMatch(/check failed/);
    expect(result.checks?.[0]).toMatchObject({ conclusion: 'neutral' });

    // codeload refused the private archive; the API served it to the installation token.
    const codeload = h.gh.calls.filter((c) => c.url.startsWith('https://codeload.github.com/') && c.url.toLowerCase().includes(REPO.toLowerCase()));
    const api = h.gh.calls.filter((c) => /\/repos\/[^/]+\/[^/]+\/tarball\//.test(c.path));
    expect(codeload.length).toBeGreaterThan(0);
    expect(codeload.every((c) => !c.auth)).toBe(true);
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((c) => h.gh.tokens.includes(c.auth!.replace(/^Bearer /, '')))).toBe(true);

    // Indexed into the installation's graph, never the owner's public workspace.
    const graphs = await store.listGraphs();
    expect(graphs).toContain(`ghp-${INST}`);
    expect(graphs).not.toContain(`gh-${OWNER}`);
    const repoNodes = (await store.org(`ghp-${INST}`).run<{ name: string }>('MATCH (r:Repo) RETURN r.name AS name')).rows.map((r) => r.name);
    expect(repoNodes).toEqual([REPO.toLowerCase()]);
    expect((await new AppRegistry(store, REGISTRY).indexed(`ghp-${INST}`)).map((r) => r.name)).toEqual([REPO.toLowerCase()]);
    // The hosted service cannot find it: not by name, not in its list of graphs.
    expect(await h.workspaces.locate(REPO)).toBeUndefined();
    expect((await h.workspaces.graphs()).map((g) => g.name).filter(isPrivateGraph)).toEqual([]);
    expect((await h.workspaces.list()).flatMap((w) => w.repos.map((r) => r.name.toLowerCase()))).not.toContain(REPO.toLowerCase());

    // The check run: the report with "Docs this pull request makes wrong", an annotation per new finding.
    const run = [...h.gh.checkRuns.values()][0]!;
    const final = run.updates.at(-1)!;
    expect(final.status).toBe('completed');
    expect(final.output.summary.startsWith(COMMENT_MARKER)).toBe(true);
    expect(final.output.summary).toContain(NEW_FINDINGS_HEADING);
    expect(final.output.summary).toContain('ghp-');
    const annotations = run.updates.flatMap((u) => u.output?.annotations ?? []);
    const where = annotations.map((a) => `${a.path}:${a.start_line} ${a.title.split(':')[0]}`).sort();
    expect(where).toEqual(['AGENTS.md:3 command-missing', 'README.md:3 command-missing', 'README.md:5 link-broken']);
    // There is something to say: the comment carries the same report.
    const comment = h.gh.comments.get(`${REPO.toLowerCase()}#3`)?.[0];
    expect(comment?.body).toContain(NEW_FINDINGS_HEADING);
    // Verified fixes (SP5): the script renamed in this pull request. In the diff (README.md): a suggestion; outside (AGENTS.md): the comment and Apply fixes.
    const review = h.gh.reviews.find((r) => r.number === 3)?.body;
    expect(review?.comments.some((c: { path: string; line: number; body: string }) => c.path === 'README.md' && c.line === 3 && c.body.includes('npm run lint-docs'))).toBe(true);
    expect(final.actions).toEqual([expect.objectContaining({ identifier: 'apply-fixes' })]);
    expect(comment?.body).toContain('AGENTS.md:3');
    expect(comment?.body).toContain('**Apply fixes**');

    // Apply fixes: one commit on the pull request's branch, on top of the head it was checked at, read and written with the token.
    const applied = await h.run('check_run', {
      action: 'requested_action',
      requested_action: { identifier: 'apply-fixes' },
      check_run: { id: run.id, head_sha: head, external_id: '3', app: { id: Number(APP_ID) }, output: { title: final.output.title, summary: 'report' } },
      repository: { full_name: REPO, private: true, default_branch: 'main' },
      installation: { id: INST },
    });
    expect(applied.result).toMatch(/^Committed \d+ verified fix/);
    const [sha, commit] = [...h.gh.createdCommits.entries()][0]!;
    expect(commit.parents).toEqual([head]);
    const tree = h.gh.createdTrees.get(commit.tree)!;
    const agents = tree.entries.find((e: { path: string }) => e.path === 'AGENTS.md');
    expect(agents).toMatchObject({ mode: '100644', type: 'blob' });
    expect(agents.content).toBe('# Agents\n\nRun `npm run lint-docs` to check the docs.\n');
    expect(h.gh.refUpdates).toEqual([{ repo: REPO, branch: 'feature', sha, force: false }]);

    // No token in any log line.
    for (const t of h.gh.tokens) expect(h.logs.join('\n')).not.toContain(t);
  });

  it('a repository that was public once leaves the hosted workspace when the App sees it private', async () => {
    const h = harness();
    const name = `${OWNER}/was-public`;
    const { dir, base, head } = await makeRepo('was-public');
    h.gh.gitRepos.set(name.toLowerCase(), { dir, private: false });
    await h.workspaces.ensure(name);
    expect((await h.workspaces.locate(name))?.graph.name).toBe(`gh-${OWNER}`);
    // Now it is private.
    h.gh.gitRepos.set(name.toLowerCase(), { dir, private: true });
    const pull = ghPull({ repo: name, number: 1, base, head });
    pull.head.repo = { full_name: name, private: true, default_branch: 'main' };
    await h.run('pull_request', { action: 'opened', number: 1, pull_request: pull, repository: { full_name: name, private: true, default_branch: 'main' }, installation: { id: INST } });
    expect(await h.workspaces.locate(name)).toBeUndefined();
    expect(await store.listGraphs()).not.toContain(`gh-${OWNER}`);
    expect(await new AppRegistry(store, REGISTRY).indexed(`ghp-${INST}`)).toEqual(expect.arrayContaining([expect.objectContaining({ name: name.toLowerCase() })]));
  });
});

describe('private workspaces', () => {
  it('keep at most maxRepos per installation, dropping the least recently used and rebuilding the graph', async () => {
    const gh = new FakeGitHub(APP_ID, keys.publicKey);
    const registry = new AppRegistry(store, REGISTRY);
    const inst = INST + 7;
    graphsToDrop.add(`ghp-${inst}`);
    const pw = new PrivateWorkspaces(store, config, registry, { limits: { maxRepos: 2 }, fetchImpl: gh.fetch });
    const names = ['one', 'two', 'three'].map((n) => `${OWNER}/lru-${n}`);
    for (const n of names) gh.gitRepos.set(n, { dir: (await makeRepo(`lru-${n.split('-').at(-1)}`)).dir, private: true });
    const token = 'ghs_test_x_1';
    gh.tokens.push(token);
    await pw.ensure(inst, names[0]!, token);
    await new Promise((r) => setTimeout(r, 5));
    await pw.ensure(inst, names[1]!, token);
    // Using one again keeps it; the next new repository pushes out the other.
    await new Promise((r) => setTimeout(r, 5));
    await pw.ensure(inst, names[0]!, token);
    await pw.ensure(inst, names[2]!, token);
    const held = (await registry.indexed(`ghp-${inst}`)).map((r) => r.name);
    expect(held.sort()).toEqual([names[0], names[2]].sort());
    const inGraph = (await store.org(`ghp-${inst}`).run<{ name: string }>('MATCH (r:Repo) RETURN r.name AS name ORDER BY name')).rows.map((r) => r.name);
    expect(inGraph.sort()).toEqual([names[0], names[2]].sort());
    expect(await pw.has(inst, names[1]!)).toBe(false);

    // also-index of a repository the installation cannot read is left out, not fatal.
    const r = await pw.ensure(inst, names[0]!, token, { with: [`${OWNER}/not-readable`], refresh: true });
    expect(r.skipped).toEqual([`${OWNER}/not-readable`]);
    // A token for nothing reads nothing.
    await expect(pw.ensure(inst + 1, names[1]!, 'ghs_wrong')).rejects.toThrow(/failed: 401|not found/);
    graphsToDrop.add(`ghp-${inst + 1}`);
    await expect(pw.evict('gh-acme')).rejects.toThrow(/not an App graph/);
  });
});
