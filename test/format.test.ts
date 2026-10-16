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
  offset: 0,
  truncated: false,
  counts: { breaking: 1, api: 0, behavior: 0 },
  predicted: [],
  mismatched: [],
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
        '<!-- staleproof -->',
        '### Staleproof: 1 doc section this pull request can make false',
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
        'Proposed edits: `npx staleproof patch https://github.com/acme/c/pull/1`',
        '',
        '<sub>[Staleproof](https://github.com/rajkaria/staleproof) · FalkorDB graph `acme` · aaaaaaa..bbbbbbb</sub>',
        '<!-- staleproof:counts breaks=0 predicted=0 sections=1 mismatched=0 -->',
      ].join('\n'),
    );
  });

  it('leads with the examples the pull request breaks, before and after', () => {
    const md = checkMarkdown({
      impact,
      summary: 's',
      cleared: [],
      runs: [
        { example: 'acme/docs:a.mdx:0', url: 'https://github.com/acme/docs/blob/s/a.mdx#L5', verdict: 'breaks', before: { status: 'pass', error: '', reason: '' }, after: { status: 'fail', error: "AttributeError: 'Graph' object has no attribute 'ro_query'", reason: '' } },
        { example: 'acme/docs:a.mdx:1', url: 'https://github.com/acme/docs/blob/s/a.mdx#L9', verdict: 'skipped', before: { status: 'skipped', error: '', reason: 'needs an LLM provider (OpenAI(); x)' } },
      ],
      org: 'acme',
    });
    const lines = md.split('\n');
    expect(lines[1]).toBe('### Staleproof: this pull request breaks 1 docs example');
    expect(md).toContain('| Example | Before (`aaaaaaa`) | After (`bbbbbbb`) | Result |');
    expect(md).toContain("| [a.mdx:0](https://github.com/acme/docs/blob/s/a.mdx#L5) | passes | `AttributeError: 'Graph' object has no attribute 'ro_query'` | **breaks**: passes before this PR, fails after |");
    expect(md).toContain('| [a.mdx:1](https://github.com/acme/docs/blob/s/a.mdx#L9) | skipped (needs an LLM provider (OpenAI(); x)) | — | not run |');
  });

  it('says so when no doc reaches the change', () => {
    const md = checkMarkdown({ impact: { ...impact, sections: [], totalSections: 0, counts: { breaking: 0, api: 0, behavior: 0 } }, summary: 's', cleared: [], org: 'acme' });
    expect(md.split('\n')[1]).toBe('### Staleproof: no docs reach the code this pull request changed');
  });

  it('says when the pull request edits the page of an example', () => {
    const md = checkMarkdown({
      impact: { ...impact, pr: { ...impact.pr, repo: 'acme/docs', docsTouched: ['a.mdx'] } },
      summary: 's',
      cleared: [],
      runs: [{ example: 'acme/docs:a.mdx:0', url: 'u', verdict: 'breaks', before: { status: 'pass', error: '', reason: '' }, after: { status: 'fail', error: 'E', reason: '' } }],
      org: 'acme',
    });
    expect(md.split('\n')[1]).toBe('### Staleproof: this pull request breaks 1 docs example');
    expect(md).toContain('**breaks**: passes before this PR, fails after (after: the page as this PR edits it) |');
    const fixed = checkMarkdown({ impact: { ...impact, pr: { ...impact.pr, repo: 'acme/docs', docsTouched: ['a.mdx'] } }, summary: 's', cleared: [], org: 'acme' });
    expect(fixed.split('\n')[1]).toBe('### Staleproof: the doc section this pull request reaches is on pages it edits');
    expect(md).toContain('(page edited in this PR)');
    expect(md).toContain('This pull request also edits `a.mdx`: examples on those pages are run after the change as the pull request leaves them;');
  });
});
