import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newFindingsTool, prFindingsSummary, prNewFindings, runGraphCheck } from '../src/agent/graph-check.js';
import { auditDocs } from '../src/audit.js';
import { auditMarkdown, auditText } from '../src/format/audit.js';
import { checkMarkdown, NEW_FINDINGS_HEADING } from '../src/format/markdown.js';
import { checkReport } from '../src/format/report.js';
import { newFindingsText } from '../src/format/text.js';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg, INDEX_VERSION } from '../src/indexer/index.js';
import { formatGithub } from '../src/lint/format.js';
import type { Finding } from '../src/lint/types.js';
import { lintDocsTool } from '../src/mcp/server.js';
import { diffRange } from '../src/pr/changes.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { checkChangesTool } from '../src/pr/local.js';
import type { ToolContext } from '../src/tools/types.js';
import { fakePr, gitIn, testConfig, testGraph } from './helpers.js';

const brief = (fs: readonly Finding[]) => fs.map((f) => `${f.path}:${f.line} ${f.rule} ${f.subject}`);

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

/**
 * An app whose README and AGENTS.md name `npm run lint:docs` and `docs/setup.md`; the pull
 * request renames the script and moves the page, touching neither README nor AGENTS.md.
 */
async function appWithPr(): Promise<{ dir: string; base: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-prf-'));
  await put(dir, {
    'AGENTS.md': '# Agents\n\n## Checks\n\n- Run `npm run lint:docs` before you push.\n- Setup steps are in `docs/setup.md`.\n',
    'README.md': '# App\n\n## Setup\n\nRead [setup](docs/setup.md). The [old notes](docs/gone.md) are gone.\n\n## Checks\n\n```bash\nnpm run lint:docs\n```\n',
    'docs/setup.md': '# Setup\n\n## Install\n\nRun it.\n',
    'app/main.py': 'def run(x):\n    """Run it."""\n    return x\n',
    'package.json': JSON.stringify({ name: 'app', private: true, scripts: { 'lint:docs': 'staleproof lint', test: 'vitest' } }, null, 2),
  });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  const base = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', '-b', 'rename');
  await writeFile(join(dir, 'package.json'), (await readFile(join(dir, 'package.json'), 'utf8')).replace('"lint:docs"', '"docs:lint"'));
  await mkdir(join(dir, 'docs', 'guides'));
  gitIn(dir, 'mv', 'docs/setup.md', 'docs/guides/setup.md');
  gitIn(dir, 'commit', '-q', '-am', 'rename the docs script, move the setup page');
  const head = gitIn(dir, 'rev-parse', 'HEAD');
  gitIn(dir, 'checkout', '-q', 'main');
  return { dir, base, head };
}

describe('docs this pull request makes wrong (FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let ctx: ToolContext;
  let app: Awaited<ReturnType<typeof appWithPr>>;
  let home: string;
  const repo = 'acme/app';
  const pr = fakePr({ owner: 'acme', repo: 'app', fullName: repo, number: 5, url: 'https://github.com/acme/app/pull/5', state: 'open', mergedAt: null, mergeSha: null });

  beforeAll(async () => {
    app = await appWithPr();
    home = await mkdtemp(join(tmpdir(), 'staleproof-prf-home-'));
    ({ graph, done } = await testGraph('prf'));
    await indexOrg(graph, [{ repo, dir: app.dir, sha: app.base }]);
    await recordPullRequest(graph, { ...pr, baseSha: app.base, headSha: app.head }, await diffRange(app.dir, repo, app.base, app.head));
    ctx = { graph, config: testConfig({ home }), checkouts: { [repo]: app.dir } };
  });
  afterAll(async () => {
    await done();
    await rm(app.dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('stores lint findings at index time as Finding nodes in their doc sections (INDEX_VERSION 4)', async () => {
    expect(INDEX_VERSION).toBe(4);
    const rows = (
      await graph.run<{ rule: string; path: string; line: number; surface: string; section: string | null; checked: boolean; n: number }>(
        `MATCH (f:Finding {repo: $repo}) OPTIONAL MATCH (f)-[:IN_SECTION]->(d:DocSection) WITH f, d MATCH (r:Repo {name: $repo})
         RETURN f.rule AS rule, f.path AS path, f.line AS line, f.surface AS surface, d.id AS section, r.findings_checked AS checked, r.findings AS n ORDER BY path, line`,
        { repo },
      )
    ).rows;
    expect(rows.map((r) => `${r.path}:${r.line} ${r.rule} ${r.section}`)).toEqual(['README.md:5 link-broken acme/app:README.md#setup']);
    expect(rows[0]).toMatchObject({ surface: 'readme', checked: true, n: 1 });
  });

  it('runs new_findings first in the graph check and carries it to the impact step and the result', async () => {
    const events: { type: string; name?: string; data?: unknown }[] = [];
    const r = await runGraphCheck(ctx, pr.url, { maxRuns: 0, onEvent: (e) => events.push(e as never) });
    expect(r.toolOrder.slice(0, 2)).toEqual(['new_findings', 'impact']);
    expect(brief(r.newFindings!.findings)).toEqual([
      'AGENTS.md:5 command-missing npm run lint:docs',
      'AGENTS.md:6 path-missing docs/setup.md',
      'README.md:5 link-broken docs/setup.md',
      'README.md:10 command-missing npm run lint:docs',
    ]);
    expect(r.newFindings).toMatchObject({ repo, base: app.base, head: app.head, total: 4, fixed: 0, summary: { errors: 4, bySurface: { agent: 2, readme: 2 } } });
    const impact = events.find((e) => e.type === 'tool_result' && e.name === 'impact')!.data as { newFindings?: { total: number } };
    expect(impact.newFindings?.total).toBe(4);
    expect(r.summary.startsWith('This pull request makes 4 docs references wrong (4 errors, 2 in AI agent instructions): AGENTS.md:5 `npm run lint:docs`')).toBe(true);
    // Remembered per commit pair: the comment and the annotations reuse it.
    expect(await prNewFindings(ctx, pr.url)).toEqual(r.newFindings);
  });

  it('puts "Docs this pull request makes wrong" above the impact in the comment, with counts for the Action', async () => {
    const md = await checkReport(ctx, graph.name, pr.url);
    const lines = md.split('\n');
    expect(lines[1]).toBe('### Staleproof: this pull request makes 4 docs references wrong');
    const at = lines.indexOf(NEW_FINDINGS_HEADING);
    expect(at).toBeGreaterThan(0);
    expect(md.slice(md.indexOf(NEW_FINDINGS_HEADING))).toContain('**AI agent instructions**');
    expect(md.indexOf('**AI agent instructions**')).toBeLessThan(md.indexOf('**README and contributing guides**'));
    expect(md).toContain(`- [\`AGENTS.md:5\`](https://github.com/acme/app/blob/${app.head}/AGENTS.md#L5) \`lint:docs\` is not a script in package.json. <sub>command-missing</sub>`);
    expect(md).toContain('<!-- staleproof:findings new=4 errors=4 warnings=0 -->');
    expect(md).toMatch(/<!-- staleproof:counts breaks=0 predicted=0 sections=\d+ mismatched=0 -->$/);
    // Annotations: one workflow command per new finding.
    const nf = (await prNewFindings(ctx, pr.url))!;
    const gh = formatGithub({ version: 1, findings: nf.findings, summary: nf.summary, warnings: [] }).split('\n');
    expect(gh).toHaveLength(4);
    expect(gh[0]).toMatch(/^::error file=AGENTS\.md,line=5,col=\d+,endLine=5,endColumn=\d+,title=Staleproof command-missing::/);
    expect(newFindingsText(nf)).toContain('Docs this pull request makes wrong (4)');
    expect(prFindingsSummary({ ...nf, total: 0, findings: [], fixed: 1 })).toBe(`No docs reference that was true at ${app.base.slice(0, 7)} is wrong at ${app.head.slice(0, 7)} (${nf.files} files checked; 1 fixed).`);
  });

  it('a check without real commits skips it, and the comment stays as before', async () => {
    const other = fakePr({ owner: 'acme', repo: 'app', fullName: repo, number: 6, url: 'https://github.com/acme/app/pull/6' });
    await recordPullRequest(graph, other, { before: 'b', after: 'a', files: [], docsTouched: [], symbols: [] });
    const r = await runGraphCheck(ctx, other.url, { maxRuns: 0 });
    expect(r.toolOrder[0]).toBe('impact');
    expect(r.newFindings).toBeUndefined();
    await expect(newFindingsTool().run(ctx, { pr_url: other.url })).rejects.toThrow(/no commits recorded/);
    const md = await checkReport(ctx, graph.name, other.url);
    expect(md).not.toContain('staleproof:findings');
    expect(md).not.toContain(NEW_FINDINGS_HEADING);
    // Lint ran and found nothing new: one line in the footer, no section.
    const nf = (await prNewFindings(ctx, pr.url))!;
    const clean = checkMarkdown({
      impact: { pr: { url: pr.url, title: 't', repo, state: 'open', before: app.base, after: app.head, docsTouched: [] }, changed: [], sections: [], totalSections: 0, offset: 0, truncated: false, counts: { breaking: 0, api: 0, behavior: 0 }, predicted: [], mismatched: [] },
      summary: 's',
      cleared: [],
      org: 'o',
      newFindings: { ...nf, findings: [], total: 0, summary: { ...nf.summary, errors: 0, bySurface: {}, byRule: {} } },
    });
    expect(clean.split('\n')[1]).toBe('### Staleproof: no docs reach the code this pull request changed');
    expect(clean).toContain(`· docs references: none made wrong (${nf.files} files checked)</sub>`);
    expect(clean).toContain('<!-- staleproof:findings new=0 errors=0 warnings=0 -->');
  });

  it('audit lists the stored findings agent first and deducts "Docs references" (3 per error, 1 per warning, at most 25)', async () => {
    await indexOrg(graph, [{ repo, dir: app.dir, sha: app.base }]);
    gitIn(app.dir, 'checkout', '-q', 'rename');
    try {
      // Re-indexed at the pull request's head: the old Finding nodes are replaced.
      await indexOrg(graph, [{ repo, dir: app.dir, sha: app.head }]);
    } finally {
      gitIn(app.dir, 'checkout', '-q', 'main');
    }
    const r = await auditDocs(ctx, { repos: [repo] });
    expect(brief(r.data.findings!)).toEqual([
      'AGENTS.md:5 command-missing npm run lint:docs',
      'AGENTS.md:6 path-missing docs/setup.md',
      'README.md:5 link-broken docs/setup.md',
      'README.md:5 link-broken docs/gone.md',
      'README.md:10 command-missing npm run lint:docs',
    ]);
    expect(r.data.findings![0]).toMatchObject({ surface: 'agent', evidence: { looked: expect.any(String) } });
    // README sections are indexed (AGENTS.md is not docs to the indexer): the finding names its section.
    expect(r.data.findings![2]).toMatchObject({ surface: 'readme', heading: 'App > Setup' });
    expect(r.data.findingCounts).toMatchObject({ errors: 5, warnings: 0, bySurface: { agent: 2, readme: 3 } });
    expect(r.data.deductions.find((d) => d.why.startsWith('Docs references'))).toEqual({
      points: 15,
      why: 'Docs references: 5 errors where the docs or AI agent files name a path, link, command or setting the repository does not have (3 per error, 1 per warning, at most 25)',
    });
    expect(r.summary).toContain('5 docs references in 2 files no longer match the repository (2 in AI agent instructions).');
    const text = auditText(r.data, r.summary);
    expect(text.indexOf('AI agent instructions')).toBeLessThan(text.indexOf('README and contributing guides'));
    const md = auditMarkdown(r.data, r.summary);
    expect(md).toContain('#### Docs references that no longer match the repository (5)');
    expect(md).toContain(`| [AGENTS.md:5](https://github.com/acme/app/blob/${app.head}/AGENTS.md#L5) |`);
    expect(md).toContain('<!-- staleproof:audit-findings findings=5 errors=5 warnings=0 -->');
    expect(md).toMatch(/<!-- staleproof:audit score=\d+ mismatched=0 failing=0 coverage=[\d.]+ -->$/);
  });

  it('check_changes: edited files and a working tree report the references they make wrong', async () => {
    const edited = await checkChangesTool.run(ctx, { repo, base: app.base, files: [{ path: 'docs/setup.md', content: null }] });
    expect(brief(edited.data.newFindings!.findings)).toEqual(['AGENTS.md:6 path-missing docs/setup.md', 'README.md:5 link-broken docs/setup.md']);
    expect(edited.data.newFindings!.head).toBe('WORKTREE');
    expect(edited.summary).toContain('These changes make 2 docs references wrong (2 errors, 1 in AI agent instructions)');

    const readme = await readFile(join(app.dir, 'README.md'), 'utf8');
    try {
      await writeFile(join(app.dir, 'README.md'), `${readme}\nSee [the FAQ](docs/faq.md).\n`);
      const local = await checkChangesTool.run({ ...ctx, allowDir: true }, { dir: app.dir, repo, base: app.base });
      expect(brief(local.data.newFindings!.findings)).toEqual(['README.md:13 link-broken docs/faq.md']);
    } finally {
      await writeFile(join(app.dir, 'README.md'), readme);
    }
  });

  it('lint_docs (MCP): a repository by name from its tarball, or a local checkout with new_only', async () => {
    const archive = (sha: string) => execFileSync('git', ['archive', '--format=tar.gz', `--prefix=app-${sha}/`, sha], { cwd: app.dir });
    const fetchImpl = (async (input: string | URL | Request) => {
      const m = /codeload\.github\.com\/acme\/app\/tar\.gz\/(.+)$/.exec(String(input));
      return m ? new Response(new Uint8Array(archive(m[1] === 'HEAD' ? app.head : m[1]!))) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
    const byName = await lintDocsTool.run({ ...ctx, fetchImpl } as ToolContext, { repo, rules: ['link-broken', 'command-missing'] });
    expect(brief(byName.data.findings)).toEqual([
      'AGENTS.md:5 command-missing npm run lint:docs',
      'README.md:5 link-broken docs/setup.md',
      'README.md:5 link-broken docs/gone.md',
      'README.md:10 command-missing npm run lint:docs',
    ]);
    expect(byName.summary.split('\n')[0]).toMatch(/^4 errors in 2 files/);
    await expect(lintDocsTool.run(ctx, { dir: app.dir })).rejects.toThrow(/cannot read your disk/);
    await expect(lintDocsTool.run(ctx, { repo, rules: ['nope'] })).rejects.toThrow(/unknown rule nope/);
    const local = await lintDocsTool.run({ ...ctx, allowDir: true }, { dir: app.dir, new_only: true, base: 'HEAD' });
    expect(local.data.findings).toEqual([]);
  });
});
