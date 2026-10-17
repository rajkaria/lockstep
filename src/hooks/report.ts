import type { Finding } from '../lint/types.js';
import { compactSignature, type Mention } from './mentions.js';

/** At most this many items go into an agent's context per hook. */
export const MAX_ITEMS = 10;

export interface PredictedBreak {
  example: string;
  line?: number;
  detail: string;
}

export function findingLine(f: Finding): string {
  const fix = f.fix?.verified ? ` Fix: ${f.fix.description}` : '';
  return `- ${f.path}:${f.line}:${f.column} ${f.message} [${f.rule}]${fix}`;
}

export function mentionLine(m: Mention): string {
  const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(', ');
  if (m.after === undefined) return `- ${m.path}:${m.line} names \`${m.symbol}\`, which ${m.definedIn} no longer defines.`;
  const now = `\`${compactSignature(m.after)}\``;
  if (m.removed?.length) return `- ${m.path}:${m.line} still names ${list(m.removed)} of \`${m.symbol}\`; ${m.definedIn} changed it to ${now}.`;
  return `- ${m.path}:${m.line} calls \`${m.symbol}\`, which now requires ${list(m.required ?? [])} (${m.definedIn}: ${now}).`;
}

export function predictedLine(p: PredictedBreak): string {
  return `- ${p.example}${p.line ? `:${p.line}` : ''} is predicted to break: ${p.detail}`;
}

/** The list a hook hands the agent: findings first, then mentions, then predicted breaks; capped. */
export function itemList(findings: Finding[], mentions: Mention[] = [], predicted: PredictedBreak[] = []): string {
  const lines = [...findings.map(findingLine), ...mentions.map(mentionLine), ...predicted.map(predictedLine)];
  const shown = lines.slice(0, MAX_ITEMS);
  if (lines.length > shown.length) shown.push(`- and ${lines.length - shown.length} more: run \`npx staleproof lint\` to see them all.`);
  return shown.join('\n');
}
