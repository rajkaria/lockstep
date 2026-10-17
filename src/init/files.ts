import type { Detected } from './detect.js';

/** The GitHub Action ref every workflow uses (the moving major tag). */
export const ACTION_REF = 'rajkaria/staleproof@v1';
export const SITE = 'https://staleproof.dev';
/** The workflow gets a weekly docs-fix job once the Action has `mode: fix`. */
export const ACTION_HAS_FIX_MODE = false;
/** The VS Code extension id, once it is published (then `init` recommends it in `.vscode/extensions.json`). */
export const VSCODE_EXTENSION: string | undefined = undefined;

/** How a hook command runs Staleproof: the project's own install, else the pinned release through npx. */
export function cliCommand(d: Pick<Detected, 'staleproofDependency'>, version: string): string {
  return d.staleproofDependency ? 'npx --no-install staleproof' : `npx -y staleproof@${version}`;
}

function list(xs: string[], empty = 'none found'): string {
  return xs.length ? xs.join(', ') : empty;
}

/** `.staleproof.toml`: what init found, and every setting a repository usually changes, commented out. */
export function configToml(d: Detected): string {
  return [
    '# Staleproof settings: https://staleproof.dev/#/docs/configuration',
    `# Written by \`staleproof init\`${d.repo ? ` for ${d.repo}` : ''}. It found:`,
    `#   code: ${list(d.languages)}`,
    `#   docs folders: ${list(d.docsDirs.map((x) => `${x}/`))}`,
    `#   agent files: ${list(d.agentFiles)}`,
    '',
    '# Paths never indexed or checked (generated or vendored docs, old versions):',
    '# ignore = ["docs/api/**"]',
    '# Docs whose examples are indexed but never run or checked:',
    '# skip-examples = ["docs/legacy/**"]',
    '',
    '[lint]',
    '# include = []                      # more files to check (globs)',
    '# exclude = ["docs/archive/**"]     # files never checked',
    '# agent-files = ["prompts/*.md"]    # more AI agent instruction files',
    '',
    '[rules]',
    '# Change a rule\'s severity or turn it off (off | info | warning | error); every rule: https://staleproof.dev/#/docs/rules',
    '# "anchor-missing" = "error"',
    '',
    '[hooks]',
    '# What the coding-agent stop hook does with docs a session made wrong: block (ask the agent to fix them) | warn | off',
    'stop = "block"',
    '',
  ].join('\n');
}

/** `.github/workflows/staleproof.yml`: the pull request check and the weekly audit (and, once the Action has it, the weekly fix). */
export function workflowYaml(d: Detected, docsRepo?: string): string {
  const alsoIndex = docsRepo ? [`        with:`, `          also-index: ${docsRepo}   # the docs repository, indexed with this one`] : [`        # with:`, `        #   also-index: your-org/docs   # docs in another repository`];
  const out = [
    '# Staleproof: on every pull request, a comment with the docs it makes wrong and annotations on those lines;',
    '# every Monday, an audit of all the docs, kept in one issue. No secrets, no database to set up.',
    '# https://staleproof.dev/#/docs/github-action',
    'name: Staleproof',
    'on:',
    '  pull_request:',
    '  schedule:',
    "    - cron: '17 6 * * 1'",
    '  workflow_dispatch:',
    '',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    '  issues: write',
    '',
    'jobs:',
    '  docs:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${ACTION_REF}`,
    ...alsoIndex,
  ];
  if (ACTION_HAS_FIX_MODE) {
    out.push(
      '',
      '  fix:',
      "    if: github.event_name == 'schedule'",
      '    runs-on: ubuntu-latest',
      '    permissions:',
      '      contents: write',
      '      pull-requests: write',
      '    steps:',
      `      - uses: ${ACTION_REF}`,
      '        with:',
      '          mode: fix',
    );
  }
  return `${out.join('\n')}\n`;
}

export function badgeMarkdown(repo: string): string {
  return `[![docs health](${SITE}/api/badge/${repo}.svg)](${SITE}/#/audit?repo=${encodeURIComponent(repo)})`;
}

const BADGE_LINE = /^\s*(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*|!\[[^\]]*\]\([^)]*\)\s*)+$/;

/**
 * The README with the docs health badge: at the end of the badge row near the top, else
 * after the first heading. Undefined when it is there already or there is no safe place
 * (a README that starts with HTML).
 */
export function readmeWithBadge(readme: string, repo: string): string | undefined {
  if (readme.includes(`${SITE}/api/badge/`)) return undefined;
  const badge = badgeMarkdown(repo);
  const lines = readme.split('\n');
  const top = Math.min(lines.length, 20);
  for (let i = 0; i < top; i++) {
    if (!BADGE_LINE.test(lines[i]!)) continue;
    let last = i;
    while (last + 1 < lines.length && BADGE_LINE.test(lines[last + 1]!)) last++;
    lines[last] = `${lines[last]!.trimEnd()} ${badge}`;
    return lines.join('\n');
  }
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.trim().startsWith('<')) return undefined;
  const heading = lines.findIndex((l, i) => i < top && (/^#{1,6}\s/.test(l) || (i > 0 && /^(=+|-+)\s*$/.test(l) && lines[i - 1]!.trim() !== '')));
  if (heading < 0) return `${badge}\n\n${readme}`;
  lines.splice(heading + 1, 0, '', badge);
  // Keep one blank line between the badge and what follows.
  if (lines[heading + 3] !== undefined && lines[heading + 3]!.trim() !== '') lines.splice(heading + 3, 0, '');
  return lines.join('\n');
}

/** How a `.pre-commit-config.yaml` writes its lists: `  - repo:` or `-   repo:`, and the hooks list under its key. */
interface ListStyle {
  indent: string;
  gap: string;
  /** Extra indentation of `- id:` under `hooks:`. */
  hooksIndent: string;
  hooksGap: string;
}

const DEFAULT_STYLE: ListStyle = { indent: '  ', gap: ' ', hooksIndent: '  ', hooksGap: ' ' };

function listStyle(lines: string[]): ListStyle {
  const repo = lines.map((l) => /^(\s*)-(\s+)repo:/.exec(l)).find(Boolean);
  if (!repo) return DEFAULT_STYLE;
  const key = repo[1]!.length + 1 + repo[2]!.length;
  const hooks = lines.map((l) => /^(\s*)hooks:/.exec(l)).find((m) => m && m[1]!.length === key);
  const id = lines.map((l) => /^(\s*)-(\s+)id:/.exec(l)).find(Boolean);
  return {
    indent: repo[1]!,
    gap: repo[2]!,
    hooksIndent: hooks && id ? ' '.repeat(Math.max(0, id[1]!.length - key)) : DEFAULT_STYLE.hooksIndent,
    hooksGap: id ? id[2]! : DEFAULT_STYLE.hooksGap,
  };
}

/** The `.pre-commit-config.yaml` entry (the hook is defined in this repository's `.pre-commit-hooks.yaml`). */
export function preCommitEntry(version: string, style: ListStyle = DEFAULT_STYLE): string {
  const key = `${style.indent}${' '.repeat(1 + style.gap.length)}`;
  return [
    `${style.indent}-${style.gap}repo: https://github.com/rajkaria/staleproof`,
    `${key}rev: v${version}`,
    `${key}hooks:`,
    `${key}${style.hooksIndent}-${style.hooksGap}id: staleproof`,
  ].join('\n');
}

/**
 * `.pre-commit-config.yaml` with the Staleproof hook appended to `repos:`, in the file's
 * own list style. Undefined when it is there already or the file has no `repos:` list.
 */
export function preCommitWithStaleproof(text: string | undefined, version: string): string | undefined {
  if (text === undefined) return `repos:\n${preCommitEntry(version)}\n`;
  if (/github\.com\/rajkaria\/staleproof/.test(text)) return undefined;
  const lines = text.replace(/\s+$/, '').split('\n');
  const start = lines.findIndex((l) => /^repos:\s*(#.*)?$/.test(l));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!) && !lines[i]!.startsWith('#') && !lines[i]!.startsWith('-')) {
      end = i;
      break;
    }
  }
  const style = listStyle(lines.slice(start + 1, end));
  while (end > start + 1 && !lines[end - 1]!.trim()) end--;
  lines.splice(end, 0, preCommitEntry(version, style));
  return `${lines.join('\n')}\n`;
}

const HOOK_LINE = (cli: string) => `${cli} lint --new --staged`;

/** lefthook: a `pre-commit` command. Undefined when there already is one for Staleproof, or a `pre-commit:` block to edit by hand. */
export function lefthookWithStaleproof(text: string, cli: string): string | undefined {
  if (/staleproof/.test(text) || /^pre-commit:/m.test(text)) return undefined;
  return `${text.replace(/\s+$/, '')}\n\npre-commit:\n  commands:\n    staleproof:\n      run: ${HOOK_LINE(cli)}\n`;
}

/** husky: the line in `.husky/pre-commit`. */
export function huskyWithStaleproof(text: string | undefined, cli: string): string | undefined {
  if (text !== undefined && /staleproof/.test(text)) return undefined;
  return text === undefined || !text.trim() ? `${HOOK_LINE(cli)}\n` : `${text.replace(/\s+$/, '')}\n${HOOK_LINE(cli)}\n`;
}

/** `.gitignore` with `.staleproof/` (the local parse cache and hook state). Undefined when it is ignored already. */
export function gitignoreWithStaleproof(text: string | undefined): string | undefined {
  if (text !== undefined && /^\/?\.staleproof\/?\s*$/m.test(text)) return undefined;
  const entry = '# Staleproof parse cache and hook state\n.staleproof/\n';
  return text === undefined || !text.trim() ? entry : `${text.replace(/\s+$/, '')}\n\n${entry}`;
}

/** The indentation a JSON file already uses (2 spaces for a new one). */
function jsonIndent(text: string | undefined): string | number {
  return /^[{[]\n([ \t]+)\S/.exec(text ?? '')?.[1] ?? 2;
}

type HookEntry = { type: 'command'; command: string; timeout?: number; async?: boolean };
type MatcherGroup = { matcher?: string; hooks: HookEntry[] };

/** The Claude Code hooks, as the plugin defines them, run through `cli`. */
export function claudeHooks(cli: string): Record<string, MatcherGroup[]> {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: `${cli} hook session-start`, async: true, timeout: 120 }] }],
    PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: `${cli} hook post-edit`, timeout: 15 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${cli} hook stop`, timeout: 60 }] }],
  };
}

function hasStaleproofHook(groups: unknown, event: string): boolean {
  const name = { SessionStart: 'session-start', PostToolUse: 'post-edit', Stop: 'stop', sessionStart: 'session-start', postToolUse: 'post-edit', stop: 'stop' }[event];
  const s = JSON.stringify(groups ?? '');
  return s.includes('staleproof') && s.includes(`hook ${name}`);
}

/**
 * `.claude/settings.json` with the Staleproof hooks merged in: other settings and other
 * hooks are kept as they are. Undefined when every hook is there already. Throws on a
 * file that is not JSON (init then prints the hooks to add by hand).
 */
export function claudeSettingsWithHooks(text: string | undefined, cli: string): string | undefined {
  const doc = (text?.trim() ? JSON.parse(text) : {}) as Record<string, unknown>;
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not a JSON object');
  const hooks = (doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {}) as Record<string, MatcherGroup[]>;
  let changed = false;
  for (const [event, groups] of Object.entries(claudeHooks(cli))) {
    if (hasStaleproofHook(hooks[event], event)) continue;
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups];
    changed = true;
  }
  if (!changed) return undefined;
  doc.hooks = hooks;
  return `${JSON.stringify(doc, null, jsonIndent(text))}\n`;
}

/** `.cursor/hooks.json` (version 1) with the Staleproof hooks merged in. */
export function cursorHooksWithStaleproof(text: string | undefined, cli: string): string | undefined {
  const doc = (text?.trim() ? JSON.parse(text) : { version: 1 }) as { version?: number; hooks?: Record<string, unknown[]> };
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not a JSON object');
  const hooks = doc.hooks ?? {};
  const ours: Record<string, Record<string, unknown>> = {
    sessionStart: { command: `${cli} hook session-start --cursor` },
    postToolUse: { command: `${cli} hook post-edit --cursor`, matcher: 'Write' },
    stop: { command: `${cli} hook stop --cursor`, loop_limit: 1 },
  };
  let changed = false;
  for (const [event, entry] of Object.entries(ours)) {
    if (hasStaleproofHook(hooks[event], event)) continue;
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry];
    changed = true;
  }
  if (!changed) return undefined;
  return `${JSON.stringify({ version: doc.version ?? 1, ...doc, hooks }, null, jsonIndent(text))}\n`;
}

/** `.vscode/extensions.json` recommending the Staleproof extension. */
export function vscodeExtensionsWith(text: string | undefined, id: string): string | undefined {
  const doc = (text?.trim() ? JSON.parse(text) : {}) as { recommendations?: string[] };
  const recs = Array.isArray(doc.recommendations) ? doc.recommendations : [];
  if (recs.includes(id)) return undefined;
  return `${JSON.stringify({ ...doc, recommendations: [...recs, id] }, null, 2)}\n`;
}
