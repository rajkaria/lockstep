import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditData } from './audit.js';
import { CONFIG_FILES, EMPTY_CONFIG, parseRepoConfig, type RepoConfig } from './indexer/repo-config.js';
import { git } from './indexer/repo.js';

/**
 * CODEOWNERS routing: who owns a docs page, by GitHub's own rules. GitHub reads the first
 * of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` it finds; patterns follow
 * gitignore except that `!` negation, `[ ]` ranges and a `\#` escape do not work; paths are
 * case sensitive; the last matching line wins, and a line with no owners leaves its paths
 * unowned. Lines GitHub would skip as invalid are skipped here too (and listed in `errors`).
 */

/** Where GitHub looks, in its order: the first file found is the one it uses. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;

/** GitHub does not load a CODEOWNERS file of 3 MB or more. */
export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;

export interface CodeownersRule {
  pattern: string;
  /** `@user`, `@org/team` or an email address; empty: the paths have no owner. */
  owners: string[];
  /** 1-based line in the file. */
  line: number;
  matches(path: string): boolean;
}

export interface Codeowners {
  /** The file the rules came from (`.github/CODEOWNERS`). */
  path: string;
  rules: CodeownersRule[];
  /** Lines skipped as invalid, as `line N: why`. */
  errors: string[];
}

const USER_OR_TEAM = /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isOwner(token: string): boolean {
  return USER_OR_TEAM.test(token) || EMAIL.test(token);
}

/** The pattern of a line (up to the first unescaped whitespace, `\ ` kept as a space) and the rest. */
function splitPattern(line: string): { pattern: string; rest: string } {
  let pattern = '';
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length && /\s/.test(line[i + 1]!)) {
      pattern += line[++i];
      continue;
    }
    if (/\s/.test(c)) break;
    pattern += c;
  }
  return { pattern, rest: line.slice(i) };
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** One segment of a pattern as a regular expression: `*` within the segment, `?` one character, `[ ]` literal. */
function segmentRe(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === '\\' && i + 1 < seg.length) out += escapeRe(seg[++i]!);
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }
  return out;
}

/**
 * A gitignore-style matcher with GitHub's CODEOWNERS behaviour. A pattern with a slash at
 * the start or in the middle is anchored at the root, else it matches at any depth; a
 * trailing slash matches directories only (everything under them). A match on a directory
 * covers everything under it, except a last segment with a wildcard: `docs/*` owns
 * `docs/getting-started.md`, not `docs/build-app/troubleshooting.md` (GitHub's example).
 */
export function compilePattern(pattern: string): (path: string) => boolean {
  const dirOnly = pattern.endsWith('/');
  const trimmed = pattern.replace(/\/+$/, '');
  const anchored = trimmed.startsWith('/') || trimmed.replace(/^\/+/, '').includes('/');
  const body = trimmed.replace(/^\/+/, '');
  if (!body) return () => true;
  const segs = body.split('/');
  let re = anchored ? '' : '(?:.*/)?';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') re += last ? '.*' : '(?:.*/)?';
    else re += segmentRe(seg) + (last ? '' : '/');
  });
  const exact = new RegExp(`^${re}$`);
  const lastSeg = segs[segs.length - 1]!;
  const coversContents = dirOnly || lastSeg === '**' || !/(^|[^\\])[*?]/.test(lastSeg);
  return (path: string) => {
    const p = path.replace(/^\/+/, '');
    if (!dirOnly && exact.test(p)) return true;
    if (!coversContents) return false;
    const parts = p.split('/');
    for (let n = parts.length - 1; n >= 1; n--) if (exact.test(parts.slice(0, n).join('/'))) return true;
    return false;
  };
}

/** Parse a CODEOWNERS file. Invalid lines are skipped, as GitHub skips them. */
export function parseCodeowners(text: string, path = 'CODEOWNERS'): Codeowners {
  const rules: CodeownersRule[] = [];
  const errors: string[] = [];
  if (Buffer.byteLength(text, 'utf8') >= MAX_CODEOWNERS_BYTES) {
    return { path, rules, errors: ['the file is 3 MB or larger: GitHub does not load it'] };
  }
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const n = i + 1;
    if (line.startsWith('\\#')) {
      errors.push(`line ${n}: a pattern cannot start with an escaped #`);
      continue;
    }
    const { pattern, rest } = splitPattern(line);
    if (pattern.startsWith('!')) {
      errors.push(`line ${n}: negated patterns (!) are not supported`);
      continue;
    }
    const owners: string[] = [];
    let bad: string | undefined;
    for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith('#')) break;
      if (!isOwner(token)) {
        bad = token;
        break;
      }
      owners.push(token);
    }
    if (bad) {
      errors.push(`line ${n}: ${bad} is not a user, team or email`);
      continue;
    }
    rules.push({ pattern, owners, line: n, matches: compilePattern(pattern) });
  }
  return { path, rules, errors };
}

/** The owners of a repository-relative path: the last matching rule's (none when it lists none). */
export function ownersOf(co: Codeowners | undefined, path: string): string[] {
  if (!co) return [];
  for (let i = co.rules.length - 1; i >= 0; i--) {
    const r = co.rules[i]!;
    if (r.matches(path)) return r.owners;
  }
  return [];
}

/** The rule that decides a path's owners, if any. */
export function ruleFor(co: Codeowners | undefined, path: string): CodeownersRule | undefined {
  if (!co) return undefined;
  for (let i = co.rules.length - 1; i >= 0; i--) if (co.rules[i]!.matches(path)) return co.rules[i];
  return undefined;
}

export type FileReader = (path: string) => Promise<string | undefined>;

/** The CODEOWNERS file GitHub would use: the first of `CODEOWNERS_PATHS` that exists. */
export async function loadCodeowners(read: FileReader): Promise<Codeowners | undefined> {
  for (const path of CODEOWNERS_PATHS) {
    const text = await read(path).catch(() => undefined);
    if (text !== undefined) return parseCodeowners(text, path);
  }
  return undefined;
}

/** Files of a checkout on disk. */
export function dirReader(dir: string): FileReader {
  return (path) => readFile(join(dir, path), 'utf8').catch(() => undefined);
}

/** Files at a commit of a local clone (GitHub reads the base branch's CODEOWNERS for a pull request). */
export function gitReader(dir: string, ref: string): FileReader {
  return (path) => git(dir, ['show', `${ref}:${path}`]).catch(() => undefined);
}

/** Files of a GitHub repository at a ref: public through raw.githubusercontent.com, private through the API with a token. */
export function githubReader(repo: string, ref: string, opts: { token?: string; fetchImpl?: typeof fetch } = {}): FileReader {
  const f = opts.fetchImpl ?? fetch;
  return async (path) => {
    const res = opts.token
      ? await f(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
          headers: { 'User-Agent': 'staleproof', Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${opts.token}` },
        })
      : await f(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path}`, { headers: { 'User-Agent': 'staleproof' } });
    if (!res.ok) return undefined;
    return res.text();
  };
}

/** `[audit] mention-owners = true` turns owners into @-mentions; plain text (no notification) otherwise. */
export function mentionOwners(config?: RepoConfig): boolean {
  return config?.audit?.mentionOwners === true;
}

/** An owner as Markdown: a mention (`@org/team`, GitHub notifies) or a code span (shown, nobody is notified). */
export function ownerLabel(owner: string, mention: boolean): string {
  return mention ? owner : `\`${owner}\``;
}

export interface OwnerGroup<T> {
  /** `null`: the items no CODEOWNERS rule assigns. */
  owner: string | null;
  items: T[];
}

/**
 * Items grouped by owner: an item with several owners is in each of their groups. Owners
 * with the most items first; unowned items last.
 */
export function groupByOwner<T>(items: readonly T[], ownersFor: (item: T) => string[]): OwnerGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const owners = ownersFor(item);
    for (const o of owners.length ? owners : [null]) groups.set(o, [...(groups.get(o) ?? []), item]);
  }
  return [...groups]
    .map(([owner, list]) => ({ owner, items: list }))
    .sort((a, b) => (a.owner === null ? 1 : 0) - (b.owner === null ? 1 : 0) || b.items.length - a.items.length || (a.owner ?? '').localeCompare(b.owner ?? ''));
}

/** CODEOWNERS of each repository, by name (an audit or a check can span repositories). */
export type CodeownersFor = (repo: string) => Codeowners | undefined;

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

interface AuditItem {
  repo: string;
  path: string;
  line: number;
  text: string;
  url?: string;
}

/** Everything an audit asks someone to fix, located on a docs page: docs references, example lines, failing runs. */
function auditItems(d: AuditData): AuditItem[] {
  const out: AuditItem[] = [];
  for (const f of d.findings ?? []) out.push({ repo: f.repo ?? d.repos[0]?.name ?? '', path: f.path, line: f.line, text: f.message, url: f.evidence?.url });
  for (const m of d.mismatches) out.push({ repo: m.repo, path: m.path, line: m.line, text: `Example: ${m.detail}`, url: m.url });
  for (const r of d.runs.filter((x) => x.status === 'fail' || x.status === 'timeout')) {
    const repo = d.repos.map((x) => x.name).find((name) => r.example.startsWith(`${name}:`));
    if (!repo) continue;
    const rest = r.example.slice(repo.length + 1);
    const path = rest.slice(0, rest.lastIndexOf(':'));
    out.push({ repo, path, line: 0, text: `Example fails when run: ${(r.error || r.reason).split('\n')[0]!.slice(0, 120)}`, url: r.url });
  }
  return out;
}

/**
 * The audit issue's "by owner" section: each owner's docs to fix, from the repositories'
 * CODEOWNERS. Empty when no audited repository has a CODEOWNERS file or nothing needs fixing.
 */
export function auditOwnersMarkdown(d: AuditData, coFor: CodeownersFor, opts: { mention?: boolean; maxPerOwner?: number } = {}): string {
  const files = d.repos.map((r) => [r.name, coFor(r.name)] as const).filter(([, co]) => co);
  if (!files.length) return '';
  const items = auditItems(d);
  if (!items.length) return '';
  const groups = groupByOwner(items, (i) => ownersOf(coFor(i.repo), i.path));
  const max = opts.maxPerOwner ?? 20;
  const multi = d.repos.length > 1;
  const from = files.map(([repo, co]) => `${multi ? `${repo}: ` : ''}\`${co!.path}\``).join(', ');
  const out = [`#### Docs to fix, by owner`, '', `Owners from ${from} (GitHub's rules: the last matching pattern wins).`, ''];
  for (const g of groups) {
    out.push(`**${g.owner === null ? 'No owner in CODEOWNERS' : ownerLabel(g.owner, opts.mention === true)}** (${g.items.length})`, '');
    for (const i of g.items.slice(0, max)) {
      const where = `${multi ? `${i.repo}:` : ''}${i.path}${i.line ? `:${i.line}` : ''}`;
      out.push(`- ${i.url ? `[${esc(where)}](${i.url})` : `\`${esc(where)}\``}: ${esc(i.text)}`);
    }
    if (g.items.length > max) out.push(`- … and ${g.items.length - max} more`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Docs paths a pull request check reports on: new findings, impacted sections, predicted breaks. */
export function affectedDocPaths(check: {
  repo?: string;
  newFindings?: { repo: string; findings: readonly { repo?: string; path: string }[] };
  impact?: { pr?: { repo: string }; sections: readonly { repo: string; path: string }[]; predicted?: readonly { repo: string; path: string }[] };
}): { repo: string; path: string }[] {
  const out = new Map<string, { repo: string; path: string }>();
  const add = (repo: string | undefined, path: string) => {
    if (!repo || !path) return;
    out.set(`${repo}\0${path}`, { repo, path });
  };
  for (const f of check.newFindings?.findings ?? []) add(f.repo ?? check.newFindings!.repo, f.path);
  for (const s of check.impact?.sections ?? []) add(s.repo, s.path);
  for (const p of check.impact?.predicted ?? []) add(p.repo, p.path);
  return [...out.values()];
}

/**
 * The PR comment's "Owners of affected docs" line: each owner with the pages of theirs the
 * check reports on. Empty when no affected page has an owner.
 */
export function affectedOwnersMarkdown(paths: readonly { repo: string; path: string }[], coFor: CodeownersFor, opts: { mention?: boolean; maxPaths?: number } = {}): string {
  const groups = groupByOwner(paths, (p) => ownersOf(coFor(p.repo), p.path)).filter((g) => g.owner !== null);
  if (!groups.length) return '';
  const multi = new Set(paths.map((p) => p.repo)).size > 1;
  const max = opts.maxPaths ?? 5;
  const parts = groups.map((g) => {
    const shown = g.items.slice(0, max).map((p) => `\`${esc(`${multi ? `${p.repo}:` : ''}${p.path}`)}\``);
    const more = g.items.length > max ? `, +${g.items.length - max} more` : '';
    return `${ownerLabel(g.owner!, opts.mention === true)} (${shown.join(', ')}${more})`;
  });
  return `**Owners of affected docs:** ${parts.join(' · ')}`;
}

/**
 * Put a block into a Staleproof Markdown report just above its `<sub>` footer (the audit
 * issue body, the PR comment), or at the end when there is no footer.
 */
export function insertBeforeFooter(markdown: string, block: string): string {
  if (!block.trim()) return markdown;
  const lines = markdown.split('\n');
  const at = lines.findLastIndex((l) => l.startsWith('<sub>'));
  if (at < 0) return `${markdown.trimEnd()}\n\n${block}\n`;
  return [...lines.slice(0, at), block, '', ...lines.slice(at)].join('\n');
}

export interface OwnersSourceOptions {
  /** Where clones live (`config.home`): a clone at `<home>/repos/<owner>/<name>` is read first. */
  home?: string;
  /** For private repositories without a clone. */
  token?: string;
  fetchImpl?: typeof fetch;
}

/** A repository's files at a commit: its local clone when there is one, else GitHub. */
export function repoReader(repo: string, ref: string, opts: OwnersSourceOptions = {}): FileReader {
  const clone = opts.home ? join(opts.home, 'repos', ...repo.split('/')) : undefined;
  const local = clone && existsSync(join(clone, '.git')) ? gitReader(clone, ref) : undefined;
  const remote = githubReader(repo, ref, { token: opts.token, fetchImpl: opts.fetchImpl });
  return async (path) => (local ? await local(path) : undefined) ?? (await remote(path).catch(() => undefined));
}

/** The repository's `.staleproof.toml` (or `[tool.staleproof]`) through a reader, as `loadRepoConfig` reads it from disk. */
export async function readRepoConfig(read: FileReader): Promise<RepoConfig> {
  for (const name of CONFIG_FILES) {
    const text = await read(name);
    if (text === undefined) continue;
    try {
      const config = parseRepoConfig(text, name);
      if (name === '.staleproof.toml' || config !== EMPTY_CONFIG) return config;
    } catch {
      return EMPTY_CONFIG;
    }
  }
  return EMPTY_CONFIG;
}

/**
 * The audit issue's "Docs to fix, by owner" section, reading each audited repository's
 * CODEOWNERS and `[audit] mention-owners` at its indexed commit. Empty without CODEOWNERS.
 */
export async function ownersForAudit(d: AuditData, opts: OwnersSourceOptions = {}): Promise<string> {
  const files = new Map<string, Codeowners | undefined>();
  let mention = false;
  for (const r of d.repos) {
    const read = repoReader(r.name, r.sha || 'HEAD', opts);
    files.set(r.name, await loadCodeowners(read));
    if (files.get(r.name)) mention ||= mentionOwners(await readRepoConfig(read));
  }
  return auditOwnersMarkdown(d, (repo) => files.get(repo), { mention });
}

/**
 * The PR comment's "Owners of affected docs" line: CODEOWNERS of the pull request's
 * repository at its base commit (what GitHub uses for review requests), and of other
 * repositories with affected docs at their default branch.
 */
export async function ownersForCheck(
  check: Parameters<typeof affectedDocPaths>[0] & { impact?: { pr?: { repo: string; before?: string } } },
  opts: OwnersSourceOptions = {},
): Promise<string> {
  const paths = affectedDocPaths(check);
  if (!paths.length) return '';
  const prRepo = check.impact?.pr?.repo ?? check.newFindings?.repo;
  const files = new Map<string, Codeowners | undefined>();
  let mention = false;
  for (const repo of new Set(paths.map((p) => p.repo))) {
    const ref = repo === prRepo ? check.impact?.pr?.before || 'HEAD' : 'HEAD';
    const read = repoReader(repo, ref, opts);
    files.set(repo, await loadCodeowners(read));
    if (repo === prRepo && files.get(repo)) mention = mentionOwners(await readRepoConfig(read));
  }
  return affectedOwnersMarkdown(paths, (repo) => files.get(repo), { mention });
}
