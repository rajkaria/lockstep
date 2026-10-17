import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = join(ROOT, 'plugins', 'claude-code');
const SCRIPT = join(PLUGIN, 'scripts', 'staleproof.mjs');
const json = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;

/** Frontmatter of a skill or command file. */
function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? (parseYaml(m[1]!) as Record<string, string>) : {};
}

/** A fake CLI that prints what it was called with, and exits with the code in its first argument when asked. */
async function fakeCli(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-fake-'));
  await mkdir(join(dir, 'dist'));
  const body = (name: string) =>
    `let input = ''; process.stdin.on('data', (c) => (input += c)).on('end', () => { process.stdout.write(JSON.stringify({ entry: '${name}', args: process.argv.slice(2), input })); process.exit(process.argv.includes('--exit-3') ? 3 : 0); });\n`;
  await writeFile(join(dir, 'dist', 'cli.js'), body('cli'));
  return dir;
}

function runScript(args: string[], env: Record<string, string>, input = '{"x":1}') {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? (JSON.parse(r.stdout) as { entry: string; args: string[]; input: string }) : undefined };
}

describe('Claude Code plugin and marketplace', () => {
  it('the marketplace at the repository root lists the plugin by a relative path', async () => {
    const m = await json<{ name: string; owner: { name: string }; plugins: { name: string; source: string; description: string }[] }>(join(ROOT, '.claude-plugin', 'marketplace.json'));
    expect(m.name).toBe('staleproof');
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins).toHaveLength(1);
    expect(m.plugins[0]).toMatchObject({ name: 'staleproof', source: './plugins/claude-code' });
    expect(existsSync(join(ROOT, m.plugins[0]!.source, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('the manifest, hooks, MCP server, skill and commands have the shapes Claude Code loads', async () => {
    const manifest = await json<{ name: string; version: string; description: string; author: { name: string }; homepage: string }>(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(manifest.name).toBe('staleproof');
    expect(() => new URL(manifest.homepage)).not.toThrow();
    // Only the manifest lives in .claude-plugin/; every component is at the plugin root.
    expect(await readdir(join(PLUGIN, '.claude-plugin'))).toEqual(['plugin.json']);

    const hooks = await json<{ hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number; async?: boolean }[] }[]> }>(join(PLUGIN, 'hooks', 'hooks.json'));
    expect(Object.keys(hooks.hooks)).toEqual(['SessionStart', 'PostToolUse', 'Stop']);
    expect(hooks.hooks.PostToolUse![0]!.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    const commands = Object.values(hooks.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    for (const h of commands) {
      expect(h.type).toBe('command');
      // Quoted, so a plugin path with spaces stays one argument.
      expect(h.command).toMatch(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/staleproof\.mjs" hook (session-start|post-edit|stop)$/);
      expect(h.timeout).toBeGreaterThan(0);
    }
    expect(hooks.hooks.SessionStart![0]!.hooks[0]!.async).toBe(true);

    const mcp = await json<{ mcpServers: Record<string, { command: string; args: string[] }> }>(join(PLUGIN, '.mcp.json'));
    expect(mcp.mcpServers.staleproof).toEqual({ command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs', 'mcp'] });

    const skill = frontmatter(await readFile(join(PLUGIN, 'skills', 'staleproof', 'SKILL.md'), 'utf8'));
    expect(skill.name).toBe('staleproof');
    expect(skill.description!.length).toBeLessThan(1536);
    expect((await readdir(join(PLUGIN, 'commands'))).sort()).toEqual(['audit.md', 'check.md', 'docs-for.md', 'fix.md']);
    for (const c of ['audit', 'check', 'docs-for', 'fix']) {
      const text = await readFile(join(PLUGIN, 'commands', `${c}.md`), 'utf8');
      expect(frontmatter(text).description, c).toBeTruthy();
      expect(text, c).toContain('${CLAUDE_PLUGIN_ROOT}/scripts/staleproof.mjs');
    }
    // A top-level bin/ keeps a plugin out of claude.ai and Cowork; the script lives in scripts/.
    expect(existsSync(join(PLUGIN, 'bin'))).toBe(false);
  });

  it('pins one release everywhere: plugin.json, the CLI resolver, and this package (or the release being prepared)', async () => {
    const manifest = await json<{ version: string }>(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    const script = await readFile(SCRIPT, 'utf8');
    const pinned = /const PINNED = '([\d.]+)'/.exec(script)?.[1];
    expect(pinned).toBe(manifest.version);
    const pkg = await json<{ version: string }>(join(ROOT, 'package.json'));
    const [major, minor] = pkg.version.split('.').map(Number) as [number, number];
    expect([pkg.version, `${major}.${minor + 1}.0`]).toContain(manifest.version);
  });

  it('the resolver is executable, passes arguments and stdin through, and never fails a hook', async () => {
    accessSync(SCRIPT, constants.X_OK);
    const dir = await fakeCli();
    const cli = join(dir, 'dist', 'cli.js');
    expect(runScript(['lint', '--new'], { STALEPROOF_CLI: cli })).toEqual({ code: 0, out: { entry: 'cli', args: ['lint', '--new'], input: '{"x":1}' } });
    expect(runScript(['lint', '--exit-3'], { STALEPROOF_CLI: cli }).code).toBe(3);
    expect(runScript(['hook', 'stop', '--exit-3'], { STALEPROOF_CLI: cli }).code).toBe(0);
    // With dist/hook.js beside dist/cli.js, hooks skip loading the whole CLI.
    await writeFile(join(dir, 'dist', 'hook.js'), (await readFile(cli, 'utf8')).replace("entry: 'cli'", "entry: 'hook'"));
    expect(runScript(['hook', 'post-edit'], { STALEPROOF_CLI: cli }).out).toEqual({ entry: 'hook', args: ['post-edit'], input: '{"x":1}' });
    expect(runScript(['lint'], { STALEPROOF_CLI: cli }).out?.entry).toBe('cli');
  });

  it("the resolver finds the project's own staleproof when it is recent enough", async () => {
    const project = await mkdtemp(join(tmpdir(), 'staleproof-project-'));
    const pkgDir = join(project, 'node_modules', 'staleproof');
    await mkdir(join(pkgDir, 'dist'), { recursive: true });
    await writeFile(join(pkgDir, 'dist', 'cli.js'), (await readFile(join(await fakeCli(), 'dist', 'cli.js'), 'utf8')).replace("entry: 'cli'", "entry: 'project'"));
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'staleproof', version: '0.5.0' }));
    const env = { CLAUDE_PROJECT_DIR: join(project, 'sub'), STALEPROOF_CLI: '' };
    await mkdir(join(project, 'sub'));
    expect(runScript(['lint'], env).out?.entry).toBe('project');
  });

  it('passes `claude plugin validate` when the claude CLI is installed', () => {
    let claude = '';
    try {
      claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    } catch {
      return;
    }
    if (!claude) return;
    for (const dir of [PLUGIN, ROOT]) {
      const out = execFileSync(claude, ['plugin', 'validate', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(out).toMatch(/Validation passed/);
    }
  });
});
