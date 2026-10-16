import type { VerdictRow } from '../patch.js';
import type { ExampleRunRow } from './report.js';
import type { ClearedSymbol, ImpactData, RankedSection } from '../tools/graph-tools.js';

export const COMMENT_MARKER = '<!-- staleproof -->';

const SEV = { breaking: '**breaking**', api: '**signature**', behavior: 'behavior' } as const;

const REPO_URL = 'https://github.com/rajkaria/staleproof';

const RESULT: Record<ExampleRunRow['verdict'], string> = {
  breaks: '**breaks**: passes before this PR, fails after',
  fixes: 'fixed by this PR',
  passes: 'passes before and after',
  'already-broken': 'already broken (fails before and after)',
  'changed-failure': 'fails before and after, with a different error',
  fails: 'fails',
  skipped: 'not run',
  error: 'could not be installed',
};

function side(run: ExampleRunRow['before']): string {
  if (!run) return '—';
  if (run.status === 'pass') return 'passes';
  if (run.status === 'skipped') return `skipped (${esc(run.reason.split('\n')[0]!.slice(0, 80))})`;
  if (run.status === 'error') return `not installed (${esc(run.reason.split('\n')[0]!.slice(0, 80))})`;
  return run.error ? `\`${esc(run.error.slice(0, 120))}\`` : run.status;
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The PR comment: impacted sections with evidence paths, clearance, and (agent mode) verdicts. */
export function checkMarkdown(opts: {
  impact: ImpactData;
  summary: string;
  cleared: ClearedSymbol[];
  ranked?: RankedSection[];
  verdicts?: VerdictRow[];
  runs?: ExampleRunRow[];
  agentSummary?: string;
  org: string;
}): string {
  const { impact } = opts;
  const runs = opts.runs ?? [];
  // Pages the pull request edits itself: their after runs use the page as the pull request leaves it.
  const touched = new Set(impact.pr.docsTouched.map((p) => `${impact.pr.repo}:${p}`));
  const onTouchedPage = (id: string) => touched.has(id.split(':').slice(0, 2).join(':'));
  const breaks = runs.filter((r) => r.verdict === 'breaks').length;
  const elsewhere = impact.sections.filter((s) => !onTouchedPage(s.section.replace('#', ':'))).length;
  const n = impact.totalSections;
  const title = breaks
    ? `this pull request breaks ${breaks} docs example${breaks === 1 ? '' : 's'}`
    : n && !impact.truncated && elsewhere === 0
      ? `the ${n === 1 ? 'doc section' : `${n} doc sections`} this pull request reaches ${n === 1 ? 'is' : 'are'} on pages it edits`
      : n
        ? `${n} doc section${n === 1 ? '' : 's'} this pull request can make false`
        : 'no docs reach the code this pull request changed';
  const out: string[] = [COMMENT_MARKER, `### Staleproof: ${title}`, '', opts.summary, ''];
  if (runs.length) {
    const short = (sha: string) => sha.slice(0, 7);
    out.push(
      `| Example | Before (\`${short(impact.pr.before)}\`) | After (\`${short(impact.pr.after)}\`) | Result |`,
      '|---|---|---|---|',
    );
    for (const r of runs) {
      const result = onTouchedPage(r.example) ? `${RESULT[r.verdict]} (after: the page as this PR edits it)` : RESULT[r.verdict];
      out.push(`| [${esc(r.example.split(':').slice(1).join(':'))}](${r.url}) | ${side(r.before)} | ${side(r.after)} | ${result} |`);
    }
    out.push('');
  }
  if (impact.sections.length) {
    const order = opts.ranked ? new Map(opts.ranked.map((r, i) => [r.id, i])) : undefined;
    const sections = order ? [...impact.sections].sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9)) : impact.sections;
    out.push('| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |', '|---|---|---|---|---|');
    for (const s of sections) {
      out.push(
        `| ${SEV[s.severity]} | [${esc(s.heading)}](${s.url})${onTouchedPage(s.section.replace('#', ':')) ? ' (page edited in this PR)' : ''} | ${s.repo} | ${s.evidence.map((n) => `\`${esc(n)}\``).join(' ← ')} | ${s.hops} (${s.confidence}) |`,
      );
    }
    if (impact.truncated) out.push('', `_${impact.totalSections - impact.sections.length} more sections not shown._`);
    out.push('');
  }
  if (opts.cleared.length) {
    out.push(`<details><summary>Cleared: ${opts.cleared.length} changed symbol(s) reach no doc within 3 call hops</summary>`, '');
    for (const c of opts.cleared) out.push(`- \`${c.symbol}\` (${c.change}) — ${c.textMatches} raw text matches in the docs; check with \`${c.grep}\``);
    out.push('', '</details>', '');
  }
  if (opts.verdicts?.length) {
    out.push('#### Verdicts', '', '| Verdict | Section | Reason |', '|---|---|---|');
    for (const v of opts.verdicts) out.push(`| ${v.verdict} | [${esc(v.heading)}](${v.url}) | ${esc(v.reason)} |`);
    out.push('');
    if (opts.verdicts.some((v) => v.verdict === 'stale')) out.push('Proposed edits: `npx staleproof patch ' + impact.pr.url + '`', '');
  }
  if (impact.pr.docsTouched.length) {
    out.push(`This pull request also edits ${impact.pr.docsTouched.map((p) => `\`${p}\``).join(', ')}: examples on those pages are run after the change as the pull request leaves them; the sections above are linked as they are on the default branch.`, '');
  }
  if (opts.agentSummary) out.push(opts.agentSummary, '');
  out.push(`<sub>[Staleproof](${REPO_URL}) · FalkorDB graph \`${opts.org}\` · ${impact.pr.before.slice(0, 7)}..${impact.pr.after.slice(0, 7)}</sub>`);
  return out.join('\n');
}
