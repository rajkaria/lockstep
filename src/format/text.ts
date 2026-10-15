import type { ClearedSymbol, ImpactData, RankedSection } from '../tools/graph-tools.js';
import type { RunExampleData } from '../tools/run-example.js';

const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c(1);
export const dim = c(2);
export const red = c(31);
export const green = c(32);
export const yellow = c(33);
export const cyan = c(36);

const SEV = { breaking: red('BREAKING'), api: yellow('SIGNATURE'), behavior: dim('BEHAVIOR') } as const;

export function impactText(d: ImpactData, ranked?: RankedSection[]): string {
  const out: string[] = [];
  out.push(bold(`${d.pr.title}`), dim(`${d.pr.url} (${d.pr.state}, ${d.pr.before.slice(0, 7)}..${d.pr.after.slice(0, 7)})`), '');
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
