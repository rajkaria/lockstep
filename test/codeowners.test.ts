import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditData } from '../src/audit.js';
import {
  affectedDocPaths,
  affectedOwnersMarkdown,
  auditOwnersMarkdown,
  compilePattern,
  githubReader,
  groupByOwner,
  insertBeforeFooter,
  loadCodeowners,
  mentionOwners,
  ownerLabel,
  ownersForAudit,
  ownersForCheck,
  ownersOf,
  parseCodeowners,
  readRepoConfig,
} from '../src/codeowners.js';
import { FIXTURES } from './helpers.js';

/**
 * The example CODEOWNERS file from GitHub's docs ("About code owners", github/docs, CC BY 4.0),
 * copied verbatim into the fixture. Each block's comment there says what it owns.
 */
const GITHUB_EXAMPLE = readFileSync(join(FIXTURES, 'codeowners', 'github-docs-example'), 'utf8');

/** One block of GitHub's example as its own file. */
const owners = (file: string, path: string) => ownersOf(parseCodeowners(file), path);

describe('CODEOWNERS: GitHub\'s documented examples, one block at a time', () => {
  it('* makes default owners for everything in the repo', () => {
    const file = '*       @global-owner1 @global-owner2';
    expect(owners(file, 'README.md')).toEqual(['@global-owner1', '@global-owner2']);
    expect(owners(file, 'deeply/nested/file.py')).toEqual(['@global-owner1', '@global-owner2']);
  });

  it('a later *.js line takes precedence for JS files only; the inline comment is not an owner', () => {
    const file = '*       @global-owner1 @global-owner2\n*.js    @js-owner #This is an inline comment.';
    expect(owners(file, 'src/app.js')).toEqual(['@js-owner']);
    expect(owners(file, 'app.js')).toEqual(['@js-owner']);
    expect(owners(file, 'src/app.ts')).toEqual(['@global-owner1', '@global-owner2']);
  });

  it('email addresses are owners', () => {
    expect(owners('*.go docs@example.com', 'cmd/server/main.go')).toEqual(['docs@example.com']);
  });

  it('teams are owners: @octo-org/octocats owns all .txt files', () => {
    expect(owners('*.txt @octo-org/octocats', 'notes/todo.txt')).toEqual(['@octo-org/octocats']);
    expect(owners('*.txt @octo-org/octocats', 'notes/todo.md')).toEqual([]);
  });

  it('/build/logs/ owns that root directory and its subdirectories', () => {
    const file = '/build/logs/ @doctocat';
    expect(owners(file, 'build/logs/app.log')).toEqual(['@doctocat']);
    expect(owners(file, 'build/logs/2026/10/app.log')).toEqual(['@doctocat']);
    expect(owners(file, 'src/build/logs/app.log')).toEqual([]);
    expect(owners(file, 'build/logs')).toEqual([]);
  });

  it('docs/* matches docs/getting-started.md but not docs/build-app/troubleshooting.md', () => {
    const file = 'docs/* docs@example.com';
    expect(owners(file, 'docs/getting-started.md')).toEqual(['docs@example.com']);
    expect(owners(file, 'docs/build-app/troubleshooting.md')).toEqual([]);
  });

  it('apps/ owns any file in an apps directory anywhere', () => {
    const file = 'apps/ @octocat';
    expect(owners(file, 'apps/web/index.ts')).toEqual(['@octocat']);
    expect(owners(file, 'services/apps/worker.py')).toEqual(['@octocat']);
    expect(owners(file, 'apps.md')).toEqual([]);
  });

  it('/docs/ owns the root docs directory and its subdirectories', () => {
    const file = '/docs/ @doctocat';
    expect(owners(file, 'docs/getting-started.md')).toEqual(['@doctocat']);
    expect(owners(file, 'docs/build-app/troubleshooting.md')).toEqual(['@doctocat']);
    expect(owners(file, 'packages/x/docs/readme.md')).toEqual([]);
  });

  it('/scripts/ with two owners: either may approve', () => {
    expect(owners('/scripts/ @doctocat @octocat', 'scripts/release/tag.sh')).toEqual(['@doctocat', '@octocat']);
  });

  it('**/logs owns /build/logs, /scripts/logs and /deeply/nested/logs', () => {
    const file = '**/logs @octocat';
    for (const p of ['build/logs/a.log', 'scripts/logs/a.log', 'deeply/nested/logs/a.log', 'logs/a.log']) expect(owners(file, p)).toEqual(['@octocat']);
    expect(owners(file, 'build/logs.txt')).toEqual([]);
  });

  it('/apps/github with no owners leaves that subdirectory unowned', () => {
    const file = '/apps/ @octocat\n/apps/github';
    expect(owners(file, 'apps/web/index.ts')).toEqual(['@octocat']);
    expect(owners(file, 'apps/github/workflow.yml')).toEqual([]);
  });

  it('/apps/github @doctocat gives that subdirectory its own owner', () => {
    const file = '/apps/ @octocat\n/apps/github @doctocat';
    expect(owners(file, 'apps/web/index.ts')).toEqual(['@octocat']);
    expect(owners(file, 'apps/github/workflow.yml')).toEqual(['@doctocat']);
  });
});

describe('CODEOWNERS: GitHub\'s whole example file, last match wins', () => {
  const co = parseCodeowners(GITHUB_EXAMPLE, '.github/CODEOWNERS');

  it('parses every pattern line and nothing else', () => {
    expect(co.errors).toEqual([]);
    expect(co.rules.map((r) => r.pattern)).toEqual([
      '*',
      '*.js',
      '*.go',
      '*.txt',
      '/build/logs/',
      'docs/*',
      'apps/',
      '/docs/',
      '/scripts/',
      '**/logs',
      '/apps/',
      '/apps/github',
      '/apps/',
      '/apps/github',
    ]);
    expect(co.rules.find((r) => r.pattern === '/apps/github')!.owners).toEqual([]);
  });

  it.each([
    ['README.md', ['@global-owner1', '@global-owner2']],
    ['src/index.js', ['@js-owner']],
    ['cmd/main.go', ['docs@example.com']],
    ['notes.txt', ['@octo-org/octocats']],
    // /build/logs/ says @doctocat, and the later **/logs says @octocat: the later line wins.
    ['build/logs/app.log', ['@octocat']],
    // docs/* names docs@example.com, the later /docs/ names @doctocat.
    ['docs/getting-started.md', ['@doctocat']],
    ['docs/build-app/troubleshooting.md', ['@doctocat']],
    ['apps/github/main.go', ['@doctocat']],
    ['apps/web/app.js', ['@octocat']],
    ['scripts/deploy.sh', ['@doctocat', '@octocat']],
    ['scripts/logs/x.txt', ['@octocat']],
    ['lib/apps/helper.py', ['@octocat']],
    // Paths are case sensitive.
    ['Docs/readme.md', ['@global-owner1', '@global-owner2']],
  ])('%s → %j', (path, expected) => {
    expect(ownersOf(co, path)).toEqual(expected);
  });
});

describe('CODEOWNERS: what GitHub does not support, and edge cases', () => {
  it('skips invalid lines, as GitHub does', () => {
    const co = parseCodeowners(['\\#hash.md @a', '!*.md @a', '*.md not-an-owner', '*.py @ok', '   ', '# comment'].join('\n'));
    expect(co.rules.map((r) => r.pattern)).toEqual(['*.py']);
    expect(co.errors).toEqual([
      'line 1: a pattern cannot start with an escaped #',
      'line 2: negated patterns (!) are not supported',
      'line 3: not-an-owner is not a user, team or email',
    ]);
  });

  it('treats [ ] literally (no character ranges)', () => {
    const co = parseCodeowners('[abc].md @a');
    expect(ownersOf(co, 'a.md')).toEqual([]);
    expect(ownersOf(co, '[abc].md')).toEqual(['@a']);
  });

  it('reads escaped spaces, CRLF line endings, ? and middle **', () => {
    const co = parseCodeowners('My\\ Docs/ @a\r\n/docs/v?/ @b\r\n/src/**/README.md @c\r\n');
    expect(ownersOf(co, 'My Docs/intro.md')).toEqual(['@a']);
    expect(ownersOf(co, 'docs/v2/intro.md')).toEqual(['@b']);
    expect(ownersOf(co, 'docs/v10/intro.md')).toEqual([]);
    expect(ownersOf(co, 'src/README.md')).toEqual(['@c']);
    expect(ownersOf(co, 'src/a/b/README.md')).toEqual(['@c']);
  });

  it('a file of 3 MB or more is not loaded', () => {
    const co = parseCodeowners(`* @a\n${'#'.repeat(3 * 1024 * 1024)}`);
    expect(co.rules).toEqual([]);
    expect(co.errors[0]).toMatch(/3 MB/);
  });

  it('compiles a lone slash or ** to match everything', () => {
    expect(compilePattern('/')('a/b.md')).toBe(true);
    expect(compilePattern('**')('a/b.md')).toBe(true);
  });

  it('uses the first of .github/, the root and docs/, in GitHub\'s order', async () => {
    const files: Record<string, string> = { CODEOWNERS: '* @root', 'docs/CODEOWNERS': '* @docs', '.github/CODEOWNERS': '* @github' };
    expect((await loadCodeowners(async (p) => files[p]))!.path).toBe('.github/CODEOWNERS');
    delete files['.github/CODEOWNERS'];
    expect((await loadCodeowners(async (p) => files[p]))!.path).toBe('CODEOWNERS');
    delete files.CODEOWNERS;
    expect(ownersOf(await loadCodeowners(async (p) => files[p]), 'x.md')).toEqual(['@docs']);
    expect(await loadCodeowners(async () => undefined)).toBeUndefined();
  });

  it('reads from GitHub: raw for public repositories, the API with a token', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.includes('.github/CODEOWNERS') ? new Response('docs/ @acme/docs') : new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const co = await loadCodeowners(githubReader('acme/app', 'main', { fetchImpl }));
    expect(ownersOf(co, 'docs/a.md')).toEqual(['@acme/docs']);
    expect(urls[0]).toBe('https://raw.githubusercontent.com/acme/app/main/.github/CODEOWNERS');
    await loadCodeowners(githubReader('acme/app', 'main', { fetchImpl, token: 't' }));
    expect(urls.at(-1)).toBe('https://api.github.com/repos/acme/app/contents/.github/CODEOWNERS?ref=main');
  });
});

describe('owners in reports', () => {
  const co = parseCodeowners('* @acme/maintainers\ndocs/ @acme/docs\nAGENTS.md @alice\n/docs/internal/', '.github/CODEOWNERS');
  const coFor = (repo: string) => (repo === 'acme/app' ? co : undefined);

  it('plain text by default, mentions with [audit] mention-owners = true', () => {
    expect(ownerLabel('@acme/docs', false)).toBe('`@acme/docs`');
    expect(ownerLabel('@acme/docs', true)).toBe('@acme/docs');
    expect(mentionOwners(undefined)).toBe(false);
    expect(mentionOwners({ ignore: [], skipExamples: [], audit: { mentionOwners: true } })).toBe(true);
  });

  it('groups items by owner, most items first, unowned last, an item in each of its owners\' groups', () => {
    const groups = groupByOwner(['a', 'b', 'c', 'd'], (x) => ({ a: ['@x'], b: ['@x', '@y'], c: [], d: ['@y'] })[x]!);
    expect(groups).toEqual([
      { owner: '@x', items: ['a', 'b'] },
      { owner: '@y', items: ['b', 'd'] },
      { owner: null, items: ['c'] },
    ]);
  });

  const audit = {
    org: 'acme',
    repos: [{ name: 'acme/app', sha: 'abc1234', symbols: 1, sections: 1 }],
    score: 80,
    grade: 'B',
    deductions: [],
    examples: { total: 1, python: 1, linked: 1, mismatched: 1 },
    mismatches: [
      { example: 'acme/app:docs/api.md:0', url: 'https://github.com/acme/app/blob/abc/docs/api.md#L9', repo: 'acme/app', path: 'docs/api.md', heading: 'API', line: 9, kind: 'unknown-keyword', detail: '`connect` has no parameter `tls`', call: 'connect', symbol: 'app.connect' },
    ],
    coverage: { api: 1, documented: 1, percent: 100 },
    undocumented: [],
    runs: [{ example: 'acme/app:docs/internal/run.md:0', url: 'https://github.com/acme/app/blob/abc/docs/internal/run.md#L3', status: 'fail', error: 'TypeError: boom', reason: '' }],
    runCounts: { pass: 0, fail: 1, skipped: 0, error: 0 },
    findings: [
      { rule: 'path-missing', severity: 'error', message: '`src/old.ts` does not exist.', repo: 'acme/app', path: 'AGENTS.md', line: 4, column: 1, endLine: 4, endColumn: 11, surface: 'agent', subject: 'src/old.ts', fingerprint: 'f1', evidence: { looked: 'files', url: 'https://github.com/acme/app/blob/abc/AGENTS.md#L4' } },
      { rule: 'command-missing', severity: 'error', message: '`npm run docs` is not a script in package.json.', repo: 'acme/app', path: 'README.md', line: 7, column: 1, endLine: 7, endColumn: 13, surface: 'readme', subject: 'npm run docs', fingerprint: 'f2' },
    ],
    generatedAt: 0,
  } as unknown as AuditData;

  it('the audit issue lists each owner\'s docs to fix', () => {
    expect(auditOwnersMarkdown(audit, coFor)).toBe(
      [
        '#### Docs to fix, by owner',
        '',
        "Owners from `.github/CODEOWNERS` (GitHub's rules: the last matching pattern wins).",
        '',
        '**`@acme/docs`** (1)',
        '',
        '- [docs/api.md:9](https://github.com/acme/app/blob/abc/docs/api.md#L9): Example: `connect` has no parameter `tls`',
        '',
        '**`@acme/maintainers`** (1)',
        '',
        '- `README.md:7`: `npm run docs` is not a script in package.json.',
        '',
        '**`@alice`** (1)',
        '',
        '- [AGENTS.md:4](https://github.com/acme/app/blob/abc/AGENTS.md#L4): `src/old.ts` does not exist.',
        '',
        '**No owner in CODEOWNERS** (1)',
        '',
        '- [docs/internal/run.md](https://github.com/acme/app/blob/abc/docs/internal/run.md#L3): Example fails when run: TypeError: boom',
      ].join('\n'),
    );
    expect(auditOwnersMarkdown(audit, coFor, { mention: true })).toContain('**@acme/docs** (1)');
    expect(auditOwnersMarkdown(audit, () => undefined)).toBe('');
  });

  it('the PR comment names the owners of the affected docs', () => {
    const paths = affectedDocPaths({
      newFindings: { repo: 'acme/app', findings: [{ path: 'README.md' }, { repo: 'acme/app', path: 'AGENTS.md' }] },
      impact: { sections: [{ repo: 'acme/app', path: 'docs/a.md' }, { repo: 'acme/app', path: 'docs/a.md' }], predicted: [{ repo: 'acme/app', path: 'docs/b.md' }] },
    });
    expect(paths).toHaveLength(4);
    expect(affectedOwnersMarkdown(paths, coFor)).toBe(
      '**Owners of affected docs:** `@acme/docs` (`docs/a.md`, `docs/b.md`) · `@acme/maintainers` (`README.md`) · `@alice` (`AGENTS.md`)',
    );
    expect(affectedOwnersMarkdown([{ repo: 'acme/app', path: 'docs/internal/x.md' }], coFor)).toBe('');
    expect(affectedOwnersMarkdown(paths, coFor, { mention: true, maxPaths: 1 })).toContain('@acme/docs (`docs/a.md`, +1 more)');
  });

  it('goes above the report footer', () => {
    const report = ['<!-- staleproof-audit -->', '### Audit', '', 'body', '', '<sub>[Staleproof](x) · graph</sub>', '<!-- staleproof:audit score=1 -->'].join('\n');
    expect(insertBeforeFooter(report, 'OWNERS')).toBe(
      ['<!-- staleproof-audit -->', '### Audit', '', 'body', '', 'OWNERS', '', '<sub>[Staleproof](x) · graph</sub>', '<!-- staleproof:audit score=1 -->'].join('\n'),
    );
    expect(insertBeforeFooter('no footer', 'OWNERS')).toBe('no footer\n\nOWNERS\n');
    expect(insertBeforeFooter(report, '')).toBe(report);
  });
});

describe('owners from a clone or from GitHub', () => {
  let home: string;
  let base: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'staleproof-owners-'));
    const dir = join(home, 'repos', 'acme', 'app');
    mkdirSync(join(dir, '.github'), { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @acme/maintainers\ndocs/ @acme/docs\n');
    writeFileSync(join(dir, '.staleproof.toml'), '[audit]\nmention-owners = true\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    // Later commits do not change who owns the pull request's docs: GitHub reads the base branch.
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @someone-else\n');
    git('commit', '-q', '-am', 'later');
  });
  afterAll(async () => rm(home, { recursive: true, force: true }));

  const noNetwork = (async () => {
    throw new Error('no network in this test');
  }) as unknown as typeof fetch;

  it('the PR comment reads CODEOWNERS and mention-owners at the base commit of the clone', async () => {
    const line = await ownersForCheck(
      { impact: { pr: { repo: 'acme/app', before: base }, sections: [{ repo: 'acme/app', path: 'docs/a.md' }] }, newFindings: { repo: 'acme/app', findings: [{ path: 'README.md' }] } },
      { home, fetchImpl: noNetwork },
    );
    expect(line).toBe('**Owners of affected docs:** @acme/docs (`docs/a.md`) · @acme/maintainers (`README.md`)');
    expect(await ownersForCheck({ impact: { pr: { repo: 'acme/app', before: base }, sections: [] } }, { home, fetchImpl: noNetwork })).toBe('');
  });

  it('the audit reads each repository at its indexed commit, from GitHub without a clone', async () => {
    const files: Record<string, string> = {
      'https://raw.githubusercontent.com/acme/site/abc/.github/CODEOWNERS': '/docs/ @acme/docs',
    };
    const fetchImpl = (async (url: string) => (files[url] ? new Response(files[url]) : new Response('', { status: 404 }))) as unknown as typeof fetch;
    const audit = {
      repos: [{ name: 'acme/site', sha: 'abc', symbols: 0, sections: 1 }],
      mismatches: [],
      runs: [],
      findings: [{ rule: 'link-broken', severity: 'error', message: 'Broken.', repo: 'acme/site', path: 'docs/x.md', line: 2, column: 1, endLine: 2, endColumn: 3, surface: 'docs', subject: 'y', fingerprint: 'z' }],
    } as unknown as AuditData;
    const md = await ownersForAudit(audit, { home, fetchImpl });
    expect(md).toContain('**`@acme/docs`** (1)');
    expect(md).toContain('- `docs/x.md:2`: Broken.');
  });

  it('reads the repository config like loadRepoConfig: .staleproof.toml first, then [tool.staleproof]', async () => {
    const files: Record<string, string> = { 'pyproject.toml': '[tool.staleproof.audit]\nmention-owners = true\n' };
    expect((await readRepoConfig(async (p) => files[p])).audit).toEqual({ mentionOwners: true });
    files['.staleproof.toml'] = 'ignore = []\n';
    expect((await readRepoConfig(async (p) => files[p])).audit).toBeUndefined();
    expect(await readRepoConfig(async () => 'not = [toml')).toEqual({ ignore: [], skipExamples: [] });
  });
});
