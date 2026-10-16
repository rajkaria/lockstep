import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCompatibleProvider } from './agent/anthropic.js';

export interface Config {
  /** falkor[s]://[[user][:password]@]host[:port] */
  falkordbUrl: string;
  /** Graph name: one graph per organisation. */
  org: string;
  /** Where clones, caches and venvs live. */
  home: string;
  githubToken?: string;
  anthropicApiKey?: string;
  /** ANTHROPIC_BASE_URL: the Claude API by default, or an Anthropic-compatible provider (e.g. DeepSeek). */
  modelBaseUrl?: string;
  /** The model endpoint is another provider's Anthropic-compatible API (portable request fields only). */
  modelCompatible: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Server-side refusal fallback on the Claude API. */
  fallbacks: boolean;
  /** Scratch FalkorDB that docs examples run against (never the org graph's server). */
  scratch: { host: string; port: number; managed: boolean };
  runTimeoutMs: number;
  /** Wall-clock budget for one agent check in the server (Vercel Functions stop at 300 s). */
  checkBudgetMs?: number;
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

/**
 * A setting from the environment: `STALEPROOF_<name>`, else `LOCKSTEP_<name>` (the
 * product's former name, still read so existing deployments keep working).
 */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`STALEPROOF_${name}`] ?? env[`LOCKSTEP_${name}`];
}

/** `~/.staleproof`, or `~/.lockstep` when only the former home exists (its clones and venvs are kept). */
export function defaultHome(home = homedir()): string {
  const current = join(home, '.staleproof');
  const former = join(home, '.lockstep');
  return !existsSync(current) && existsSync(former) ? former : current;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => setting(name, env);
  return {
    falkordbUrl: env.FALKORDB_URL ?? 'falkor://localhost:6379',
    org: orgSlug(get('ORG') ?? 'falkordb'),
    // Serverless file systems are read-only except /tmp.
    home: get('HOME') ?? (env.VERCEL ? '/tmp/staleproof' : defaultHome()),
    githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? undefined,
    modelBaseUrl: env.ANTHROPIC_BASE_URL || undefined,
    modelCompatible: isCompatibleProvider(env.ANTHROPIC_BASE_URL || undefined),
    model: get('MODEL') ?? DEFAULT_MODEL,
    effort: effortOf(get('EFFORT')),
    fallbacks: get('FALLBACKS') !== 'off',
    scratch: get('SCRATCH_URL')
      ? { ...hostPort(get('SCRATCH_URL')!), managed: false }
      : { host: '127.0.0.1', port: Number(get('SCRATCH_PORT') ?? 6390), managed: true },
    runTimeoutMs: Number(get('RUN_TIMEOUT_MS') ?? 30_000),
    // Leave a model turn's worth of headroom under the 300 s function limit.
    checkBudgetMs: get('CHECK_BUDGET_MS') ? Number(get('CHECK_BUDGET_MS')) : env.VERCEL ? 240_000 : undefined,
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
  // Docs examples connect to localhost:6379 without credentials, so the scratch server can't require any.
  if (/^(?:\w+:\/\/)?[^/]*@/.test(url)) throw new Error('STALEPROOF_SCRATCH_URL must not carry credentials: docs examples connect to the scratch server without a password');
  const m = /^(?:\w+:\/\/)?([^:/]+)(?::(\d+))?/.exec(url);
  if (!m) throw new Error(`invalid STALEPROOF_SCRATCH_URL: ${url}`);
  return { host: m[1]!, port: Number(m[2] ?? 6379) };
}

function effortOf(v: string | undefined): Config['effort'] {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
  if (v === undefined) return 'medium';
  if ((levels as readonly string[]).includes(v)) return v as Config['effort'];
  throw new Error(`STALEPROOF_EFFORT must be one of ${levels.join(', ')}`);
}
