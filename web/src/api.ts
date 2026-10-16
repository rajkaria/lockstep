import type { AuditData, CheckRow, Facts, Health, NamedQuery, PreloadedPr, RepoStatus, SectionText, TraceEvent } from './types';

type HttpError = Error & { status?: number; body?: unknown };

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const body = isJson ? await res.json().catch(() => ({})) : undefined;
  if (!res.ok || !isJson) {
    const message = (body as { error?: string } | undefined)?.error ?? (isJson ? `${res.status}` : `the API is not available here (${res.status})`);
    throw Object.assign(new Error(message), { status: isJson ? res.status : 503, body }) as HttpError;
  }
  return body as T;
}

/** What `npm run snapshot` bundles: the API's answers at one moment, for hosts with no FalkorDB behind them. */
interface Snapshot {
  takenAt: string;
  health: Health;
  stats: Facts;
  prs: { prs: PreloadedPr[] };
  checks: { checks: CheckRow[] };
  traces: Record<string, TraceEvent[]>;
  model: { queries: NamedQuery[]; tools: { name: string; description: string; queries: string[] }[] };
}

let snapshot: Promise<Snapshot | null> | undefined;
let offline = false;

function loadSnapshot(): Promise<Snapshot | null> {
  snapshot ??= fetch('/snapshot.json')
    .then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null))
    .catch(() => null);
  return snapshot;
}

export function isSnapshotMode(): boolean {
  return offline;
}

/** Ask the live API; if it is unreachable (no server, or no FalkorDB behind it), answer from the snapshot. */
async function live<T>(path: string, pick: (s: Snapshot) => T | undefined): Promise<T> {
  if (!offline) {
    try {
      return await json<T>(path);
    } catch (err) {
      const status = (err as HttpError).status;
      if (status !== undefined && status < 500) throw err;
    }
  }
  const s = await loadSnapshot();
  const value = s ? pick(s) : undefined;
  if (s && value !== undefined) {
    offline = true;
    return value;
  }
  throw new Error('the Staleproof API is unreachable and no snapshot is bundled');
}

const SNAPSHOT_ONLY = 'Live checks need the Staleproof API connected to FalkorDB; this deployment is showing a snapshot. Run it locally: npx staleproof serve';

export const api = {
  health: () => live<Health>('/api/health', (s) => ({ ...s.health, agent: { available: false, reason: 'snapshot mode' }, snapshot: { takenAt: s.takenAt } })),
  stats: () => live<Facts>('/api/stats', (s) => s.stats),
  prs: () => live<{ prs: PreloadedPr[] }>('/api/prs', (s) => s.prs),
  checks: () => live<{ checks: CheckRow[] }>('/api/checks?limit=12', (s) => s.checks),
  check: (id: string) =>
    live<{ id: string; events: TraceEvent[] }>(`/api/checks/${encodeURIComponent(id)}`, (s) => (s.traces[id] ? { id, events: s.traces[id]! } : undefined)),
  section: (id: string) => live<SectionText>(`/api/sections?id=${encodeURIComponent(id)}`, () => undefined),
  model: () => live<{ queries: NamedQuery[]; tools: { name: string; description: string; queries: string[] }[] }>('/api/model', (s) => s.model),
  repo: (name: string) => json<RepoStatus>(`/api/repos?name=${encodeURIComponent(name)}`),
  audit: (repo: string) => json<AuditData>(`/api/audit?repo=${encodeURIComponent(repo)}`),
  patch: (pr: string) => live<{ title: string; body: string; diff: string }>(`/api/patch?pr=${encodeURIComponent(pr)}`, () => undefined),
  decide: async (text: string, governs: string[]) => {
    if (offline) throw new Error(SNAPSHOT_ONLY);
    return json<{ id: string; governed: number; summary: string }>('/api/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, governs, author: 'web demo' }),
    });
  },
};

/** POST a check and read the server-sent trace events as they arrive. */
export async function streamCheck(
  prUrl: string,
  mode: 'agent' | 'graph',
  onEvent: (e: TraceEvent) => void,
  signal?: AbortSignal,
  withRepos: string[] = [],
): Promise<void> {
  if (offline) throw new Error(SNAPSHOT_ONLY);
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_url: prUrl, mode, ...(withRepos.length ? { with: withRepos } : {}) }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error((body as { error?: string }).error ?? `check failed (${res.status})`), { body, status: res.status });
  }
  await readSse(res.body, (e) => onEvent(e as TraceEvent));
}

/** Read server-sent events (`data:` lines, blank-line separated) as JSON objects. */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(JSON.parse(data));
    }
  }
}

export type AuditEvent =
  | { type: 'queued' }
  | { type: 'index_started'; repos: string[]; graph: string; reason: string }
  | { type: 'index_progress'; message: string }
  | { type: 'index_finished'; graph: string; ms: number; repos: { repo: string; sha: string; symbols: number; sections: number; examples: number }[] }
  | { type: 'audit'; graph: string; summary: string; data: Omit<AuditData, 'summary'> }
  | { type: 'error'; message: string };

/** POST an audit: the server indexes the repository if it has to (streaming progress), then audits it. */
export async function streamAudit(repo: string, onEvent: (e: AuditEvent) => void, signal?: AbortSignal): Promise<void> {
  if (offline) throw new Error(SNAPSHOT_ONLY);
  const res = await fetch('/api/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo }), signal });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error((body as { error?: string }).error ?? `audit failed (${res.status})`), { body, status: res.status });
  }
  await readSse(res.body, (e) => onEvent(e as AuditEvent));
}
