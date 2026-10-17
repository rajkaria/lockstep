import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';

/**
 * Per-repository settings, read from `.staleproof.toml` (docs repositories) or the
 * `[tool.staleproof]` table of `pyproject.toml`:
 *
 * ```toml
 * [tool.staleproof]
 * ignore = ["docs/legacy/**", "CHANGELOG.md"]   # never indexed
 * skip-examples = ["docs/v1/**"]                # indexed and linked, never run or checked
 *
 * [tool.staleproof.lint]                        # `staleproof lint` (docs/lint.md)
 * exclude = ["docs/archive/**"]
 * agent-files = ["prompts/*.md"]
 *
 * [tool.staleproof.rules]
 * "env-undocumented" = "off"                    # off | info | warning | error
 * ```
 *
 * The optional tables appear only when the file has them, and unknown keys are
 * reported in `warnings`, never fatal: a config written for a newer Staleproof
 * still loads.
 */
export interface RepoConfig {
  ignore: string[];
  skipExamples: string[];
  lint?: LintConfig;
  /** Severity per rule id, or `off`. */
  rules?: Record<string, RuleSetting>;
  hooks?: HooksConfig;
  app?: AppConfig;
  audit?: AuditConfig;
  /** Unknown keys and values that were ignored. */
  warnings?: string[];
}

export type RuleSetting = 'off' | 'info' | 'warning' | 'error';

export interface LintConfig {
  /** Extra files to check (globs), on top of the docs, READMEs and agent files. */
  include: string[];
  /** Files never checked. */
  exclude: string[];
  /** Extra agent instruction files (globs). */
  agentFiles: string[];
}

export interface HooksConfig {
  /** What the coding-agent stop hook does with new findings. */
  stop?: 'block' | 'warn' | 'off';
}

export interface AppConfig {
  comment?: 'findings' | 'always' | 'never';
  failOn?: 'never' | 'findings' | 'predicted';
  suggestions?: boolean;
  drafts?: boolean;
  fixPrs?: boolean;
  auditIssue?: boolean;
  alsoIndex?: string[];
}

export interface AuditConfig {
  mentionOwners?: boolean;
}

export const EMPTY_CONFIG: RepoConfig = { ignore: [], skipExamples: [] };

export const CONFIG_FILES = ['.staleproof.toml', 'pyproject.toml'];

function strings(v: unknown, key: string, file: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${file}: ${key} must be a list of glob strings`);
  return v;
}

type Table = Record<string, unknown>;

const TOP_KEYS = new Set(['ignore', 'skip-examples', 'lint', 'rules', 'hooks', 'app', 'audit']);
const RULE_SETTINGS = new Set<RuleSetting>(['off', 'info', 'warning', 'error']);

function isTable(v: unknown): v is Table {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read one optional table, keeping only the known keys of the expected type. */
function readTable<T>(
  table: Table,
  name: string,
  file: string,
  warnings: string[],
  fields: Record<string, [key: keyof T & string, kind: 'string' | 'boolean' | 'strings', allowed?: string[]]>,
): T | undefined {
  const v = table[name];
  if (v === undefined) return undefined;
  if (!isTable(v)) {
    warnings.push(`${file}: [${name}] must be a table; ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, value] of Object.entries(v)) {
    const field = fields[k];
    if (!field) {
      warnings.push(`${file}: unknown key ${name}.${k}; ignored`);
      continue;
    }
    const [key, kind, allowed] = field;
    const ok =
      kind === 'strings'
        ? Array.isArray(value) && value.every((x) => typeof x === 'string')
        : typeof value === kind && (!allowed || allowed.includes(value as string));
    if (!ok) {
      warnings.push(`${file}: ${name}.${k} must be ${kind === 'strings' ? 'a list of strings' : allowed ? allowed.map((a) => `"${a}"`).join(' | ') : `a ${kind}`}; ignored`);
      continue;
    }
    out[key] = value;
  }
  return out as T;
}

export function parseRepoConfig(text: string, file: string): RepoConfig {
  const doc = parse(text) as Table;
  const table = (file.endsWith('pyproject.toml') ? (doc.tool as Table | undefined)?.staleproof : doc) as Table | undefined;
  if (!table) return EMPTY_CONFIG;
  const config: RepoConfig = { ignore: strings(table.ignore, 'ignore', file), skipExamples: strings(table['skip-examples'], 'skip-examples', file) };
  const warnings: string[] = [];
  for (const k of Object.keys(table)) if (!TOP_KEYS.has(k)) warnings.push(`${file}: unknown key ${k}; ignored`);

  const lint = readTable<Partial<LintConfig>>(table, 'lint', file, warnings, {
    include: ['include', 'strings'],
    exclude: ['exclude', 'strings'],
    'agent-files': ['agentFiles', 'strings'],
  });
  if (lint) config.lint = { include: lint.include ?? [], exclude: lint.exclude ?? [], agentFiles: lint.agentFiles ?? [] };

  if (table.rules !== undefined) {
    if (!isTable(table.rules)) warnings.push(`${file}: [rules] must be a table; ignored`);
    else {
      config.rules = {};
      for (const [id, v] of Object.entries(table.rules)) {
        if (typeof v === 'string' && RULE_SETTINGS.has(v as RuleSetting)) config.rules[id] = v as RuleSetting;
        else warnings.push(`${file}: rules.${id} must be "off" | "info" | "warning" | "error"; ignored`);
      }
    }
  }
  const hooks = readTable<HooksConfig>(table, 'hooks', file, warnings, { stop: ['stop', 'string', ['block', 'warn', 'off']] });
  if (hooks) config.hooks = hooks;
  const app = readTable<AppConfig>(table, 'app', file, warnings, {
    comment: ['comment', 'string', ['findings', 'always', 'never']],
    'fail-on': ['failOn', 'string', ['never', 'findings', 'predicted']],
    suggestions: ['suggestions', 'boolean'],
    drafts: ['drafts', 'boolean'],
    'fix-prs': ['fixPrs', 'boolean'],
    'audit-issue': ['auditIssue', 'boolean'],
    'also-index': ['alsoIndex', 'strings'],
  });
  if (app) config.app = app;
  const audit = readTable<AuditConfig>(table, 'audit', file, warnings, { 'mention-owners': ['mentionOwners', 'boolean'] });
  if (audit) config.audit = audit;
  if (warnings.length) config.warnings = warnings;
  return config;
}

/** The repository's config: `.staleproof.toml` wins over `[tool.staleproof]`; none is the default. */
export async function loadRepoConfig(dir: string): Promise<RepoConfig> {
  for (const name of CONFIG_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const config = parseRepoConfig(await readFile(path, 'utf8'), name);
    if (name === '.staleproof.toml' || config !== EMPTY_CONFIG) return config;
  }
  return EMPTY_CONFIG;
}

/** A glob as gitignore-ish patterns use it: `**` any depth, `*` within a segment, `?` one character; a bare directory matches what is under it. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/^\.?\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += g[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
