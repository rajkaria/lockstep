import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';


export const FIX_APP = join(import.meta.dirname, 'fixtures', 'fixes', 'app');

export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  }).trim();
}

export async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

export async function edit(dir: string, path: string, change: (text: string) => string): Promise<void> {
  await writeFile(join(dir, path), change(await readFile(join(dir, path), 'utf8')));
}

/** The fixture app as a git repository on `main` with one commit (the base); returns its directory and the base sha. */
export async function baseRepo(from = FIX_APP): Promise<{ dir: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-fixes-'));
  await cp(from, dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/**
 * The head change: a script, a Make target, a flag and an env var renamed, a file and a
 * docs page moved; the docs still name the old ones.
 */
export async function headChange(dir: string): Promise<void> {
  await edit(dir, 'package.json', (t) => t.replace('"lint:docs"', '"docs:lint"'));
  await edit(dir, 'Makefile', (t) => t.replace(/check-docs/g, 'docs-check'));
  await edit(dir, 'mypkg/cli.py', (t) => t.replace('"--quiet"', '"--silent"'));
  await mkdir(join(dir, 'src', 'config'), { recursive: true });
  git(dir, 'mv', 'src/settings/defaults.ts', 'src/config/defaults.ts');
  await edit(dir, 'src/app.ts', (t) => t.replace('./settings/defaults.js', './config/defaults.js'));
  git(dir, 'mv', 'docs/old-guide.md', 'docs/guide.md');
}

export const FIX_MORE = join(import.meta.dirname, 'fixtures', 'fixes', 'more');

/** The app plus the `more` overlay (examples, a nested page, a second CLI) as one base commit. */
export async function moreRepo(): Promise<{ dir: string; base: string }> {
  const { dir } = await baseRepo();
  await cp(FIX_MORE, dir, { recursive: true });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'more');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}

/** The `more` head change: a heading, a subcommand and a parameter renamed. */
export async function moreChange(dir: string): Promise<void> {
  await edit(dir, 'docs/api.md', (t) => t.replace('## Connecting', '## Connections'));
  await edit(dir, 'mypkg/cli2.py', (t) => t.replace('"sync"', '"pull"'));
  await edit(dir, 'mypkg/tools.py', (t) => t.replace('retries: int = 3', 'attempts: int = 3'));
}
