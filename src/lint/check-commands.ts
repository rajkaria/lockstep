import { posix } from 'node:path';
import type { RawFinding } from './engine.js';
import type { RepoFacts } from './facts.js';
import {
  closeNames,
  joinDir,
  listNames,
  normalizeDist,
  patternMatches,
  scriptFacts,
  upward,
  type MakeFacts,
  type PackageManifest,
  type PyProjectFacts,
  type ScriptFacts,
} from './facts-scripts.js';
import { isShellLang, type ScannedDoc, type Span } from './scan.js';
import type { Surface } from './types.js';

/**
 * Commands in docs, parsed the way a shell would: inline code spans and the lines of
 * shell blocks, with prompts, `VAR=value` prefixes, `sudo`/`env` wrappers, `cd`
 * (tracked through the block), `&&`/`||`/`;`/`|` chains, `\` continuations, comments
 * and heredocs handled, and every word located on its exact line and column.
 */

export interface Word extends Span {
  /** Contains `$VAR`, `$(...)`, backticks or a glob: its value is not what is written. */
  dynamic: boolean;
}

/** Where a command runs, relative to the repository root; `null` when unknown (`cd $DIR`, `cd my-new-app`). */
export interface Cwd {
  dir: string;
  /** Set by an explicit `cd`; otherwise the page's context (its folder, then the root). */
  explicit: boolean;
}

export interface ShellCommand {
  words: Word[];
  cwd: Cwd | null;
  /** From an inline code span rather than a shell block. */
  inline: boolean;
  /** The command is about another project: an earlier line scaffolds or clones one, or the page `cd`s into folders this repository does not have. */
  afterScaffold: boolean;
}

interface Ch {
  c: string;
  line: number;
  col: number;
}

const PROMPT = /^\s*(?:\$|%|❯|➜|>|PS(?: [^>]*)?>)\s/;
const DOLLAR_PROMPT = /^\s*\$\s/;

/** Characters of `text` placed at `line`, starting at 1-based `col`. */
function charsOf(text: string, line: number, col: number): Ch[] {
  return [...text].map((c, i) => ({ c, line, col: col + i }));
}

/** Logical command lines of a page: spans and shell-block lines (prompts stripped, continuations joined). */
function logicalLines(doc: ScannedDoc): { chars: Ch[]; inline: boolean; fence?: number }[] {
  const out: { chars: Ch[]; inline: boolean; fence?: number }[] = [];
  for (const span of doc.spans) {
    const text = span.text.replace(/^\$\s+/, '');
    out.push({ chars: charsOf(text, span.line, span.column + (span.text.length - text.length)), inline: true });
  }
  doc.fences.forEach((fence, fi) => {
    const shell = isShellLang(fence.lang);
    if (!shell && fence.lang !== '') return;
    const promptRe = shell ? PROMPT : DOLLAR_PROMPT;
    const prompted = fence.lines.some((l) => promptRe.test(l.text));
    if (!shell && !prompted) return;
    let heredoc: string | null = null;
    let acc: Ch[] | null = null;
    for (const fl of fence.lines) {
      const raw = doc.lines[fl.line - 1] ?? fl.text;
      const offset = raw.length - fl.text.length;
      let text = fl.text;
      let col = offset + 1;
      if (heredoc !== null) {
        if (text.trim() === heredoc) heredoc = null;
        continue;
      }
      if (acc === null) {
        if (prompted) {
          const m = promptRe.exec(text);
          if (!m) continue; // output
          col += m[0].length;
          text = text.slice(m[0].length);
        }
      } else if (prompted) {
        const m = /^\s*>\s/.exec(text);
        if (m) {
          col += m[0].length;
          text = text.slice(m[0].length);
        }
      }
      const cont = /(^|[^\\])\\\s*$/.test(text);
      const body = cont ? text.replace(/\\\s*$/, '') : text;
      const chars = charsOf(body, fl.line, col);
      acc = acc ? [...acc, { c: ' ', line: fl.line, col }, ...chars] : chars;
      if (cont) continue;
      out.push({ chars: acc, inline: false, fence: fi });
      const hd = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(acc.map((c) => c.c).join(''));
      if (hd && !/<<</.test(acc.map((c) => c.c).join(''))) heredoc = hd[2]!;
      acc = null;
    }
    if (acc) out.push({ chars: acc, inline: false, fence: fi });
  });
  return out;
}

/** Split one logical line into commands (words), at `&&`, `||`, `;`, `|`, `&`, parentheses. Undefined when a quote is unbalanced. */
export function tokenize(chars: Ch[]): Word[][] | undefined {
  const cmds: Word[][] = [[]];
  let cur: { text: string; start: Ch; end: Ch; dynamic: boolean } | null = null;
  const flush = () => {
    if (cur) cmds.at(-1)!.push({ text: cur.text, line: cur.start.line, column: cur.start.col, endColumn: cur.end.col + 1, dynamic: cur.dynamic });
    cur = null;
  };
  const add = (ch: Ch, c = ch.c, dynamic = false) => {
    if (!cur) cur = { text: '', start: ch, end: ch, dynamic: false };
    cur.text += c;
    cur.end = ch;
    cur.dynamic ||= dynamic;
  };
  const sep = () => {
    flush();
    if (cmds.at(-1)!.length) cmds.push([]);
  };
  let skipNextWord = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const c = ch.c;
    const next = chars[i + 1]?.c;
    if (/\s/.test(c)) {
      if (cur && skipNextWord) {
        cur = null;
        skipNextWord = false;
      } else flush();
      continue;
    }
    if (c === '#' && !cur) break;
    if (c === '\\') {
      if (i + 1 < chars.length) add(chars[++i]!);
      continue;
    }
    if (c === "'") {
      const close = chars.findIndex((x, k) => k > i && x.c === "'");
      if (close < 0) return undefined;
      if (!cur) cur = { text: '', start: ch, end: ch, dynamic: false };
      for (let k = i + 1; k < close; k++) add(chars[k]!);
      cur!.end = chars[close]!;
      i = close;
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      if (!cur) cur = { text: '', start: ch, end: ch, dynamic: false };
      for (; k < chars.length && chars[k]!.c !== '"'; k++) {
        if (chars[k]!.c === '\\' && k + 1 < chars.length) k++;
        add(chars[k]!, chars[k]!.c, chars[k]!.c === '$' || chars[k]!.c === '`');
      }
      if (k >= chars.length) return undefined;
      cur!.end = chars[k]!;
      i = k;
      continue;
    }
    if (c === '$' || c === '`') {
      // `$VAR`, `${X}`, `$(cmd)`, backticks: one dynamic word.
      if (next === '(' || next === '{' || c === '`') {
        const open = c === '`' ? '`' : next!;
        const closeCh = open === '(' ? ')' : open === '{' ? '}' : '`';
        let depth = 0;
        let k = c === '`' ? i + 1 : i + 2;
        add(ch, c, true);
        if (c !== '`') add(chars[i + 1]!, open, true);
        for (; k < chars.length; k++) {
          const x = chars[k]!.c;
          add(chars[k]!, x, true);
          if (open !== '`' && x === open) depth++;
          else if (x === closeCh) {
            if (depth === 0) break;
            depth--;
          }
        }
        i = k;
        continue;
      }
      add(ch, c, true);
      continue;
    }
    if (c === '&' && next === '&') {
      sep();
      i++;
      continue;
    }
    if (c === '|') {
      sep();
      if (next === '|' || next === '&') i++;
      continue;
    }
    if (c === ';' || c === '(' || c === ')') {
      sep();
      continue;
    }
    if (c === '&') {
      if (next === '>') {
        flush();
        i++;
        if (chars[i + 1]?.c === '>') i++;
        skipNextWord = true;
        continue;
      }
      sep();
      continue;
    }
    if (c === '<') {
      // `<placeholder>` in docs (`tool index <repo>`, `pkg@<version>`) is a word, not a redirection.
      const rest = chars.slice(i, i + 80).map((x) => x.c).join('');
      const ph = /^<[A-Za-z_][^\s<>]*>/.exec(rest);
      if (ph) {
        for (let k = 0; k < ph[0].length; k++) add(chars[i + k]!, chars[i + k]!.c, true);
        i += ph[0].length - 1;
        continue;
      }
    }
    // `pkg>=1.2`, `x<=2`: a version specifier, not a redirection.
    if ((c === '>' || c === '<') && next === '=' && cur) {
      add(ch);
      continue;
    }
    if (c === '>' || c === '<') {
      // Redirection: `> file`, `2>&1`, `<file`; a digit word right before is the fd.
      if (cur && /^\d+$/.test(cur.text)) cur = null;
      else flush();
      while (chars[i + 1]?.c === '>' || chars[i + 1]?.c === '<') i++;
      if (chars[i + 1]?.c === '&') {
        i++;
        while (/[\d-]/.test(chars[i + 1]?.c ?? '')) i++;
        continue;
      }
      skipNextWord = true;
      continue;
    }
    if (/[*?]/.test(c)) {
      add(ch, c, true);
      continue;
    }
    if (skipNextWord && !cur) {
      cur = { text: '', start: ch, end: ch, dynamic: false };
      cur.text += c;
      continue;
    }
    add(ch);
  }
  if (cur && skipNextWord) cur = null;
  flush();
  return cmds.filter((c) => c.length);
}

const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'noglob', 'cross-env', 'dotenv', 'caffeinate', 'nice', 'xvfb-run']);

/** Drop `VAR=value` prefixes and wrappers (`sudo -E`, `env -i`, `cross-env NODE_ENV=x`, `npx cross-env`). */
export function stripPrefixes(words: Word[]): Word[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (!w) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)) {
      i++;
      continue;
    }
    if (w.text === 'npx' && words[i + 1]?.text === 'cross-env') {
      i += 2;
      continue;
    }
    if (WRAPPERS.has(w.text)) {
      i++;
      while (words[i] && words[i]!.text.startsWith('-')) {
        // `sudo -u user`, `env -u NAME`, `dotenv -e .env --`
        if (/^-(u|g|e|C|n)$/.test(words[i]!.text)) i++;
        if (words[i]?.text === '--') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    break;
  }
  return words.slice(i);
}

/** Commands that create or fetch another project: what follows describes that project, not this repository. */
const SCAFFOLD = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:create|init)\s+\S|npm\s+init\s+-y\b|(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec)\s+(?:-y\s+|--yes\s+)?(?:create-|@[\w-]+\/create|degit|giget|tiged|nuxi|sv\s+create|shadcn)|degit\s|cookiecutter\s|copier\s|uv\s+init|poetry\s+new|cargo\s+(?:new|init)|rails\s+new|django-admin\s+startproject)/;

const pageCommandsCache = new WeakMap<ScannedDoc, Map<string, ShellCommand[]>>();

export interface CommandContext {
  facts: RepoFacts;
  /** `owner/name`, to recognise a clone of this repository. */
  repo?: string;
}

/** Every command a page shows, with where it runs. */
export function pageCommands(doc: ScannedDoc, ctx: CommandContext): ShellCommand[] {
  const key = ctx.repo ?? '';
  let byRepo = pageCommandsCache.get(doc);
  const hit = byRepo?.get(key);
  if (hit) return hit;
  const docDir = posix.dirname(doc.path) === '.' ? '' : posix.dirname(doc.path);
  const self = (ctx.repo?.split('/').pop() ?? posix.basename(ctx.facts.root)).toLowerCase();
  const out: ShellCommand[] = [];
  let scaffoldLine = Infinity;
  let foreignLayout = false;
  const fenceCwd = new Map<number, Cwd | null>();
  const cloned = new Map<string, boolean>();
  const lines = logicalLines(doc);
  // Scaffolding anywhere on the page (an earlier line) makes later commands someone else's.
  for (const l of lines) {
    const text = l.chars.map((c) => c.c).join('');
    for (const part of text.split(/&&|\|\||;/)) {
      const t = part.trim().replace(/^\$\s+/, '');
      if (SCAFFOLD.test(t)) scaffoldLine = Math.min(scaffoldLine, l.chars[0]?.line ?? Infinity);
      const clone = /^git\s+clone\s+(.*)$/.exec(t);
      if (clone) {
        // Placeholders (`<your username>`) may hold spaces; flags may take values (`--depth 1`).
        const args = clone[1]!.replace(/<[^>]*>/g, 'X').split(/\s+/).filter(Boolean);
        const pos: string[] = [];
        for (let k = 0; k < args.length; k++) {
          if (/^(-b|--branch|-o|--origin|--depth|-c|--config|--reference|-j|--jobs|--template|-u|--upload-pack|--shallow-since|--shallow-exclude|--separate-git-dir|--filter)$/.test(args[k]!)) k++;
          else if (!args[k]!.startsWith('-')) pos.push(args[k]!);
        }
        const url = pos[0] ?? '';
        const fromUrl = url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '').toLowerCase();
        // This repository, or a fork of it (`git clone git@github.com:<you>/name.git`).
        const isSelf = !!self && fromUrl === self;
        cloned.set((pos[1] ?? fromUrl).toLowerCase(), isSelf);
        if (!isSelf) scaffoldLine = Math.min(scaffoldLine, l.chars[0]?.line ?? Infinity);
      }
      // `cd packages/core` into a folder this repository does not have: the page describes another layout.
      const cd = /^(?:cd|pushd)\s+(['"]?)([\w@.+-][\w@.+/-]*)\1\s*$/.exec(t);
      if (cd && cd[2] !== '..' && !cloned.has(cd[2]!.replace(/\/+$/, '').toLowerCase()) && cd[2]!.toLowerCase() !== self) {
        const rel = cd[2]!.replace(/\/+$/, '');
        const known = ['', docDir].some((base) => {
          const d = joinDir(base, rel);
          return d !== undefined && (d === '' || ctx.facts.isDir(d));
        });
        if (!known) foreignLayout = true;
      }
    }
  }
  for (const l of lines) {
    const cmds = tokenize(l.chars);
    if (!cmds) continue;
    let cwd: Cwd | null = l.fence !== undefined && fenceCwd.has(l.fence) ? fenceCwd.get(l.fence)! : { dir: docDir, explicit: false };
    for (const raw of cmds) {
      const words = stripPrefixes(raw);
      if (!words.length) continue;
      const head = words[0]!.text;
      if (head === 'cd' || head === 'pushd') {
        cwd = changeDir(cwd, words[1], docDir, ctx.facts, cloned, self);
        continue;
      }
      if (head === 'popd') {
        cwd = null;
        continue;
      }
      out.push({ words, cwd, inline: l.inline, afterScaffold: foreignLayout || (words[0]!.line ?? 0) > scaffoldLine });
    }
    if (l.fence !== undefined) fenceCwd.set(l.fence, cwd);
  }
  if (!byRepo) {
    byRepo = new Map();
    pageCommandsCache.set(doc, byRepo);
  }
  byRepo.set(key, out);
  return out;
}

function changeDir(cwd: Cwd | null, arg: Word | undefined, docDir: string, facts: RepoFacts, cloned: Map<string, boolean>, self?: string): Cwd | null {
  if (!arg || arg.dynamic || cwd === null) return null;
  const t = arg.text.replace(/\/+$/, '');
  if (!t || t === '-' || t.startsWith('~') || t.startsWith('/') || /[<>{}]/.test(t)) return null;
  if (cloned.has(t.toLowerCase())) return cloned.get(t.toLowerCase()) ? { dir: '', explicit: true } : null;
  if (cwd.explicit) {
    const d = joinDir(cwd.dir, t);
    return d !== undefined && facts.isDir(d) ? { dir: d, explicit: true } : null;
  }
  for (const base of ['', docDir]) {
    const d = joinDir(base, t);
    if (d !== undefined && (d === '' || facts.isDir(d))) return { dir: d, explicit: true };
  }
  // `cd staleproof` right after cloning it, written without the clone on this page.
  if (self && t.toLowerCase() === self) return { dir: '', explicit: true };
  return null;
}

// ------------------------------------------------------------------ guards

/** Names that stand for "your script here". */
const PLACEHOLDER_NAMES = new Set(['foo', 'bar', 'baz', 'qux', 'xxx', 'script', 'scripts', 'name', 'task', 'tasks', 'target', 'targets', 'command', 'cmd', 'recipe', 'example', 'something', 'whatever', 'module', 'mod', 'pkg', 'package']);

export function isPlaceholder(w: Word | undefined): boolean {
  if (!w) return true;
  const t = w.text;
  return (
    w.dynamic ||
    t.length < 2 ||
    /[<>{}[\]*…|]|\.\.\./.test(t) ||
    PLACEHOLDER_NAMES.has(t.toLowerCase()) ||
    /^[A-Z][A-Z0-9_]*$/.test(t) ||
    /^(my|your|some|the|new|other)[-_]/i.test(t)
  );
}

/** The word's line or the three lines above it mention `name` (a folder). */
function nearText(doc: ScannedDoc, w: Word, name: string): boolean {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  for (let k = w.line - 1; k >= Math.max(0, w.line - 4); k--) if (re.test(doc.lines[k] ?? '')) return true;
  return false;
}

/** The sentence says the command or option is gone (or names an old version): history, not a claim about today. */
const HISTORICAL = /\b(?:removed|renamed|deprecated|no longer|used to|previously|formerly|replaced (?:by|with)|instead of|legacy|old(?:er)? versions?|(?:before|until|prior to) v?\d|migrat(?:e|es|ed|ing|ion))\b/i;

/** The prose right above the block a word is in (up to the previous blank line, at most `max` lines). */
function proseAbove(doc: ScannedDoc, w: Word, max: number): string {
  let i = w.line - 2;
  while (i >= 0 && !/^\s*(`{3,}|~{3,})/.test(doc.lines[i]!)) i--;
  let text = '';
  for (let k = i - 1, n = 0; k >= 0 && n < max; k--, n++) {
    const l = doc.lines[k]!;
    if (!l.trim()) {
      if (text) break;
      continue;
    }
    text = `${l} ${text}`;
  }
  return text;
}

/** The line (or, in a block, the prose above it) says the command is history (a removed flag, a migration note). */
export function historical(doc: ScannedDoc, w: Word, inline: boolean): boolean {
  if (HISTORICAL.test(doc.lines[w.line - 1] ?? '')) return true;
  return !inline && HISTORICAL.test(proseAbove(doc, w, 4));
}

/** The sentence or the paragraph above a block is about the reader's own project. */
const YOUR_PROJECT = /\byour (?:own )?(?:project|app|application|repo|repository|package\.json|package|codebase|site|workspace|monorepo|ci|pipeline|workflow|makefile|justfile|taskfile|pyproject\.toml|scripts?)\b|\b(?:in|to|from) the (?:generated|new|created|scaffolded) (?:project|app|folder|directory)\b|\badd (?:this|the following|a script|these)\b[^.]*\b(?:to|in) (?:your|the) `?(?:package\.json|makefile|scripts)/i;

function aboutReader(doc: ScannedDoc, w: Word, inline: boolean): boolean {
  if (YOUR_PROJECT.test(doc.lines[w.line - 1] ?? '')) return true;
  return !inline && YOUR_PROJECT.test(proseAbove(doc, w, 6));
}

/** Script, target and task names a page itself defines in a JSON/YAML/TOML/Makefile block (`"docs:check": "..."`). */
function pageDefines(doc: ScannedDoc): Set<string> {
  const out = new Set<string>();
  for (const f of doc.fences) {
    if (isShellLang(f.lang)) continue;
    for (const l of f.lines) {
      for (const m of l.text.matchAll(/["']([\w:@./-]+)["']\s*[:=]/g)) out.add(m[1]!);
      const key = /^\s*([\w:@.-]+)\s*:/.exec(l.text);
      if (key) out.add(key[1]!);
      const toml = /^\s*([\w-]+)\s*=/.exec(l.text);
      if (toml) out.add(toml[1]!);
    }
  }
  return out;
}

/**
 * Runners whose manifest format the page itself shows (a ```yaml block with `tasks:`, a Makefile
 * or justfile block): the page teaches writing one, so its commands run the reader's file.
 */
function pageShows(doc: ScannedDoc): Set<string> {
  const out = new Set<string>();
  for (const f of doc.fences) {
    const text = f.lines.map((l) => l.text).join('\n');
    if (/^(make|makefile|mk)$/.test(f.lang) || (f.lang === '' && /^[\w.-]+:.*\n\t\S/m.test(text))) out.add('make');
    if (/^(just|justfile)$/.test(f.lang)) out.add('just');
    if (/^(ya?ml)$/.test(f.lang) && /^tasks:\s*$/m.test(text)) out.add('task');
  }
  return out;
}

// ------------------------------------------------------------------ the check

interface Judged {
  /** First and last word of the claim (the runner and the name), for the finding's span. */
  from: Word;
  name: Word;
  subject: string;
  message: string;
  looked: string;
  target?: string;
  candidates: string[];
}

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_LIFECYCLE: Record<string, string> = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop' };

/** npm/pnpm/yarn/bun options that take a value (`--prefix dir`). */
const PM_VALUE_FLAGS = new Set([
  '--prefix', '-C', '--dir', '--cwd', '-w', '--workspace', '--filter', '-F', '--loglevel', '--registry', '--userconfig', '--cache', '--tag',
  '--otp', '--reporter', '--workspace-concurrency', '--resume-from', '--test-pattern', '--changed-files-ignore-pattern', '--config',
  '--network-concurrency', '--child-concurrency', '--use-node-version', '--node-options', '--shell', '--script-shell', '--env-file',
]);

/** pnpm and yarn commands that are not scripts (`pnpm install`, `yarn add`, `yarn check`); a built-in wins over a script of the same name. */
const PM_BUILTINS = new Set([
  'add', 'audit', 'autoclean', 'bin', 'bugs', 'cache', 'cat-file', 'cat-index', 'catalog', 'check', 'ci', 'config', 'c', 'constraints',
  'create', 'dedupe', 'deploy', 'dist-tag', 'dlx', 'docs', 'doctor', 'env', 'exec', 'explain', 'fetch', 'find-hash', 'generate-lock-entry',
  'get', 'global', 'help', 'home', 'i', 'import', 'info', 'init', 'install', 'install-test', 'it', 'licenses', 'link', 'list', 'ln', 'login',
  'logout', 'ls', 'll', 'la', 'm', 'multi', 'node', 'npm', 'outdated', 'owner', 'pack', 'patch', 'patch-commit', 'patch-remove', 'plugin',
  'policies', 'prefix', 'prune', 'publish', 'rb', 'rebuild', 'recursive', 'remove', 'repo', 'restart', 'rm', 'root', 'run', 'run-script',
  'sbom', 'search', 'self-update', 'server', 'set', 'setup', 'show', 'stage', 'store', 'tag', 'team', 'un', 'uninstall', 'unlink', 'unplug',
  'up', 'update', 'upgrade', 'upgrade-interactive', 'version', 'versions', 'view', 'whoami', 'why', 'workspace', 'workspaces', 'x', 'approve-builds',
  'ignored-builds', 'runtime', 'with', 'self', 'stop', 'approve',
]);

export interface CommandCheckContext extends CommandContext {
  surface: Surface;
}

export async function checkCommands(doc: ScannedDoc, ctx: CommandCheckContext): Promise<RawFinding[]> {
  const sf = await scriptFacts(ctx.facts);
  const defined = pageDefines(doc);
  const shows = pageShows(doc);
  const out: RawFinding[] = [];
  for (const cmd of pageCommands(doc, ctx)) {
    if (cmd.cwd === null || cmd.afterScaffold) continue;
    const j = judge(cmd, doc, sf, ctx, shows);
    if (!j || defined.has(j.name.text)) continue;
    if (ctx.surface !== 'agent' && aboutReader(doc, j.name, cmd.inline)) continue;
    if (historical(doc, j.name, cmd.inline)) continue;
    // The whole command (`npm run lint:docs`) when it is written as one run of words; else just the name.
    const line = doc.lines[j.name.line - 1] ?? '';
    const whole = j.from.line === j.name.line && line.slice(j.from.column - 1, j.name.endColumn - 1) === j.subject;
    const span: Span = whole
      ? { text: j.subject, line: j.name.line, column: j.from.column, endColumn: j.name.endColumn }
      : { text: j.name.text, line: j.name.line, column: j.name.column, endColumn: j.name.endColumn };
    out.push({
      rule: 'command-missing',
      span,
      subject: j.subject,
      message: j.message,
      looked: j.looked,
      ...(j.target ? { target: j.target } : {}),
      ...(j.candidates.length ? { candidates: j.candidates } : {}),
    });
  }
  return out;
}

function judge(cmd: ShellCommand, doc: ScannedDoc, sf: ScriptFacts, ctx: CommandCheckContext, shows: Set<string>): Judged | undefined {
  const w = cmd.words;
  const head = w[0]!.text;
  const cwd = cmd.cwd!;
  // The repository is this runner (go-task/task, casey/just): its docs show the reader's tasks.
  if (sf.ownTools.has(head) || shows.has(head === 'gmake' ? 'make' : head)) return undefined;
  switch (head) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return judgePackageManager(head, w, cwd, sf, ctx.facts);
    case 'make':
    case 'gmake':
      return judgeMake(w, cwd, sf, ctx, doc);
    case 'just':
      return judgeJust(w, cwd, sf, ctx);
    case 'task':
      return judgeTask(w, cwd, sf, ctx);
    case 'uv':
    case 'poetry':
    case 'hatch':
    case 'pdm':
      return judgePyRunner(head, w, cwd, sf, ctx);
    default:
      if (/^(python(\d(\.\d+)?)?|py|pypy3?)$/.test(head)) return judgePythonM(w, 1, w[0]!, cwd, sf, ctx);
      return undefined;
  }
}

/** Packages a package-manager command can mean: the nearest package.json up from the cwd, and (page context) the root. */
function packagesFor(cwd: Cwd, sf: ScriptFacts): PackageManifest[] {
  const out: PackageManifest[] = [];
  for (const d of upward(cwd.dir)) {
    const p = sf.packageByDir.get(d);
    if (p) {
      out.push(p);
      break;
    }
  }
  const root = sf.packageByDir.get('');
  if (!cwd.explicit && root && !out.includes(root)) out.push(root);
  return out;
}

/** A workspace named by `-w x` / `--filter x` / `yarn workspace x`: a package name or a folder. */
function workspacePackage(name: string, cwd: Cwd, sf: ScriptFacts): PackageManifest | undefined {
  const byName = sf.packageByName.get(name);
  if (byName) return byName;
  const rel = name.replace(/^\.\//, '');
  for (const base of [cwd.dir, '']) {
    const d = joinDir(base, rel);
    const p = d !== undefined ? sf.packageByDir.get(d) : undefined;
    if (p) return p;
  }
  return undefined;
}

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * `npm run x`, `npm test`, `pnpm [run] x`, `yarn [run] x`, `bun run x`, with the options that pick
 * the package (`--prefix`, `-C`, `--dir`, `--cwd`, `-w`, `--workspace`, `--filter`, `-r`, `yarn workspace x`).
 */
function judgePackageManager(pm: Pm, w: Word[], cwd: Cwd, sf: ScriptFacts, facts: RepoFacts): Judged | undefined {
  let pkgs = packagesFor(cwd, sf);
  let picked = false;
  let unsure = false;
  const flags = new Set<string>();
  /** Read the option at `k`; returns the index after it (and its value). */
  const option = (k: number): number => {
    const t = w[k]!.text;
    const eq = t.indexOf('=');
    const flag = eq > 0 ? t.slice(0, eq) : t;
    flags.add(flag);
    let value = eq > 0 ? t.slice(eq + 1) : undefined;
    let next = k + 1;
    const takesValue = PM_VALUE_FLAGS.has(flag) && !(pm === 'pnpm' && flag === '-w');
    if (value === undefined && takesValue && w[k + 1]) {
      value = w[k + 1]!.text;
      next++;
    }
    const pick = (p: PackageManifest | undefined) => {
      if (!p) unsure = true;
      pkgs = p ? (picked ? [...pkgs, p] : [p]) : pkgs;
      picked = true;
    };
    if (value !== undefined && /^(--prefix|-C|--dir|--cwd)$/.test(flag)) {
      const d = joinDir(cwd.dir, value);
      pick(d !== undefined ? sf.packageByDir.get(d) : undefined);
    } else if (value !== undefined && (flag === '--filter' || flag === '-F' || ((pm === 'npm' || pm === 'yarn') && (flag === '-w' || flag === '--workspace')))) {
      pick(/^[@\w][\w@./-]*$/.test(value) ? workspacePackage(value, cwd, sf) : undefined);
    } else if (pm === 'pnpm' && (flag === '-w' || flag === '--workspace-root')) {
      pick(sf.packageByDir.get(''));
    } else if (/^(-r|--recursive|--workspaces|-ws|--all)$/.test(flag)) {
      pkgs = sf.packages;
      picked = true;
    }
    return next;
  };
  const words = (from: number, stop: (x: Word) => boolean): number => {
    let k = from;
    while (k < w.length && w[k]!.text !== '--' && !stop(w[k]!)) k = w[k]!.text.startsWith('-') ? option(k) : k + 1;
    return k;
  };
  const firstWord = (from: number): number => words(from, (x) => !x.text.startsWith('-'));

  let k = firstWord(1);
  let sub = w[k];
  if (!sub || sub.text === '--') return undefined;
  if (pm === 'yarn' && sub.text === 'workspace') {
    const ws = w[k + 1];
    if (!ws || isPlaceholder(ws)) return undefined;
    const p = workspacePackage(ws.text, cwd, sf);
    if (!p) return undefined;
    pkgs = [p];
    picked = true;
    k = firstWord(k + 2);
    sub = w[k];
    if (!sub || sub.text === '--') return undefined;
  }
  let nameWord: Word;
  let script: string;
  /** The name can only be a script (`npm run x`); otherwise it may also be a dependency's binary or a file. */
  let strict: boolean;
  if (NPM_RUN.has(sub.text) && (pm === 'npm' || sub.text === 'run' || sub.text === 'run-script')) {
    const at = firstWord(k + 1);
    if (!w[at] || w[at]!.text === '--') return undefined;
    nameWord = w[at]!;
    script = nameWord.text;
    strict = pm === 'npm' || pm === 'pnpm';
    k = at;
  } else if (NPM_LIFECYCLE[sub.text] && pm !== 'bun' && !(pm !== 'npm' && sub.text === 'stop')) {
    nameWord = sub;
    script = NPM_LIFECYCLE[sub.text]!;
    strict = true;
  } else {
    if (pm === 'npm' || PM_BUILTINS.has(sub.text) || (pm === 'bun' && BUN_BUILTINS.has(sub.text))) return undefined;
    nameWord = sub;
    script = sub.text;
    strict = false;
  }
  words(k + 1, () => false);
  if (unsure || flags.has('--if-present')) return undefined;
  // A name a binary or file could have (`pnpm eslint`, `yarn run tsc`, `bun run index.ts`) is not judged; `build:docs`
  // and the usual script names no package ships as a binary (`pnpm build`, `yarn lint`) are.
  if (!strict && !script.includes(':') && !(SCRIPT_NAMES.has(script) && !pkgs.some((p) => p.deps.has(script)))) return undefined;
  // A bin of this repository's own packages, or (bun) a file of that name next to it.
  if (!strict && (sf.ownTools.has(script) || (pm === 'bun' && [...facts.files].some((f) => f.startsWith(cwd.dir ? `${cwd.dir}/${script}.` : `${script}.`))))) return undefined;
  if (pm === 'pnpm' && !script.includes(':') && pkgs.some((p) => p.deps.has(script))) return undefined;
  if (flags.has('-ws') || flags.has('--workspaces') || flags.has('-r') || flags.has('--recursive')) {
    if (sf.packages.some((p) => p.scripts.has(script))) return undefined;
  }
  return scriptMissing({ ...nameWord, text: script }, nameWord, w.slice(0, w.indexOf(nameWord) + 1), pkgs, sf, facts, !cwd.explicit && !picked);
}

/** Script names that are not the binary of any common package (`serve`, `release`, `jest` are, so they are left out). */
const SCRIPT_NAMES = new Set(['build', 'dev', 'lint', 'format', 'fmt', 'typecheck', 'type-check', 'check', 'clean', 'docs', 'preview', 'watch', 'ci', 'e2e', 'coverage', 'bench', 'deploy', 'setup', 'bootstrap', 'generate', 'codegen', 'fix', 'compile', 'bundle', 'verify', 'validate', 'prebuild', 'postbuild', 'pretest', 'posttest', 'prepublishOnly', 'test-unit', 'test-e2e', 'lint-fix', 'format-check']);

const BUN_BUILTINS = new Set(['test', 'x', 'repl', 'exec', 'build', 'pm', 'a', 'i', 'r', 'rm', 'c', 'outdated', 'audit', 'info', 'feedback', 'completions', 'discord', 'upgrade', 'help', 'init', 'create', 'link', 'unlink', 'publish', 'patch', 'patch-commit', 'install', 'add', 'remove', 'update', 'why', 'start']);

function scriptMissing(script: Word, at: Word, subjectWords: Word[], pkgs: PackageManifest[], sf: ScriptFacts, facts: RepoFacts, anywhere: boolean): Judged | undefined {
  const x = script.text;
  if (isPlaceholder(at) || x.includes('/') || x.startsWith('-') || !pkgs.length) return undefined;
  if (pkgs.some((p) => p.scripts.has(x))) return undefined;
  // `npm start` without a start script runs `node server.js`.
  if (x === 'start' && pkgs.some((p) => facts.exists(p.dir ? `${p.dir}/server.js` : 'server.js'))) return undefined;
  // Prose decides which package a bare command means: a script any package of the repository defines is not judged.
  if (anywhere && sf.packages.some((p) => p.scripts.has(x))) return undefined;
  const p = pkgs[0]!;
  const all = [...new Set(pkgs.flatMap((q) => [...q.scripts.keys()]))];
  return {
    from: subjectWords[0]!,
    name: at,
    subject: subjectWords.map((s) => s.text).join(' '),
    message: `\`${x}\` is not a script in ${p.path}.`,
    looked: `${p.path} scripts (${listNames(p.scripts.keys())})`,
    target: p.path,
    candidates: closeNames(x, all),
  };
}

// ------------------------------------------------------------------ make

const MAKE_VALUE_FLAGS = new Set(['-C', '--directory', '-f', '--file', '--makefile', '-j', '--jobs', '-l', '--load-average', '-I', '--include-dir', '-o', '--old-file', '-W', '--what-if', '--new-file', '--assume-new', '--assume-old', '-O', '--output-sync', '--eval', '--debug']);

function judgeMake(w: Word[], cwd: Cwd, sf: ScriptFacts, ctx: CommandCheckContext, doc: ScannedDoc): Judged | undefined {
  let dir: string | undefined = cwd.explicit ? cwd.dir : undefined;
  let file: string | undefined;
  const targets: Word[] = [];
  for (let i = 1; i < w.length; i++) {
    const t = w[i]!.text;
    if (t === '--') continue;
    if (t.startsWith('-')) {
      const m = /^(-C|--directory=?|-f|--file=?|--makefile=?)(.*)$/.exec(t);
      if (m) {
        const value = m[2] || w[++i]?.text;
        if (value === undefined || /[$<{]/.test(value)) return undefined;
        if (m[1]!.startsWith('-C') || m[1]!.startsWith('--directory')) {
          const d = joinDir(cwd.explicit ? cwd.dir : '', value);
          if (d === undefined || !ctx.facts.isDir(d)) return undefined;
          dir = d;
        } else file = value;
        continue;
      }
      if (/^(--help|-h|-v|--version|-p|--print-data-base)$/.test(t)) return undefined;
      // `-j 4`, `-l 2`: only a number is the value (`-j build` is `-j` and the target `build`).
      if (/^-[jl]$/.test(t)) {
        if (/^\d+(\.\d+)?$/.test(w[i + 1]?.text ?? '')) i++;
      } else if (MAKE_VALUE_FLAGS.has(t)) i++;
      continue;
    }
    if (t.includes('=')) continue; // `make build DEBUG=1`
    targets.push(w[i]!);
  }
  if (file) return undefined; // another makefile than the standard names: not read
  if (!targets.length) return undefined;
  const dirs = dir !== undefined ? [dir] : [...new Set([cwd.dir, ''])];
  const mfs = dirs.map((d) => sf.makefiles.get(d)).filter((m): m is MakeFacts => !!m);
  if (!mfs.length || mfs.some((m) => m.open) || dirs.some((d) => sf.makeGenerated.has(d))) return undefined;
  for (const target of targets) {
    const x = target.text;
    if (isPlaceholder(target) || x.startsWith('.')) continue;
    if (mfs.some((m) => m.targets.has(x) || m.patterns.some((p) => patternMatches(p, x)))) continue;
    // A file of that name is "up to date"; `x.c` next to it builds by an implicit rule.
    if (dirs.some((d) => ctx.facts.exists(d ? `${d}/${x}` : x) || [...ctx.facts.files].some((f) => f.startsWith(d ? `${d}/${x}.` : `${x}.`) && !f.slice((d ? d.length + 1 : 0) + x.length + 1).includes('/')))) continue;
    // From prose, a target another Makefile defines is not judged; nor one a folder's catch-all
    // Makefile may build when the text names that folder ("build the docs with `make html`").
    if (
      dir === undefined &&
      [...sf.makefiles.values()].some((m) => m.targets.has(x) || ((m.open || m.patterns.some((p) => patternMatches(p, x))) && m.dir !== '' && nearText(doc, target, posix.basename(m.dir))))
    )
      continue;
    const m = mfs[0]!;
    const all = [...new Set(mfs.flatMap((q) => [...q.targets]))].filter((t) => !t.startsWith('.'));
    const where = m.paths[0]!;
    return {
      from: w[0]!,
      name: target,
      subject: `make ${x}`,
      message: `\`${x}\` is not a target in ${where}.`,
      looked: `${where} targets (${listNames(all)})`,
      target: where,
      candidates: closeNames(x, all),
    };
  }
  return undefined;
}

// ------------------------------------------------------------------ just

function judgeJust(w: Word[], cwd: Cwd, sf: ScriptFacts, ctx: CommandCheckContext): Judged | undefined {
  for (let i = 1; i < w.length; i++) {
    const t = w[i]!.text;
    if (t.startsWith('-')) {
      if (/^(-f|--justfile|-d|--working-directory)(=|$)/.test(t)) return undefined;
      if (/^(-l|--list|--summary|-s|--show|--choose|--dump|--edit|-e|--init|--evaluate|--variables|--fmt|--groups|--completions|-h|--help|-V|--version|--changelog|--command|-c|--man|--request|--usage)(=|$)/.test(t)) return undefined;
      if (/^(--set|--color|--shell|--shell-arg|--dotenv-path|--dotenv-filename|-E|--chooser|--command-color|--timestamp-format|--list-heading|--list-prefix|--alias-style)$/.test(t)) i += t === '--set' ? 2 : 1;
      continue;
    }
    if (t.includes('=')) continue; // `just VAR=1 build`
    const name = w[i]!;
    const x = name.text;
    if (isPlaceholder(name) || x.includes('/') || x.includes('::')) return undefined;
    const dirs = upward(cwd.explicit ? cwd.dir : cwd.dir);
    const jfs = dirs.map((d) => sf.justfiles.get(d)).filter((j) => !!j);
    if (!jfs.length || jfs.some((j) => j.open)) return undefined;
    if (jfs.some((j) => j.recipes.has(x) || j.modules.has(x))) return undefined;
    if (!cwd.explicit && [...sf.justfiles.values()].some((j) => j.open || j.recipes.has(x) || j.modules.has(x))) return undefined;
    const j = jfs[0]!;
    const all = [...new Set(jfs.flatMap((q) => [...q.recipes]))];
    return {
      from: w[0]!,
      name,
      subject: `just ${x}`,
      message: `\`${x}\` is not a recipe in ${j.path}.`,
      looked: `${j.path} recipes (${listNames(all)})`,
      target: j.path,
      candidates: closeNames(x, all),
    };
  }
  return undefined;
}

// ------------------------------------------------------------------ task

function judgeTask(w: Word[], cwd: Cwd, sf: ScriptFacts, ctx: CommandCheckContext): Judged | undefined {
  const names: Word[] = [];
  for (let i = 1; i < w.length; i++) {
    const t = w[i]!.text;
    if (t === '--') break;
    if (t.startsWith('-')) {
      if (/^(-d|--dir|-t|--taskfile|-g|--global|--remote)(=|$)/.test(t)) return undefined;
      if (/^(-l|--list|-a|--list-all|-i|--init|--summary|--status|-h|--help|--version|--completion|--experiments|-x|--exit-code)(=|$)/.test(t)) return undefined;
      if (/^(-C|--concurrency|-o|--output|--output-group-begin|--output-group-end|--sort|-I|--interval)$/.test(t)) i++;
      continue;
    }
    if (t.includes('=')) continue;
    names.push(w[i]!);
  }
  if (!names.length) return undefined;
  const dirs = upward(cwd.dir);
  const tfs = dirs.map((d) => sf.taskfiles.get(d)).filter((t) => !!t);
  if (!tfs.length || tfs.some((t) => t.open)) return undefined;
  for (const name of names) {
    const x = name.text;
    if (isPlaceholder(name)) continue;
    const has = (t: { tasks: Set<string>; patterns: string[] }) => t.tasks.has(x) || t.patterns.some((p) => patternMatches(p, x));
    if (tfs.some(has)) continue;
    if (!cwd.explicit && [...sf.taskfiles.values()].some((t) => t.open || has(t))) continue;
    const tf = tfs[0]!;
    const all = [...new Set(tfs.flatMap((q) => [...q.tasks]))];
    return {
      from: w[0]!,
      name,
      subject: `task ${x}`,
      message: `\`${x}\` is not a task in ${tf.path}.`,
      looked: `${tf.path} tasks (${listNames(all)})`,
      target: tf.path,
      candidates: closeNames(x, all),
    };
  }
  return undefined;
}

// ------------------------------------------------------------------ uv / poetry / hatch / pdm, python -m

/** Tools commonly run through `uv run` / `poetry run` that are never the repository's own scripts. */
export const PY_TOOLS = new Set([
  'python', 'python3', 'py', 'pip', 'pip3', 'pytest', 'py.test', 'ruff', 'mypy', 'dmypy', 'pyright', 'basedpyright', 'ty', 'black', 'isort', 'flake8',
  'pylint', 'pre-commit', 'prek', 'coverage', 'tox', 'nox', 'mkdocs', 'sphinx-build', 'sphinx-autobuild', 'jupyter', 'ipython', 'uvicorn', 'gunicorn',
  'hypercorn', 'fastapi', 'alembic', 'django-admin', 'celery', 'streamlit', 'gradio', 'marimo', 'bash', 'sh', 'zsh', 'node', 'npm', 'npx', 'make',
  'just', 'task', 'twine', 'maturin', 'pyinstaller', 'bandit', 'vulture', 'codespell', 'typos', 'deptry', 'pip-audit', 'interrogate', 'pdoc', 'logfire',
  'mcp', 'stubgen', 'pyupgrade', 'autoflake', 'mdformat', 'yamllint', 'hatch', 'poetry', 'uv', 'uvx', 'pipx', 'wheel', 'build', 'setuptools',
  'cython', 'cythonize', 'nuitka', 'locust', 'scrapy', 'flask', 'django', 'pdm', 'rye', 'invoke', 'inv', 'doit', 'poe', 'dotenv', 'pyre', 'pytype',
  'griffe', 'mike', 'quarto', 'nbconvert', 'jupyter-lab', 'jupyter-notebook', 'voila', 'datasette', 'sqlite-utils', 'httpx', 'http', 'curl', 'git',
  'docker', 'gh', 'playwright', 'pyodide', 'wasm-pack', 'cargo', 'rustc', 'go', 'java', 'deno', 'bun', 'pnpm', 'yarn', 'xdist', 'hypothesis',
]);

/** Standard-library modules people run with `python -m`; never this repository's package even when names clash. */
const STDLIB_M = new Set(['test', 'unittest', 'pip', 'venv', 'http', 'json', 'pdb', 'timeit', 'cProfile', 'profile', 'doctest', 'ensurepip', 'zipapp', 'pydoc', 'site', 'trace', 'tokenize', 'ast', 'compileall', 'py_compile', 'webbrowser', 'uuid', 'calendar', 'base64', 'gzip', 'zipfile', 'tarfile', 'sqlite3', 'asyncio', 'pickle', 'dis', 'inspect', 'platform', 'sysconfig', 'tabnanny', 'pstats', 'idlelib', 'turtledemo', 'smtpd', 'mimetypes', 'encodings', 'lib2to3', 'tkinter', 'random', 'string', 'code', 'this', 'antigravity', 'filecmp', 'quopri', 'uu', 'binhex', 'pyclbr', 'pickletools', 'tracemalloc', 'faulthandler', 'runpy', 'symtable', 'shlex', 'textwrap', 'typing', 'enum', 'logging', 'email', 'xml', 'html', 'urllib', 'wsgiref', 'xmlrpc', 'ctypes', 'curses', 'dbm', 'importlib', 'multiprocessing', 'concurrent', 'unittest2']);

const PY_RUN_VALUE_FLAGS = new Set([
  '--with', '-w', '--with-editable', '--with-requirements', '--extra', '--group', '--only-group', '--no-group', '--package', '--directory', '--project',
  '--python', '-p', '--env-file', '--index', '--index-url', '--extra-index-url', '--find-links', '-f', '--refresh-package', '--upgrade-package', '-P',
  '--reinstall-package', '--no-binary-package', '--no-build-package', '--color', '--cache-dir', '--config-file', '--exclude-newer', '--resolution',
  '--prerelease', '--link-mode', '--keyring-provider', '--index-strategy', '--config-setting', '-C', '--no-sources-package', '--from', '-e', '--env',
  '-E', '--venv', '--project-dir',
]);

function judgePyRunner(runner: string, w: Word[], cwd: Cwd, sf: ScriptFacts, ctx: CommandCheckContext): Judged | undefined {
  let i = 1;
  // Global options before `run` (`uv --directory x run`, `poetry -C x run`).
  while (i < w.length && w[i]!.text.startsWith('-')) {
    if (PY_RUN_VALUE_FLAGS.has(w[i]!.text) || /^(-C|--directory|--project|--project-dir)$/.test(w[i]!.text)) return undefined;
    i++;
  }
  if (w[i]?.text !== 'run') return undefined;
  i++;
  for (; i < w.length; i++) {
    const t = w[i]!.text;
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-')) break;
    if (t === '-m' || t === '--module') return judgePythonM(w, i, w[0]!, cwd, sf, ctx);

    if (/^(--directory|--project|--package|--script|-s|--env|-e)$/.test(t)) return undefined;
    if (PY_RUN_VALUE_FLAGS.has(t)) i++;
  }
  const name = w[i];
  if (!name || isPlaceholder(name)) return undefined;
  const x = name.text;
  if (/^(python(\d(\.\d+)?)?|py|pypy3?)$/.test(x)) return judgePythonM(w, i + 1, name, cwd, sf, ctx);
  if (runner === 'hatch' && x.includes(':')) return judgeHatchEnv(w, name, sf, cwd);
  // A file, a path, a dependency's console script or a common tool: never judged.
  if (/[/.\\]/.test(x) || PY_TOOLS.has(x) || ctx.facts.exists(joinDir(cwd.dir, x) ?? x) || ctx.facts.exists(x)) return undefined;
  const projects = sf.pyprojects;
  if (!projects.length) return undefined;
  const deps = new Set(projects.flatMap((p) => [...p.deps]));
  if (deps.has(normalizeDist(x))) return undefined;
  const own = new Set(projects.flatMap((p) => [...p.scripts.keys(), ...p.runnerScripts, ...[...p.hatchEnvs.values()].flatMap((s) => [...s])]));
  if (own.has(x)) return undefined;
  // Only a name close to one of the repository's own scripts (a rename) is judged; anything else may be installed.
  const close = closeNames(x, own);
  if (!close.length) return undefined;
  const near = nearestPyproject(cwd, sf) ?? projects[0]!;
  const table = runner === 'hatch' ? '[tool.hatch.envs.*.scripts]' : runner === 'pdm' ? '[tool.pdm.scripts]' : runner === 'poetry' ? '[tool.poetry.scripts]' : '[project.scripts]';
  return {
    from: w[0]!,
    name,
    subject: `${runner} run ${x}`,
    message: `\`${x}\` is not a script of this repository (${near.path} ${table}).`,
    looked: `${near.path} scripts (${listNames(own)})`,
    target: near.path,
    candidates: close,
  };
}

function nearestPyproject(cwd: Cwd, sf: ScriptFacts): PyProjectFacts | undefined {
  for (const d of upward(cwd.dir)) {
    const p = sf.pyprojectByDir.get(d);
    if (p) return p;
  }
  return undefined;
}

function judgeHatchEnv(w: Word[], name: Word, sf: ScriptFacts, cwd: Cwd): Judged | undefined {
  const [env, script] = name.text.split(':', 2) as [string, string];
  const p = nearestPyproject(cwd, sf);
  if (!p || !p.hatchEnvs.size || /[.{]/.test(env) || env.startsWith('hatch-') || env === 'default') return undefined;
  if (p.hatchEnvs.has(env)) return undefined;
  if (sf.pyprojects.some((q) => q.hatchEnvs.has(env))) return undefined;
  return {
    from: w[0]!,
    name,
    subject: `hatch run ${name.text}`,
    message: `\`${env}\` is not a hatch environment in ${p.path} (so \`${script}\` cannot run in it).`,
    looked: `${p.path} [tool.hatch.envs] (${listNames(p.hatchEnvs.keys())})`,
    target: p.path,
    candidates: closeNames(env, p.hatchEnvs.keys()),
  };
}

/** `python -m pkg.mod` where `pkg` is a package of this repository: the module must exist. */
function judgePythonM(w: Word[], start: number, from: Word, cwd: Cwd, sf: ScriptFacts, ctx: CommandCheckContext): Judged | undefined {
  let i = start;
  for (; i < w.length; i++) {
    const t = w[i]!.text;
    if (t === '-m') break;
    if (!t.startsWith('-')) return undefined; // a script file
    if (/^-[XW]$/.test(t)) i++;
  }
  if (w[i]?.text !== '-m' && w[i]?.text !== '--module') return undefined;
  const name = w[i + 1];
  if (!name || isPlaceholder(name) || !/^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)*$/.test(name.text)) return undefined;
  const parts = name.text.split('.');
  const top = parts[0]!;
  if (STDLIB_M.has(top)) return undefined;
  const roots = sf.pyPackages.get(top);
  if (!roots?.length) return undefined;
  const files = ctx.facts.files;
  const rest = parts.slice(1);
  const exists = (root: string) => {
    const p = [root, ...rest].join('/');
    if (files.has(`${p}.py`) || files.has(`${p}.pyi`) || [...['.pyx', '.so', '.pyd', '.c']].some((e) => files.has(`${p}${e}`))) return true;
    if (files.has(`${p}/__init__.py`)) return files.has(`${p}/__main__.py`) || 'package';
    return ctx.facts.isDir(p) ? 'namespace' : false;
  };
  const results = roots.map(exists);
  if (results.some((r) => r === true || r === 'namespace')) return undefined;
  const subject = w.slice(w.indexOf(from), w.indexOf(name) + 1).map((x) => x.text).join(' ');
  if (results.some((r) => r === 'package')) {
    const pkgDir = [roots[results.indexOf('package')]!, ...rest].join('/');
    return {
      from,
      name,
      subject,
      message: `\`${name.text}\` is a package without \`__main__.py\`, so \`python -m ${name.text}\` cannot run it.`,
      looked: `${pkgDir}/`,
      target: `${pkgDir}/__main__.py`,
      candidates: [],
    };
  }
  // The deepest existing package, and its modules, for the message and fix candidates.
  const root = roots[0]!;
  let base = root;
  let k = 0;
  while (k < rest.length - 1 && files.has(`${base}/${rest[k]}/__init__.py`)) base = `${base}/${rest[k++]}`;
  const siblings = [...files]
    .filter((f) => f.startsWith(`${base}/`) && !f.slice(base.length + 1).includes('/') && f.endsWith('.py') && !f.endsWith('__init__.py'))
    .map((f) => f.slice(base.length + 1, -3));
  const mods = [...files].filter((f) => f.startsWith(`${base}/`) && f.endsWith('/__init__.py') && f.slice(base.length + 1).split('/').length === 2).map((f) => f.slice(base.length + 1).split('/')[0]!);
  const names = [...new Set([...siblings, ...mods])].sort();
  const prefix = [top, ...rest.slice(0, k)].join('.');
  return {
    from,
    name,
    subject,
    message: `\`${name.text}\` is not a module of this repository.`,
    looked: `${base}/ (modules: ${listNames(names)})`,
    target: `${[root, ...rest].join('/')}.py`,
    candidates: closeNames(rest[k] ?? top, names).map((n) => `${prefix}.${n}`),
  };
}
