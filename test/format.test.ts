import { describe, expect, it } from 'vitest';
import { checkMarkdown } from '../src/format/markdown.js';
import type { ImpactData } from '../src/tools/graph-tools.js';

const impact: ImpactData = {
  pr: { url: 'https://github.com/acme/c/pull/1', title: 'x', repo: 'acme/c', state: 'merged', before: 'aaaaaaaaaa', after: 'bbbbbbbbbb', docsTouched: [] },
  changed: [{ symbol: 'c.Graph.ro_query', change: 'renamed', renamedTo: 'c.Graph.read_query' }],
  sections: [
    {
      section: 'acme/docs:a.mdx#reads', heading: 'Guide > Reads | queries', repo: 'acme/docs', path: 'a.mdx', url: 'https://github.com/acme/docs/blob/s/a.mdx#L3',
      severity: 'breaking', evidence: ['c.Graph.ro_query', 'acme/docs:a.mdx#reads'], hops: 1, confidence: 'exact',
      changes: [{ symbol: 'c.Graph.ro_query', change: 'renamed', before: 'def ro_query(self)', after: 'def read_query(self)' }], examples: [], crossRepo: true,
    },
  ],
  totalSections: 1,
  truncated: false,
  counts: { breaking: 1, api: 0, behavior: 0 },
};

describe('checkMarkdown', () => {
  it('renders the PR comment', () => {
    const md = checkMarkdown({
      impact,
      summary: '1 changed symbols reach 1 doc sections.',
      cleared: [{ symbol: 'c.Graph._send', name: '_send', repo: 'acme/c', change: 'modified', visibility: 'private', textMatches: 0, grep: "git grep -nw _send -- '*.md' '*.mdx'" }],
      verdicts: [
        { section: 'acme/docs:a.mdx#reads', repo: 'acme/docs', path: 'a.mdx', heading: 'Guide > Reads | queries', lineno: 3, endLineno: 9, url: 'https://github.com/acme/docs/blob/s/a.mdx#L3', id: 'v1', verdict: 'stale', status: 'proposed', reason: 'ro_query was renamed.', newText: 'x', oldText: 'y', evidence: [], cites: [], runs: [] },
      ],
      org: 'acme',
    });
    expect(md).toBe(
      [
        '<!-- lockstep-docs -->',
        '### Lockstep: docs this pull request can falsify',
        '',
        '1 changed symbols reach 1 doc sections.',
        '',
        '| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |',
        '|---|---|---|---|---|',
        '| **breaking** | [Guide > Reads \\| queries](https://github.com/acme/docs/blob/s/a.mdx#L3) | acme/docs | `c.Graph.ro_query` ← `acme/docs:a.mdx#reads` | 1 (exact) |',
        '',
        '<details><summary>Cleared: 1 changed symbol(s) reach no doc within 3 call hops</summary>',
        '',
        "- `c.Graph._send` (modified) — 0 raw text matches in the docs; check with `git grep -nw _send -- '*.md' '*.mdx'`",
        '',
        '</details>',
        '',
        '#### Verdicts',
        '',
        '| Verdict | Section | Reason |',
        '|---|---|---|',
        '| stale | [Guide > Reads \\| queries](https://github.com/acme/docs/blob/s/a.mdx#L3) | ro_query was renamed. |',
        '',
        'Proposed edits: `npx lockstep-docs patch https://github.com/acme/c/pull/1`',
        '',
        '<sub>Lockstep · FalkorDB graph `acme` · aaaaaaa..bbbbbbb</sub>',
      ].join('\n'),
    );
  });
});
