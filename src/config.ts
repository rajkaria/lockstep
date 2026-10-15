import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  /** falkor[s]://[[user][:password]@]host[:port] */
  falkordbUrl: string;
  /** Graph name: one graph per organisation. */
  org: string;
  /** Where clones, caches and venvs live. */
  home: string;
  githubToken?: string;
  anthropicApiKey?: string;
  model: string;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    falkordbUrl: env.FALKORDB_URL ?? 'falkor://localhost:6379',
    org: orgSlug(env.LOCKSTEP_ORG ?? 'falkordb'),
    home: env.LOCKSTEP_HOME ?? join(homedir(), '.lockstep'),
    githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? undefined,
    model: env.LOCKSTEP_MODEL ?? DEFAULT_MODEL,
  };
}

/** Graph names are org slugs: lowercase letters, digits, `-` and `_`. */
export function orgSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid org name: "${raw}"`);
  return slug;
}
