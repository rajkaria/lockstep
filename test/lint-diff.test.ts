import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultBase, lintCommit, lintCommits, lintNew, lintStaged, newFindings } from '../src/lint/diff.js';
import { lintRepo } from '../src/lint/engine.js';
import { RULE_BY_ID } from '../src/lint/rules.js';
import { downloadTree, gitRoot, indexTree, lintTree, overlayTree, refTree, subdirOf, tarballTree } from '../src/lint/sources.js';
import type { Finding, LintResult, RuleId } from '../src/lint/types.js';
import { gitIn } from './helpers.js';

const brief = (fs: readonly Finding[]) => fs.map((f) => `${f.path}:${f.line} ${f.rule} ${f.subject}`);
/** Full-result assertions pin the path and link rules: rules other sprints add must not change them. */
const PATHS: RuleId[] = ['path-missing', 'link-broken', 'anchor-missing', 'line-out-of-range'];

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

/** A small app repository on `main`: an agent file, a README and a docs page that point at each other. */
async function appRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-diff-'));
  await put(dir, {
    'AGENTS.md': '# Agents\n\n- Setup steps are in `docs/setup.md`.\n- Code lives in `src/app.ts`.\n',
    'README.md': '# App\n\nRead [setup](docs/setup.md) first. The [old notes](docs/gone.md) are gone.\n',
    'docs/setup.md': '# Setup\n\n## Install\n\nRun it.\n',
    'src/app.ts': 'export const x = 1;\n',
    'assets/logo.png': 'PNG',
    'package.json': JSON.stringify({ name: 'app', private: true, scripts: { 'lint:docs': 'staleproof lint', test: 'vitest' } }, null, 2),
  });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('newFindings', () => {
  const f = (fingerprint: string, path = 'README.md'): Finding => ({
    rule: 'link-broken', severity: 'error', message: 'm', path, line: 1, column: 1, endLine: 1, endColumn: 2, surface: 'readme', subject: fingerprint, fingerprint,
  });
  it('keeps head findings whose fingerprint the base lacks, in head order', () => {
    expect(newFindings([f('a'), f('b')], [f('c', 'AGENTS.md'), f('a'), f('d')]).map((x) => x.fingerprint)).toEqual(['c', 'd']);
    expect(newFindings({ findings: [f('a')] } as LintResult, { findings: [f('a')] } as LintResult)).toEqual([]);
  });
});

describe('lint --new (git sources)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await appRepo();
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it('a clean tree on the default branch introduces nothing', async () => {
    expect(await defaultBase(dir)).toMatchObject({ why: 'this branch against main' });
    const r = await lintNew({ dir, repo: 'acme/app', examples: false });
    expect(r.findings).toEqual([]);
    expect(r.base.sha).toBe(gitIn(dir, 'rev-parse', 'HEAD'));
    expect(r.fixed).toBe(0);
    expect(r.version).toBe(1);
  });

  it('fingerprints are line-independent: lines inserted above and sections reordered add nothing new', async () => {
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    try {
      await writeFile(join(dir, 'README.md'), `<!-- intro -->\n\nA new paragraph.\n\n## Later\n\nMore text.\n\n${readme}`);
      await writeFile(join(dir, 'AGENTS.md'), agents.replace('- Setup steps are in `docs/setup.md`.\n- Code lives in `src/app.ts`.\n', '- Code lives in `src/app.ts`.\n- Setup steps are in `docs/setup.md`.\n'));
      expect((await defaultBase(dir)).ref).toBe('HEAD');
      const full = await lintRepo({ dir, repo: 'acme/app', examples: false, rules: PATHS });
      expect(brief(full.findings)).toEqual(['README.md:11 link-broken docs/gone.md']);
      const r = await lintNew({ dir, repo: 'acme/app', examples: false });
      expect(r.findings).toEqual([]);
      expect(r.base).toMatchObject({ ref: 'HEAD', why: 'the uncommitted changes against the last commit' });
    } finally {
      await writeFile(join(dir, 'README.md'), readme);
      await writeFile(join(dir, 'AGENTS.md'), agents);
    }
  });

  it('a file renamed on a branch makes the untouched README and AGENTS.md references new findings', async () => {
    gitIn(dir, 'checkout', '-q', '-b', 'rename-setup');
    try {
      await mkdir(join(dir, 'docs', 'guides'));
      gitIn(dir, 'mv', 'docs/setup.md', 'docs/guides/setup.md');
      gitIn(dir, 'commit', '-q', '-m', 'move setup');
      const r = await lintNew({ dir, repo: 'acme/app', examples: false });
      expect(r.base.why).toBe('this branch against main');
      expect(brief(r.findings)).toEqual(['AGENTS.md:3 path-missing docs/setup.md', 'README.md:3 link-broken docs/setup.md']);
      expect(r.findings[0]!.message).toBe('`docs/setup.md` does not exist; it moved to `docs/guides/setup.md`.');
      // The old broken link was already there on main: not new.
      expect(r.findings.some((f) => f.subject === 'docs/gone.md')).toBe(false);
      expect(r.summary).toMatchObject({ errors: 2, warnings: 0 });
      // An explicit base gives the same answer; comparing with the branch itself gives none.
      expect((await lintNew({ dir, repo: 'acme/app', base: 'main', examples: false })).findings).toHaveLength(2);
      expect((await lintNew({ dir, repo: 'acme/app', base: 'HEAD', examples: false })).findings).toEqual([]);
      await expect(lintNew({ dir, base: 'no-such-ref', examples: false })).rejects.toThrow(/not a commit/);
    } finally {
      gitIn(dir, 'checkout', '-q', 'main');
    }
  });

  it('--staged lints the index, not the files on disk, and --staged --new compares it with HEAD', async () => {
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    try {
      await writeFile(join(dir, 'README.md'), `${readme}\nSee [the FAQ](docs/faq.md).\n`);
      gitIn(dir, 'add', 'README.md');
      // On disk the line is gone again; the index still has it.
      await writeFile(join(dir, 'README.md'), readme);
      const staged = await lintStaged({ dir, repo: 'acme/app', examples: false, rules: PATHS });
      expect(brief(staged.findings)).toEqual(['README.md:3 link-broken docs/gone.md', 'README.md:5 link-broken docs/faq.md']);
      const disk = await lintRepo({ dir, repo: 'acme/app', examples: false, rules: PATHS });
      expect(brief(disk.findings)).toEqual(['README.md:3 link-broken docs/gone.md']);
      const r = await lintNew({ dir, repo: 'acme/app', staged: true, examples: false });
      expect(brief(r.findings)).toEqual(['README.md:5 link-broken docs/faq.md']);
      expect(r.head.label).toBe('index');
      expect(r.base.ref).toBe('HEAD');
    } finally {
      gitIn(dir, 'reset', '-q', 'README.md');
      await writeFile(join(dir, 'README.md'), readme);
    }
  });

  it('inside a pre-commit hook (GIT_INDEX_FILE set) the temporary trees still read their own index', async () => {
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    const saved = process.env.GIT_INDEX_FILE;
    try {
      await writeFile(join(dir, 'README.md'), `${readme}\nSee [the FAQ](docs/faq.md).\n`);
      gitIn(dir, 'add', 'README.md');
      process.env.GIT_INDEX_FILE = join(dir, '.git', 'index');
      const r = await lintNew({ dir, repo: 'acme/app', staged: true, examples: false });
      expect(brief(r.findings)).toEqual(['README.md:5 link-broken docs/faq.md']);
      expect(process.env.GIT_INDEX_FILE).toBe(join(dir, '.git', 'index'));
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
      gitIn(dir, 'reset', '-q', 'README.md');
      await writeFile(join(dir, 'README.md'), readme);
    }
  });

  it('extracts a commit as a checkout: same files, history and remote, then cleans up', async () => {
    gitIn(dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    try {
      const tree = await refTree(dir, 'main');
      expect(tree.sha).toBe(gitIn(dir, 'rev-parse', 'main'));
      expect(existsSync(join(tree.dir, 'assets', 'logo.png'))).toBe(true);
      const r = await lintTree(tree, { examples: false, rules: PATHS });
      // The name comes from the copied origin remote; the evidence links the commit.
      expect(r.repo).toBe('acme/app');
      expect(r.findings[0]!.evidence?.url).toBe(`https://github.com/acme/app/blob/${tree.sha}/README.md#L3`);
      await tree.dispose();
      expect(existsSync(tree.dir)).toBe(false);
      const index = await indexTree(dir);
      expect(index.label).toBe('index');
      await index.dispose();
    } finally {
      gitIn(dir, 'remote', 'remove', 'origin');
    }
  });

  it('the CLI: lint --new and --staged, with --base only next to --new', async () => {
    const cli = (...args: string[]) => {
      try {
        return { code: 0, out: execFileSync(join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx'), [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'lint', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string };
        return { code: e.status, out: e.stdout, err: e.stderr };
      }
    };
    gitIn(dir, 'checkout', '-q', '-b', 'cli-rename');
    try {
      await mkdir(join(dir, 'docs', 'moved'), { recursive: true });
      gitIn(dir, 'mv', 'docs/setup.md', 'docs/moved/setup.md');
      gitIn(dir, 'commit', '-q', '-m', 'move setup');
      const all = cli('--no-examples', '--format', 'json', '--rule', ...PATHS);
      expect(all.code).toBe(1);
      expect((JSON.parse(all.out) as LintResult).findings).toHaveLength(3);
      const fresh = cli('--new', '--no-examples', '--format', 'json');
      expect(fresh.code).toBe(1);
      const r = JSON.parse(fresh.out) as LintResult & { base: { why: string }; fixed: number };
      expect(brief(r.findings)).toEqual(['AGENTS.md:3 path-missing docs/setup.md', 'README.md:3 link-broken docs/setup.md']);
      expect(r.base.why).toBe('this branch against main');
      // Against the branch's own commit nothing is new: exit 0.
      expect(cli('--new', '--base', 'HEAD', '--no-examples').code).toBe(0);
      const misuse = cli('--base', 'main');
      expect(misuse.code).toBe(1);
      expect(misuse.err).toContain('--base needs --new');
      expect(cli('--staged', '--no-examples', '--fail-on', 'never').code).toBe(0);
    } finally {
      gitIn(dir, 'checkout', '-q', 'main');
    }
  }, 60_000);

  // command-missing is written in parallel (SP2); this runs once it is registered.
  it.skipIf(!RULE_BY_ID.get('command-missing') || RULE_BY_ID.get('command-missing')!.planned)(
    'a script renamed in package.json makes the untouched README a new finding',
    async () => {
      const readme = await readFile(join(dir, 'README.md'), 'utf8');
      const pkg = await readFile(join(dir, 'package.json'), 'utf8');
      gitIn(dir, 'checkout', '-q', '-b', 'rename-script');
      try {
        await writeFile(join(dir, 'README.md'), `${readme}\n## Checks\n\nRun \`npm run lint:docs\` before a pull request.\n`);
        gitIn(dir, 'commit', '-q', '-am', 'document the docs check');
        await writeFile(join(dir, 'package.json'), pkg.replace('"lint:docs"', '"docs:lint"'));
        gitIn(dir, 'commit', '-q', '-am', 'rename the script');
        const r = await lintNew({ dir, repo: 'acme/app', base: 'HEAD~1', examples: false });
        expect(brief(r.findings)).toEqual(['README.md:7 command-missing npm run lint:docs']);
      } finally {
        gitIn(dir, 'checkout', '-q', 'main');
        gitIn(dir, 'branch', '-q', '-D', 'rename-script');
      }
    },
  );
});

/** `git archive` of a commit, the way codeload serves it. */
function archive(dir: string, sha: string): Buffer {
  return execFileSync('git', ['archive', '--format=tar.gz', `--prefix=app-${sha}/`, sha], { cwd: dir, maxBuffer: 64 << 20 });
}

describe('tarball and pull request sources', () => {
  let dir: string;
  let home: string;
  let base: string;
  let head: string;
  let fetchImpl: typeof fetch;
  const requested: string[] = [];

  beforeAll(async () => {
    dir = await appRepo();
    home = await mkdtemp(join(tmpdir(), 'staleproof-diff-home-'));
    await put(dir, { '.claude/skills/release/SKILL.md': '# Release\n\nBump `src/version.ts` first.\n', '.env.example': 'API_URL=\n' });
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'skill');
    base = gitIn(dir, 'rev-parse', 'HEAD');
    gitIn(dir, 'mv', 'docs/setup.md', 'docs/install.md');
    gitIn(dir, 'commit', '-q', '-m', 'rename');
    head = gitIn(dir, 'rev-parse', 'HEAD');
    fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const m = /codeload\.github\.com\/acme\/app\/tar\.gz\/([0-9a-f]{40})$/.exec(url);
      return m ? new Response(new Uint8Array(archive(dir, m[1]!))) : new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('a tarball lists every path, writes hidden agent files and text, and lints like the checkout', async () => {
    const t = await downloadTree(home, 'acme/app', base, { fetchImpl });
    expect(t.sha).toBe(base);
    expect(t.paths).toEqual(['.claude/skills/release/SKILL.md', '.env.example', 'AGENTS.md', 'README.md', 'assets/logo.png', 'docs/setup.md', 'package.json', 'src/app.ts']);
    expect(existsSync(join(t.dir, '.claude', 'skills', 'release', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(t.dir, '.env.example'))).toBe(true);
    // Binary files are listed (paths to them are real) but not written.
    expect(existsSync(join(t.dir, 'assets', 'logo.png'))).toBe(false);
    await rm(t.dir, { recursive: true, force: true });

    const fromTar = await tarballTree(home, 'acme/app', base, { fetchImpl });
    const fromGit = await refTree(dir, base, { repo: 'acme/app' });
    try {
      const [a, b] = [await lintTree(fromTar, { examples: false, rules: PATHS }), await lintTree(fromGit, { examples: false, rules: PATHS })];
      expect(brief(a.findings)).toEqual(['.claude/skills/release/SKILL.md:3 path-missing src/version.ts', 'README.md:3 link-broken docs/gone.md']);
      expect(a.findings.map((f) => f.fingerprint)).toEqual(b.findings.map((f) => f.fingerprint));
    } finally {
      await fromTar.dispose();
      await fromGit.dispose();
    }
    await expect(downloadTree(home, 'acme/nope', base, { fetchImpl })).rejects.toThrow(/not found/);
  });

  it('a pull request: new findings between two commits, from a clone or from tarballs, cached by commit', async () => {
    requested.length = 0;
    const viaClone = await lintCommits('acme/app', base, head, { home, clone: dir, lint: { examples: false } });
    expect(brief(viaClone.findings)).toEqual(['AGENTS.md:3 path-missing docs/setup.md', 'README.md:3 link-broken docs/setup.md']);
    expect(viaClone.base.sha).toBe(base);
    expect(requested).toHaveLength(0);

    const viaTar = await lintCommits('acme/app', base, head, { home, fetchImpl, lint: { examples: false, rules: ['link-broken', 'path-missing'] } });
    expect(brief(viaTar.findings)).toEqual(['AGENTS.md:3 path-missing docs/setup.md', 'README.md:3 link-broken docs/setup.md']);
    expect(requested).toHaveLength(2);
    // Each commit is linted once per options.
    const again = await lintCommit('acme/app', head, { home, fetchImpl, lint: { examples: false, rules: ['link-broken', 'path-missing'] } });
    expect(again.sha).toBe(head);
    expect(requested).toHaveLength(2);
  });

  it('overlays edited files on a commit: what unsaved edits would make wrong', async () => {
    const tree = await refTree(dir, base, { repo: 'acme/app' });
    const edited = await overlayTree(tree, [
      { path: 'docs/setup.md', content: null },
      { path: 'docs/new.md', content: '# New\n\nSee [setup](setup.md).\n' },
    ]);
    try {
      const [b, h] = [await lintTree(tree, { examples: false }), await lintTree(edited, { examples: false })];
      expect(brief(newFindings(b, h))).toEqual(['AGENTS.md:3 path-missing docs/setup.md', 'README.md:3 link-broken docs/setup.md', 'docs/new.md:3 link-broken docs/setup.md']);
      // The base tree is untouched.
      expect(existsSync(join(tree.dir, 'docs', 'setup.md'))).toBe(true);
      await expect(overlayTree(tree, [{ path: '../escape.md', content: 'x' }])).rejects.toThrow(/not a repository path/);
    } finally {
      await tree.dispose();
      await edited.dispose();
    }
  });
});

describe('subdirOf', () => {
  it('compares real paths, so a checkout reached through a symlink is its own root, never a path out of it', async () => {
    const real = await mkdtemp(join(tmpdir(), 'staleproof-real-'));
    await mkdir(join(real, 'docs'));
    gitIn(real, 'init', '-q', '-b', 'main');
    const link = `${real}-link`;
    await symlink(real, link);
    try {
      const root = (await gitRoot(link))!;
      expect(subdirOf(root, link)).toBe('');
      expect(subdirOf(root, join(link, 'docs'))).toBe('docs');
      expect(() => subdirOf(root, tmpdir())).toThrow(/is not inside the checkout/);
    } finally {
      await rm(link, { force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
});
