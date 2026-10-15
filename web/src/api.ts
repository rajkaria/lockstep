import type { CheckRow, Facts, Health, NamedQuery, PreloadedPr, SectionText, TraceEvent } from './types';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `${res.status}`), { status: res.status, body });
  return body as T;
}

export const api = {
  health: () => json<Health>('/api/health'),
  stats: () => json<Facts>('/api/stats'),
  prs: () => json<{ prs: PreloadedPr[] }>('/api/prs'),
  checks: () => json<{ checks: CheckRow[] }>('/api/checks?limit=12'),
  check: (id: string) => json<{ id: string; events: TraceEvent[] }>(`/api/checks/${encodeURIComponent(id)}`),
  section: (id: string) => json<SectionText>(`/api/sections?id=${encodeURIComponent(id)}`),
  model: () => json<{ queries: NamedQuery[]; tools: { name: string; description: string; queries: string[] }[] }>('/api/model'),
  patch: (pr: string) => json<{ title: string; body: string; diff: string }>(`/api/patch?pr=${encodeURIComponent(pr)}`),
  decide: (text: string, governs: string[]) =>
    json<{ id: string; governed: number; summary: string }>('/api/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, governs, author: 'web demo' }),
    }),
};

/** POST a check and read the server-sent trace events as they arrive. */
export async function streamCheck(prUrl: string, mode: 'agent' | 'graph', onEvent: (e: TraceEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_url: prUrl, mode }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error((body as { error?: string }).error ?? `check failed (${res.status})`), { body, status: res.status });
  }
  const reader = res.body.getReader();
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
      if (data) onEvent(JSON.parse(data) as TraceEvent);
    }
  }
}
