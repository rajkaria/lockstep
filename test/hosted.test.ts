import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphStore, OrgGraph } from '../src/graph/client.js';
import { Workspaces, TRANSLATION_DIR, type HostedEvent } from '../src/hosted/workspaces.js';
import { indexOrg, listFiles } from '../src/indexer/index.js';
import { downloadRepo, RepoTooLargeError, tarEntries } from '../src/indexer/tarball.js';
import { repoOfArgs } from '../src/mcp/http.js';
import { canonicalPrUrl, recordPullRequest } from '../src/pr/ingest.js';
import { createApp } from '../src/server/app.js';
import { fakePr, FIXTURE_REPOS, makeGitOrg, testConfig, testGraph } from './helpers.js';

/** `git archive` of a checkout, the way GitHub serves it: gzip, a pax header with the commit, a `<name>-<sha>/` prefix. */
function archive(dir: string, sha: string): Buffer {
  return execFileSync('git', ['archive', '--format=tar.gz', `--prefix=${dir.split('/').at(-1)}-${sha}/`, sha], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
}

describe('tarball download (no git)', () => {
  let root: string;
  let home: string;
  let org: Awaited<ReturnType<typeof makeGitOrg>>;
  let fetchImpl: typeof fetch;
  const requested: string[] = [];

  beforeAll(async () => {
    org = await makeGitOrg();
    root = org.root;
    home = await mkdtemp(join(tmpdir(), 'staleproof-tar-'));
    const byRepo = new Map(org.checkouts.map((c) => [c.repo, archive(c.dir, c.sha)]));
    fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const m = /codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(url);
      const body = m && byRepo.get(m[1]!);
      return body ? new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } }) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('reads the commit from the pax header and extracts exactly the files the indexer reads', async () => {
    for (const c of org.checkouts) {
      const got = await downloadRepo(home, c.repo, 'HEAD', { fetchImpl });
      expect(got.sha).toBe(c.sha);
      expect((await listFiles(got.dir)).map((f) => f.path)).toEqual((await listFiles(c.dir)).map((f) => f.path));
    }
    expect(requested[0]).toBe('https://codeload.github.com/acme/mini-client/tar.gz/HEAD');
  });

  it('skips what it is told to and refuses archives over the limits', async () => {
    const docs = org.checkouts.find((c) => c.repo === 'acme/mini-docs')!;
    const skipped = await downloadRepo(home, docs.repo, 'HEAD', { fetchImpl, skip: (p) => p.startsWith('docs/') });
    expect((await listFiles(skipped.dir)).some((f) => f.path.startsWith('docs/'))).toBe(false);
    await expect(downloadRepo(home, docs.repo, 'HEAD', { fetchImpl, limits: { maxBytes: 10, maxFiles: 100 } })).rejects.toBeInstanceOf(RepoTooLargeError);
    await expect(downloadRepo(home, docs.repo, 'HEAD', { fetchImpl, limits: { maxBytes: 1e9, maxFiles: 1 } })).rejects.toThrow(/more than 1 code and docs files/);
    await expect(downloadRepo(home, 'acme/nope', 'HEAD', { fetchImpl })).rejects.toThrow(/not found/);
  });

  it('parses long paths from pax headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-long-'));
    const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'f'.repeat(60)}.md`;
    execFileSync('mkdir', ['-p', join(dir, long.split('/').slice(0, -1).join('/'))]);
    execFileSync('bash', ['-c', `echo '# Title' > '${join(dir, long)}'`]);
    const tgz = execFileSync('tar', ['--format=pax', '-czf', '-', '-C', dir, long], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const paths: string[] = [];
    for await (const e of tarEntries(Readable.from([tgz]).pipe(createGunzip()))) if (e.type === 'file') paths.push(e.path);
    expect(paths).toEqual([long]);
    await rm(dir, { recursive: true, force: true });
  });

  it('recognises translated docs directories', () => {
    expect(TRANSLATION_DIR.test('docs/zh/index.md')).toBe(true);
    expect(TRANSLATION_DIR.test('docs/pt-BR/tutorial.md')).toBe(true);
    expect(TRANSLATION_DIR.test('docs/en/index.md')).toBe(false);
    expect(TRANSLATION_DIR.test('docs/api/index.md')).toBe(false);
  });
});

describe('hosted workspaces (FalkorDB)', () => {
  let root: string;
  let store: GraphStore;
  let curated: OrgGraph;
  let done: () => Promise<void>;
  let ws: Workspaces;
  let fetchImpl: typeof fetch;
  const prefix = `ws${process.pid}-`;
  const registry = `ws-registry-${process.pid}`;
  const config = testConfig();

  beforeAll(async () => {
    const org = await makeGitOrg();
    root = org.root;
    const byRepo = new Map(org.checkouts.map((c) => [c.repo, archive(c.dir, c.sha)]));
    fetchImpl = (async (input: string | URL | Request) => {
      const m = /codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(String(input));
      const body = m && byRepo.get(m[1]!);
      return body ? new Response(new Uint8Array(body)) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
    const t = await testGraph('curated');
    ({ store, done } = t);
    curated = t.graph;
    // The curated graph holds only the SDK; the client and docs are indexed on demand.
    await indexOrg(curated, FIXTURE_REPOS.filter((r) => r.repo === 'acme/mini-sdk'));
    ws = new Workspaces(store, { ...config, home: await mkdtemp(join(tmpdir(), 'staleproof-ws-')) }, curated, { prefix, registry, fetchImpl });
  });
  afterAll(async () => {
    for (const w of await ws.list()) if (!w.curated) await ws.evict(w.graph);
    await store.org(registry).drop();
    await done();
    await rm(root, { recursive: true, force: true });
  });

  it('answers curated repositories from the curated graph and never re-indexes them', async () => {
    expect((await ws.locate('acme/mini-sdk'))?.curated).toBe(true);
    await expect(ws.ensure('acme/mini-sdk', { with: ['acme/mini-docs'] })).rejects.toThrow(/curated/);
    expect(await ws.locate('acme/mini-client')).toBeUndefined();
  });

  it('indexes a repository and its docs together on first use, then reuses the workspace', async () => {
    const events: HostedEvent[] = [];
    const r = await ws.ensure('acme/mini-client', { with: ['acme/mini-docs'], onEvent: (e) => events.push(e) });
    expect(r.graph.name).toBe(`${prefix}acme`);
    expect(events[0]).toMatchObject({ type: 'index_started', repos: ['acme/mini-client', 'acme/mini-docs'], reason: 'new' });
    expect(events.at(-1)).toMatchObject({ type: 'index_finished', graph: `${prefix}acme` });
    const finished = events.at(-1) as Extract<HostedEvent, { type: 'index_finished' }>;
    expect(finished.repos.find((x) => x.repo === 'acme/mini-docs')!.sections).toBeGreaterThan(0);
    // A doc in mini-docs links to code in mini-client: indexed together, the edge resolves.
    const cross = await r.graph.run<{ n: number }>(`MATCH (d:DocSection {repo: 'acme/mini-docs'})-[:MENTIONS]->(s:Symbol {repo: 'acme/mini-client'}) RETURN count(*) AS n`);
    expect(cross.rows[0]!.n).toBeGreaterThan(0);

    const again: HostedEvent[] = [];
    const r2 = await ws.ensure('acme/mini-docs', { onEvent: (e) => again.push(e) });
    expect(r2.graph.name).toBe(`${prefix}acme`);
    expect(again).toEqual([]);
    expect((await ws.locate('ACME/Mini-Client'))?.graph.name).toBe(`${prefix}acme`);
    // GitHub names are case-insensitive: another spelling reuses the workspace and the same nodes.
    const shouted: HostedEvent[] = [];
    expect((await ws.ensure('ACME/Mini-Client', { onEvent: (e) => shouted.push(e) })).graph.name).toBe(`${prefix}acme`);
    expect(shouted).toEqual([]);
    expect(await canonicalPrUrl(r.graph, 'https://github.com/ACME/Mini-Client/pull/5')).toBe('https://github.com/acme/mini-client/pull/5');
    expect(await canonicalPrUrl(curated, 'https://github.com/ACME/MINI-SDK/pull/5')).toBe('https://github.com/acme/mini-sdk/pull/5');
    const list = await ws.list();
    expect(list.find((w) => w.graph === `${prefix}acme`)?.repos.map((x) => x.name)).toEqual(['acme/mini-client', 'acme/mini-docs']);
  });

  it('re-indexes a workspace written by an older index format on next use', async () => {
    const registryGraph = store.org(registry);
    await registryGraph.run(`MATCH (r:HostedRepo {name: 'acme/mini-docs'}) REMOVE r.index_version`);
    const events: HostedEvent[] = [];
    await ws.ensure('acme/mini-docs', { onEvent: (e) => events.push(e) });
    expect(events[0]).toMatchObject({ type: 'index_started', reason: 'stale' });
    const again: HostedEvent[] = [];
    await ws.ensure('acme/mini-docs', { onEvent: (e) => again.push(e) });
    expect(again).toEqual([]);
  });

  it('refuses workspaces over the repository limit, and counts a daily budget', async () => {
    const small = new Workspaces(store, config, curated, { prefix, registry, fetchImpl, limits: { maxRepos: 1 } });
    await expect(small.ensure('acme/other', { with: ['acme/more'] })).rejects.toThrow(/limit 1/);
    const kind = `test-${process.pid}`;
    expect(await ws.withinDailyBudget(kind, 2)).toBe(true);
    expect(await ws.withinDailyBudget(kind, 2)).toBe(true);
    expect(await ws.withinDailyBudget(kind, 2)).toBe(false);
  });

  it('serves hosted checks, repository status and MCP over HTTP', async () => {
    const app = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    const repo = (await (await app.request('/api/repos?name=acme/mini-client')).json()) as { indexed: boolean; graph: string; workspace: string[] };
    expect(repo).toMatchObject({ indexed: true, graph: `${prefix}acme`, workspace: ['acme/mini-client', 'acme/mini-docs'] });
    expect(await (await app.request('/api/repos?name=acme/unknown')).json()).toMatchObject({ indexed: false, graph: `${prefix}acme` });
    expect((await app.request('/api/repos?name=not a repo')).status).toBe(400);

    // A pull request already ingested (no GitHub access in tests), checked through the hosted route.
    const graph = (await ws.locate('acme/mini-client'))!.graph;
    const pr = fakePr({ number: 41, url: 'https://github.com/acme/mini-client/pull/41' });
    await recordPullRequest(graph, pr, {
      before: 'b', after: 'a', files: [], docsTouched: [],
      symbols: [{ repo: 'acme/mini-client', qualname: 'miniclient.graph.Graph.ro_query', name: 'ro_query', kind: 'method', change: 'renamed', renamedTo: 'miniclient.graph.Graph.read_query', before: 'def ro_query(self, q: str)', after: 'def read_query(self, q: str)', path: 'miniclient/graph.py', lineno: 13, endLineno: 15 }],
    });
    const res = await app.request('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_url: pr.url, mode: 'graph' }) });
    const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { type: string; checkId?: string; status?: string });
    const finished = events.find((e) => e.type === 'check_finished')!;
    expect(finished.status).toBe('done');
    // No example runs on a hosted workspace: there is no sandbox.
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as unknown as { name: string }).name)).toEqual(['impact', 'clearance', 'rank_sections']);
    const stored = (await (await app.request(`/api/checks/${finished.checkId}`)).json()) as { org: string };
    expect(stored.org).toBe(`${prefix}acme`);
    const recent = (await (await app.request('/api/checks?limit=abc')).json()) as { checks: { id: string; org: string }[] };
    expect(recent.checks.find((c) => c.id === finished.checkId)?.org).toBe(`${prefix}acme`);

    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://local/api/mcp'), { fetch: async (url, init) => app.request(String(url), init as RequestInit) }));
    const { tools } = await client.listTools();
    expect(tools[0]!.name).toBe('check_pull_request');
    expect(tools.map((t) => t.name)).not.toContain('run_example');
    const report = await client.callTool({ name: 'check_pull_request', arguments: { pr_url: pr.url } });
    const text = (report.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/^<!-- staleproof -->\n### Staleproof: (\d+ doc sections? this pull request can make false|this pull request is predicted to break 1 docs example)/);
    expect(text).toContain('acme/mini-docs');
    const audit = await client.callTool({ name: 'audit_docs', arguments: { repos: ['acme/mini-client'] } });
    expect((audit.content as { text: string }[])[0]!.text).toMatch(/^Docs health \d+\/100 \([A-F]\) for acme\/mini-client\./);
    const section = await client.callTool({ name: 'read_section', arguments: { section_id: 'acme/unknown:x.md#y' } });
    expect(section.isError).toBe(true);
    expect((section.content as { text: string }[])[0]!.text).toContain('not indexed yet');
    await client.close();
  });

  it('audits a repository on demand over HTTP and serves its badge', async () => {
    const app = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    // Not yet audited (and not indexed): a grey badge, a 404 with what to do.
    const grey = await app.request('/api/badge/acme/stale-docs.svg');
    expect(grey.headers.get('content-type')).toContain('image/svg+xml');
    expect(await grey.text()).toContain('not audited');
    const missing = await app.request('/api/audit?repo=acme/stale-docs');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ indexed: false, error: expect.stringContaining('POST /api/audit') });

    const res = await app.request('/api/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'acme/mini-client' }) });
    const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { type: string; summary?: string; data?: { score: number; coverage: { api: number } } });
    const audit = events.find((e) => e.type === 'audit')!;
    expect(audit.summary).toMatch(/^Docs health \d+\/100/);
    expect(audit.data!.coverage.api).toBeGreaterThan(0);

    const json = (await (await app.request('/api/audit?repo=ACME/Mini-Client')).json()) as { score: number; repos: { name: string }[] };
    expect(json.repos.map((r) => r.name)).toEqual(['acme/mini-client']);
    const badge = await app.request('/api/badge/acme/mini-client.svg');
    expect(badge.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=3600');
    expect(await badge.text()).toContain(`docs health: ${json.score} `);
    expect((await app.request('/api/audit?repo=nope')).status).toBe(400);
  });

  it('routes MCP calls by the repository their arguments name', () => {
    expect(repoOfArgs({ repos: ['a/b', 'c/d'] })).toBe('a/b');
    expect(repoOfArgs({ pr_url: 'https://github.com/a/b/pull/1' })).toBe('a/b');
    expect(repoOfArgs({ section_ids: ['x/y:docs/a.md#h'] })).toBe('x/y');
    expect(repoOfArgs({ target_id: 'x/y:pkg.mod.f' })).toBe('x/y');
    expect(repoOfArgs({ text: 'no ids' })).toBeUndefined();
  });
});

describe('tarball extraction keeps the repository config', () => {
  it('extracts a root .staleproof.toml but no other hidden path', async () => {
    const { mkdtemp, writeFile, mkdir, readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-cfg-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await writeFile(join(dir, '.staleproof.toml'), 'ignore = ["docs/old.md"]\n');
    await mkdir(join(dir, '.github'), { recursive: true });
    await writeFile(join(dir, '.github', 'notes.md'), '# hidden\n');
    await writeFile(join(dir, 'README.md'), '# Readme\n');
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x'], { cwd: dir });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const body = archive(dir, sha);
    const fetchImpl = (async () => new Response(new Uint8Array(body))) as unknown as typeof fetch;
    const home = await mkdtemp(join(tmpdir(), 'staleproof-cfg-home-'));
    const co = await downloadRepo(home, 'acme/cfg', 'HEAD', { fetchImpl });
    const top = await readdir(co.dir);
    expect(top.sort()).toEqual(['.staleproof.toml', 'README.md']);
  });
});

describe('hosted lint (FalkorDB)', () => {
  let root: string;
  let store: GraphStore;
  let curated: OrgGraph;
  let done: () => Promise<void>;
  let ws: Workspaces;
  let fetchImpl: typeof fetch;
  const requested: string[] = [];
  let home: string;
  let mainSha: string;
  let prSha: string;
  const prefix = `wl${process.pid}-`;
  const registry = `wl-registry-${process.pid}`;
  const config = testConfig();

  beforeAll(async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    root = await mkdtemp(join(tmpdir(), 'staleproof-hl-'));
    // An application with agent files in a hidden folder and one stale reference in each kind of file.
    const files: Record<string, string> = {
      'AGENTS.md': '# Agents\n\n- Code lives in `src/app.ts`; settings in `src/settings.ts`.\n',
      '.claude/skills/ship/SKILL.md': '# Ship\n\nBump `src/version.ts` first.\n',
      'README.md': '# Lint app\n\nRead [setup](docs/setup.md).\n',
      'docs/guide.md': '# Guide\n\n## Run\n\nSee [the FAQ](faq.md).\n',
      'src/app.ts': 'export const x = 1;\n',
      'logo.png': 'PNG',
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    mainSha = git('rev-parse', 'HEAD');
    // A pull request that moves the entry point AGENTS.md names.
    git('checkout', '-q', '-b', 'move-app');
    git('mv', 'src/app.ts', 'src/main.ts');
    git('commit', '-q', '-m', 'move the entry point');
    prSha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    const archive = (sha: string) => execFileSync('git', ['archive', '--format=tar.gz', `--prefix=lint-app-${sha}/`, sha], { cwd: root });
    fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const ref = /codeload\.github\.com\/lintco\/lint-app\/tar\.gz\/(.+)$/.exec(url)?.[1];
      const sha = ref === 'HEAD' ? mainSha : ref === mainSha || ref === prSha ? ref : undefined;
      return sha ? new Response(new Uint8Array(archive(sha))) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
    const t = await testGraph('hl-curated');
    ({ store, done } = t);
    curated = t.graph;
    home = await mkdtemp(join(tmpdir(), 'staleproof-hl-ws-'));
    ws = new Workspaces(store, { ...config, home }, curated, { prefix, registry, fetchImpl });
  });
  afterAll(async () => {
    for (const w of await ws.list()) if (!w.curated) await ws.evict(w.graph);
    await store.org(registry).drop();
    await done();
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  const expected = [
    '.claude/skills/ship/SKILL.md:3 path-missing src/version.ts',
    'AGENTS.md:3 path-missing src/settings.ts',
    'README.md:3 link-broken docs/setup.md',
    'docs/guide.md:5 link-broken docs/faq.md',
  ];

  it('GET /api/lint lints any public repository from its tarball, cached, in every format', async () => {
    const app = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    const res = await app.request('/api/lint?repo=lintco/lint-app');
    expect(res.status).toBe(200);
    const r = (await res.json()) as { version: number; repo: string; findings: { path: string; line: number; rule: string; subject: string }[]; cached: boolean; tool: { name: string } };
    expect(r).toMatchObject({ version: 1, repo: 'lintco/lint-app', cached: false, tool: { name: 'staleproof' } });
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.rule} ${f.subject}`)).toEqual(expected);
    const downloads = requested.length;
    const again = (await (await app.request('/api/lint?repo=LintCo/Lint-App')).json()) as { cached: boolean };
    expect(again.cached).toBe(true);
    expect(requested.length).toBe(downloads);
    const md = await app.request('/api/lint?repo=lintco/lint-app&format=markdown');
    expect(md.headers.get('content-type')).toContain('text/markdown');
    expect(await md.text()).toContain('**AI agent instructions**');
    const sarif = (await (await app.request('/api/lint?repo=lintco/lint-app&format=sarif&rule=link-broken')).json()) as { runs: { results: unknown[] }[] };
    expect(sarif.runs[0]!.results).toHaveLength(2);
    expect((await app.request('/api/lint?repo=lintco/nope')).status).toBe(404);
    expect((await app.request('/api/lint?repo=not-a-repo')).status).toBe(400);
    expect((await app.request('/api/lint?repo=lintco/lint-app&rule=nope')).status).toBe(400);
    expect((await app.request('/api/lint?repo=lintco/lint-app&ref=../x')).status).toBe(400);
    expect((await app.request('/api/lint?repo=lintco/lint-app&format=pdf')).status).toBe(400);
    // Only downloads count against the rate limit.
    const strict = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1 });
    expect((await strict.request('/api/lint?repo=lintco/lint-app')).status).toBe(200);
    expect((await strict.request('/api/lint?repo=lintco/lint-app&fresh=1')).status).toBe(200);
    expect((await strict.request('/api/lint?repo=lintco/lint-app&fresh=1')).status).toBe(200);
    expect((await strict.request('/api/lint?repo=lintco/lint-app&fresh=1')).status).toBe(429);
  });

  it('indexes the whole tree listing, so the audit reads the findings with no checkout (agent files first)', async () => {
    await ws.ensure('lintco/lint-app');
    const graph = (await ws.locate('lintco/lint-app'))!.graph;
    const rows = (await graph.run<{ path: string; rule: string }>(`MATCH (f:Finding {repo: 'lintco/lint-app'}) RETURN f.path AS path, f.rule AS rule ORDER BY path`)).rows;
    expect(rows.map((r) => r.path)).toEqual(['.claude/skills/ship/SKILL.md', 'AGENTS.md', 'README.md', 'docs/guide.md']);
    // The indexer saw what downloadRepo would extract: no hidden folders, no binaries.
    const files = (await graph.run<{ path: string }>(`MATCH (f:File {repo: 'lintco/lint-app'}) RETURN f.path AS path ORDER BY path`)).rows.map((r) => r.path);
    expect(files.some((p) => p.startsWith('.claude/'))).toBe(false);
    const app = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    const audit = (await (await app.request('/api/audit?repo=lintco/lint-app&fresh=1')).json()) as { findings: { path: string; line: number; rule: string; subject: string; surface: string }[]; deductions: { points: number; why: string }[]; repos: { findingsChecked: boolean }[] };
    expect(audit.findings.map((f) => `${f.path}:${f.line} ${f.rule} ${f.subject}`)).toEqual(expected);
    expect(audit.findings.map((f) => f.surface)).toEqual(['agent', 'agent', 'readme', 'docs']);
    expect(audit.deductions.find((d) => d.why.startsWith('Docs references'))?.points).toBe(12);
    expect(audit.repos[0]!.findingsChecked).toBe(true);
  });

  it('a hosted check lists the docs references the pull request makes wrong, from the public tarballs of both commits', async () => {
    const graph = (await ws.locate('lintco/lint-app'))!.graph;
    // Merged, so the check does not ask GitHub whether it moved (no network in tests).
    const pr = fakePr({ owner: 'lintco', repo: 'lint-app', fullName: 'lintco/lint-app', number: 3, url: 'https://github.com/lintco/lint-app/pull/3', mergeSha: prSha });
    await recordPullRequest(graph, pr, { before: mainSha, after: prSha, files: [], docsTouched: [], symbols: [] });
    const app = createApp({ store, config: { ...config, org: curated.name, githubToken: 'server-token' }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    requested.length = 0;
    const res = await app.request('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pr_url: pr.url, mode: 'graph' }) });
    const events = (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as { type: string; name?: string; data?: unknown; status?: string; summary?: string });
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.name)).toEqual(['new_findings', 'impact', 'clearance']);
    const impact = events.find((e) => e.type === 'tool_result' && e.name === 'impact')!.data as { newFindings: { total: number; findings: { path: string; rule: string; subject: string }[] } };
    expect(impact.newFindings.findings.map((f) => `${f.path} ${f.rule} ${f.subject}`)).toEqual(['AGENTS.md path-missing src/app.ts']);
    const finished = events.find((e) => e.type === 'check_finished')!;
    expect(finished.status).toBe('done');
    expect(finished.summary).toMatch(/^This pull request makes 1 docs reference wrong \(1 error, 1 in AI agent instructions\): AGENTS\.md:3 `src\/app\.ts`\./);
    // Both commits from codeload, never the API with the server's token.
    expect(requested.filter((u) => u.includes('/tar.gz/')).sort()).toEqual([mainSha, prSha].map((s) => `https://codeload.github.com/lintco/lint-app/tar.gz/${s}`).sort());
    expect(requested.some((u) => u.includes('api.github.com'))).toBe(false);
  });

  it('serves lint_docs over MCP without indexing, and never reads the server disk', async () => {
    const app = createApp({ store, config: { ...config, org: curated.name }, workspaces: ws, webDir: '/nonexistent', rateLimit: 1000 });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://local/api/mcp'), { fetch: async (url, init) => app.request(String(url), init as RequestInit) }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('lint_docs');
    const r = await client.callTool({ name: 'lint_docs', arguments: { dir: '/' } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toContain('cannot read your disk');
    await client.close();
  });
});
