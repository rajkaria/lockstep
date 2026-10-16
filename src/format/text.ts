import type { ClearedSymbol, ImpactData, RankedSection } from '../tools/graph-tools.js';
import type { RunExampleData } from '../tools/run-example.js';
import type { TraceEvent } from '../agent/trace.js';

const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const cyan = c(36);

const SEV = { breaking: red('BREAKING'), api: yellow('SIGNATURE'), behavior: dim('BEHAVIOR') } as const;

/** A commit as shown in reports: 7 characters, or the working tree when there is no commit. */
export function commitLabel(sha: string): string {
  return sha === 'WORKTREE' ? 'working tree' : sha.slice(0, 7);
}

export function impactText(d: ImpactData, ranked?: RankedSection[]): string {
  const out: string[] = [];
  out.push(bold(`${d.pr.title}`), dim(`${d.pr.url} (${d.pr.state}, ${commitLabel(d.pr.before)}..${commitLabel(d.pr.after)})`), '');
  out.push(bold(`Changed symbols (${d.changed.length})`));
  for (const ch of d.changed) {
    out.push(`  ${ch.change.padEnd(14)} ${ch.symbol}${ch.renamedTo ? ` → ${ch.renamedTo}` : ''}`);
    if (ch.change === 'signature') out.push(dim(`                 ${ch.before}\n               → ${ch.after}`));
  }
  if (d.pr.docsTouched.length) out.push('', dim(`This PR already edits: ${d.pr.docsTouched.join(', ')}`));
  out.push('', bold(`Impacted doc sections (${d.totalSections})`));
  const order = ranked ? new Map(ranked.map((r, i) => [r.id, i])) : undefined;
  const sections = order ? [...d.sections].sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9)) : d.sections;
  for (const s of sections) {
    out.push(`  ${SEV[s.severity]} ${cyan(s.heading)} ${dim(`[${s.repo}]`)}${s.crossRepo ? dim(' (other repo)') : ''}`);
    out.push(`    ${dim('path:')} ${s.evidence.join(dim(' ← '))}`);
    out.push(`    ${dim(`${s.hops} hops, ${s.confidence}${s.examples.length ? `, ${s.examples.length} example(s)` : ''} · ${s.url}`)}`);
  }
  if (d.truncated) out.push(dim(`  … ${d.totalSections - d.sections.length} more`));
  if (d.predicted?.length) {
    out.push('', bold(`Predicted to break (${d.predicted.length}): the call no longer fits the changed code`));
    for (const p of d.predicted) {
      out.push(`  ${red('✗')} ${p.example.split(':').slice(1).join(':')} ${dim(`line ${p.line}`)} ${p.call}`);
      out.push(`    ${p.detail}${p.confidence === 'by-name' ? dim(' (matched by name)') : ''}`);
    }
  }
  if (d.mismatched?.length) {
    out.push('', bold(`Already out of date before ${d.pr.state === 'local' ? 'these changes' : 'this PR'} (${d.mismatched.length})`));
    for (const m of d.mismatched) out.push(`  ${yellow('!')} ${m.example.split(':').slice(1).join(':')} ${dim(`line ${m.line}`)} ${m.detail}`);
  }
  return out.join('\n');
}

export function clearanceText(cleared: ClearedSymbol[]): string {
  const out = [bold(`Cleared: reach no doc within 3 hops (${cleared.length})`)];
  for (const s of cleared) {
    out.push(`  ${green('✓')} ${s.symbol} ${dim(`(${s.change}; ${s.textMatches} raw text matches in docs; check: ${s.grep})`)}`);
  }
  return out.join('\n');
}

const STATUS = { pass: green('PASS'), fail: red('FAIL'), timeout: red('TIMEOUT'), skipped: dim('SKIPPED'), error: yellow('ERROR') } as const;

export function runText(d: RunExampleData): string {
  const out = [bold(d.example), dim(d.url)];
  for (const r of d.runs) {
    out.push('', `${STATUS[r.status]} ${r.side !== 'current' ? `${r.side} ` : ''}${dim(r.installed.join(', '))}${r.cached ? dim(' (recorded)') : ''}`);
    if (r.stitched.length) out.push(dim(`  stitched with ${r.stitched.join(', ')}`));
    if (r.reason) out.push(`  ${r.reason}`);
    if (r.traceback && r.status !== 'skipped') out.push(r.traceback.split('\n').map((l) => `  ${l}`).join('\n'));
  }
  return out.join('\n');
}

/** One line (or a few) per trace event, for the terminal. Deltas are written raw. */
export function traceLine(e: TraceEvent): string | undefined {
  switch (e.type) {
    case 'check_started':
      return `${bold('Staleproof')} checking ${e.pr} ${dim(`(${e.model}, ${e.checkId})`)}${e.since ? `\n${dim(`since the last check: ${e.since}`)}` : ''}`;
    case 'thinking':
      return dim(`  ${e.text.trim().split('\n').join('\n  ')}`);
    case 'tool_call':
      return `${cyan('→')} ${bold(e.name)}(${compactInput(e.input)})`;
    case 'tool_result': {
      const q = e.queries.filter((x) => x.name !== 'adhoc');
      const meta = dim(`${q.length} Cypher quer${q.length === 1 ? 'y' : 'ies'}${q.length ? `: ${[...new Set(q.map((x) => x.name))].join(', ')}` : ''} · ${e.ms} ms`);
      return `${e.isError ? red('✗') : green('←')} ${e.summary}\n  ${meta}`;
    }
    case 'nudge':
      return yellow(`! ${e.missing.length} impacted section(s) still need a verdict; reminding the model`);
    case 'check_finished':
      return `\n${bold(e.status === 'done' ? green('Done') : e.status === 'incomplete' ? yellow('Incomplete') : red(e.status))} ${dim(`${e.steps} turns, ${e.toolCalls} tool calls (${e.toolOrder.join(' → ')}), ${e.verdicts} verdicts, ${e.usage.input + e.usage.output} tokens`)}\n${e.summary}`;
    default:
      return undefined;
  }
}

function compactInput(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  return Object.entries(obj)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${s.length > 60 ? `${s.slice(0, 57)}…` : s}`;
    })
    .join(', ');
}
