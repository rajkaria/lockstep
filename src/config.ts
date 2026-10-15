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
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Server-side refusal fallback on the Claude API. */
  fallbacks: boolean;
  /** Scratch FalkorDB that docs examples run against (never the org graph's server). */
  scratch: { host: string; port: number; managed: boolean };
  runTimeoutMs: number;
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
    effort: effortOf(env.LOCKSTEP_EFFORT),
    fallbacks: env.LOCKSTEP_FALLBACKS !== 'off',
    scratch: env.LOCKSTEP_SCRATCH_URL
      ? { ...hostPort(env.LOCKSTEP_SCRATCH_URL), managed: false }
      : { host: '127.0.0.1', port: Number(env.LOCKSTEP_SCRATCH_PORT ?? 6390), managed: true },
    runTimeoutMs: Number(env.LOCKSTEP_RUN_TIMEOUT_MS ?? 30_000),
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

function hostPort(url: string): { host: string; port: number } {
  const m = /^(?:\w+:\/\/)?([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`invalid LOCKSTEP_SCRATCH_URL: ${url}`);
  return { host: m[1]!, port: Number(m[2] ?? 6379) };
}

function effortOf(v: string | undefined): Config['effort'] {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  if (v === undefined) return 'medium';
  if ((levels as readonly string[]).includes(v)) return v as Config['effort'];
  throw new Error(`LOCKSTEP_EFFORT must be one of ${levels.join(', ')}`);
}
