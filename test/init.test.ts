import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseRepoConfig } from '../src/indexer/repo-config.js';
import { guessDocsRepo } from '../src/init/detect.js';
import { claudeSettingsWithHooks, cursorHooksWithStaleproof, gitignoreWithStaleproof, preCommitWithStaleproof, readmeWithBadge } from '../src/init/files.js';
import { runInit, type Asker } from '../src/init/index.js';
import { FIXTURES, gitIn } from './helpers.js';

const VERSION = '0.5.0';

/** An init fixture as a git checkout with a GitHub origin (fixture files that this repository's .gitignore would hide are renamed back). */
async function fixtureRepo(name: 'python' | 'node'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `staleproof-init-${name}-`));
  await cp(join(FIXTURES, 'init', name), dir, { recursive: true });
  const renames: [string, string][] = [
    ['gitignore.txt', '.gitignore'],
    ['CLAUDE.md.txt', 'CLAUDE.md'],
    ['claude-settings.json', '.claude/settings.json'],
  ];
  for (const [from, to] of renames) {
    if (!existsSync(join(dir, from))) continue;
    await mkdir(dirname(join(dir, to)), { recursive: true });
    await rename(join(dir, from), join(dir, to));
  }
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'remote', 'add', 'origin', `https://github.com/acme/demo-${name === 'python' ? 'py' : 'node'}.git`);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** The output with the temporary folder taken out. */
const stable = (text: string, dir: string) => text.replaceAll(dir, '<repo>');

describe('staleproof init', () => {
  it('Python repository, --yes --dry-run: the plan and every file (golden)', async () => {
    const dir = await fixtureRepo('python');
    const r = await runInit({ dir, dryRun: true, version: VERSION });
    expect(r.written).toEqual([]);
    expect(gitIn(dir, 'status', '--porcelain')).toBe('');
    await expect(stable(r.text, dir)).toMatchFileSnapshot('fixtures/init/python.golden.txt');
    expect(r.detected).toMatchObject({ repo: 'acme/demo-py', languages: ['Python'], docsDirs: ['docs'], agentFiles: ['AGENTS.md'], python: true, docsRepoGuess: 'acme/demo-py-docs' });
  });

  it('Node repository with husky and Claude Code, --yes --dry-run --claude (golden)', async () => {
    const dir = await fixtureRepo('node');
    const r = await runInit({ dir, dryRun: true, claude: true, version: VERSION });
    await expect(stable(r.text, dir)).toMatchFileSnapshot('fixtures/init/node.golden.txt');
    expect(r.detected).toMatchObject({ repo: 'acme/demo-node', languages: ['TypeScript'], husky: true, claude: true, node: true });
  });

  it('writes valid files, and a second run writes nothing', async () => {
    const dir = await fixtureRepo('python');
    const first = await runInit({ dir, version: VERSION, claude: true, cursor: true });
    expect(first.written.sort()).toEqual(['.claude/settings.json', '.cursor/hooks.json', '.github/workflows/staleproof.yml', '.gitignore', '.pre-commit-config.yaml', '.staleproof.toml', '.vscode/extensions.json', 'README.md']);
    const vscode = JSON.parse(await readFile(join(dir, '.vscode/extensions.json'), 'utf8')) as { recommendations: string[] };
    expect(vscode.recommendations).toContain('staleproof.staleproof');
    // Every file is what its tool reads.
    const config = parseRepoConfig(await readFile(join(dir, '.staleproof.toml'), 'utf8'), '.staleproof.toml');
    expect(config.warnings).toBeUndefined();
    expect(config.hooks).toEqual({ stop: 'block' });
    const workflow = parseYaml(await readFile(join(dir, '.github/workflows/staleproof.yml'), 'utf8')) as { jobs: { docs: { steps: { uses: string }[] } } };
    expect(workflow.jobs.docs.steps[0]!.uses).toBe('rajkaria/staleproof@v1');
    const preCommit = parseYaml(await readFile(join(dir, '.pre-commit-config.yaml'), 'utf8')) as { repos: { repo: string; rev: string; hooks: { id: string }[] }[]; ci: unknown };
    expect(preCommit.repos.map((r) => r.repo)).toEqual(['https://github.com/astral-sh/ruff-pre-commit', 'https://github.com/rajkaria/staleproof']);
    expect(preCommit.repos[1]).toEqual({ repo: 'https://github.com/rajkaria/staleproof', rev: 'v0.5.0', hooks: [{ id: 'staleproof' }] });
    expect(preCommit.ci).toEqual({ autofix_prs: false });
    const claude = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(claude.hooks)).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
    expect(claude.hooks.PostToolUse![0]!.hooks[0]!.command).toBe('npx -y staleproof@0.5.0 hook post-edit');
    const cursor = JSON.parse(await readFile(join(dir, '.cursor/hooks.json'), 'utf8')) as { version: number; hooks: Record<string, unknown[]> };
    expect(cursor.version).toBe(1);
    expect(Object.keys(cursor.hooks)).toEqual(['sessionStart', 'postToolUse', 'stop']);

    const second = await runInit({ dir, version: VERSION, claude: true, cursor: true });
    expect(second.written).toEqual([]);
    expect(second.files.every((f) => f.action === 'unchanged')).toBe(true);
    expect(second.text).toContain('Everything was in place already: nothing written.');
  });

  it('merges into existing Claude Code settings without touching other keys or hooks', async () => {
    const dir = await fixtureRepo('node');
    await runInit({ dir, version: VERSION, claude: true });
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8')) as { permissions: unknown; hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.hooks.PostToolUse!.map((g) => g.hooks[0]!.command)).toEqual(['npx prettier --write "$CLAUDE_FILE_PATHS"', 'npx -y staleproof@0.5.0 hook post-edit']);
    expect(await readFile(join(dir, '.husky/pre-commit'), 'utf8')).toBe('npx lint-staged\nnpx -y staleproof@0.5.0 lint --new --staged\n');
  });

  it('asks in a terminal: a "no" leaves that file alone; the docs repository answer goes into the workflow', async () => {
    const dir = await fixtureRepo('python');
    const asked: string[] = [];
    const ask: Asker = {
      async confirm(q) {
        asked.push(q);
        return !q.includes('README.md');
      },
      async text(q, byDefault) {
        asked.push(q);
        return byDefault;
      },
    };
    const r = await runInit({ dir, version: VERSION, ask });
    expect(r.written).not.toContain('README.md');
    expect(asked[0]).toBe('Docs in another repository (owner/name, "-" for none)?');
    expect(await readFile(join(dir, '.github/workflows/staleproof.yml'), 'utf8')).toContain('also-index: acme/demo-py-docs');
  });

  it('places the badge after the title, or at the end of the badge row', () => {
    expect(readmeWithBadge('# x\nText.\n', 'a/b')).toBe(
      '# x\n\n[![docs health](https://staleproof.dev/api/badge/a/b.svg)](https://staleproof.dev/#/audit?repo=a%2Fb)\n\nText.\n',
    );
    expect(readmeWithBadge('# x\n\n[![ci](u)](v)\n\nText.\n', 'a/b')).toBe(
      '# x\n\n[![ci](u)](v) [![docs health](https://staleproof.dev/api/badge/a/b.svg)](https://staleproof.dev/#/audit?repo=a%2Fb)\n\nText.\n',
    );
    expect(readmeWithBadge('<p align="center"><img src="logo.png"></p>\n\n# x\n', 'a/b')).toBeUndefined();
    expect(readmeWithBadge('# x\n[![docs health](https://staleproof.dev/api/badge/a/b.svg)](…)\n', 'a/b')).toBeUndefined();
  });

  it('edits pre-commit, .gitignore, Claude and Cursor files in place, once', () => {
    const spaced = 'repos:\n  - repo: https://github.com/psf/black\n    rev: 24.8.0\n    hooks:\n      - id: black\n';
    const once = preCommitWithStaleproof(spaced, VERSION)!;
    expect(once).toBe(`${spaced}  - repo: https://github.com/rajkaria/staleproof\n    rev: v0.5.0\n    hooks:\n      - id: staleproof\n`);
    expect(preCommitWithStaleproof(once, VERSION)).toBeUndefined();
    expect(preCommitWithStaleproof('default_stages: [pre-commit]\n', VERSION)).toBeUndefined();
    expect(gitignoreWithStaleproof('node_modules/\n.staleproof/\n')).toBeUndefined();
    expect(gitignoreWithStaleproof(undefined)).toBe('# Staleproof parse cache and hook state\n.staleproof/\n');
    const settings = claudeSettingsWithHooks(undefined, 'npx -y staleproof@0.5.0')!;
    expect(claudeSettingsWithHooks(settings, 'npx -y staleproof@0.5.0')).toBeUndefined();
    // The plugin's own hooks count too: init adds nothing next to them.
    const viaPlugin = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'node "/p/scripts/staleproof.mjs" hook session-start' }] }], PostToolUse: [{ hooks: [{ command: 'node "/p/scripts/staleproof.mjs" hook post-edit' }] }], Stop: [{ hooks: [{ command: 'node "/p/scripts/staleproof.mjs" hook stop' }] }] } });
    expect(claudeSettingsWithHooks(viaPlugin, 'npx -y staleproof@0.5.0')).toBeUndefined();
    expect(() => claudeSettingsWithHooks('{ // comment\n}', 'x')).toThrow();
    const cursor = cursorHooksWithStaleproof(undefined, 'npx -y staleproof@0.5.0')!;
    expect(JSON.parse(cursor)).toEqual({
      version: 1,
      hooks: {
        sessionStart: [{ command: 'npx -y staleproof@0.5.0 hook session-start --cursor' }],
        postToolUse: [{ command: 'npx -y staleproof@0.5.0 hook post-edit --cursor', matcher: 'Write' }],
        stop: [{ command: 'npx -y staleproof@0.5.0 hook stop --cursor', loop_limit: 1 }],
      },
    });
    expect(cursorHooksWithStaleproof(cursor, 'npx -y staleproof@0.5.0')).toBeUndefined();
  });

  it('guesses a separate docs repository from the README, never this one', () => {
    expect(guessDocsRepo('See [docs](https://github.com/acme/acme-docs).', 'acme/acme')).toBe('acme/acme-docs');
    expect(guessDocsRepo('Site: https://github.com/acme/acme.github.io', 'acme/acme')).toBe('acme/acme.github.io');
    expect(guessDocsRepo('https://github.com/other/docs', 'acme/acme')).toBeUndefined();
    expect(guessDocsRepo('https://github.com/acme/acme/tree/main/docs', 'acme/acme')).toBeUndefined();
  });
});
