import type { AuditData, AuditFinding } from '../audit.js';
import { MISMATCH_LABEL } from '../indexer/signature.js';
import { SURFACE_TITLE } from '../lint/format.js';
import { bold, cyan, dim, green, red, yellow } from './text.js';

export const AUDIT_MARKER = '<!-- staleproof-audit -->';
const SITE = 'https://staleproof.dev';
const REPO_URL = 'https://github.com/rajkaria/staleproof';

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const shortExample = (id: string) => id.split(':').slice(1).join(':');

/** How many findings the text and Markdown reports list (the JSON has them all). */
const MAX_LISTED = 100;

/** Findings grouped under their section title, in order (AI agent instructions first). */
function bySurface(findings: AuditFinding[]): [string, AuditFinding[]][] {
  const out = new Map<string, AuditFinding[]>();
  for (const f of findings) out.set(SURFACE_TITLE[f.surface], [...(out.get(SURFACE_TITLE[f.surface]) ?? []), f]);
  return [...out];
}

function findingCountsLabel(d: AuditData): string {
  const c = d.findingCounts;
  if (!c) return '';
  return [c.errors && `${c.errors} error${c.errors === 1 ? '' : 's'}`, c.warnings && `${c.warnings} warning${c.warnings === 1 ? '' : 's'}`, c.infos && `${c.infos} info`]
    .filter(Boolean)
    .join(', ');
}

/** The README badge for a repository's docs health, served by the hosted API. */
export function badgeMarkdown(repo: string): string {
  return `[![docs health](${SITE}/api/badge/${repo}.svg)](${SITE}/#/audit?repo=${encodeURIComponent(repo)})`;
}

export function auditText(d: AuditData, summary: string): string {
  const color = d.score >= 80 ? green : d.score >= 60 ? yellow : red;
  const out: string[] = [];
  out.push(bold(`Docs health ${color(`${d.score}/100 (${d.grade})`)}`), dim(d.repos.map((r) => `${r.name}@${(r.sha ?? '').slice(0, 7)}`).join('  ')), '');
  out.push(summary, '');
  if (d.deductions.length) {
    out.push(bold('Score'));
    for (const x of d.deductions) out.push(`  ${red(`-${x.points}`)} ${x.why}`);
    out.push('');
  }
  const findings = d.findings ?? [];
  if (findings.length) {
    out.push(bold(`Docs references that no longer match the repository (${findings.length}: ${findingCountsLabel(d)})`));
    for (const [title, list] of bySurface(findings.slice(0, MAX_LISTED))) {
      out.push(`  ${title}`);
      for (const f of list) {
        const sev = f.severity === 'error' ? red(f.severity) : f.severity === 'warning' ? yellow(f.severity) : dim(f.severity);
        out.push(`    ${cyan(`${d.repos.length > 1 ? `${f.repo}:` : ''}${f.path}:${f.line}`)} ${sev} ${f.message} ${dim(`[${f.rule}]`)}`);
      }
    }
    if (findings.length > MAX_LISTED) out.push(dim(`  … and ${findings.length - MAX_LISTED} more (--format json lists them all)`));
    out.push('');
  } else if (d.findings && d.repos.some((r) => r.findingsChecked)) {
    out.push(bold('Docs references'), dim('  every path, link, anchor, command and env var the docs and AI agent files name matches the repository'), '');
  }
  out.push(bold(`Examples that no longer fit the code (${d.examples.mismatched} examples, ${d.mismatches.length} lines)`));
  if (!d.mismatches.length) out.push(dim('  none found: every call in an example fits the signature it reaches'));
  for (const m of d.mismatches) {
    out.push(`  ${red('✗')} ${cyan(shortExample(m.example))} ${dim(`line ${m.line} · ${m.repo}`)}`);
    out.push(`    ${m.detail} ${dim(`(${MISMATCH_LABEL[m.kind]}; ${m.call})`)}`);
  }
  out.push('');
  if (d.runs.length) {
    out.push(bold(`Example runs at the indexed commits (${d.runCounts.pass} pass, ${d.runCounts.fail} fail, ${d.runCounts.skipped} skipped, ${d.runCounts.error} not installed)`));
    for (const r of d.runs.filter((x) => x.status === 'fail' || x.status === 'timeout')) out.push(`  ${red('FAIL')} ${shortExample(r.example)} ${dim(r.error || r.reason)}`);
    out.push('');
  }
  out.push(bold(`API coverage: ${d.coverage.documented} of ${d.coverage.api} public symbols (${d.coverage.percent}%) named or called by a doc`));
  if (d.undocumented.length) out.push(dim('  Undocumented, most used first:'));
  for (const u of d.undocumented) {
    out.push(`  ${yellow('·')} ${u.qualname} ${dim(`${u.kind} · ${u.callers} callers${u.crossRepoCallers ? ` (${u.crossRepoCallers} other repos)` : ''} · ${u.repo}`)}`);
  }
  if (d.repos.length === 1) out.push('', dim(`Badge: ${badgeMarkdown(d.repos[0]!.name)}`));
  return out.join('\n');
}

/** The audit as Markdown: the Action's job summary and issue body, `audit --format markdown`. */
export function auditMarkdown(d: AuditData, summary: string): string {
  const out: string[] = [AUDIT_MARKER, `### Staleproof docs audit: ${d.score}/100 (${d.grade})`, '', summary, ''];
  if (d.deductions.length) {
    out.push('| Points | Why |', '|---:|---|');
    for (const x of d.deductions) out.push(`| −${x.points} | ${esc(x.why)} |`);
    out.push('');
  }
  const findings = d.findings ?? [];
  if (findings.length) {
    out.push(
      `#### Docs references that no longer match the repository (${findings.length})`,
      '',
      `${findingCountsLabel(d)}: paths, links, anchors, commands, CLI flags and env vars that the docs, READMEs and AI agent instructions name and the repository does not have, at the indexed commit.`,
      '',
    );
    for (const [title, list] of bySurface(findings.slice(0, MAX_LISTED))) {
      out.push(`**${title}**`, '', '| Where | Problem | Rule |', '|---|---|---|');
      for (const f of list) {
        const where = `${d.repos.length > 1 ? `${f.repo}:` : ''}${f.path}:${f.line}`;
        out.push(`| ${f.evidence?.url ? `[${esc(where)}](${f.evidence.url})` : `\`${esc(where)}\``} | ${esc(f.message)}${f.fix?.verified ? ` Fix: ${esc(f.fix.description)}` : ''} | ${f.rule} |`);
      }
      out.push('');
    }
    if (findings.length > MAX_LISTED) out.push(`_${findings.length - MAX_LISTED} more not shown (\`staleproof audit --format json\` lists them all)._`, '');
  }
  if (d.mismatches.length) {
    out.push(
      `#### Examples that no longer fit the code (${d.examples.mismatched})`,
      '',
      'Each line calls the code in a way the current source rejects: found statically, across repositories, without running anything.',
      '',
      '| Example | Section | Call | Problem |',
      '|---|---|---|---|',
    );
    for (const m of d.mismatches) {
      out.push(`| [${esc(shortExample(m.example))} line ${m.line}](${m.url}) | ${esc(m.heading)} | \`${esc(m.call)}\` | ${esc(m.detail)} |`);
    }
    out.push('');
  } else {
    out.push(`Every call in the ${d.examples.linked} examples that use the code fits the signature it reaches.`, '');
  }
  const failing = d.runs.filter((r) => r.status === 'fail' || r.status === 'timeout');
  if (failing.length) {
    out.push(`#### Examples that fail when run (${failing.length} of ${d.runCounts.pass + d.runCounts.fail})`, '', '| Example | Error |', '|---|---|');
    for (const r of failing) out.push(`| [${esc(shortExample(r.example))}](${r.url}) | \`${esc((r.error || r.reason).slice(0, 160))}\` |`);
    out.push('');
  }
  out.push(`#### API coverage: ${d.coverage.percent}% (${d.coverage.documented} of ${d.coverage.api} public symbols)`, '');
  if (d.undocumented.length) {
    out.push(`<details><summary>${d.coverage.api - d.coverage.documented} public symbols no doc names or calls — the ${d.undocumented.length} most used</summary>`, '', '| Symbol | Kind | Callers |', '|---|---|---:|');
    for (const u of d.undocumented) {
      out.push(`| [\`${esc(u.qualname)}\`](${u.url}) | ${u.kind} | ${u.callers}${u.crossRepoCallers ? ` (${u.crossRepoCallers} other repos)` : ''} |`);
    }
    out.push('', '</details>', '');
  }
  if (d.repos.length === 1) out.push(`Badge for the README: \`${badgeMarkdown(d.repos[0]!.name)}\``, '');
  out.push(`<sub>[Staleproof](${REPO_URL}) · FalkorDB graph \`${d.org}\` · ${d.repos.map((r) => `${r.name}@${(r.sha ?? '').slice(0, 7)}`).join(', ')}</sub>`);
  // Machine-readable counts: the docs references on their own line, so the audit line keeps its shape.
  if (d.findings) out.push(`<!-- staleproof:audit-findings findings=${findings.length} errors=${d.findingCounts?.errors ?? 0} warnings=${d.findingCounts?.warnings ?? 0} -->`);
  out.push(`<!-- staleproof:audit score=${d.score} mismatched=${d.examples.mismatched} failing=${d.runCounts.fail} coverage=${d.coverage.percent} -->`);
  return out.join('\n');
}
