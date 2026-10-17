import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PrCheckRequest, PrCheckResult } from '../src/app/checker.js';
import type { GitHubAppEnv } from '../src/app/env.js';
import { AppRegistry } from '../src/app/registry.js';
import { registerGitHubAppRoutes } from '../src/app/routes.js';
import type { CronReport, FixPrFn, HandleResult } from '../src/app/service.js';
import { MAX_WEBHOOK_BYTES, signBody } from '../src/app/webhook.js';
import type { Config } from '../src/config.js';
import { AUDIT_MARKER } from '../src/format/audit.js';
import { COMMENT_MARKER } from '../src/format/markdown.js';
import { GraphStore } from '../src/graph/client.js';
import { Workspaces } from '../src/hosted/workspaces.js';
import type { Finding, Fix } from '../src/lint/types.js';
import { FakeGitHub, finding, ghPull, prFindings, testKeys } from './fixtures/github-app/fake-github.js';
import { testConfig } from './helpers.js';

/**
 * The App end to end against a fake GitHub (signed payloads in, REST calls out) with its
 * registry on the test FalkorDB. The check itself is a stub here (its own test runs the
 * real one on a private repository): these tests are about what the App does with it.
 */

const U = `${process.pid}${Math.random().toString(36).slice(2, 6)}`;
const OWNER = `sp6acme${U}`;
const REPO = `${OWNER}/app`;
const APP_ID = '4242';
const INST = 900_000_000 + Math.floor(Math.random() * 1e8);
const REGISTRY = `test-sp6-app-${U}`;
const HOSTED_REGISTRY = `test-sp6-hosted-${U}`;
const CURATED = `test-sp6-curated-${U}`;
const keys = testKeys();
const ENV: GitHubAppEnv = { appId: APP_ID, privateKey: keys.privateKey, webhookSecret: 'whsec-test', slug: 'staleproof-test', cronSecret: 'cron-test' };
const B = '1'.repeat(40);
const H = '2'.repeat(40);
const H2 = '3'.repeat(40);

let store: GraphStore;
let config: Config;
let home: string;
let registry: AppRegistry;
let workspaces: Workspaces;
const graphsToDrop = new Set<string>([REGISTRY, HOSTED_REGISTRY, CURATED, `ghp-${INST}`, `gh-${OWNER}`]);

beforeAll(async () => {
  store = await GraphStore.connect(inject('falkordbUrl'));
  home = await mkdtemp(join(tmpdir(), 'staleproof-app-'));
  config = testConfig({ home });
  registry = new AppRegistry(store, REGISTRY);
  workspaces = new Workspaces(store, config, store.org(CURATED), { registry: HOSTED_REGISTRY });
});

afterAll(async () => {
  for (const g of graphsToDrop) await store.org(g).drop();
  await store.close();
  await rm(home, { recursive: true, force: true });
});

const README = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: run \`npm run lint:docs\` before you push.`).join('\n') + '\n';

/** A finding on README.md line `line` with a verified fix renaming the script. */
function fixable(i: number, path = 'README.md', line = 10): Finding {
  const column = README.split('\n')[line - 1]!.indexOf('npm run lint:docs') + 1;
  const span = { line, column, endLine: line, endColumn: column + 'npm run lint:docs'.length };
  const fix: Fix = { description: 'Rename to `npm run lint-docs` (script renamed in package.json)', edits: [{ path, ...span, newText: 'npm run lint-docs' }], verified: true };
  return finding(i, { path, ...span, subject: 'npm run lint:docs', fix, surface: path === 'AGENTS.md' ? 'agent' : 'readme' });
}

const repository = (o: { private?: boolean; repo?: string } = {}) => ({ id: 1, full_name: o.repo ?? REPO, private: !!o.private, default_branch: 'main', owner: { login: OWNER } });
const prEvent = (action: string, pull: ReturnType<typeof ghPull>, o: { private?: boolean } = {}) => ({ action, number: pull.number, pull_request: pull, repository: repository(o), installation: { id: INST } });

function harness(o: { env?: GitHubAppEnv | null; fixPr?: FixPrFn; checker?: (req: PrCheckRequest) => Promise<PrCheckResult> } = {}) {
  const gh = new FakeGitHub(APP_ID, keys.publicKey, 'staleproof-test');
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const requests: PrCheckRequest[] = [];
  const state: { next: Partial<PrCheckResult> | Error } = { next: {} };
  const checker = async (req: PrCheckRequest): Promise<PrCheckResult> => {
    requests.push(req);
    if (state.next instanceof Error) throw state.next;
    return { report: `${COMMENT_MARKER}\n### Staleproof: a test report\n\nThe body.\n\n<sub>footer</sub>`, predicted: 0, sections: 0, stale: 0, graph: 'gh-test', ...state.next };
  };
  // Hosted workspaces download through the fake GitHub (codeload) too.
  const ws = new Workspaces(store, config, store.org(CURATED), { registry: HOSTED_REGISTRY, fetchImpl: gh.fetch });
  const app = new Hono();
  registerGitHubAppRoutes(app, {
    store,
    config,
    workspaces: ws,
    env: o.env === null ? undefined : (o.env ?? ENV),
    registry: REGISTRY,
    fetchImpl: gh.fetch,
    waitUntil: (p) => pending.push(p),
    log: (m) => logs.push(m),
    checker: o.checker ?? checker,
    ...(o.fixPr ? { fixPr: o.fixPr } : {}),
  });
  const deliver = (event: string, payload: unknown, d: { delivery?: string; secret?: string; signature?: string | null } = {}) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': d.delivery ?? randomUUID() };
    const sig = d.signature === null ? undefined : (d.signature ?? signBody(d.secret ?? ENV.webhookSecret, body));
    if (sig) headers['x-hub-signature-256'] = sig;
    return app.request('/api/github/webhook', { method: 'POST', headers, body });
  };
  const settle = async (): Promise<HandleResult[]> => {
    const out: HandleResult[] = [];
    while (pending.length) out.push((await pending.shift()) as HandleResult);
    return out;
  };
  /** Deliver and wait for the background work. */
  const run = async (event: string, payload: unknown) => {
    const res = await deliver(event, payload);
    expect(res.status).toBe(202);
    return (await settle())[0]!;
  };
  const runs = () => [...gh.checkRuns.values()];
  const comments = (n: number) => gh.comments.get(`${REPO.toLowerCase()}#${n}`) ?? [];
  return { gh, app, pending, logs, requests, state, deliver, settle, run, runs, comments };
}

describe('webhook route', () => {
  it('answers 404 when the App is not configured (both routes)', async () => {
    const h = harness({ env: null });
    expect((await h.deliver('ping', {})).status).toBe(404);
    expect((await h.app.request('/api/github/cron')).status).toBe(404);
  });

  it('refuses a bad, missing or other-secret signature with 401, and does nothing', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 1, base: B, head: H });
    expect((await h.deliver('pull_request', prEvent('opened', pull), { signature: `sha256=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await h.deliver('pull_request', prEvent('opened', pull), { signature: null })).status).toBe(401);
    expect((await h.deliver('pull_request', prEvent('opened', pull), { secret: 'not-the-secret' })).status).toBe(401);
    expect(h.pending).toHaveLength(0);
    expect(h.gh.calls).toHaveLength(0);
  });

  it('refuses payloads over 25 MB', async () => {
    const h = harness();
    const body = `{"x":"${'a'.repeat(MAX_WEBHOOK_BYTES)}"}`;
    const res = await h.app.request('/api/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signBody(ENV.webhookSecret, body) },
      body,
    });
    expect(res.status).toBe(413);
    expect(h.pending).toHaveLength(0);
  });

  it('needs the GitHub headers, answers ping, and refuses a body that is not JSON', async () => {
    const h = harness();
    expect((await h.app.request('/api/github/webhook', { method: 'POST', body: '{}' })).status).toBe(400);
    const ping = await h.deliver('ping', { zen: 'Keep it logically awesome.', hook_id: 1 });
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ ok: true, event: 'ping' });
    const body = 'not json';
    const res = await h.app.request('/api/github/webhook', {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signBody(ENV.webhookSecret, body) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('answers 202 at once and works in the background; a repeated delivery is ignored', async () => {
    const h = harness();
    const delivery = randomUUID();
    const pull = ghPull({ repo: REPO, number: 2, base: B, head: H });
    const first = await h.deliver('pull_request', prEvent('opened', pull), { delivery });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, event: 'pull_request', delivery });
    expect(h.pending).toHaveLength(1);
    await h.settle();
    expect(h.runs()).toHaveLength(1);
    const again = await h.deliver('pull_request', prEvent('opened', pull), { delivery });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true, delivery });
    expect(h.pending).toHaveLength(0);
    expect(h.runs()).toHaveLength(1);
  });

  it('forgets deliveries after 24 hours', async () => {
    const id = randomUUID();
    const t = Date.now();
    expect(await registry.seenDelivery(id, t)).toBe(false);
    expect(await registry.seenDelivery(id, t + 3600_000)).toBe(true);
    expect(await registry.seenDelivery(id, t + 25 * 3600_000)).toBe(false);
  });
});

describe('pull request checks', () => {
  it('opened: check run in progress, then completed with batched annotations, the report and Apply fixes; a comment; suggestions', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 7, base: B, head: H });
    // 120 new findings: one fixable inside the diff (README.md line 10), one outside it (AGENTS.md).
    const findings = [fixable(0), fixable(1, 'AGENTS.md', 4), ...Array.from({ length: 118 }, (_, i) => finding(i + 2))];
    h.state.next = { newFindings: prFindings(findings) };
    h.gh.files.set(`${REPO}@${H}:README.md`, README);
    h.gh.files.set(`${REPO}@${H}:AGENTS.md`, README);
    h.gh.pullFiles.set(`${REPO.toLowerCase()}#7`, [{ filename: 'README.md', status: 'modified', patch: '@@ -8,5 +8,5 @@\n a\n b\n-c\n+c2\n d\n e' }]);
    const result = await h.run('pull_request', prEvent('opened', pull));
    expect(result.result).toBe('checked: neutral');

    const [run] = h.runs();
    expect(run!.created).toMatchObject({ name: 'Staleproof', head_sha: H, status: 'in_progress', external_id: '7' });
    // Two batches of 50 while in progress, the last 20 with the conclusion.
    expect(run!.updates.map((u) => u.output.annotations.length)).toEqual([50, 50, 20]);
    expect(run!.updates.slice(0, 2).every((u) => !u.conclusion)).toBe(true);
    const final = run!.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'completed', conclusion: 'neutral', actions: [{ label: 'Apply fixes', identifier: 'apply-fixes' }] });
    expect(final.output.title).toBe('120 docs references made wrong');
    expect(final.output.summary.startsWith(COMMENT_MARKER)).toBe(true);
    expect(final.output.annotations[0]).toMatchObject({ annotation_level: 'failure' });

    // The checker was asked for fixes with the installation token.
    expect(h.requests[0]).toMatchObject({ installationId: INST, repo: { fullName: REPO, private: false, defaultBranch: 'main' }, refresh: false, fixes: true });
    expect(h.gh.tokens).toContain(h.requests[0]!.token);

    // One suggestion inside the diff (SP5's planner and poster), the other fix listed in the comment.
    expect(h.gh.reviews).toHaveLength(1);
    const review = h.gh.reviews[0]!.body;
    expect(review.commit_id).toBe(H);
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ path: 'README.md', line: 10 });
    expect(review.comments[0].body).toContain('```suggestion\nLine 10: run `npm run lint-docs` before you push.\n```');
    const [comment] = h.comments(7);
    expect(comment!.body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(comment!.body).toContain('AGENTS.md:4');
    expect(comment!.body).toContain('**Apply fixes**');

    // The fixes behind the button are kept with the check run.
    const stored = await registry.checkRun(run!.id);
    expect(stored).toMatchObject({ pr: 7, head: H });
    expect(stored!.fixes).toHaveLength(2);
    expect(h.logs.join('\n')).not.toMatch(/ghs_test_/);
  });

  it('a later push that clears everything edits the comment to "All clear" (once) and succeeds', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 8, base: B, head: H });
    h.state.next = { newFindings: prFindings([finding(1)]) };
    await h.run('pull_request', prEvent('opened', pull));
    expect(h.comments(8)).toHaveLength(1);
    const id = h.comments(8)[0]!.id;

    h.state.next = { newFindings: prFindings([]), sections: 2 };
    const result = await h.run('pull_request', prEvent('synchronize', { ...pull, head: { ...pull.head, sha: H2 } }));
    expect(result.checks?.[0]).toMatchObject({ conclusion: 'success', comment: 'all-clear' });
    expect(h.comments(8)).toHaveLength(1);
    expect(h.comments(8)[0]!.id).toBe(id);
    expect(h.comments(8)[0]!.body).toContain('all clear');
    expect(h.comments(8)[0]!.body).toContain(H2.slice(0, 7));
    const last = h.runs().at(-1)!.updates.at(-1)!;
    expect(last).toMatchObject({ conclusion: 'success', actions: [] });
    expect(last.output.title).toBe('No docs problems found (2 doc sections reached)');

    const patches = h.gh.find('PATCH', /\/issues\/comments\//).length;
    await h.run('pull_request', prEvent('synchronize', { ...pull, head: { ...pull.head, sha: H2 } }));
    expect(h.gh.find('PATCH', /\/issues\/comments\//)).toHaveLength(patches);
  });

  it('only edits its own comment, not another account’s that carries the marker', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 9, base: B, head: H });
    h.gh.comments.set(`${REPO.toLowerCase()}#9`, [{ id: 1, body: `${COMMENT_MARKER}\nfrom the Action`, user: { login: 'github-actions[bot]' }, performed_via_github_app: { id: 15368 } }]);
    h.state.next = { newFindings: prFindings([finding(1)]) };
    await h.run('pull_request', prEvent('opened', pull));
    expect(h.comments(9)).toHaveLength(2);
    expect(h.comments(9)[0]!.body).toBe(`${COMMENT_MARKER}\nfrom the Action`);
  });

  it('a check that fails completes the run as neutral with the reason, without the token', async () => {
    const h = harness();
    h.state.next = new Error('the workspace is full');
    const result = await h.run('pull_request', prEvent('opened', ghPull({ repo: REPO, number: 10, base: B, head: H })));
    expect(result.checks?.[0]).toMatchObject({ conclusion: 'neutral', error: 'the workspace is full' });
    const final = h.runs()[0]!.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'completed', conclusion: 'neutral', output: { title: 'Staleproof could not check this pull request' } });
    expect(final.output.summary).toContain('the workspace is full');
    expect(h.comments(10)).toHaveLength(0);
    expect(h.logs.join('\n')).toContain('the workspace is full');
    for (const t of h.gh.tokens) expect(h.logs.join('\n')).not.toContain(t);
  });

  it('a pull request from a fork gets the patch in the check run, no Apply fixes button, and a pointer in the comment', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 11, base: B, head: H, headRepo: 'someone/app-fork' });
    h.state.next = { newFindings: prFindings([fixable(0)]) };
    // The base repository serves the fork's head commit (GitHub keeps pull request heads there).
    h.gh.files.set(`${REPO}@${H}:README.md`, README);
    await h.run('pull_request', prEvent('opened', pull));
    const run = h.runs()[0]!;
    const final = run.updates.at(-1)!;
    expect(final.actions).toEqual([]);
    expect(final.output.text).toContain('```diff');
    expect(final.output.text).toContain('-Line 10: run `npm run lint:docs` before you push.');
    expect(final.output.text).toContain('+Line 10: run `npm run lint-docs` before you push.');
    expect(await registry.checkRun(run.id)).toBeUndefined();
    expect(h.comments(11)[0]!.body).toMatch(/fork.*check run has the patch/);
  });

  it('completes the check run plainly when GitHub refuses its full output, never leaving it in progress', async () => {
    const h = harness();
    h.state.next = { newFindings: prFindings([finding(1)]) };
    h.gh.failures.push({ method: 'PATCH', path: /\/check-runs\/\d+$/, status: 422 });
    const r = await h.run('pull_request', prEvent('opened', ghPull({ repo: REPO, number: 14, base: B, head: H })));
    expect(r.checks?.[0]).toMatchObject({ conclusion: 'neutral', comment: 'created' });
    const run = h.runs()[0]!;
    expect(run.updates).toHaveLength(1);
    expect(run.updates[0]).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(run.updates[0].output.annotations).toBeUndefined();
    expect(h.logs.join('\n')).toMatch(/full output was refused/);
  });

  it('falls back to the default settings when they cannot be read', async () => {
    const h = harness();
    h.gh.failures.push({ method: 'GET', path: /contents\/\.staleproof\.toml/, status: 500 });
    h.state.next = { newFindings: prFindings([finding(1)]) };
    const r = await h.run('pull_request', prEvent('opened', ghPull({ repo: REPO, number: 13, base: B, head: H })));
    expect(r.checks?.[0]).toMatchObject({ conclusion: 'neutral', comment: 'created' });
    expect(h.logs.join('\n')).toMatch(/settings not read, using the defaults/);
  });

  it('skips drafts and closed pull requests unless configured; ready_for_review checks', async () => {
    const h = harness();
    const draft = ghPull({ repo: REPO, number: 12, base: B, head: H, draft: true });
    expect((await h.run('pull_request', prEvent('opened', draft))).result).toMatch(/^skipped: draft/);
    expect(h.runs()).toHaveLength(0);
    expect((await h.run('pull_request', prEvent('closed', draft))).result).toBe('ignored: pull_request closed');
    expect((await h.run('pull_request', prEvent('ready_for_review', { ...draft, draft: false }))).result).toBe('checked: success');
    expect(h.runs()).toHaveLength(1);
    h.gh.files.set(`${REPO}@main:.staleproof.toml`, '[app]\ndrafts = true\n');
    expect((await h.run('pull_request', prEvent('synchronize', draft))).result).toBe('checked: success');
  });
});

describe('[app] config from the default branch', () => {
  it('fail-on = "findings", comment = "never", suggestions = false', async () => {
    const h = harness();
    h.gh.files.set(`${REPO}@main:.staleproof.toml`, '[app]\nfail-on = "findings"\ncomment = "never"\nsuggestions = false\n');
    // The pull request's own config is not read: it cannot turn its check off.
    h.gh.files.set(`${REPO}@${H}:.staleproof.toml`, '[app]\nfail-on = "never"\n');
    h.gh.files.set(`${REPO}@${H}:README.md`, README);
    h.gh.pullFiles.set(`${REPO.toLowerCase()}#20`, [{ filename: 'README.md', status: 'modified', patch: '@@ -8,5 +8,5 @@\n a\n b\n-c\n+c2\n d\n e' }]);
    h.state.next = { newFindings: prFindings([fixable(0)]) };
    const r = await h.run('pull_request', prEvent('opened', ghPull({ repo: REPO, number: 20, base: B, head: H })));
    expect(r.checks?.[0]).toMatchObject({ conclusion: 'failure', comment: 'none', suggestions: 0 });
    expect(h.comments(20)).toHaveLength(0);
    expect(h.gh.reviews).toHaveLength(0);
  });

  it('fail-on = "predicted"; comment = "always" comments even when clean; also-index reaches the check; pyproject works too', async () => {
    const h = harness();
    h.gh.files.set(`${REPO}@main:pyproject.toml`, '[tool.staleproof.app]\nfail-on = "predicted"\ncomment = "always"\nalso-index = ["acme/docs", "not a repo"]\n');
    h.state.next = { predicted: 1 };
    const r = await h.run('pull_request', prEvent('opened', ghPull({ repo: REPO, number: 21, base: B, head: H })));
    expect(r.checks?.[0]).toMatchObject({ conclusion: 'failure', comment: 'created' });
    expect(h.requests[0]!.alsoIndex).toEqual(['acme/docs']);
    h.state.next = { report: `${COMMENT_MARKER}\n### Staleproof: a clean test report` };
    const clean = await h.run('pull_request', prEvent('synchronize', ghPull({ repo: REPO, number: 21, base: B, head: H2 })));
    expect(clean.checks?.[0]).toMatchObject({ conclusion: 'success', comment: 'updated' });
    expect(h.comments(21)[0]!.body).toContain('a clean test report');
  });
});

describe('re-runs', () => {
  it('check_run rerequested checks the pull request again; another app’s check run is ignored', async () => {
    const h = harness();
    const pull = ghPull({ repo: REPO, number: 30, base: B, head: H });
    h.gh.pulls.set(`${REPO.toLowerCase()}#30`, pull);
    const event = (appId: number) => ({ action: 'rerequested', check_run: { id: 5, head_sha: H, external_id: '30', app: { id: appId }, pull_requests: [] }, repository: repository(), installation: { id: INST } });
    expect((await h.run('check_run', event(1))).result).toMatch(/another app/);
    const r = await h.run('check_run', event(Number(APP_ID)));
    expect(r.result).toBe('re-checked 1 pull request(s)');
    expect(h.runs()).toHaveLength(1);
    expect(h.runs()[0]!.created.head_sha).toBe(H);
  });

  it('check_suite rerequested finds pull requests by head commit, forks included', async () => {
    const h = harness();
    const fork = ghPull({ repo: REPO, number: 31, base: B, head: H2, headRepo: 'someone/fork' });
    h.gh.pulls.set(`${REPO.toLowerCase()}#31`, fork);
    const r = await h.run('check_suite', { action: 'rerequested', check_suite: { id: 1, head_sha: H2, head_branch: null, pull_requests: [] }, repository: repository(), installation: { id: INST } });
    expect(r.result).toBe('re-checked 1 pull request(s)');
    expect(h.runs()[0]!.created).toMatchObject({ head_sha: H2, external_id: '31' });
  });
});

describe('Apply fixes', () => {
  async function checked(h: ReturnType<typeof harness>, number: number, headRepo?: string) {
    const pull = ghPull({ repo: REPO, number, base: B, head: H, headRef: 'docs/fix-readme', ...(headRepo ? { headRepo } : {}) });
    h.gh.files.set(`${REPO}@${H}:README.md`, README);
    h.gh.files.set(`${REPO}@${H}:scripts/run.sh`, '#!/bin/sh\n');
    h.gh.pulls.set(`${REPO.toLowerCase()}#${number}`, pull);
    h.gh.refs.set(`${REPO.toLowerCase()}:docs/fix-readme`, H);
    h.state.next = { newFindings: prFindings([fixable(0), fixable(1, 'README.md', 20)]) };
    await h.run('pull_request', prEvent('opened', pull));
    const run = h.runs().at(-1)!;
    const action = { action: 'requested_action', requested_action: { identifier: 'apply-fixes' }, check_run: { id: run.id, head_sha: H, external_id: String(number), app: { id: Number(APP_ID) }, output: { title: 't', summary: 's' } }, repository: repository(), installation: { id: INST } };
    return { pull, run, action };
  }

  it('commits the verified fixes to the branch through the Git Data API, never forced', async () => {
    const h = harness();
    const { run, action } = await checked(h, 40);
    const r = await h.run('check_run', action);
    expect(r.result).toMatch(/^Committed 2 verified fixes to `docs\/fix-readme`/);
    const [tree] = [...h.gh.createdTrees.values()];
    expect(tree!.base).toBe(`t_${H}_`);
    expect(tree!.entries).toEqual([{ path: 'README.md', mode: '100644', type: 'blob', content: README.replace('Line 10: run `npm run lint:docs`', 'Line 10: run `npm run lint-docs`').replace('Line 20: run `npm run lint:docs`', 'Line 20: run `npm run lint-docs`') }]);
    const [sha, commit] = [...h.gh.createdCommits.entries()][0]!;
    expect(commit!.parents).toEqual([H]);
    expect(commit!.message).toMatch(/^Staleproof: fix 2 stale docs references/);
    expect(h.gh.refUpdates).toEqual([{ repo: REPO, branch: 'docs/fix-readme', sha, force: false }]);
    const last = h.gh.checkRuns.get(run.id)!.updates.at(-1)!;
    expect(last.actions).toEqual([]);
    expect(last.output.text).toMatch(/Committed 2 verified fixes/);
  });

  it('writes nothing when the branch moved, the check run has no fixes, or the pull request is closed', async () => {
    const h = harness();
    const { pull, action } = await checked(h, 41);
    h.gh.pulls.set(`${REPO.toLowerCase()}#41`, { ...pull, head: { ...pull.head, sha: H2 } });
    expect((await h.run('check_run', action)).result).toMatch(/moved past/);
    // The pull request still says H but the branch itself moved on.
    h.gh.pulls.set(`${REPO.toLowerCase()}#41`, pull);
    h.gh.refs.set(`${REPO.toLowerCase()}:docs/fix-readme`, H2);
    expect((await h.run('check_run', action)).result).toMatch(/has moved past/);
    expect((await h.run('check_run', { ...action, check_run: { ...action.check_run, id: 1 } })).result).toMatch(/no verified fixes on record/);
    h.gh.pulls.set(`${REPO.toLowerCase()}#41`, { ...pull, state: 'closed' });
    expect((await h.run('check_run', action)).result).toMatch(/is not open/);
    expect(h.gh.createdCommits.size).toBe(0);
    expect(h.gh.refUpdates).toHaveLength(0);
  });

  it('a protected branch is reported, not retried', async () => {
    const h = harness();
    const { action } = await checked(h, 42);
    h.gh.failures.push({ method: 'PATCH', path: /\/git\/refs\/heads\//, status: 422 });
    expect((await h.run('check_run', action)).result).toMatch(/refused the commit \(422\)/);
  });
});

describe('push to the default branch', () => {
  it('refreshes once per 5 minutes; a push in between marks the repo dirty and the next check refreshes it', async () => {
    const h = harness();
    const repo = `${OWNER}/pushy`;
    const push = (ref: string) => ({ ref, after: H, repository: repository({ repo }), installation: { id: INST } });
    expect((await h.run('push', push('refs/heads/feature'))).result).toBe('ignored: not the default branch');
    expect((await h.run('push', push('refs/heads/main'))).result).toBe('not indexed yet: nothing to refresh');
    expect((await h.run('push', push('refs/heads/main'))).result).toBe('debounced: marked dirty');
    expect((await registry.repo(repo))!.dirty).toBe(true);
    const pull = ghPull({ repo, number: 50, base: B, head: H });
    await h.run('pull_request', { ...prEvent('opened', pull), repository: repository({ repo }) });
    expect(h.requests[0]!.refresh).toBe(true);
    expect((await registry.repo(repo))!.dirty).toBe(false);
    // After the window, a push refreshes again.
    expect(await registry.pushRefresh({ fullName: repo, private: false, installation: INST }, Date.now() + 6 * 60_000)).toBe(true);
  });
});

describe('installations', () => {
  it('records installations and their repositories; uninstalling drops the private graph', async () => {
    const h = harness();
    const id = INST + 1;
    graphsToDrop.add(`ghp-${id}`);
    const installation = { id, account: { login: OWNER, type: 'Organization' }, repository_selection: 'selected' };
    await h.run('installation', { action: 'created', installation, repositories: [{ full_name: `${OWNER}/Public-One`, private: false }, { full_name: `${OWNER}/secret`, private: true }] });
    expect(await registry.installation(id)).toMatchObject({ id, account: OWNER, accountType: 'Organization', selection: 'selected', suspended: false });
    expect((await registry.repos(id)).map((r) => [r.name, r.fullName, r.private])).toEqual([
      [`${OWNER}/public-one`, `${OWNER}/Public-One`, false],
      [`${OWNER}/secret`, `${OWNER}/secret`, true],
    ]);

    await h.run('installation_repositories', { action: 'added', installation, repository_selection: 'selected', repositories_added: [{ full_name: `${OWNER}/more`, private: true }], repositories_removed: [] });
    expect((await registry.repos(id)).map((r) => r.name)).toContain(`${OWNER}/more`);

    // A removed private repository that the App indexed: its graph goes.
    await store.org(`ghp-${id}`).run(`CREATE (:Repo {name: $n})`, { n: `${OWNER}/secret` });
    await registry.recordIndexed(`ghp-${id}`, [{ name: `${OWNER}/secret`, sha: H }], { mb: 1, version: 4 });
    const removed = await h.run('installation_repositories', { action: 'removed', installation, repositories_added: [], repositories_removed: [{ full_name: `${OWNER}/secret`, private: true }] });
    expect(removed.result).toContain(`ghp-${id} dropped`);
    expect(await store.listGraphs()).not.toContain(`ghp-${id}`);
    expect(await registry.indexed(`ghp-${id}`)).toEqual([]);
    expect((await registry.repos(id)).map((r) => r.name)).not.toContain(`${OWNER}/secret`);

    await h.run('installation', { action: 'suspend', installation });
    expect((await registry.installation(id))!.suspended).toBe(true);
    await h.run('installation', { action: 'unsuspend', installation });
    expect((await registry.installation(id))!.suspended).toBe(false);

    await store.org(`ghp-${id}`).run(`CREATE (:Repo {name: $n})`, { n: `${OWNER}/more` });
    await h.run('installation', { action: 'deleted', installation });
    expect(await registry.installation(id)).toBeUndefined();
    expect(await registry.repos(id)).toEqual([]);
    expect(await store.listGraphs()).not.toContain(`ghp-${id}`);
  });
});

describe('daily cron', () => {
  const cron = (h: ReturnType<typeof harness>, auth?: string) => h.app.request('/api/github/cron', { headers: auth ? { authorization: auth } : {} });

  it('needs CRON_SECRET: off without it, 401 with a wrong or missing bearer', async () => {
    expect((await cron(harness({ env: { ...ENV, cronSecret: undefined } }), 'Bearer x')).status).toBe(503);
    const h = harness();
    expect((await cron(h)).status).toBe(401);
    expect((await cron(h, 'Bearer nope')).status).toBe(401);
    expect((await cron(h, 'cron-test')).status).toBe(401);
  });

  it('opens the docs fix PR and keeps the audit issue for repositories that ask, then closes it when all is clear', async () => {
    const fixPrs: Parameters<FixPrFn>[0][] = [];
    const h = harness({
      fixPr: async (input) => {
        fixPrs.push(input);
        return { action: 'opened', url: `https://github.com/${input.repo}/pull/99`, fixes: 1 };
      },
    });
    const id = INST + 2;
    const repo = `${OWNER}/docs-site`;
    // A public repository served by the fake codeload: the README links a page that does not exist.
    const dir = join(home, 'docs-site');
    await mkdir(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'README.md'), '# Docs site\n\nRead the [setup guide](docs/setup.md) first.\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    h.gh.gitRepos.set(repo.toLowerCase(), { dir, private: false });
    h.gh.installationRepos.set(id, [{ full_name: repo, private: false, default_branch: 'main' }, { full_name: `${OWNER}/quiet`, private: false, default_branch: 'main' }]);
    await writeFile(join(dir, '.staleproof.toml'), '[app]\nfix-prs = true\naudit-issue = true\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'config');
    await h.run('installation', { action: 'created', installation: { id, account: { login: OWNER, type: 'User' } }, repositories: [] });

    const res = await cron(h, 'Bearer cron-test');
    expect(res.status).toBe(200);
    const report = (await res.json()) as CronReport;
    expect(report.errors).toEqual([]);
    expect(report.installations).toBeGreaterThanOrEqual(1);
    expect(report.fixPrs).toEqual([{ repo, action: 'opened', url: `https://github.com/${repo}/pull/99` }]);
    expect(fixPrs[0]).toMatchObject({ repo, defaultBranch: 'main', home });
    expect(h.gh.tokens).toContain(fixPrs[0]!.token);
    expect(report.auditIssues).toHaveLength(1);
    expect(report.auditIssues[0]).toMatchObject({ repo, action: 'opened', number: 1 });
    const [issue] = h.gh.issues.get(repo.toLowerCase())!;
    expect(issue!.body.startsWith(AUDIT_MARKER)).toBe(true);
    expect(issue!.title).toMatch(/^Docs health \d+\/100: 1 docs reference\(s\) no longer match the repository$/);
    expect(issue!.body).toContain('docs/setup.md');
    // It went into the public owner's hosted workspace, like any public repository.
    expect((await workspaces.locate(repo))?.graph.name).toBe(`gh-${OWNER}`);

    // The link is fixed on the default branch; the push refreshes the index and the next cron closes the issue.
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'setup.md'), '# Setup\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'add the page');
    expect((await h.run('push', { ref: 'refs/heads/main', after: H, repository: { ...repository({ repo }) }, installation: { id } })).result).toBe('refreshed');
    const again = (await (await cron(h, 'Bearer cron-test')).json()) as CronReport;
    expect(again.errors).toEqual([]);
    expect(again.auditIssues[0]).toMatchObject({ repo, action: 'closed', number: 1 });
    expect(issue!.state).toBe('closed');
    expect(issue!.comments.at(-1)).toMatch(/^All clear/);
  });

  it('opens the docs fix PR with runFixPr on the default branch archive, then leaves it when nothing changed', async () => {
    const h = harness();
    const id = INST + 3;
    const repo = `${OWNER}/typo-docs`;
    const dir = join(home, 'typo-docs');
    await mkdir(join(dir, 'docs'), { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(dir, 'README.md'), '# Typo docs\n\nRead the [install guide](docs/instal.md) first.\n');
    await writeFile(join(dir, 'docs', 'install.md'), '# Install\n');
    await writeFile(join(dir, '.staleproof.toml'), '[app]\nfix-prs = true\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    h.gh.gitRepos.set(repo.toLowerCase(), { dir, private: false });
    h.gh.installationRepos.set(id, [{ full_name: repo, private: false, default_branch: 'main' }]);
    await h.run('installation', { action: 'created', installation: { id, account: { login: OWNER, type: 'User' } }, repositories: [{ full_name: repo, private: false }] });

    const report = (await (await cron(h, 'Bearer cron-test')).json()) as CronReport;
    expect(report.errors).toEqual([]);
    expect(report.fixPrs).toEqual([{ repo, action: 'opened', url: `https://github.com/${repo}/pull/1` }]);
    const pr = h.gh.pulls.get(`${repo.toLowerCase()}#1`)!;
    expect(pr).toMatchObject({ title: 'Staleproof: fix 1 stale docs reference', head: { ref: 'staleproof/fix-docs' }, base: { ref: 'main' }, state: 'open' });
    expect([...h.gh.blobs.values()]).toContain('# Typo docs\n\nRead the [install guide](docs/install.md) first.\n');
    expect(h.gh.refUpdates.map((u) => u.branch)).toEqual(['staleproof/fix-docs']);
    // Read and written with the installation's token.
    const writes = h.gh.calls.filter((c) => c.method !== 'GET' && c.path.startsWith(`/repos/${repo}/`));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((c) => h.gh.tokens.includes(c.auth!.replace(/^Bearer /, '')))).toBe(true);

    const again = (await (await cron(h, 'Bearer cron-test')).json()) as CronReport;
    expect(again.fixPrs).toEqual([{ repo, action: 'unchanged', url: `https://github.com/${repo}/pull/1` }]);
    expect(h.gh.pulls.size).toBe(1);
  });
});
