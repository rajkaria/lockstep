import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditData } from '../src/audit.js';
import { auditIssueTitle } from '../src/app/audit-issue.js';
import {
  allClearBody,
  annotationsOf,
  APP_COMMENT_MARKER,
  APP_DEFAULTS,
  checkTitle,
  chunks,
  conclusionOf,
  isAllClear,
  planComment,
  resolveAppConfig,
  somethingToSay,
  truncate,
  type CheckOutcome,
} from '../src/app/checks.js';
import { applyEach } from '../src/app/commit-fixes.js';
import { patchOf, unifiedDiff } from '../src/app/patch.js';
import { commentBody, storedFixes } from '../src/app/pr-check.js';
import { COMMENT_MARKER } from '../src/format/markdown.js';
import type { Fix } from '../src/lint/types.js';
import { finding, prFindings } from './fixtures/github-app/fake-github.js';

const outcome = (o: Partial<CheckOutcome> = {}): CheckOutcome => ({ report: `${COMMENT_MARKER}\n### Staleproof: x`, predicted: 0, sections: 0, stale: 0, ...o });

describe('check run output', () => {
  it('annotates each new finding on its line, with columns only on one-line spans', () => {
    const fix: Fix = { description: 'Rename to `npm run lint-docs`', edits: [], verified: true };
    const [a, b, c] = annotationsOf([
      finding(1, { fix }),
      finding(2, { severity: 'warning', endLine: 14, endColumn: 2 }),
      finding(3, { severity: 'info' }),
    ]);
    expect(a).toEqual({
      path: 'AGENTS.md',
      start_line: 11,
      end_line: 11,
      start_column: 5,
      end_column: 24,
      annotation_level: 'failure',
      message: '`npm run lint:docs1` is not a script in package.json. Fix: Rename to `npm run lint-docs` (looked in package.json scripts (build, test, lint-docs))',
      title: 'command-missing: npm run lint:docs1',
    });
    expect(b).toMatchObject({ start_line: 12, end_line: 14, annotation_level: 'warning' });
    expect(b).not.toHaveProperty('start_column');
    expect(c!.annotation_level).toBe('notice');
  });

  it('batches annotations at most 50 per request', () => {
    const batches = chunks(annotationsOf(Array.from({ length: 120 }, (_, i) => finding(i))));
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(chunks([])).toEqual([]);
  });

  it('concludes success when clean, neutral with findings, failure per fail-on', () => {
    const clean = outcome({ sections: 3 });
    const errors = outcome({ newFindings: prFindings([finding(1)]) });
    const warnings = outcome({ newFindings: prFindings([finding(1, { severity: 'warning' })]) });
    const predicted = outcome({ predicted: 2 });
    expect(conclusionOf(clean, 'never')).toBe('success');
    expect(conclusionOf(clean, 'findings')).toBe('success');
    expect(conclusionOf(errors, 'never')).toBe('neutral');
    expect(conclusionOf(errors, 'findings')).toBe('failure');
    expect(conclusionOf(warnings, 'findings')).toBe('neutral');
    expect(conclusionOf(errors, 'predicted')).toBe('neutral');
    expect(conclusionOf(predicted, 'predicted')).toBe('failure');
    expect(conclusionOf(predicted, 'never')).toBe('neutral');
    expect(conclusionOf(outcome({ stale: 1 }), 'never')).toBe('neutral');
  });

  it('titles the run by what it found', () => {
    expect(checkTitle(outcome())).toBe('No docs problems found');
    expect(checkTitle(outcome({ sections: 1 }))).toBe('No docs problems found (1 doc section reached)');
    expect(checkTitle(outcome({ newFindings: prFindings([finding(1), finding(2)]), predicted: 1 }))).toBe('2 docs references made wrong, 1 example predicted to break');
  });

  it('cuts a summary to what GitHub takes, saying so', () => {
    const long = 'x'.repeat(70_000);
    const cut = truncate(long);
    expect(cut.length).toBeLessThanOrEqual(65_000);
    expect(cut).toMatch(/pull request comment has all of it/);
    expect(truncate('short')).toBe('short');
  });
});

describe('comment policy', () => {
  const head = 'c'.repeat(40);
  const findings = outcome({ newFindings: prFindings([finding(1)]) });
  const clean = outcome({ newFindings: prFindings([]), sections: 2 });

  it('"findings" (default) comments only when there is something to say', () => {
    expect(APP_DEFAULTS.comment).toBe('findings');
    expect(somethingToSay(clean)).toBe(false);
    expect(planComment('findings', clean, 'body', head)).toEqual({ kind: 'none' });
    expect(planComment('findings', findings, 'body', head)).toEqual({ kind: 'create', body: 'body' });
    expect(planComment('findings', outcome({ predicted: 1 }), 'body', head)).toEqual({ kind: 'create', body: 'body' });
    expect(planComment('findings', outcome({ stale: 1 }), 'body', head)).toEqual({ kind: 'create', body: 'body' });
  });

  it('updates its comment in place, and leaves an identical one alone', () => {
    expect(planComment('findings', findings, 'new', head, { id: 5, body: 'old' })).toEqual({ kind: 'update', id: 5, body: 'new' });
    expect(planComment('findings', findings, 'same', head, { id: 5, body: 'same' })).toEqual({ kind: 'none' });
  });

  it('edits the comment to "All clear" when a later push clears everything, once, never deleting it', () => {
    const plan = planComment('findings', clean, 'report', head, { id: 5, body: 'findings were here' });
    expect(plan).toMatchObject({ kind: 'update', id: 5 });
    const body = (plan as { body: string }).body;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('all clear');
    expect(body).toContain(head.slice(0, 7));
    expect(isAllClear(body)).toBe(true);
    expect(planComment('findings', clean, 'report', head, { id: 5, body: allClearBody(head) })).toEqual({ kind: 'none' });
  });

  it('"always" keeps the report there; "never" never comments', () => {
    expect(planComment('always', clean, 'report', head)).toEqual({ kind: 'create', body: 'report' });
    expect(planComment('always', clean, 'report', head, { id: 1, body: 'x' })).toEqual({ kind: 'update', id: 1, body: 'report' });
    expect(planComment('never', findings, 'report', head)).toEqual({ kind: 'none' });
    expect(planComment('never', clean, 'report', head, { id: 1, body: 'x' })).toEqual({ kind: 'none' });
  });

  it('adds fixes outside the diff above the footer, with the Apply fixes button or the fork patch', () => {
    const fix: Fix = { description: 'Rename to `npm run lint-docs`', edits: [{ path: 'README.md', line: 3, column: 1, endLine: 3, endColumn: 4, newText: 'x' }], verified: true };
    const report = `${COMMENT_MARKER}\n### Staleproof: t\n\nbody\n\n<sub>footer</sub>\n<!-- staleproof:counts breaks=0 -->`;
    const same = commentBody(report, [finding(1, { fix })], false, false);
    expect(same.indexOf('Apply fixes')).toBeLessThan(same.indexOf('<sub>footer'));
    expect(same).toMatch(/npx staleproof fix/);
    expect(same.endsWith('<!-- staleproof:counts breaks=0 -->\n<!-- staleproof:app -->')).toBe(true);
    expect(commentBody(report, [finding(1, { fix })], true, true)).toMatch(/fork.*check run has the patch/);
    // The App's comment is marked so the Action on the same repository keeps its own.
    expect(commentBody(report, [], false, false)).toBe(`${report}\n${APP_COMMENT_MARKER}`);
    expect(allClearBody('a'.repeat(40))).toContain(APP_COMMENT_MARKER);
  });
});

describe('[app] config', () => {
  it('fills the defaults and keeps what the repository sets', () => {
    expect(resolveAppConfig(undefined)).toEqual(APP_DEFAULTS);
    expect(APP_DEFAULTS).toEqual({ comment: 'findings', failOn: 'never', suggestions: true, drafts: false, fixPrs: false, auditIssue: false, alsoIndex: [] });
    expect(resolveAppConfig({ comment: 'always', failOn: 'findings', suggestions: false, drafts: true, fixPrs: true, auditIssue: true, alsoIndex: ['acme/docs'] })).toEqual({
      comment: 'always',
      failOn: 'findings',
      suggestions: false,
      drafts: true,
      fixPrs: true,
      auditIssue: true,
      alsoIndex: ['acme/docs'],
    });
  });
});

describe('fixes on a fork: the patch', () => {
  it('is a unified diff git applies, for within-line and line-count changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'staleproof-patch-'));
    try {
      const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: run \`npm run lint:docs\` first`);
      const before = `${lines.join('\n')}\n`;
      const within = new Map([
        ['README.md', { before, after: before.replace('line 3: run `npm run lint:docs`', 'line 3: run `npm run lint-docs`').replace('line 30: run `npm run lint:docs`', 'line 30: run `npm run lint-docs`') }],
        ['docs/setup.md', { before: 'a\nb\nc\n', after: 'a\nB\nc\n' }],
      ]);
      const grown = new Map([['README.md', { before, after: before.replace('line 20: run `npm run lint:docs` first\n', 'line 20: run\n`npm run lint-docs` first\n') }]]);
      for (const changes of [within, grown]) {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('mkdir', ['-p', join(dir, 'docs')]);
        for (const [path, c] of changes) await writeFile(join(dir, path), c.before);
        const patch = patchOf(changes);
        await writeFile(join(dir, 'fix.patch'), `${patch}\n`);
        execFileSync('git', ['apply', 'fix.patch'], { cwd: dir });
        for (const [path, c] of changes) expect(await readFile(join(dir, path), 'utf8')).toBe(c.after);
      }
      const p = unifiedDiff('README.md', before, within.get('README.md')!.after);
      // Two changes far apart: two hunks.
      expect(p.match(/^@@ /gm)).toHaveLength(2);
      expect(unifiedDiff('x', 'same', 'same')).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('applies fixes one by one, leaving out one that overlaps an earlier one', () => {
    const edit = (line: number, column: number, endColumn: number, newText: string) => ({ path: 'README.md', line, column, endLine: line, endColumn, newText });
    const fixes: Fix[] = [
      { description: 'a', edits: [edit(1, 5, 8, 'XYZ')], verified: true },
      { description: 'b', edits: [edit(1, 6, 9, 'Q')], verified: true },
      { description: 'c', edits: [edit(2, 1, 2, 'Z')], verified: true },
    ];
    const r = applyEach(new Map([['README.md', 'run abc now\nx\n']]), fixes);
    expect(r.changed.get('README.md')).toBe('run XYZ now\nZ\n');
    expect(r.applied.map((f) => f.description)).toEqual(['a', 'c']);
    expect(r.skipped.map((f) => f.description)).toEqual(['b']);
  });

  it('keeps only verified fixes with edits from what a check run stored', () => {
    const good: Fix = { description: 'g', edits: [{ path: 'a', line: 1, column: 1, endLine: 1, endColumn: 2, newText: 'b' }], verified: true };
    expect(storedFixes([good, { ...good, verified: false }, { ...good, edits: [] }, null, 'x'])).toEqual([good]);
  });
});

describe('audit issue title', () => {
  const data = (o: { mismatched?: number; failing?: number; errors?: number; warnings?: number }) =>
    ({
      score: 71,
      examples: { total: 3, python: 3, linked: 3, mismatched: o.mismatched ?? 0 },
      runCounts: { pass: 0, fail: o.failing ?? 0, skipped: 0, error: 0 },
      findingCounts: { errors: o.errors ?? 0, warnings: o.warnings ?? 0, infos: 4, byRule: {}, bySurface: {} },
    }) as unknown as AuditData;

  it('words it like the Action and counts docs references as something to fix', () => {
    expect(auditIssueTitle(data({ mismatched: 2, failing: 1 }))).toEqual({ title: 'Docs health 71/100: 2 example(s) no longer fit the code', todo: 3 });
    expect(auditIssueTitle(data({ failing: 1 }))).toEqual({ title: 'Docs health 71/100: 1 example(s) fail when run', todo: 1 });
    expect(auditIssueTitle(data({ errors: 2, warnings: 1 }))).toEqual({ title: 'Docs health 71/100: 3 docs reference(s) no longer match the repository', todo: 3 });
    // Info-level findings alone open nothing.
    expect(auditIssueTitle(data({}))).toEqual({ title: 'Docs health 71/100', todo: 0 });
  });
});
