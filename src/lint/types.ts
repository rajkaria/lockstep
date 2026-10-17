/**
 * The findings model every Staleproof surface shares: `staleproof lint`, the hooks,
 * the editor, PR checks, the audit and the GitHub App all speak `Finding`.
 * The JSON form (`version: 1`) is public: change it only by adding fields.
 */

export type Severity = 'error' | 'warning' | 'info';

/** Where the stale text lives: agent instructions are listed first in every report. */
export type Surface = 'agent' | 'readme' | 'docs' | 'docstring' | 'example' | 'config';

export type RuleId =
  | 'path-missing'
  | 'line-out-of-range'
  | 'link-broken'
  | 'anchor-missing'
  | 'command-missing'
  | 'cli-command-unknown'
  | 'cli-flag-unknown'
  | 'env-unused'
  | 'env-undocumented'
  | 'symbol-missing'
  | 'docstring-param-unknown'
  | 'docstring-param-undocumented'
  | 'example-unknown-keyword'
  | 'example-too-many-arguments'
  | 'example-missing-argument'
  | 'example-missing-import'
  | 'example-missing-attribute'
  | 'example-removed';

export interface TextEdit {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  newText: string;
}

export interface Fix {
  /** "Rename to `npm run lint-docs` (script renamed in package.json)". */
  description: string;
  edits: TextEdit[];
  /** Re-checked after applying: the finding is gone and nothing new appeared. Only verified fixes are applied. */
  verified: boolean;
}

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** One plain sentence. */
  message: string;
  /** `owner/name` when known. */
  repo?: string;
  /** Repository-relative POSIX path of the stale text. */
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  endLine: number;
  /** Exclusive. */
  endColumn: number;
  surface: Surface;
  /** What the text refers to: `npm run lint:docs`, `FOO_URL`, `src/x.ts`, `Client.query`. */
  subject: string;
  /** Where Staleproof looked, so a reader can check the claim. */
  evidence?: { looked: string; url?: string; detail?: string };
  fix?: Fix;
  /** Stable across edits elsewhere in the file: rule, path, subject and occurrence, never the line. */
  fingerprint: string;
}

export interface LintSummary {
  errors: number;
  warnings: number;
  infos: number;
  /** Files checked (docs, agent files, READMEs). */
  files: number;
  byRule: Partial<Record<RuleId, number>>;
  bySurface: Partial<Record<Surface, number>>;
  ms: number;
}

export interface LintResult {
  version: 1;
  repo?: string;
  sha?: string;
  findings: Finding[];
  summary: LintSummary;
  /** Config problems and files that could not be read; never fatal. */
  warnings: string[];
}

export const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
