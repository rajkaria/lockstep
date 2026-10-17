import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { predictedFromLocalGraph } from '../src/hooks/graph.js';
import { parseHookInput, runHook, stopMode } from '../src/hooks/index.js';
import { breakingParams, changedSignatures, compactSignature } from '../src/hooks/mentions.js';
import { mentionLine } from '../src/hooks/report.js';
import { extractPython } from '../src/indexer/python.js';
import { FIXTURES, gitIn } from './helpers.js';

const HOOKS = join(FIXTURES, 'hooks');

/** The hooks fixture as a git repository with one commit (AGENTS.md already names a missing file there). */
async function hooksRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-hooks-'));
  await cp(join(HOOKS, 'repo'), dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A recorded hook input with the fixture's paths pointed at `root`. */
async function input(name: string, root: string): Promise<string> {
  return (await readFile(join(HOOKS, 'inputs', `${name}.json`), 'utf8')).replaceAll('{{root}}', root);
}

async function edit(root: string, path: string, from: string, to: string): Promise<void> {
  const text = await readFile(join(root, path), 'utf8');
  if (!text.includes(from)) throw new Error(`${path} has no ${from}`);
  await writeFile(join(root, path), text.replace(from, to));
}

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.STALEPROOF_HOOK;
  return { ...e, ...extra };
};

async function hook(event: 'session-start' | 'post-edit' | 'stop', root: string, name: string, extra: Record<string, string> = {}) {
  const r = await runHook(event, await input(name, root), { env: env(extra), graph: false, timeoutMs: 60_000 });
  return r.stdout ? (JSON.parse(r.stdout) as Record<string, unknown>) : undefined;
}

const context = (out: Record<string, unknown> | undefined) => (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

describe('coding-agent hooks', () => {
  let root: string;

  beforeEach(async () => {
    delete process.env.STALEPROOF_CACHE_DIR;
    delete process.env.STALEPROOF_HOOK;
    root = await hooksRepo();
  });

  it('reads Claude Code and Cursor hook input', async () => {
    const claude = parseHookInput(await input('claude-post-edit-signature', '/w'), {});
    expect(claude).toMatchObject({ dialect: 'claude', event: 'PostToolUse', cwd: '/w', files: ['/w/demo/client.py'], toolName: 'Edit', stopHookActive: false });
    expect(parseHookInput(await input('claude-stop-active', '/w'), {}).stopHookActive).toBe(true);
    const cursor = parseHookInput(await input('cursor-post-tool-use', '/w'), {});
    expect(cursor).toMatchObject({ dialect: 'cursor', cwd: '/w', files: ['/w/demo/client.py'], sessionId: 'c0ffee00-1111-4222-8333-444455556666' });
    expect(parseHookInput(await input('cursor-stop-looped', '/w'), {}).stopHookActive).toBe(true);
    expect(parseHookInput('not json', { CLAUDE_PROJECT_DIR: '/p' })).toMatchObject({ dialect: 'claude', cwd: '/p', files: [] });
  });

  it('after an edit that breaks the README example: says which docs, with the line, once', async () => {
    expect(await hook('session-start', root, 'claude-session-start')).toBeUndefined();
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    const out = await hook('post-edit', root, 'claude-post-edit-signature');
    expect((out?.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe('PostToolUse');
    expect(context(out)).toBe(
      [
        'Staleproof: this edit leaves docs out of date (checked against HEAD, nothing left the machine):',
        '- README.md:8:8 `connect` has no parameter `timeout`. [example-unknown-keyword]',
        '- docs/usage.md:3 still names `timeout` of `connect`; demo/client.py changed it to `def connect(host, deadline=10)`.',
        'Update them in the same change, or say why they stay.',
      ].join('\n'),
    );
    // The pre-existing `demo/legacy.py` in AGENTS.md is at HEAD too: never reported. A second,
    // unrelated edit of the same file repeats nothing.
    await edit(root, 'demo/client.py', 'return text', 'return text.strip()');
    expect(await hook('post-edit', root, 'claude-post-edit-signature')).toBeUndefined();
  });

  it('after a harmless edit: no output', async () => {
    await hook('session-start', root, 'claude-session-start');
    await edit(root, 'demo/client.py', 'Open a connection to host.', 'Open a connection to the server at host.');
    expect(await hook('post-edit', root, 'claude-post-edit-docstring')).toBeUndefined();
  });

  it('reports a new stale reference in the edited agent file, not the old one', async () => {
    await edit(root, 'AGENTS.md', '- Old notes', '- Settings are in `demo/settings.py`.\n- Old notes');
    expect(context(await hook('post-edit', root, 'claude-post-write-agents'))).toBe(
      [
        'Staleproof: this edit leaves docs out of date (checked against HEAD, nothing left the machine):',
        '- AGENTS.md:4:20 `demo/settings.py` does not exist in the repository. [path-missing]',
        'Update them in the same change, or say why they stay.',
      ].join('\n'),
    );
  });

  it('a script renamed in package.json: the untouched README is reported', async () => {
    await hook('session-start', root, 'claude-session-start');
    await edit(root, 'package.json', '"lint:docs"', '"lint-docs"');
    const text = context(await hook('post-edit', root, 'claude-post-edit-package'));
    expect(text).toContain('- README.md:11:');
    expect(text).toContain('[command-missing]');
  });

  it('stop: blocks once with the new error findings, never when already continuing', async () => {
    await hook('session-start', root, 'claude-session-start');
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    await hook('post-edit', root, 'claude-post-edit-signature');
    const out = await hook('stop', root, 'claude-stop');
    expect(out?.decision).toBe('block');
    expect(out?.reason).toBe(
      [
        'Staleproof: 1 doc reference this session made wrong (new since HEAD):',
        '- README.md:8:8 `connect` has no parameter `timeout`. [example-unknown-keyword] Fix: Rename to `deadline=` (renamed in the signature of `demo.client.connect`)',
        '- docs/usage.md:3 still names `timeout` of `connect`; demo/client.py changed it to `def connect(host, deadline=10)`.',
        'Update the docs and agent files above in this change (apply the fixes listed), or explain why they stay as they are.',
      ].join('\n'),
    );
    const again = await hook('stop', root, 'claude-stop-active');
    expect(again?.decision).toBeUndefined();
    expect(again?.systemMessage).toContain('README.md:8:8');
  });

  it('replays the recorded headless run: the README fixed, only the prose mention is left, and nothing blocks', async () => {
    await hook('session-start', root, 'claude-session-start');
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    await hook('post-edit', root, 'claude-post-edit-signature');
    // The recorded session id differs from the fixtures': use one session throughout.
    const recorded = (await input('claude-recorded-post-edit-readme', root)).replaceAll('835aa976-88d4-47c4-8f5d-8b74bc6a0164', '3b6f0c2e-7d4a-4f51-9a0e-1c2d3e4f5a6b');
    await edit(root, 'README.md', 'connect("localhost", timeout=5)', 'connect("localhost", deadline=5)');
    expect((await runHook('post-edit', recorded, { env: env(), graph: false })).stdout).toBe('');
    const stopping = (await input('claude-recorded-stop-active', root)).replaceAll('835aa976-88d4-47c4-8f5d-8b74bc6a0164', '3b6f0c2e-7d4a-4f51-9a0e-1c2d3e4f5a6b');
    const out = JSON.parse((await runHook('stop', stopping, { env: env(), graph: false })).stdout) as Record<string, string>;
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toBe(
      [
        'Staleproof: docs that name code this session changed (check they still hold):',
        '- docs/usage.md:3 still names `timeout` of `connect`; demo/client.py changed it to `def connect(host, deadline=10)`.',
      ].join('\n'),
    );
  });

  it('a session-start hook that finishes after the first edit loses nothing', async () => {
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    await hook('post-edit', root, 'claude-post-edit-signature');
    await hook('session-start', root, 'claude-session-start');
    expect((await hook('stop', root, 'claude-stop'))?.decision).toBe('block');
  });

  it('stop: silent when the docs are fine, when the session edited nothing, and when off', async () => {
    expect(await hook('stop', root, 'claude-stop')).toBeUndefined();
    await hook('session-start', root, 'claude-session-start');
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    // A change made outside the session (no post-edit hook ran): not the agent's to fix.
    expect(await hook('stop', root, 'claude-stop')).toBeUndefined();
    await hook('post-edit', root, 'claude-post-edit-signature');
    expect(await hook('stop', root, 'claude-stop', { STALEPROOF_HOOK: 'off' })).toBeUndefined();
  });

  it('stop: [hooks] stop = "warn" tells the user only; STALEPROOF_HOOK wins over the config', async () => {
    await writeFile(join(root, '.staleproof.toml'), '[hooks]\nstop = "warn"\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-q', '-m', 'config');
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    await hook('post-edit', root, 'claude-post-edit-signature');
    const warned = await hook('stop', root, 'claude-stop');
    expect(warned?.decision).toBeUndefined();
    expect(warned?.systemMessage).toContain('`connect` has no parameter `timeout`');
    expect((await hook('stop', root, 'claude-stop', { STALEPROOF_HOOK: 'block' }))?.decision).toBe('block');
    expect(stopMode({}, undefined)).toBe('block');
    expect(stopMode({ STALEPROOF_HOOK: 'nonsense' }, 'off')).toBe('off');
  });

  it('Cursor: additional_context after an edit, one follow-up before stopping', async () => {
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    const after = await hook('post-edit', root, 'cursor-post-tool-use');
    expect(after?.additional_context).toContain('README.md:8:8 `connect` has no parameter `timeout`.');
    expect((await hook('stop', root, 'cursor-stop'))?.followup_message).toContain('README.md:8:8');
    const looped = await hook('stop', root, 'cursor-stop-looped');
    expect(looped?.followup_message).toBeUndefined();
  });

  it('never fails the agent: outside git, bad input, or out of time gives no output', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'staleproof-nogit-'));
    expect((await runHook('post-edit', JSON.stringify({ cwd: outside, tool_input: { file_path: join(outside, 'a.py') } }), { graph: false })).stdout).toBe('');
    // Unreadable input falls back to the project folder (here one outside git), never to wherever the test runs.
    expect((await runHook('stop', '{{{', { graph: false, env: { ...env(), CLAUDE_PROJECT_DIR: outside } })).stdout).toBe('');
    await edit(root, 'demo/client.py', 'def connect(host, timeout=10):', 'def connect(host, deadline=10):');
    expect((await runHook('post-edit', await input('claude-post-edit-signature', root), { graph: false, timeoutMs: 1 })).stdout).toBe('');
  });

  it('keeps its state in the self-ignoring cache: git status stays clean', async () => {
    await hook('session-start', root, 'claude-session-start');
    expect(gitIn(root, 'status', '--porcelain')).toBe('');
  });

  it('predicted breaks only ever come from a graph on this machine', async () => {
    const saved = process.env.FALKORDB_URL;
    process.env.FALKORDB_URL = 'falkor://graph.example.com:6379';
    try {
      expect(await predictedFromLocalGraph(root)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.FALKORDB_URL;
      else process.env.FALKORDB_URL = saved;
    }
  });

  it('finds public signature changes and removals between two parses', async () => {
    const before = await extractPython(
      'class Graph:\n    def __init__(self, url):\n        pass\n    def query(self, a):\n        pass\n    def _hidden(self):\n        pass\n\ndef keep(x):\n    pass\n\ndef gone():\n    pass\n\ndef f(x):\n    pass\n',
      { module: 'm', path: 'm.py' },
    );
    const after = await extractPython(
      'class Graph:\n    def __init__(self, url, *, timeout=5):\n        pass\n    def query(self, a, b):\n        pass\n    def _hidden(self, z):\n        pass\n\ndef keep(x):\n    return 1\n\ndef f(y):\n    pass\n',
      { module: 'm', path: 'm.py' },
    );
    // Private helpers and names too short to find in prose are left out; constructors count.
    expect(changedSignatures(before, after).map((c) => [c.def.qualname, c.after?.signature])).toEqual([
      ['m.Graph.__init__', 'def __init__(self, url, *, timeout=5)'],
      ['m.Graph.query', 'def query(self, a, b)'],
      ['m.gone', undefined],
    ]);
  });

  it('a changed signature counts only when a doc can now be wrong', async () => {
    const def = async (src: string) => (await extractPython(src, { module: 'm', path: 'm.py' })).defs.find((d) => d.name === 'connect')!;
    const base = await def('def connect(host, timeout=10):\n    pass\n');
    expect(breakingParams(base, await def('def connect(host, timeout=10, retries=3):\n    pass\n'))).toEqual({ removed: [], required: [] });
    expect(breakingParams(base, await def('def connect(host: str, timeout: int = 10) -> None:\n    pass\n'))).toEqual({ removed: [], required: [] });
    expect(breakingParams(base, await def('def connect(host, deadline=10):\n    pass\n'))).toEqual({ removed: ['timeout'], required: [] });
    expect(breakingParams(base, await def('def connect(host, port, timeout=10):\n    pass\n'))).toEqual({ removed: [], required: ['port'] });
  });

  it('says what a mention gets wrong, on one line', () => {
    const base = { path: 'docs/a.md', line: 3, column: 1, symbol: 'connect', definedIn: 'demo/client.py', before: 'def connect(host)' };
    expect(mentionLine({ ...base, after: 'def connect(\n    host,\n    port,\n)', required: ['port'] })).toBe(
      '- docs/a.md:3 calls `connect`, which now requires `port` (demo/client.py: `def connect(host, port)`).',
    );
    expect(mentionLine(base)).toBe('- docs/a.md:3 names `connect`, which demo/client.py no longer defines.');
    expect(compactSignature(`def f(${'a, '.repeat(80)}b)`).length).toBe(120);
  });
});
