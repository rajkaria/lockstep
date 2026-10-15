// Shapes the API returns (mirrors src/agent/trace.ts and the tool results).

export interface QueryTrace {
  name: string;
  cypher: string;
  params: Record<string, unknown>;
  ms: number;
  rows: number;
}

export type TraceEvent =
  | { type: 'check_started'; checkId: string; pr: string; model: string; at: number; since?: string }
  | { type: 'delta'; kind: 'text' | 'thinking'; text: string; step: number }
  | { type: 'thinking'; text: string; step: number }
  | { type: 'text'; text: string; step: number }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; step: number }
  | { type: 'tool_result'; id: string; name: string; summary: string; isError: boolean; queries: QueryTrace[]; data?: unknown; ms: number; step: number }
  | { type: 'nudge'; missing: string[]; step: number }
  | {
      type: 'check_finished';
      checkId: string;
      status: 'done' | 'incomplete' | 'refused' | 'error';
      summary: string;
      steps: number;
      toolCalls: number;
      toolOrder: string[];
      verdicts: number;
      missing: string[];
      usage: { input: number; output: number; cacheRead: number };
      at: number;
    }
  | { type: 'queued' }
  | { type: 'error'; message: string };

export type Severity = 'breaking' | 'api' | 'behavior';

export interface ImpactedSection {
  section: string;
  heading: string;
  repo: string;
  path: string;
  url: string;
  severity: Severity;
  evidence: string[];
  hops: number;
  confidence: 'exact' | 'by-name' | 'late';
  changes: { symbol: string; change: string; before: string; after: string }[];
  examples: string[];
  crossRepo: boolean;
}

export interface ImpactData {
  pr: { url: string; title: string; repo: string; state: string; before: string; after: string; docsTouched: string[] };
  changed: { symbol: string; change: string; before?: string; after?: string; renamedTo?: string }[];
  sections: ImpactedSection[];
  totalSections: number;
  truncated: boolean;
  counts?: Record<Severity, number>;
}

export interface ClearedSymbol {
  symbol: string;
  name: string;
  repo: string;
  change: string;
  textMatches: number;
  grep: string;
}

export interface RunRecord {
  id: string;
  example: string;
  status: 'pass' | 'fail' | 'timeout' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  traceback?: string;
  stdout: string;
  durationMs: number;
  stitched: string[];
  installed: string[];
  side: 'before' | 'after' | 'current';
  cached: boolean;
}

export interface RunExampleData {
  example: string;
  url: string;
  verdict: string;
  runs: RunRecord[];
}

export interface RankedSection {
  id: string;
  heading: string;
  page: string;
  pageScore: number;
  score: number;
}

export interface DecisionHit {
  id: string;
  text: string;
  source: string;
  matched: string;
  via: string;
}

export interface Health {
  ok: boolean;
  version: string;
  org: string;
  falkordb: string;
  agent: { available: true; model: string; effort: string; provider?: string } | { available: false; reason: string };
  busy: boolean;
  /** Set when the UI is showing the bundled snapshot because the live API is unreachable. */
  snapshot?: { takenAt: string };
}

export interface Facts {
  org: string;
  falkordb: string;
  nodes: Record<string, number>;
  edges: Record<string, number>;
  repos: { name: string; sha: string; packages: string[]; symbols: number; sections: number; examples: number; pythonExamples: number }[];
  calls: { exact: number; byName: number; crossRepo: number };
  crossRepoDocPaths: number;
}

export interface PreloadedPr {
  url: string;
  ref: { fullName: string; number: number };
  title: string | null;
  state: string | null;
  latestCheck: { id: string; model: string; status: string; summary: string; startedAt: number } | null;
  runs: { example: string; side: string; status: string; error: string }[];
}

export interface CheckRow {
  id: string;
  pr: string;
  title: string;
  status: string;
  model: string;
  startedAt: number;
  toolCalls: number;
  verdicts: number;
  toolOrder: string[];
}

export interface SectionText {
  id: string;
  repo: string;
  path: string;
  heading: string;
  body: string;
  url: string;
}

export interface NamedQuery {
  name: string;
  group: string;
  purpose: string;
  cypher: string;
}
