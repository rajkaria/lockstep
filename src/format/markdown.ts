import type { VerdictRow } from '../patch.js';
import type { ClearedSymbol, ImpactData, RankedSection } from '../tools/graph-tools.js';

export const COMMENT_MARKER = '<!-- staleproof -->';

const SEV = { breaking: '**breaking**', api: '**signature**', behavior: 'behavior' } as const;

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
  agentSummary?: string;
  org: string;
}): string {
  const { impact } = opts;
  const out: string[] = [COMMENT_MARKER, `### Staleproof: docs this pull request can falsify`, '', opts.summary, ''];
  if (impact.sections.length) {
    const order = opts.ranked ? new Map(opts.ranked.map((r, i) => [r.id, i])) : undefined;
    const sections = order ? [...impact.sections].sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9)) : impact.sections;
    out.push('| Change | Doc section | Repository | Evidence path (changed symbol ← … ← doc) | Hops |', '|---|---|---|---|---|');
    for (const s of sections) {
      out.push(
        `| ${SEV[s.severity]} | [${esc(s.heading)}](${s.url}) | ${s.repo} | ${s.evidence.map((n) => `\`${esc(n)}\``).join(' ← ')} | ${s.hops} (${s.confidence}) |`,
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
  if (opts.agentSummary) out.push(opts.agentSummary, '');
  out.push(`<sub>Staleproof · FalkorDB graph \`${opts.org}\` · ${impact.pr.before.slice(0, 7)}..${impact.pr.after.slice(0, 7)}</sub>`);
  return out.join('\n');
}
