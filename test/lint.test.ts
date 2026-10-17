import { cp, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../src/indexer/repo-config.js';
import { pathInSpan } from '../src/lint/check-paths.js';
import { lintRepo } from '../src/lint/engine.js';
import { lintTargets } from '../src/lint/files.js';
import { formatGithub, formatLint, formatMarkdown, formatSarif, lintExitCode } from '../src/lint/format.js';
import { RULES } from '../src/lint/rules.js';
import { scanClaims } from '../src/lint/scan.js';
import type { LintResult } from '../src/lint/types.js';
import { FIXTURE_REPOS, FIXTURES, gitIn, STALE_DOCS } from './helpers.js';

/** The claims fixture as a git repository with history: one file renamed, one deleted. */
async function claimsRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-claims-'));
  await cp(join(FIXTURES, 'claims'), dir, { recursive: true });
  await rename(join(dir, 'gitignore.txt'), join(dir, '.gitignore'));
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  gitIn(dir, 'mv', 'src/util/old.ts', 'src/helpers/old.ts');
  gitIn(dir, 'rm', '-q', 'lib/removed.ts');
  gitIn(dir, 'commit', '-q', '-m', 'move helpers, drop lib');
  return dir;
}

const brief = (r: LintResult) => r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.subject} | ${f.message}`);

describe('staleproof lint (claims engine)', () => {
  let dir: string;
  let result: LintResult;

  beforeAll(async () => {
    dir = await claimsRepo();
    result = await lintRepo({ dir, repo: 'acme/claims-demo' });
  });

  it('reports every stale claim, agent instruction files first, and nothing else', () => {
    const deletedIn = gitIn(dir, 'rev-parse', '--short=7', 'HEAD');
    expect(brief(result).map((l) => l.replace(new RegExp(`deleted in ${deletedIn}\\w*`), 'deleted in <sha>'))).toEqual([
      '.cursor/rules/style.mdc:5:22 path-missing src/missing-style.ts | `src/missing-style.ts` does not exist in the repository.',
      'AGENTS.md:4:21 path-missing src/settings.ts | `src/settings.ts` does not exist in the repository.',
      'AGENTS.md:5:26 path-missing src/util/old.ts | `src/util/old.ts` does not exist; it moved to `src/helpers/old.ts`.',
      'AGENTS.md:6:29 line-out-of-range src/app.ts:999 | `src/app.ts` has 4 lines; line 999 does not exist.',
      'AGENTS.md:7:85 link-broken docs/old-guide.md | The link target `docs/old-guide.md` does not exist.',
      'README.md:3:62 link-broken docs/roadmap.md | The link target `docs/roadmap.md` does not exist.',
      'README.md:7:1 example-unknown-keyword claims_demo.connect | `connect` has no parameter `timeout`.',
      'docs/guide.md:5:52 anchor-missing #configuration | This page has no heading `#configuration`.',
      'docs/guide.md:7:70 path-missing lib/removed.ts | `lib/removed.ts` does not exist; it was deleted in <sha>.',
      'docs/guide.md:9:56 anchor-missing docs/setup.md#legacy-usage | `docs/setup.md` has no heading `#legacy-usage`.',
    ]);
    expect(result.findings.map((f) => f.surface)).toEqual(['agent', 'agent', 'agent', 'agent', 'agent', 'readme', 'example', 'docs', 'docs', 'docs']);
    expect(result.summary).toMatchObject({ errors: 7, warnings: 3, infos: 0, files: 6 });
    expect(result.version).toBe(1);
  });

  it('locates each finding on the exact text it is about', async () => {
    const agents = (await readFile(join(dir, 'AGENTS.md'), 'utf8')).split('\n');
    for (const f of result.findings.filter((x) => x.path === 'AGENTS.md')) {
      const text = agents[f.line - 1]!.slice(f.column - 1, f.endColumn - 1);
      expect(f.subject.startsWith(text) || text.startsWith(f.subject.replace(/:\d+$/, ''))).toBe(true);
    }
    const ex = result.findings.find((f) => f.rule === 'example-unknown-keyword')!;
    expect(ex.evidence?.url).toMatch(/^https:\/\/github\.com\/acme\/claims-demo\/blob\/[0-9a-f]{40}\/README\.md#L7$/);
  });

  it('never reports paths that are ignored, generated, created by the sentence, suppressed, slugs or MIME types', () => {
    const subjects = result.findings.map((f) => f.subject);
    for (const s of ['src/ghost.ts', 'dist/app.js', 'src/report.json', 'src/cache/today.json', 'acme/claims-demo', 'text/plain', 'docs/other/page.md', 'src/zzz.ts']) {
      expect(subjects).not.toContain(s);
    }
  });

  it('keeps fingerprints when lines are added above a finding', async () => {
    const copy = await claimsRepo();
    const agents = join(copy, 'AGENTS.md');
    await writeFile(agents, `<!-- a note -->\n\nSome new intro.\n\n${await readFile(agents, 'utf8')}`);
    const again = await lintRepo({ dir: copy, repo: 'acme/claims-demo' });
    const fp = (r: LintResult) => r.findings.filter((f) => f.path === 'AGENTS.md').map((f) => f.fingerprint);
    expect(fp(again)).toEqual(fp(result));
    expect(again.findings.find((f) => f.subject === 'src/settings.ts')!.line).toBe(8);
  });

  it('filters by rule, by file, and honours [rules] severities from the config', async () => {
    const only = await lintRepo({ dir, repo: 'acme/claims-demo', rules: ['anchor-missing'] });
    expect(only.findings.map((f) => f.rule)).toEqual(['anchor-missing', 'anchor-missing']);
    const files = await lintRepo({ dir, repo: 'acme/claims-demo', files: ['README.md'], examples: false });
    expect(files.findings.map((f) => f.path)).toEqual(['README.md']);
    const config = parseRepoConfig('[rules]\n"path-missing" = "off"\n"anchor-missing" = "error"\n', '.staleproof.toml');
    const tuned = await lintRepo({ dir, repo: 'acme/claims-demo', config, examples: false });
    expect(tuned.findings.some((f) => f.rule === 'path-missing')).toBe(false);
    expect(tuned.findings.filter((f) => f.rule === 'anchor-missing').map((f) => f.severity)).toEqual(['error', 'error']);
  });

  it('runs the static example checks in memory, against code in other checkouts', async () => {
    const r = await lintRepo({ dir: STALE_DOCS.dir, repo: STALE_DOCS.repo, with: FIXTURE_REPOS.slice(0, 2).map((c) => c.dir) });
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.rule} | ${f.message}`)).toEqual([
      'docs/stale.md:8 example-missing-import | `miniclient` has no `connect`.',
      'docs/stale.md:10 example-unknown-keyword | `Client` has no parameter `hostname`.',
      'docs/stale.md:19 example-too-many-arguments | `Graph.query` takes at most 2 positional arguments; the example passes 3.',
      'docs/stale.md:20 example-missing-attribute | `Graph` has no attribute `read_only`.',
      'docs/stale.md:31 example-unknown-keyword | `Rag.ask` has no parameter `top_k`.',
    ]);
    const none = await lintRepo({ dir: STALE_DOCS.dir, repo: STALE_DOCS.repo, examples: false });
    expect(none.findings).toEqual([]);
  });

  it('formats findings as text, JSON, SARIF, GitHub annotations and Markdown, with exit codes', () => {
    const text = formatLint(result, 'text');
    expect(text.indexOf('AI agent instructions')).toBeLessThan(text.indexOf('README and contributing guides'));
    expect(text).toContain('7 errors, 3 warnings in 4 files (6 files checked');
    const json = JSON.parse(formatLint(result, 'json'));
    expect(json).toMatchObject({ version: 1, tool: { name: 'staleproof' }, repo: 'acme/claims-demo' });
    const sarif = JSON.parse(formatSarif(result));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results).toHaveLength(10);
    expect(sarif.runs[0].results[0]).toMatchObject({
      ruleId: 'path-missing',
      level: 'error',
      locations: [{ physicalLocation: { artifactLocation: { uri: '.cursor/rules/style.mdc' }, region: { startLine: 5, startColumn: 22 } } }],
    });
    expect(sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)).toEqual(['path-missing', 'line-out-of-range', 'link-broken', 'anchor-missing', 'example-unknown-keyword']);
    const gh = formatGithub(result).split('\n');
    expect(gh[0]).toBe('::error file=.cursor/rules/style.mdc,line=5,col=22,endLine=5,endColumn=42,title=Staleproof path-missing::`src/missing-style.ts` does not exist in the repository.');
    expect(gh.some((l) => l.startsWith('::warning file=docs/guide.md,line=5'))).toBe(true);
    const md = formatMarkdown(result);
    expect(md.split('\n')[0]).toBe('**AI agent instructions**');
    expect(md).toContain('[`README.md:7`](https://github.com/acme/claims-demo/blob/');
    expect(lintExitCode(result, 'error')).toBe(1);
    expect(lintExitCode({ ...result, findings: result.findings.filter((f) => f.severity === 'warning') }, 'error')).toBe(0);
    expect(lintExitCode({ ...result, findings: result.findings.filter((f) => f.severity === 'warning') }, 'warning')).toBe(1);
    expect(lintExitCode(result, 'never')).toBe(0);
  });
});

describe('lint building blocks', () => {
  it('reads paths out of code spans, and nothing that is not one', () => {
    expect(pathInSpan('src/cli.ts')).toEqual({ path: 'src/cli.ts' });
    expect(pathInSpan('src/cli.ts:42')).toEqual({ path: 'src/cli.ts', line: 42 });
    expect(pathInSpan('src/cli.ts#L10-L20')).toEqual({ path: 'src/cli.ts', line: 10 });
    expect(pathInSpan('./scripts/test')).toEqual({ path: './scripts/test' });
    expect(pathInSpan('docs/')).toEqual({ path: 'docs/' });
    for (const no of ['https://x.dev/a/b', '/api/health', '~/x/y', 'npm run x/y', 'path/to/<file>', 'src/*.ts', '{dir}/x', '@scope/pkg', 'README.md', 'a/b(c)', '1.2/3', '$HOME/x', 'owner/repo#12']) {
      expect(pathInSpan(no)).toBeUndefined();
    }
  });

  it('scans spans, links and fences with exact columns, and skips comments, code and front matter', () => {
    const doc = scanClaims('a.md', '---\ntitle: `x/y.ts`\n---\nSee `src/a.ts` and [b](docs/b.md#c "t").\n<!-- `src/hidden.ts` -->\n```bash\nls `src/in-fence.ts`\n```\n`[not](link.md)`\n[ref]: docs/ref.md\n<a href="docs/h.md">h</a>\n');
    expect(doc.spans.map((s) => [s.text, s.line, s.column, s.endColumn])).toEqual([
      ['src/a.ts', 4, 6, 14],
      ['[not](link.md)', 9, 2, 16],
    ]);
    expect(doc.links.map((l) => [l.text, l.line, l.column, l.kind])).toEqual([
      ['docs/b.md#c', 4, 24, 'inline'],
      ['docs/ref.md', 10, 8, 'reference'],
      ['docs/h.md', 11, 10, 'html'],
    ]);
    expect(doc.fences).toEqual([{ lang: 'bash', line: 6, lines: [{ text: 'ls `src/in-fence.ts`', line: 7 }] }]);
  });

  it('reads suppression comments for the same line, the next line, and the whole file', () => {
    const doc = scanClaims('a.md', 'x `a/b` <!-- staleproof: ignore path-missing -->\n<!-- staleproof: ignore -->\n\nnext `c/d`\n{/* staleproof: ignore link-broken */}\ny\n');
    expect([...doc.suppress.lines].map(([l, s]) => [l, [...s]])).toEqual([
      [1, ['path-missing']],
      [4, ['*']],
      [6, ['link-broken']],
    ]);
    expect(scanClaims('b.md', '<!-- staleproof: ignore-file -->\n').suppress.file).toBe(true);
    expect(scanClaims('c.rst', '.. staleproof: ignore\n\nSee ``src/x.py``.\n').suppress.lines.get(3)).toEqual(new Set(['*']));
  });

  it('chooses the docs, READMEs and agent files to check, agent files first, never translations, fixtures or changelogs', () => {
    const t = lintTargets([
      'README.md',
      'CHANGELOG.md',
      'docs/guide.md',
      'docs/zh/guide.md',
      'packages/x/AGENTS.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/a.mdc',
      '.claude/skills/x/SKILL.md',
      'test/fixtures/claims/AGENTS.md',
      'node_modules/y/README.md',
      'src/a.ts',
      'CONTRIBUTING.md',
    ]);
    expect(t).toEqual([
      { path: '.claude/skills/x/SKILL.md', surface: 'agent' },
      { path: '.cursor/rules/a.mdc', surface: 'agent' },
      { path: '.github/copilot-instructions.md', surface: 'agent' },
      { path: 'packages/x/AGENTS.md', surface: 'agent' },
      { path: 'CONTRIBUTING.md', surface: 'readme' },
      { path: 'README.md', surface: 'readme' },
      { path: 'docs/guide.md', surface: 'docs' },
    ]);
    const cfg = parseRepoConfig('[lint]\nexclude = ["docs/**"]\nagent-files = ["prompts/*.md"]\n', '.staleproof.toml');
    expect(lintTargets(['docs/a.md', 'prompts/p.md'], cfg)).toEqual([{ path: 'prompts/p.md', surface: 'agent' }]);
  });

  it('parses the new config tables, and warns (never fails) on unknown keys and bad values', () => {
    const c = parseRepoConfig(
      [
        'ignore = ["vendor/**"]',
        'colour = "blue"',
        '[lint]',
        'exclude = ["docs/archive/**"]',
        'agent-files = ["prompts/*.md"]',
        'typo = 1',
        '[rules]',
        '"env-undocumented" = "off"',
        '"path-missing" = "loud"',
        '[hooks]',
        'stop = "warn"',
        '[app]',
        'comment = "findings"',
        'fail-on = "sometimes"',
        'fix-prs = true',
        'also-index = ["acme/docs"]',
        '[audit]',
        'mention-owners = true',
      ].join('\n'),
      '.staleproof.toml',
    );
    expect(c).toEqual({
      ignore: ['vendor/**'],
      skipExamples: [],
      lint: { include: [], exclude: ['docs/archive/**'], agentFiles: ['prompts/*.md'] },
      rules: { 'env-undocumented': 'off' },
      hooks: { stop: 'warn' },
      app: { comment: 'findings', fixPrs: true, alsoIndex: ['acme/docs'] },
      audit: { mentionOwners: true },
      warnings: [
        '.staleproof.toml: unknown key colour; ignored',
        '.staleproof.toml: unknown key lint.typo; ignored',
        '.staleproof.toml: rules.path-missing must be "off" | "info" | "warning" | "error"; ignored',
        '.staleproof.toml: app.fail-on must be "never" | "findings" | "predicted"; ignored',
      ],
    });
  });

  it('documents every rule once, with an example and a reason', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect(r.summary.endsWith('.')).toBe(true);
      expect(r.why.length).toBeGreaterThan(20);
      expect(r.example.message.length).toBeGreaterThan(5);
    }
  });
});
