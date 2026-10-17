import { describe, expect, it } from 'vitest';
import type { Finding, TextEdit } from '../src/lint/types.js';
import {
  fetchChangedLines,
  markerFingerprints,
  outsideFixesMarkdown,
  planSuggestions,
  postSuggestions,
  rightHandLines,
  suggestFixes,
  type SuggestionPlan,
} from '../src/pr/suggest.js';
import { fakeGitHub } from './fix-github.js';

const README = '# App\n\nRun `npm run lint:docs` first.\nThen `make check-docs`.\nAnd `npm run tset`.\n';

function finding(fp: string, line: number, edits: Omit<TextEdit, 'path'>[], opts: { path?: string; verified?: boolean; description?: string; extraPath?: string } = {}): Finding {
  const path = opts.path ?? 'README.md';
  return {
    rule: 'command-missing',
    severity: 'error',
    message: `\`${fp}\` is not a script in package.json.`,
    path,
    line,
    column: edits[0]?.column ?? 1,
    endLine: line,
    endColumn: edits[0]?.endColumn ?? 2,
    surface: 'readme',
    subject: fp,
    fingerprint: fp,
    fix: {
      description: opts.description ?? `Rename to \`${edits[0]?.newText}\` (renamed in package.json)`,
      edits: [...edits.map((e) => ({ ...e, path })), ...(opts.extraPath ? [{ path: opts.extraPath, line: 1, column: 1, endLine: 1, endColumn: 1, newText: 'x' }] : [])],
      verified: opts.verified ?? true,
    },
  };
}

const lintDocs = finding('aaaa000000000001', 3, [{ line: 3, column: 14, endLine: 3, endColumn: 23, newText: 'docs:lint' }]);
const checkDocs = finding('aaaa000000000002', 4, [{ line: 4, column: 12, endLine: 4, endColumn: 22, newText: 'docs-check' }]);
const changedAll = new Map([['README.md', new Set([1, 2, 3, 4, 5])]]);
const files = new Map([['README.md', README]]);

describe('planSuggestions', () => {
  it('turns a verified fix on a diff line into a suggestion replacing that line', () => {
    const plan = planSuggestions({ findings: [lintDocs], changed: changedAll, files });
    expect(plan.outside).toEqual([]);
    expect(plan.comments).toEqual([
      {
        path: 'README.md',
        line: 3,
        side: 'RIGHT',
        fingerprints: ['aaaa000000000001'],
        body: [
          '<!-- staleproof:suggestion fp=aaaa000000000001 -->',
          '**Staleproof** `command-missing`: `aaaa000000000001` is not a script in package.json. Rename to `docs:lint` (renamed in package.json).',
          '',
          '```suggestion',
          'Run `npm run docs:lint` first.',
          '```',
        ].join('\n'),
      },
    ]);
    expect(markerFingerprints(plan.comments[0]!.body)).toEqual(['aaaa000000000001']);
  });

  it('lists fixes outside the diff, editing several files, or past the cap; ignores unverified hints', () => {
    const multi = finding('aaaa000000000003', 5, [{ line: 5, column: 14, endLine: 5, endColumn: 18, newText: 'test' }], { extraPath: 'AGENTS.md' });
    const hint = finding('aaaa000000000004', 5, [{ line: 5, column: 14, endLine: 5, endColumn: 18, newText: 'test' }], { verified: false });
    const plan = planSuggestions({ findings: [lintDocs, checkDocs, multi, hint], changed: new Map([['README.md', new Set([3])]]), files });
    expect(plan.comments.map((c) => c.line)).toEqual([3]);
    expect(plan.outside.map((f) => f.fingerprint)).toEqual(['aaaa000000000003', 'aaaa000000000002']);
    const capped = planSuggestions({ findings: [lintDocs, checkDocs], changed: changedAll, files, max: 1 });
    expect(capped.comments).toHaveLength(1);
    expect(capped.outside.map((f) => f.fingerprint)).toEqual(['aaaa000000000002']);
    // A file the plan cannot read is outside too.
    expect(planSuggestions({ findings: [lintDocs], changed: changedAll, files: () => undefined }).outside).toHaveLength(1);
  });

  it('merges fixes on the same lines into one suggestion, and spans several lines with start_line', () => {
    const one = finding('bbbb000000000001', 3, [{ line: 3, column: 6, endLine: 3, endColumn: 9, newText: 'pnpm' }]);
    const merged = planSuggestions({ findings: [lintDocs, one], changed: changedAll, files });
    expect(merged.comments).toHaveLength(1);
    expect(merged.comments[0]!.fingerprints).toEqual(['aaaa000000000001', 'bbbb000000000001']);
    expect(merged.comments[0]!.body).toContain('```suggestion\nRun `pnpm run docs:lint` first.\n```');

    const span = finding('cccc000000000001', 3, [
      { line: 3, column: 14, endLine: 3, endColumn: 23, newText: 'docs:lint' },
      { line: 4, column: 12, endLine: 4, endColumn: 22, newText: 'docs-check' },
    ]);
    const plan = planSuggestions({ findings: [span], changed: changedAll, files });
    expect(plan.comments[0]).toMatchObject({ line: 4, start_line: 3, start_side: 'RIGHT', side: 'RIGHT' });
    expect(plan.comments[0]!.body).toContain('```suggestion\nRun `npm run docs:lint` first.\nThen `make docs-check`.\n```');
    // Every line of the range must be on the diff's right side.
    expect(planSuggestions({ findings: [span], changed: new Map([['README.md', new Set([3])]]), files }).comments).toEqual([]);
  });

  it('fences a line holding backticks with a longer fence, and drops carriage returns', () => {
    const text = '# A\r\n\r\n```bash\r\nnpm run lint:docs\r\n```\r\n';
    const f = finding('dddd000000000001', 3, [{ line: 3, column: 4, endLine: 3, endColumn: 8, newText: 'sh' }], { path: 'docs/a.md' });
    const plan = planSuggestions({ findings: [f], changed: new Map([['docs/a.md', new Set([3])]]), files: new Map([['docs/a.md', text]]) });
    expect(plan.comments[0]!.body).toContain('````suggestion\n```sh\n````');
  });
});

describe('rightHandLines', () => {
  it('reads added and context lines of every hunk, not removed ones', () => {
    const patch = '@@ -1,4 +1,5 @@\n # App\n-old line\n+new line\n+another\n \n@@ -20,2 +21,3 @@ section\n context\n+added\n\\ No newline at end of file\n';
    expect([...rightHandLines(patch)]).toEqual([1, 2, 3, 4, 21, 22]);
  });
});

describe('outsideFixesMarkdown', () => {
  it('lists each fix with the command that applies them', () => {
    expect(outsideFixesMarkdown([])).toBe('');
    expect(outsideFixesMarkdown([lintDocs])).toBe(
      'One verified fix is outside this diff. Run `npx staleproof fix` to apply it:\n\n- `README.md:3` Rename to `docs:lint` (renamed in package.json)',
    );
    expect(outsideFixesMarkdown([lintDocs, checkDocs]).split('\n')[0]).toBe('2 verified fixes are outside this diff. Run `npx staleproof fix` to apply them:');
  });
});

const PR = { owner: 'acme', repo: 'app', number: 7, headSha: 'c0ffee' };

describe('postSuggestions', () => {
  const plan = (...fs: Finding[]): SuggestionPlan => planSuggestions({ findings: fs, changed: changedAll, files });

  it('posts one review for a push; the same plan again posts nothing and changes nothing', async () => {
    const gh = fakeGitHub();
    const first = await postSuggestions(plan(lintDocs, checkDocs), PR, { token: 't', fetchImpl: gh.fetch });
    expect(first).toMatchObject({ created: 2, updated: 0, unchanged: 0, superseded: 0, skipped: 0, review: { id: expect.any(Number) } });
    expect(gh.state.reviews).toEqual([expect.objectContaining({ pull: 7, commit_id: 'c0ffee', event: 'COMMENT', comments: 2 })]);
    const again = await postSuggestions(plan(lintDocs, checkDocs), PR, { token: 't', fetchImpl: gh.fetch });
    expect(again).toEqual({ created: 0, updated: 0, unchanged: 2, superseded: 0, skipped: 0 });
    expect(gh.state.reviews).toHaveLength(1);
    expect(gh.state.reviewComments).toHaveLength(2);
  });

  it('updates its comment on current lines in place when the suggestion changed', async () => {
    const gh = fakeGitHub();
    await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh.fetch });
    const changed = finding('aaaa000000000001', 3, [{ line: 3, column: 14, endLine: 3, endColumn: 23, newText: 'docs:check' }]);
    const r = await postSuggestions(plan(changed), { ...PR, headSha: 'beef' }, { token: 't', fetchImpl: gh.fetch });
    expect(r).toMatchObject({ created: 0, updated: 1 });
    expect(gh.state.reviews).toHaveLength(1);
    expect(gh.state.reviewComments).toHaveLength(1);
    expect(gh.state.reviewComments[0]!.body).toContain('Run `npm run docs:check` first.');
  });

  it('leaves comments on outdated lines and posts the suggestion again on the current line', async () => {
    const gh = fakeGitHub();
    await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh.fetch });
    gh.state.reviewComments[0]!.line = null; // the lines changed in a later push
    const r = await postSuggestions(plan(lintDocs), { ...PR, headSha: 'beef' }, { token: 't', fetchImpl: gh.fetch });
    expect(r).toMatchObject({ created: 1, updated: 0, superseded: 0 });
    expect(gh.state.reviews).toHaveLength(2);
    expect(gh.state.reviewComments.map((c) => c.line)).toEqual([null, 3]);
    expect(gh.state.reviewComments[0]!.body).toContain('```suggestion');
  });

  it('marks its comment on current lines at another range superseded, never leaving two live suggestions', async () => {
    const gh = fakeGitHub();
    await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh.fetch });
    gh.state.reviewComments[0]!.line = 2; // still current, but the plan now targets line 3
    const r = await postSuggestions(plan(lintDocs), { ...PR, headSha: 'beef' }, { token: 't', fetchImpl: gh.fetch });
    expect(r).toMatchObject({ created: 1, superseded: 1 });
    expect(gh.state.reviewComments[0]!.body).toBe('<!-- staleproof:suggestion fp=aaaa000000000001 superseded -->\nSuperseded by a newer Staleproof suggestion on this pull request.');
    expect(markerFingerprints(gh.state.reviewComments[0]!.body)).toBeUndefined();
    expect(gh.state.reviewComments.filter((c) => c.body.includes('```suggestion'))).toHaveLength(1);
  });

  it('ignores marker-carrying comments by other accounts', async () => {
    const gh = fakeGitHub();
    gh.state.reviewComments.push({ id: 1, body: '<!-- staleproof:suggestion fp=aaaa000000000001 -->\nfake', path: 'README.md', line: 3, start_line: null, commit_id: 'x', user: { login: 'someone' } });
    const withAuthor = await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh.fetch, author: 'github-actions[bot]' });
    expect(withAuthor).toMatchObject({ created: 1, updated: 0 });
    // Without an author filter the edit is refused (403) and the suggestion is posted as new.
    const gh2 = fakeGitHub();
    gh2.state.reviewComments.push({ id: 1, body: '<!-- staleproof:suggestion fp=aaaa000000000001 -->\nfake', path: 'README.md', line: 3, start_line: null, commit_id: 'x', user: { login: 'someone' } });
    expect(await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh2.fetch })).toMatchObject({ created: 1, updated: 0 });
    expect(gh2.state.reviewComments[0]!.body).toContain('fake');
  });

  it('posts nothing for an empty plan', async () => {
    const gh = fakeGitHub();
    expect(await postSuggestions({ comments: [], outside: [] }, PR, { token: 't', fetchImpl: gh.fetch })).toEqual({ created: 0, updated: 0, unchanged: 0, superseded: 0, skipped: 0 });
    expect(gh.writes()).toEqual([]);
  });

  it('falls back to single comments when GitHub refuses the review, counting the ones it refuses', async () => {
    const gh = fakeGitHub();
    // The diff GitHub knows has no patch for README.md (a line left the diff since the plan was made).
    gh.state.prFiles.set(7, [{ filename: 'README.md', status: 'modified' }]);
    const r = await postSuggestions(plan(lintDocs), PR, { token: 't', fetchImpl: gh.fetch });
    expect(r).toMatchObject({ created: 1, skipped: 0 });
    expect(r.review).toBeUndefined();
    expect(gh.state.reviewComments).toHaveLength(1);
  });
});

describe('fetchChangedLines and suggestFixes', () => {
  it('reads every page of the PR files and plans and posts in one call', async () => {
    const gh = fakeGitHub();
    const many = Array.from({ length: 130 }, (_, i) => ({ filename: `f${i}.md`, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n' }));
    gh.state.prFiles.set(7, [...many, { filename: 'README.md', status: 'modified', patch: '@@ -1,5 +1,5 @@\n # App\n \n-Run old.\n+Run `npm run lint:docs` first.\n Then `make check-docs`.\n' }, { filename: 'gone.md', status: 'removed', patch: '@@ -1 +0,0 @@\n-x\n' }]);
    const lines = await fetchChangedLines(PR, { token: 't', fetchImpl: gh.fetch });
    expect(lines.size).toBe(131);
    expect([...lines.get('README.md')!]).toEqual([1, 2, 3, 4]);
    const { plan, posted } = await suggestFixes({ findings: [lintDocs, checkDocs, finding('eeee000000000001', 5, [{ line: 5, column: 14, endLine: 5, endColumn: 18, newText: 'test' }])], files, pr: PR }, { token: 't', fetchImpl: gh.fetch });
    expect(plan.comments.map((c) => c.line)).toEqual([3, 4]);
    expect(plan.outside.map((f) => f.line)).toEqual([5]);
    expect(posted.created).toBe(2);
  });
});
