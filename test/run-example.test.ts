import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import type { Checkout } from '../src/indexer/repo.js';
import { diffRange } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { runExampleTool } from '../src/tools/run-example.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, FIXTURES, testConfig, testGraph } from './helpers.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

describe('run_example (sandbox, FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let root: string;
  const pr = fakePr({ url: 'https://github.com/acme/mini-client/pull/8', number: 8, title: 'Rename ro_query to read_query' });

  beforeAll(async () => {
    ({ graph, done } = await testGraph('run'));
    root = await mkdtemp(join(tmpdir(), 'lockstep-org-'));
    const checkouts: Checkout[] = [];
    for (const name of ['mini-client', 'mini-sdk', 'mini-docs']) {
      const dir = join(root, name);
      await cp(join(FIXTURES, 'org', name), dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'init');
      checkouts.push({ repo: `acme/${name}`, dir, sha: git(dir, 'rev-parse', 'HEAD') });
    }
    await indexOrg(graph, checkouts);
    // The PR: rename Graph.ro_query → read_query in the client.
    const client = checkouts[0]!;
    const file = join(client.dir, 'miniclient', 'graph.py');
    await writeFile(file, (await readFile(file, 'utf8')).replace('def ro_query(', 'def read_query('));
    git(client.dir, 'commit', '-q', '-am', 'rename');
    const after = git(client.dir, 'rev-parse', 'HEAD');
    await recordPullRequest(graph, pr, await diffRange(client.dir, client.repo, client.sha, after));
    // A separate scratch server: runs FLUSHALL it before every example, so it must never be the test graph's server.
    const config = testConfig({ home: join(root, 'home'), scratch: { host: '127.0.0.1', port: 6391, managed: true } });
    ctx = { graph, config, checkouts: Object.fromEntries(checkouts.map((c) => [c.repo, c.dir])) };
  }, 240_000);
  afterAll(async () => {
    await done();
    await rm(root, { recursive: true, force: true });
  });

  it('proves the PR breaks a docs example: passes before, fails after, with the real traceback', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/mini-docs:docs/getting-started.mdx:1', pr_url: pr.url });
    expect(r.data.verdict).toBe('breaks');
    const [before, after] = r.data.runs;
    expect(before!.status).toBe('pass');
    expect(before!.stitched).toEqual(['acme/mini-docs:docs/getting-started.mdx:0']);
    expect(after!.status).toBe('fail');
    expect(after!.error).toBe("AttributeError: 'Graph' object has no attribute 'ro_query'. Did you mean: 'read_query'?");
    expect(after!.traceback).toContain('Traceback (most recent call last):');
    expect(r.summary).toMatch(/^Passes at \w{7} and fails at \w{7} with AttributeError: 'Graph' object has no attribute 'ro_query'\. Did you mean: 'read_query'\?: the PR breaks this example\.$/);
    const runs = await graph.run<{ status: string; side: string }>(
      `MATCH (r:Run)-[:OF]->(:CodeExample {id: 'acme/mini-docs:docs/getting-started.mdx:1'}), (r)-[:AT]->(:PullRequest {url: $pr}) RETURN r.status AS status, r.side AS side ORDER BY side`,
      { pr: pr.url },
    );
    expect(runs.rows).toEqual([{ status: 'fail', side: 'after' }, { status: 'pass', side: 'before' }]);
  }, 240_000);

  it('remembers identical runs instead of re-running them', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/mini-docs:docs/getting-started.mdx:1', pr_url: pr.url });
    expect(r.data.runs.every((x) => x.cached)).toBe(true);
    expect(r.summary).toMatch(/recorded earlier; not re-run/);
  });

  it('records examples it cannot run honestly as skipped, with the reason', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/mini-docs:docs/rag.mdx:1', pr_url: pr.url });
    expect(r.data.verdict).toBe('skipped');
    expect(r.summary).toBe('Not run: not Python (bash).');
  });

  it('passes an unaffected example before and after', async () => {
    const r = await runExampleTool.run(ctx, { example_id: 'acme/mini-docs:docs/rag.mdx:0', pr_url: pr.url });
    expect(r.data.verdict).toBe('passes');
    expect(r.data.runs.map((x) => x.installed.length)).toEqual([2, 2]);
  }, 240_000);
});
