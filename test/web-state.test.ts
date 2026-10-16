import { describe, expect, it } from 'vitest';
import { replay } from '../web/src/state.js';
import type { TraceEvent } from '../web/src/types.js';

const impact = {
  pr: { url: 'u', title: 't', repo: 'r', state: 'merged', before: 'b', after: 'a', docsTouched: [] },
  changed: [],
  sections: [{ section: 'r:a.md#x', heading: 'X', repo: 'r', path: 'a.md', url: '', severity: 'breaking', evidence: [], hops: 1, confidence: 'exact', changes: [], examples: ['r:a.md:0'], crossRepo: false }],
  totalSections: 41,
  truncated: true,
  counts: { breaking: 41, api: 0, behavior: 0 },
};

describe('web view reducer', () => {
  it('folds a trace into the findings, the same live or replayed', () => {
    const events: TraceEvent[] = [
      { type: 'check_started', checkId: 'c', pr: 'u', model: 'm', at: 1 },
      { type: 'delta', kind: 'thinking', text: 'hm', step: 1 },
      { type: 'thinking', text: 'Start with impact.', step: 1 },
      { type: 'tool_call', id: '1', name: 'impact', input: { pr_url: 'u' }, step: 1 },
      { type: 'tool_result', id: '1', name: 'impact', summary: 's', isError: false, queries: [], data: impact, ms: 3, step: 1 },
      { type: 'tool_call', id: '2', name: 'propose_edit', input: { section_id: 'r:a.md#x', new_text: 'new', reason: 'why' }, step: 2 },
      { type: 'tool_result', id: '2', name: 'propose_edit', summary: 'ok', isError: false, queries: [], data: { id: 'v' }, ms: 1, step: 2 },
      { type: 'tool_call', id: '3', name: 'record_verdict', input: { section_ids: ['r:b.md#y'], verdict: 'ok', reason: 'fine' }, step: 3 },
      { type: 'tool_result', id: '3', name: 'record_verdict', summary: 'ok', isError: false, queries: [], data: {}, ms: 1, step: 3 },
      { type: 'tool_result', id: '9', name: 'impact', summary: 'trimmed', isError: false, queries: [], data: { __trimmed: true, preview: '' }, ms: 1, step: 4 },
    ];
    const v = replay(events);
    expect(v.impact?.totalSections).toBe(41); // a truncated impact list is still shown
    expect(v.live.thinking).toBe('');
    expect(v.items.map((i) => i.kind)).toEqual(['thinking', 'tool', 'tool', 'tool']);
    expect(v.verdicts['r:a.md#x']).toEqual({ verdict: 'stale', reason: 'why', newText: 'new' });
    expect(v.verdicts['r:b.md#y']).toEqual({ verdict: 'ok', reason: 'fine' });
  });
});

describe('runSummary', async () => {
  const { runSummary } = await import('../web/src/format.js');
  const both = (example: string, before: string, after: string) => [
    { example, side: 'before', status: before },
    { example, side: 'after', status: after },
  ];
  it('names breaks and fixes first, then counts the rest', () => {
    expect(runSummary(both('r:README.md:4', 'fail', 'pass'))).toBe('README.md:4: fixed by this PR (fails before, passes after)');
    const mixed = [
      ...both('d:a.mdx:0', 'error', 'error'),
      ...both('d:b.mdx:0', 'pass', 'pass'),
      ...both('d:c.mdx:0', 'fail', 'fail'),
      ...both('d:e.mdx:1', 'pass', 'fail'),
      ...both('d:f.mdx:0', 'pass', 'pass'),
      { example: 'd:g.mdx:0', side: 'before', status: 'skipped' },
    ];
    expect(runSummary(mixed)).toBe('e.mdx:1: breaks (passes before, fails after) · 1 already broken · 2 pass · 1 can\'t install');
  });
});
