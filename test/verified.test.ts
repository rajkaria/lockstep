import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDocs, type AuditData } from '../src/audit.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { graphVerifiedSource, isPrivateGraph, registerVerifiedRoutes, verifiedData, type VerifiedSource } from '../src/server/verified.js';
import { FIXTURE_REPOS, STALE_DOCS, testConfig, testGraph } from './helpers.js';

const DAY = 86_400_000;
const INDEXED = Date.UTC(2026, 9, 15, 12);

/** An audit as the hosted service computes it (src/audit.ts), with one of everything. */
function sampleAudit(over: Partial<AuditData> = {}): AuditData {
  return {
    org: 'gh-acme',
    repos: [{ name: 'acme/app', sha: 'abc1234def5678', symbols: 10, sections: 6, indexVersion: 4, findingsChecked: true }],
    score: 84,
    grade: 'B',
    deductions: [],
    examples: { total: 4, python: 4, linked: 4, mismatched: 1 },
    mismatches: [
      {
        example: 'acme/app:docs/api.md:1',
        url: 'https://github.com/acme/app/blob/abc1234def5678/docs/api.md#L30',
        repo: 'acme/app',
        path: 'docs/api.md',
        heading: 'API > Connect',
        line: 30,
        kind: 'unknown-keyword',
        detail: '`connect` has no parameter `tls`',
        call: 'app.connect',
        symbol: 'app.connect',
      },
    ],
    coverage: { api: 10, documented: 9, percent: 90 },
    undocumented: [],
    runs: [
      { example: 'acme/app:docs/install.md:0', url: 'u', status: 'pass', error: '', reason: '' },
      { example: 'acme/app:docs/install.md:1', url: 'u', status: 'pass', error: '', reason: '' },
      { example: 'acme/app:docs/run.md:0', url: 'u', status: 'fail', error: 'TypeError', reason: '' },
      { example: 'acme/app:docs/run.md:1', url: 'u', status: 'skipped', error: '', reason: 'no uv' },
    ],
    runCounts: { pass: 2, fail: 1, skipped: 1, error: 0 },
    findings: [
      { rule: 'command-missing', severity: 'error', message: '`npm run docs` is not a script in package.json.', repo: 'acme/app', path: 'docs/api.md', line: 3, column: 1, endLine: 3, endColumn: 10, surface: 'docs', subject: 'npm run docs', fingerprint: 'a1' },
      { rule: 'env-undocumented', severity: 'info', message: 'info only', repo: 'acme/app', path: 'docs/guide.md', line: 1, column: 1, endLine: 1, endColumn: 2, surface: 'docs', subject: 'X', fingerprint: 'a2' },
      { rule: 'path-missing', severity: 'warning', message: '`src/x.ts` does not exist.', repo: 'acme/app', path: 'AGENTS.md', line: 9, column: 1, endLine: 9, endColumn: 9, surface: 'agent', subject: 'src/x.ts', fingerprint: 'a3' },
    ],
    findingCounts: { errors: 1, warnings: 1, infos: 1, byRule: {}, bySurface: {} },
    generatedAt: INDEXED + DAY,
    ...over,
  } as AuditData;
}

function sampleSource(over: Partial<VerifiedSource> = {}): VerifiedSource {
  return {
    graph: 'gh-acme',
    repo: { name: 'acme/app', sha: 'abc1234def5678', indexedAt: INDEXED },
    pages: [
      { path: 'docs/install.md', examples: 2 },
      { path: 'docs/api.md', examples: 2 },
      { path: 'docs/guide.md', examples: 0 },
      { path: 'docs/run.md', examples: 2 },
    ],
    audit: sampleAudit(),
    ...over,
  };
}

describe('verified data', () => {
  it('reports each page: checked, or drift with what is out of date', () => {
    const page = (path: string, extra: object) => ({ path, sha: 'abc1234def5678', checkedAt: INDEXED, findings: 0, mismatches: 0, ...extra });
    expect(verifiedData(sampleSource())).toEqual({
      version: 1,
      repo: 'acme/app',
      sha: 'abc1234def5678',
      checkedAt: INDEXED,
      score: 84,
      grade: 'B',
      checks: { references: true, examples: true },
      pages: [
        page('AGENTS.md', { status: 'drift', findings: 1, examples: 0 }),
        page('docs/api.md', { status: 'drift', findings: 1, mismatches: 1, examples: 2 }),
        // An info-level finding is not drift.
        page('docs/guide.md', { status: 'checked', examples: 0 }),
        page('docs/install.md', { status: 'checked', examples: 2, runs: { pass: 2, fail: 0 } }),
        // Skipped runs are not counted either way.
        page('docs/run.md', { status: 'drift', examples: 2, runs: { pass: 0, fail: 1 } }),
      ],
    });
  });

  it('never says references were checked when the index did not lint them', () => {
    const audit = sampleAudit({ repos: [{ name: 'acme/app', sha: 'abc1234def5678', symbols: 1, sections: 1, indexVersion: 3, findingsChecked: false }], findings: [], runs: [] });
    const d = verifiedData(sampleSource({ audit }));
    expect(d.checks).toEqual({ references: false, examples: true });
    // A page with no examples had nothing checked: it is left out, so the stamp shows nothing there.
    expect(d.pages.map((p) => `${p.path} ${p.status}`)).toEqual(['docs/api.md drift', 'docs/install.md checked', 'docs/run.md checked']);
    const old = sampleAudit({ repos: [{ name: 'acme/app', sha: 'x', symbols: 1, sections: 1, indexVersion: 2 }], findings: [], runs: [], mismatches: [] });
    expect(verifiedData(sampleSource({ audit: old })).pages).toEqual([]);
  });

  it('refuses private graphs by name', () => {
    expect(isPrivateGraph('ghp-12345')).toBe(true);
    expect(isPrivateGraph('GHP-1')).toBe(true);
    expect(isPrivateGraph('gh-acme')).toBe(false);
    expect(isPrivateGraph('falkordb')).toBe(false);
  });
});

describe('verified routes', () => {
  const sources: Record<string, VerifiedSource> = {
    'acme/app': sampleSource(),
    'secret/app': sampleSource({ graph: 'ghp-4242', repo: { name: 'secret/app', sha: 'f'.repeat(40), indexedAt: INDEXED } }),
  };
  const app = new Hono();
  registerVerifiedRoutes(app, {
    load: async (repo) => {
      if (repo === 'broken/app') throw new Error('FalkorDB is down');
      return sources[repo.toLowerCase()];
    },
  });

  it('serves per-page status as JSON, CORS *, cached 10 minutes at the CDN', async () => {
    const res = await app.request('/api/verified/acme/app.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=600');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const body = (await res.json()) as ReturnType<typeof verifiedData>;
    expect(body).toEqual(verifiedData(sources['acme/app']!));
    expect(body.pages.find((p) => p.path === 'docs/install.md')).toMatchObject({ status: 'checked', runs: { pass: 2, fail: 0 } });
  });

  it('answers a repository nobody audited and a private (ghp-) graph the same way: 404', async () => {
    const missing = await app.request('/api/verified/acme/nope.json');
    const secret = await app.request('/api/verified/secret/app.json');
    expect(missing.status).toBe(404);
    expect(secret.status).toBe(404);
    expect(secret.headers.get('access-control-allow-origin')).toBe('*');
    const [a, b] = [(await missing.json()) as { indexed: boolean; error: string }, (await secret.json()) as { indexed: boolean; error: string }];
    expect(a.indexed).toBe(false);
    expect(b).toEqual({ ...a, error: a.error.replaceAll('acme/nope', 'secret/app') });
    expect(JSON.stringify(b)).not.toContain('ghp-');
  });

  it('rejects names that are not repositories, and fails soft when the graph is unreachable', async () => {
    expect((await app.request('/api/verified/a%20b/c.json')).status).toBe(400);
    const down = await app.request('/api/verified/broken/app.json');
    expect(down.status).toBe(503);
    expect(down.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/api/verified/acme/app.txt')).status).toBe(404);
  });

  it('serves the stamp script for any repository, cached a day at the CDN', async () => {
    const res = await app.request('/api/verified/acme/app/stamp.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    const js = await res.text();
    expect(js).toContain('var R="acme/app"');
    expect(Buffer.byteLength(js)).toBeLessThan(4096);
    expect((await app.request('/api/verified/a%20b/c/stamp.js')).status).toBe(400);
  });
});

describe('verified source from a graph (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ graph, done } = await testGraph('verified'));
    await indexOrg(graph, [...FIXTURE_REPOS, STALE_DOCS]);
  });
  afterAll(async () => done());

  const audit = (g: OrgGraph) => async (name: string) => (await auditDocs({ graph: g, config: testConfig() }, { repos: [name] })).data;

  it('lists the indexed docs pages with their examples, around the audit', async () => {
    const src = (await graphVerifiedSource(graph, 'ACME/stale-docs', audit(graph)))!;
    expect(src.repo).toMatchObject({ name: 'acme/stale-docs', sha: 'fixture' });
    expect(src.repo.indexedAt).toBeGreaterThan(Date.now() - 600_000);
    expect(src.pages).toEqual([{ path: 'docs/stale.md', examples: 4 }]);
    const d = verifiedData(src);
    // Plain fixture folders are not linted at index time: only the examples were checked.
    expect(d.checks).toEqual({ references: false, examples: true });
    expect(d.pages).toEqual([{ path: 'docs/stale.md', status: 'drift', findings: 0, mismatches: 5, examples: 4, sha: 'fixture', checkedAt: src.repo.indexedAt }]);

    const docs = verifiedData((await graphVerifiedSource(graph, 'acme/mini-docs', audit(graph)))!);
    expect(docs.pages.length).toBeGreaterThan(0);
    expect(docs.pages.every((p) => p.examples > 0)).toBe(true);
    expect(await graphVerifiedSource(graph, 'acme/none', audit(graph))).toBeUndefined();
  });

  it('never reads a private (ghp-) graph', async () => {
    const privateGraph = { name: 'ghp-99', run: async () => ({ rows: [{ name: 'x/y', sha: 's', indexedAt: 1 }] }) } as unknown as OrgGraph;
    expect(await graphVerifiedSource(privateGraph, 'x/y', audit(graph))).toBeUndefined();
  });
});
