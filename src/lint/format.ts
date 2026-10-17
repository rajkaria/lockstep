import { packageVersion } from '../pkg.js';
import { RULES } from './rules.js';
import { SEVERITY_RANK, type Finding, type LintResult, type Severity, type Surface } from './types.js';

export type LintFormat = 'text' | 'json' | 'sarif' | 'github' | 'markdown';
export const LINT_FORMATS: LintFormat[] = ['text', 'json', 'sarif', 'github', 'markdown'];

export const SURFACE_TITLE: Record<Surface, string> = {
  agent: 'AI agent instructions',
  readme: 'README and contributing guides',
  docs: 'Docs',
  example: 'Code examples',
  docstring: 'Docstrings',
  config: 'Configuration',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function lintSummaryLine(r: LintResult): string {
  const s = r.summary;
  if (!r.findings.length) return `No stale references in ${plural(s.files, 'file')} (${s.ms} ms).`;
  const parts = [s.errors && plural(s.errors, 'error'), s.warnings && plural(s.warnings, 'warning'), s.infos && `${s.infos} info`].filter(Boolean);
  return `${parts.join(', ')} in ${plural(new Set(r.findings.map((f) => f.path)).size, 'file')} (${plural(s.files, 'file')} checked, ${s.ms} ms).`;
}

/** Group findings by section title, in the order the findings already have (agent files first). */
function groups(findings: Finding[]): [string, Finding[]][] {
  const out = new Map<string, Finding[]>();
  for (const f of findings) {
    const title = SURFACE_TITLE[f.surface];
    const list = out.get(title) ?? [];
    list.push(f);
    out.set(title, list);
  }
  return [...out];
}

export function formatText(r: LintResult): string {
  const out: string[] = [];
  for (const [title, list] of groups(r.findings)) {
    out.push(title, '');
    let lastPath = '';
    for (const f of list) {
      if (f.path !== lastPath) {
        out.push(`  ${f.path}`);
        lastPath = f.path;
      }
      out.push(`    ${f.line}:${f.column}  ${f.severity.padEnd(7)}  ${f.message}  [${f.rule}]`);
      if (f.fix?.verified) out.push(`             fix: ${f.fix.description}`);
    }
    out.push('');
  }
  for (const w of r.warnings) out.push(`warning: ${w}`);
  out.push(lintSummaryLine(r));
  return out.join('\n');
}

export function formatJson(r: LintResult): string {
  return JSON.stringify({ ...r, tool: { name: 'staleproof', version: packageVersion() } }, null, 2);
}

/** GitHub workflow commands: each finding becomes an annotation on the file and line. */
export function formatGithub(r: LintResult): string {
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s: string) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const level: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'notice' };
  return r.findings
    .map(
      (f) =>
        `::${level[f.severity]} file=${prop(f.path)},line=${f.line},col=${f.column},endLine=${f.endLine},endColumn=${f.endColumn},title=${prop(`Staleproof ${f.rule}`)}::${esc(f.message + (f.fix?.verified ? ` Fix: ${f.fix.description}` : ''))}`,
    )
    .join('\n');
}

/** SARIF 2.1.0, for GitHub code scanning and other SARIF viewers. */
export function formatSarif(r: LintResult): string {
  const level: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' };
  const used = RULES.filter((x) => r.findings.some((f) => f.rule === x.id));
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Staleproof',
            version: packageVersion(),
            informationUri: 'https://staleproof.dev',
            rules: used.map((x) => ({
              id: x.id,
              shortDescription: { text: x.summary },
              fullDescription: { text: x.why },
              helpUri: `https://staleproof.dev/#/docs/rules#${x.id}`,
              defaultConfiguration: { level: level[x.severity] },
            })),
          },
        },
        results: r.findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: used.findIndex((x) => x.id === f.rule),
          level: level[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path },
                region: { startLine: f.line, startColumn: f.column, endLine: f.endLine, endColumn: f.endColumn },
              },
            },
          ],
          partialFingerprints: { 'staleproof/v1': f.fingerprint },
          ...(f.fix?.verified
            ? {
                fixes: [
                  {
                    description: { text: f.fix.description },
                    artifactChanges: f.fix.edits.map((e) => ({
                      artifactLocation: { uri: e.path },
                      replacements: [
                        {
                          deletedRegion: { startLine: e.line, startColumn: e.column, endLine: e.endLine, endColumn: e.endColumn },
                          insertedContent: { text: e.newText },
                        },
                      ],
                    })),
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

/** A Markdown section for a PR comment, an issue or a job summary. */
export function formatMarkdown(r: LintResult, opts: { heading?: string } = {}): string {
  const out: string[] = [];
  if (opts.heading) out.push(opts.heading, '');
  if (!r.findings.length) {
    out.push(lintSummaryLine(r));
    return out.join('\n');
  }
  for (const [title, list] of groups(r.findings)) {
    out.push(`**${title}**`, '');
    for (const f of list) {
      const where = `${f.path}:${f.line}`;
      const link = f.evidence?.url ? `[\`${where}\`](${f.evidence.url})` : `\`${where}\``;
      out.push(`- ${link} ${f.message} <sub>${f.rule}</sub>${f.fix?.verified ? ` Fix: ${f.fix.description}` : ''}`);
    }
    out.push('');
  }
  out.push(`<sub>${lintSummaryLine(r)}</sub>`);
  return out.join('\n');
}

export function formatLint(r: LintResult, format: LintFormat): string {
  switch (format) {
    case 'json':
      return formatJson(r);
    case 'sarif':
      return formatSarif(r);
    case 'github':
      return formatGithub(r);
    case 'markdown':
      return formatMarkdown(r);
    default:
      return formatText(r);
  }
}

/** Exit code for `--fail-on`: 1 when any finding is at or above the level. */
export function lintExitCode(r: LintResult, failOn: Severity | 'never'): number {
  if (failOn === 'never') return 0;
  return r.findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]) ? 1 : 0;
}

