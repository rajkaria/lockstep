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
 * ```
 */
export interface RepoConfig {
  ignore: string[];
  skipExamples: string[];
}

export const EMPTY_CONFIG: RepoConfig = { ignore: [], skipExamples: [] };

export const CONFIG_FILES = ['.staleproof.toml', 'pyproject.toml'];

function strings(v: unknown, key: string, file: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`${file}: ${key} must be a list of glob strings`);
  return v;
}

export function parseRepoConfig(text: string, file: string): RepoConfig {
  const doc = parse(text) as Record<string, unknown>;
  const table = (file.endsWith('pyproject.toml') ? (doc.tool as Record<string, unknown> | undefined)?.staleproof : doc) as Record<string, unknown> | undefined;
  if (!table) return EMPTY_CONFIG;
  return { ignore: strings(table.ignore, 'ignore', file), skipExamples: strings(table['skip-examples'], 'skip-examples', file) };
}

/** The repository's config: `.staleproof.toml` wins over `[tool.staleproof]`; none is the default. */
export async function loadRepoConfig(dir: string): Promise<RepoConfig> {
  for (const name of CONFIG_FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const config = parseRepoConfig(await readFile(path, 'utf8'), name);
    if (name === '.staleproof.toml' || config.ignore.length || config.skipExamples.length) return config;
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
