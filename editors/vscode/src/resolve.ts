import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * The Staleproof release this extension is built for: what `npx -y staleproof@<version>`
 * runs when no install is found. Set at each release (the extension ships with the CLI).
 */
export const STALEPROOF_VERSION = '0.6.0';

/** The first release with `staleproof lsp`: an older install is passed over. */
export const MIN_LSP_VERSION = '0.6.0';

export interface ServerCommand {
  command: string;
  /** Arguments before `lsp`. */
  args: string[];
  /** Where it was found: the `staleproof.path` setting, the workspace, the PATH, or npx. */
  source: 'setting' | 'workspace' | 'global' | 'npx';
  /** Windows `.cmd` shims only start through a shell. */
  shell: boolean;
  version?: string;
}

export interface ResolveOptions {
  /** The `staleproof.path` setting. */
  configured?: string;
  /** Workspace folder paths, first one first. */
  folders: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `staleproof --version` of an executable, or undefined when it does not run. */
  versionOf?: (command: string, shell: boolean) => Promise<string | undefined>;
  /** Whether a path is a file (tests stub it). */
  isFile?: (path: string) => boolean;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Compare `a.b.c` versions (pre-release tags ignored): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function defaultVersionOf(command: string, shell: boolean): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(shell ? `"${command}"` : command, ['--version'], { timeout: 20_000, shell, windowsHide: true }, (err, stdout) => {
      done(err ? undefined : /\d+\.\d+\.\d+[\w.-]*/.exec(String(stdout))?.[0]);
    });
  });
}

/** `~` and `${workspaceFolder}` in the setting, relative paths against the first folder. */
export function expandPath(value: string, folders: string[], home = homedir()): string {
  let p = value.trim().replace(/\$\{workspaceFolder\}/g, folders[0] ?? '.');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(1));
  return isAbsolute(p) || !folders[0] || !/[\\/]/.test(p) ? p : resolve(folders[0], p);
}

/**
 * How to start `staleproof lsp`: the `staleproof.path` setting; else the workspace's own
 * install (`node_modules/.bin/staleproof`), then one on the PATH, each only when it is
 * new enough to have the `lsp` command; else `npx -y staleproof@<STALEPROOF_VERSION>`.
 */
export async function resolveServer(o: ResolveOptions): Promise<ServerCommand> {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const isFile = o.isFile ?? fileExists;
  const versionOf = o.versionOf ?? defaultVersionOf;
  const win = platform === 'win32';
  const shellFor = (cmd: string) => win && /\.(cmd|bat)$/i.test(cmd);

  if (o.configured?.trim()) {
    const command = expandPath(o.configured, o.folders);
    return { command, args: [], source: 'setting', shell: shellFor(command) };
  }

  const names = win ? ['staleproof.cmd', 'staleproof.exe', 'staleproof'] : ['staleproof'];
  const usable = async (command: string, source: ServerCommand['source']): Promise<ServerCommand | undefined> => {
    const shell = shellFor(command);
    const version = await versionOf(command, shell);
    if (!version || compareVersions(version, MIN_LSP_VERSION) < 0) return undefined;
    return { command, args: [], source, shell, version };
  };

  for (const folder of o.folders) {
    for (const name of names) {
      const bin = join(folder, 'node_modules', '.bin', name);
      if (isFile(bin)) {
        const found = await usable(bin, 'workspace');
        if (found) return found;
        break;
      }
    }
  }

  const path = (win ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  for (const dir of path.split(win ? ';' : delimiter).filter(Boolean)) {
    for (const name of names) {
      const bin = join(dir, name);
      if (isFile(bin)) {
        const found = await usable(bin, 'global');
        if (found) return found;
      }
    }
  }

  const npx = win ? 'npx.cmd' : 'npx';
  return { command: npx, args: ['-y', `staleproof@${STALEPROOF_VERSION}`], source: 'npx', shell: win };
}
