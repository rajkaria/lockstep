import { classifyFile } from '../indexer/repo.js';
import { matchesAny, type RepoConfig } from '../indexer/repo-config.js';
import { TRANSLATION_DIR } from '../hosted/workspaces.js';
import type { Surface } from './types.js';

/**
 * Instruction files AI coding agents read on every session. Drift here misleads every
 * run of the agent, so these are checked first and listed first.
 */
export const AGENT_FILE_GLOBS = [
  '**/AGENTS.md',
  '**/AGENT.md',
  '**/CLAUDE.md',
  '**/CLAUDE.local.md',
  '**/GEMINI.md',
  '.claude/**/*.md',
  '.cursorrules',
  '.cursor/rules/**/*.md',
  '.cursor/rules/**/*.mdc',
  '.github/copilot-instructions.md',
  '.github/instructions/**/*.instructions.md',
  '.windsurfrules',
  '.windsurf/rules/**/*.md',
  '.clinerules',
  '.clinerules/**/*.md',
  'CONVENTIONS.md',
];

const README = /(^|\/)(README|CONTRIBUTING|DEVELOPMENT|HACKING|SETUP|INSTALL)(\.[\w-]+)?\.(md|mdx|rst|txt)$/i;
const DOC_EXT = /\.(md|mdx|rst|mdc)$/i;
/** Housekeeping files whose content is history, not instructions. */
const NOT_CHECKED = /(^|\/)(CHANGELOG|CHANGES|HISTORY|RELEASE[-_]?NOTES|CODE_OF_CONDUCT|LICENSE|NOTICE|AUTHORS|PULL_REQUEST_TEMPLATE|ISSUE_TEMPLATE)[^/]*$/i;
const VENDORED = /(^|\/)(node_modules|vendor|third[-_]party|\.venv|venv|site-packages|__pycache__|\.git|fixtures?|testdata|__fixtures__|__snapshots__)\//;

export interface LintTarget {
  path: string;
  surface: Surface;
}

export function isAgentFile(path: string, extra: string[] = []): boolean {
  return matchesAny(path, AGENT_FILE_GLOBS) || matchesAny(path, extra);
}

/** Where a docs file sits in the report. */
export function surfaceOf(path: string, config?: RepoConfig): Surface {
  if (isAgentFile(path, config?.lint?.agentFiles)) return 'agent';
  if (README.test(path)) return 'readme';
  return 'docs';
}

/**
 * The files `staleproof lint` reads as docs: what the indexer reads as docs, plus
 * READMEs, CONTRIBUTING and every agent instruction file, minus ignored and excluded
 * paths. Agent files come first.
 */
export function lintTargets(paths: string[], config?: RepoConfig): LintTarget[] {
  const extraAgent = config?.lint?.agentFiles ?? [];
  const include = config?.lint?.include ?? [];
  const exclude = [...(config?.ignore ?? []), ...(config?.lint?.exclude ?? [])];
  const out: LintTarget[] = [];
  for (const path of paths) {
    // Translations mirror the source pages and are maintained (or generated) apart from them.
    if (VENDORED.test(path) || TRANSLATION_DIR.test(path) || matchesAny(path, exclude)) continue;
    const agent = isAgentFile(path, extraAgent);
    const wanted =
      agent ||
      matchesAny(path, include) ||
      (DOC_EXT.test(path) && !NOT_CHECKED.test(path) && (README.test(path) || classifyFile(path) === 'markdown'));
    if (!wanted) continue;
    out.push({ path, surface: agent ? 'agent' : README.test(path) ? 'readme' : 'docs' });
  }
  const order: Record<string, number> = { agent: 0, readme: 1, docs: 2 };
  return out.sort((a, b) => order[a.surface]! - order[b.surface]! || a.path.localeCompare(b.path));
}
