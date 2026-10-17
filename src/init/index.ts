import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createTwoFilesPatch } from 'diff';
import { packageVersion } from '../pkg.js';
import { detect, type Detected } from './detect.js';
import {
  claudeHooks,
  claudeSettingsWithHooks,
  cliCommand,
  configToml,
  cursorHooksWithStaleproof,
  gitignoreWithStaleproof,
  huskyWithStaleproof,
  lefthookWithStaleproof,
  preCommitEntry,
  preCommitWithStaleproof,
  readmeWithBadge,
  badgeMarkdown,
  VSCODE_EXTENSION,
  vscodeExtensionsWith,
  workflowYaml,
} from './files.js';

export { detect, type Detected } from './detect.js';

export const INIT_ITEMS = ['config', 'workflow', 'badge', 'pre-commit', 'gitignore', 'claude', 'cursor', 'vscode'] as const;
export type InitItem = (typeof INIT_ITEMS)[number];
/** What `--skip` leaves out (the agent hooks are opt-in: `--claude`, `--cursor`). */
export const INIT_SKIPS: InitItem[] = ['config', 'workflow', 'badge', 'pre-commit', 'gitignore', 'vscode'];

/** Questions `init` asks in a terminal; without one it takes the detected defaults. */
export interface Asker {
  confirm(question: string, byDefault: boolean): Promise<boolean>;
  text(question: string, byDefault: string): Promise<string>;
  close?(): void;
}

export interface InitOptions {
  dir: string;
  /** Print the plan, write nothing. */
  dryRun?: boolean;
  /** Add the Claude Code hooks to `.claude/settings.json`. */
  claude?: boolean;
  /** Add the Cursor hooks to `.cursor/hooks.json`. */
  cursor?: boolean;
  /** `owner/name` of a separate docs repository. */
  docsRepo?: string;
  skip?: InitItem[];
  /** Interactive: ask before each file. */
  ask?: Asker;
  /** The Staleproof release hooks and pre-commit pin (default: this one). */
  version?: string;
}

export interface PlannedFile {
  item: InitItem;
  /** Repository-relative. */
  path: string;
  /** `manual`: init could not edit the file safely; `snippet` says what to add. */
  action: 'create' | 'update' | 'unchanged' | 'manual';
  note: string;
  before?: string;
  content?: string;
  executable?: boolean;
  snippet?: string;
}

export interface InitResult {
  detected: Detected;
  files: PlannedFile[];
  next: string[];
  /** Repository-relative paths written (none on a dry run). */
  written: string[];
  text: string;
}

async function read(root: string, path: string): Promise<string | undefined> {
  return readFile(join(root, path), 'utf8').catch(() => undefined);
}

function change(item: InitItem, path: string, before: string | undefined, content: string | undefined, note: string, unchangedNote: string): PlannedFile {
  if (content === undefined) return { item, path, action: 'unchanged', note: unchangedNote };
  return { item, path, action: before === undefined ? 'create' : 'update', note, ...(before !== undefined ? { before } : {}), content };
}

/** What `staleproof init` would write, given what it detected; nothing is written. */
export async function planInit(d: Detected, opts: Omit<InitOptions, 'dir' | 'ask'> & { docsRepo?: string }): Promise<PlannedFile[]> {
  const root = d.root;
  const version = opts.version ?? packageVersion();
  const skip = new Set(opts.skip ?? []);
  const cli = cliCommand(d, version);
  const out: PlannedFile[] = [];

  if (!skip.has('config')) {
    const pyproject = await read(root, 'pyproject.toml');
    if (existsSync(join(root, '.staleproof.toml'))) out.push({ item: 'config', path: '.staleproof.toml', action: 'unchanged', note: 'exists, left as it is' });
    else if (pyproject && /^\[tool\.staleproof(\.|\])/m.test(pyproject)) out.push({ item: 'config', path: 'pyproject.toml', action: 'unchanged', note: 'has [tool.staleproof], left as it is' });
    else out.push({ item: 'config', path: '.staleproof.toml', action: 'create', note: 'settings, with what init found', content: configToml(d) });
  }

  if (!skip.has('workflow')) {
    const path = '.github/workflows/staleproof.yml';
    const dir = join(root, '.github', 'workflows');
    const others = existsSync(dir) ? await readdir(dir).catch(() => [] as string[]) : [];
    let runs: string | undefined;
    for (const f of others.filter((x) => /\.ya?ml$/.test(x))) if (/rajkaria\/staleproof@/.test((await read(root, `.github/workflows/${f}`)) ?? '')) runs ??= `.github/workflows/${f}`;
    if (runs) out.push({ item: 'workflow', path: runs, action: 'unchanged', note: 'already runs Staleproof, left as it is' });
    else out.push({ item: 'workflow', path, action: 'create', note: 'the pull request check and a weekly audit', content: workflowYaml(d, opts.docsRepo).replace('your-org/docs', d.docsRepoGuess ?? 'your-org/docs') });
  }

  if (!skip.has('badge') && d.readme && d.repo) {
    const before = (await read(root, d.readme))!;
    const after = readmeWithBadge(before, d.repo);
    if (after !== undefined) out.push({ item: 'badge', path: d.readme, action: 'update', note: 'the docs health badge, after the title', before, content: after });
    else if (before.includes('staleproof.dev/api/badge/')) out.push({ item: 'badge', path: d.readme, action: 'unchanged', note: 'has the badge' });
    else out.push({ item: 'badge', path: d.readme, action: 'manual', note: 'starts with HTML: add the badge where it fits', snippet: badgeMarkdown(d.repo) });
  }

  if (!skip.has('pre-commit')) {
    if (d.preCommitConfig || (d.python && !d.lefthook && !d.husky)) {
      const path = '.pre-commit-config.yaml';
      const before = await read(root, path);
      const after = preCommitWithStaleproof(before, version);
      if (after === undefined && before !== undefined && !/rajkaria\/staleproof/.test(before))
        out.push({ item: 'pre-commit', path, action: 'manual', note: 'has no `repos:` list init can add to', snippet: preCommitEntry(version) });
      else out.push(change('pre-commit', path, before, after, 'the staleproof pre-commit hook', 'has the staleproof hook'));
    } else if (d.lefthook) {
      const before = (await read(root, d.lefthook))!;
      const after = lefthookWithStaleproof(before, cli);
      if (after === undefined && !/staleproof/.test(before))
        out.push({ item: 'pre-commit', path: d.lefthook, action: 'manual', note: 'has a pre-commit: block; add the command to it', snippet: `    staleproof:\n      run: ${cli} lint --new --staged` });
      else out.push(change('pre-commit', d.lefthook, before, after, 'a staleproof pre-commit command', 'has a staleproof command'));
    } else if (d.husky) {
      const path = '.husky/pre-commit';
      const before = await read(root, path);
      const planned = change('pre-commit', path, before, huskyWithStaleproof(before, cli), 'staleproof lint on the staged docs', 'runs staleproof');
      out.push(planned.action === 'create' ? { ...planned, executable: true } : planned);
    }
  }

  if (!skip.has('gitignore')) {
    const before = await read(root, '.gitignore');
    out.push(change('gitignore', '.gitignore', before, gitignoreWithStaleproof(before), '.staleproof/ (the local parse cache)', 'ignores .staleproof/'));
  }

  if (opts.claude && !skip.has('claude')) {
    const path = '.claude/settings.json';
    const before = await read(root, path);
    try {
      out.push(change('claude', path, before, claudeSettingsWithHooks(before, cli), 'Claude Code hooks: after each edit, and before stopping', 'has the Staleproof hooks'));
    } catch {
      out.push({ item: 'claude', path, action: 'manual', note: 'is not plain JSON: add the hooks by hand', snippet: JSON.stringify({ hooks: claudeHooks(cli) }, null, 2) });
    }
  }

  if (opts.cursor && !skip.has('cursor')) {
    const path = '.cursor/hooks.json';
    const before = await read(root, path);
    try {
      out.push(change('cursor', path, before, cursorHooksWithStaleproof(before, cli), 'Cursor hooks: after each edit, and before stopping', 'has the Staleproof hooks'));
    } catch {
      out.push({ item: 'cursor', path, action: 'manual', note: 'is not plain JSON: add the hooks by hand', snippet: cursorHooksWithStaleproof(undefined, cli) });
    }
  }

  if (VSCODE_EXTENSION && !skip.has('vscode')) {
    const path = '.vscode/extensions.json';
    const before = await read(root, path);
    try {
      out.push(change('vscode', path, before, vscodeExtensionsWith(before, VSCODE_EXTENSION), 'recommends the Staleproof extension', 'recommends the extension'));
    } catch {
      // A commented extensions.json: leave it to the user.
    }
  }
  return out;
}

function nextSteps(d: Detected, files: PlannedFile[], dryRun: boolean): string[] {
  const did = (item: InitItem) => files.some((f) => f.item === item && (f.action === 'create' || f.action === 'update'));
  const next: string[] = [];
  if (dryRun) next.push('Run it again without --dry-run to write these files.');
  if (did('workflow')) next.push('Commit and push .github/workflows/staleproof.yml: the next pull request gets the Staleproof comment.');
  if (files.some((f) => f.path === '.pre-commit-config.yaml' && f.action !== 'unchanged')) next.push('Run `pre-commit install` once in each clone, so the hook runs on commit.');
  if (did('claude')) next.push('Claude Code reads .claude/settings.json at its next start. (Or use the plugin instead: /plugin marketplace add rajkaria/staleproof, then /plugin install staleproof@staleproof.)');
  else if (d.claude && !files.some((f) => f.item === 'claude')) next.push('Using Claude Code? /plugin marketplace add rajkaria/staleproof, then /plugin install staleproof@staleproof (or run init again with --claude).');
  if (did('cursor')) next.push('Cursor reads .cursor/hooks.json when it reopens the project.');
  next.push(`See what is stale now: ${d.staleproofDependency ? 'npx --no-install staleproof' : 'npx -y staleproof'} lint`);
  return next;
}

function summaryLine(d: Detected): string {
  const parts = [d.languages.join(', ') || 'no code found', d.docsDirs.length ? `docs in ${d.docsDirs.map((x) => `${x}/`).join(', ')}` : 'no docs folder', d.agentFiles.length ? `agent files: ${d.agentFiles.join(', ')}` : 'no agent files'];
  return `Staleproof init${d.repo ? `: ${d.repo}` : ''} (${parts.join('; ')})`;
}

/** The plan as `init` prints it; on a dry run, with each file's content (new files) or diff (changed ones). */
export function formatInit(d: Detected, files: PlannedFile[], next: string[], opts: { dryRun?: boolean; written?: string[] } = {}): string {
  const width = Math.max(10, ...files.map((f) => f.path.length));
  const out = [summaryLine(d), ''];
  for (const f of files) out.push(`  ${f.action.padEnd(9)}  ${f.path.padEnd(width)}  ${f.note}`);
  if (!files.length) out.push('  nothing to do');
  for (const f of files.filter((x) => x.action === 'manual' && x.snippet)) out.push('', `Add to ${f.path}:`, '', f.snippet!);
  if (opts.dryRun) {
    out.push('', 'Dry run: nothing was written.');
    for (const f of files.filter((x) => x.content !== undefined)) {
      out.push('');
      if (f.action === 'create') out.push(`--- ${f.path} (new)`, f.content!.replace(/\n$/, ''));
      else out.push(createTwoFilesPatch(f.path, f.path, f.before ?? '', f.content!, '', '', { context: 2 }).replace(/^Index: .*\n=+\n/, '').replace(/\n$/, ''));
    }
  } else if (opts.written) {
    out.push('', opts.written.length ? `Wrote ${opts.written.length} file${opts.written.length === 1 ? '' : 's'}.` : 'Everything was in place already: nothing written.');
  }
  out.push('', 'Next:', ...next.map((n, i) => `  ${i + 1}. ${n}`));
  return out.join('\n');
}

/** `readline` questions on the terminal. */
export function terminalAsker(): Asker {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async confirm(q, byDefault) {
      const a = (await rl.question(`${q} ${byDefault ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
      return a ? a.startsWith('y') : byDefault;
    },
    async text(q, byDefault) {
      const a = (await rl.question(`${q}${byDefault ? ` [${byDefault}]` : ''} `)).trim();
      return a || byDefault;
    },
    close: () => rl.close(),
  };
}

/**
 * `staleproof init`: detect, plan, ask (in a terminal), write. Idempotent: what is in
 * place already is left as it is, so a second run writes nothing.
 */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const d = await detect(opts.dir);
  const ask = opts.ask;
  try {
    let docsRepo = opts.docsRepo;
    let claude = opts.claude;
    let cursor = opts.cursor;
    if (ask) {
      if (!docsRepo && d.docsRepoGuess) docsRepo = (await ask.text('Docs in another repository (owner/name, "-" for none)?', d.docsRepoGuess)).replace(/^-$/, '') || undefined;
      if (claude === undefined && d.claude) claude = await ask.confirm('Add Staleproof hooks for Claude Code to .claude/settings.json (or use the plugin)?', false);
      if (cursor === undefined && d.cursor) cursor = await ask.confirm('Add Staleproof hooks to .cursor/hooks.json?', true);
    }
    let files = await planInit(d, { ...opts, docsRepo, claude, cursor });
    if (ask && !opts.dryRun) {
      const kept: PlannedFile[] = [];
      for (const f of files) {
        if ((f.action === 'create' || f.action === 'update') && !(await ask.confirm(`${f.action === 'create' ? 'Create' : 'Update'} ${f.path} (${f.note})?`, true))) continue;
        kept.push(f);
      }
      files = kept;
    }
    const written: string[] = [];
    if (!opts.dryRun) {
      for (const f of files) {
        if (f.content === undefined || (f.action !== 'create' && f.action !== 'update')) continue;
        const full = join(d.root, f.path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, f.content);
        if (f.executable) await chmod(full, 0o755);
        written.push(f.path);
      }
    }
    const next = nextSteps(d, files, !!opts.dryRun);
    return { detected: d, files, next, written, text: formatInit(d, files, next, { dryRun: opts.dryRun, written: opts.dryRun ? undefined : written }) };
  } finally {
    ask?.close?.();
  }
}
