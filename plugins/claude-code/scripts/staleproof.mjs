#!/usr/bin/env node
// Runs Staleproof for the Claude Code plugin with the first CLI that has `staleproof hook`:
// the project's own (node_modules, this folder or a parent), a global install, else the
// release this plugin was made with, through npx. Hooks never fail the agent: whatever
// happens, `hook` exits 0.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** The release this plugin version ships with (kept equal to plugin.json and package.json by a test). */
const PINNED = '0.6.1';
/** The first release with `staleproof hook`. */
const MIN = [0, 5];

const args = process.argv.slice(2);
const isHook = args[0] === 'hook';

function version(pkg) {
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version;
  } catch {
    return undefined;
  }
}

function recent(v) {
  const [major, minor] = String(v ?? '').split('.').map(Number);
  return major > MIN[0] || (major === MIN[0] && minor >= MIN[1]);
}

/** `node_modules/staleproof` in the project or a folder above it. */
function projectCli(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const pkg = join(dir, 'node_modules', 'staleproof', 'package.json');
    const cli = join(dir, 'node_modules', 'staleproof', 'dist', 'cli.js');
    if (existsSync(cli) && recent(version(pkg))) return [process.execPath, [cli]];
    if (dirname(dir) === dir) return undefined;
  }
}

/** A `staleproof` on PATH whose package is recent enough (npm, pnpm and Volta link to dist/cli.js). */
function globalCli() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, 'staleproof');
    if (!existsSync(bin)) continue;
    try {
      const cli = realpathSync(bin);
      if (cli.endsWith('.js') && recent(version(join(dirname(cli), '..', 'package.json')))) return [process.execPath, [cli]];
    } catch {
      // A broken link: try the next folder.
    }
  }
  return undefined;
}

function resolveCli() {
  // For trying a checkout of Staleproof itself: STALEPROOF_CLI=/path/to/dist/cli.js
  if (process.env.STALEPROOF_CLI) return [process.execPath, [process.env.STALEPROOF_CLI]];
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return projectCli(start) ?? globalCli() ?? [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', `staleproof@${PINNED}`]];
}

const [command, cli] = resolveCli();
let argv = [...cli, ...args];
// `dist/hook.js` runs the hooks without loading the rest of the CLI: faster on every edit.
const hookEntry = command === process.execPath && /[\\/]dist[\\/]cli\.js$/.test(cli[0] ?? '') ? join(dirname(cli[0]), 'hook.js') : undefined;
if (isHook && hookEntry && existsSync(hookEntry)) argv = [hookEntry, ...args.slice(1)];
const child = spawn(command, argv, { stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') });
child.on('error', () => process.exit(isHook ? 0 : 1));
child.on('exit', (code, signal) => process.exit(isHook ? 0 : (code ?? (signal ? 1 : 0))));
