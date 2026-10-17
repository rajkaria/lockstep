/**
 * The documentation set: one entry per Markdown file in docs/. The web docs
 * pages, the site's /llms.txt, /llms-full.txt and /docs/<slug>.md, and the
 * repository's llms.txt are all built from this list, so a page added here is
 * published everywhere at once (a test checks every docs/*.md is listed).
 *
 * Plain TypeScript with no DOM or Node imports: vite.config.ts, the web app and
 * scripts/gen-docs.ts all import it.
 */

/** The product name, written once for the web app (the name may change). */
export const PRODUCT = 'Staleproof';
export const SITE_URL = 'https://staleproof.dev';
export const REPO_URL = 'https://github.com/rajkaria/staleproof';
export const PACKAGE = 'staleproof';

export type DocGroup = 'Start here' | 'Integrate' | 'How it works' | 'Reference' | 'Operate';

export interface DocEntry {
  /** URL slug: `#/docs/<slug>` in the app, `/docs/<slug>.md` as raw Markdown. */
  slug: string;
  /** File under docs/. */
  file: string;
  title: string;
  /** One sentence: what a reader (or a model) finds on the page. */
  summary: string;
  group: DocGroup;
  /** Generated from the code or the graph; never edited by hand. */
  generated?: boolean;
}

export const DOC_GROUPS: DocGroup[] = ['Start here', 'Integrate', 'How it works', 'Reference', 'Operate'];

export const DOCS: DocEntry[] = [
  {
    slug: 'introduction',
    file: 'README.md',
    title: 'Introduction',
    summary: 'What Staleproof is, the problem it solves, and a map of the documentation.',
    group: 'Start here',
  },
  {
    slug: 'getting-started',
    file: 'getting-started.md',
    title: 'Quickstart',
    summary: 'Three ways to start (website, GitHub Action, one command), then a walkthrough: local FalkorDB, index, check, patch, serve, MCP.',
    group: 'Start here',
  },
  {
    slug: 'install',
    file: 'install.md',
    title: 'Install',
    summary: 'Every way to use Staleproof, from no install to one command: the website, the GitHub Action, hosted and local MCP, the CLI.',
    group: 'Start here',
  },
  {
    slug: 'use-cases',
    file: 'use-cases.md',
    title: 'Use cases',
    summary: 'Who uses Staleproof and how: SDK teams with a separate docs site, DevRel after a release, maintainers reviewing PRs, checks before a push, AI coding agents, a weekly docs audit, multi-repo platforms.',
    group: 'Start here',
  },
  {
    slug: 'audit',
    file: 'audit.md',
    title: 'Docs audit',
    summary: 'How true the docs are with no pull request: example lines that no longer fit the code, example runs, API coverage, a 0-100 health score, the README badge and a weekly audit in CI.',
    group: 'Start here',
  },
  {
    slug: 'lint',
    file: 'lint.md',
    title: 'Lint docs and agent files',
    summary: 'staleproof lint: every path, link, anchor and code example in the docs, READMEs and AI agent instruction files (AGENTS.md, CLAUDE.md, Cursor and Copilot rules) checked against the repository, with no graph and no network; formats for terminals, CI annotations and SARIF.',
    group: 'Start here',
  },
  {
    slug: 'cli',
    file: 'cli.md',
    title: 'CLI',
    summary: 'Every staleproof command and option, with examples and what each prints.',
    group: 'Integrate',
  },
  {
    slug: 'github-action',
    file: 'github-action.md',
    title: 'GitHub Action',
    summary: 'Zero-config Action: a comment on every pull request with the docs it can make false, the examples predicted to break and the examples run before and after; a scheduled docs audit with one issue; inputs, outputs, permissions, the comment format.',
    group: 'Integrate',
  },
  {
    slug: 'mcp',
    file: 'mcp.md',
    title: 'MCP server',
    summary: 'Give Claude Code, Claude Desktop, claude.ai, Cursor, VS Code or any MCP client the Staleproof tools: hosted over HTTP, or local over stdio.',
    group: 'Integrate',
  },
  {
    slug: 'http-api',
    file: 'http-api.md',
    title: 'HTTP API',
    summary: 'Every endpoint of staleproof serve: health, stats, streaming checks over SSE, indexing on demand, docs audits and badges, docs for a symbol, MCP over HTTP, traces, patches, decisions, verdict review.',
    group: 'Integrate',
  },
  {
    slug: 'library',
    file: 'library.md',
    title: 'Node.js library',
    summary: 'Use Staleproof from TypeScript: index, check with or without a model, build patches, embed the API or the MCP server.',
    group: 'Integrate',
  },
  {
    slug: 'concepts',
    file: 'concepts.md',
    title: 'Core concepts',
    summary: 'Impact, evidence paths, severity, clearance, static checks and predicted breaks, the audit, verdicts, decisions, runs, checks, agent mode and graph mode, ids.',
    group: 'How it works',
  },
  {
    slug: 'indexing',
    file: 'indexing.md',
    title: 'Indexing',
    summary: 'What the indexer reads (Python, TypeScript and JavaScript; Markdown, MDX and reStructuredText), how calls are resolved across repositories, how docs and examples are linked to and checked against code, example directives, and re-index semantics.',
    group: 'How it works',
  },
  {
    slug: 'example-runner',
    file: 'example-runner.md',
    title: 'Example runner',
    summary: 'How docs examples run before and after a pull request: virtualenvs per commit, the sandbox, the scratch FalkorDB, skip rules, run outcomes.',
    group: 'How it works',
  },
  {
    slug: 'memory',
    file: 'memory.md',
    title: 'Decisions and memory',
    summary: 'Maintainer decisions, supersession, verdict review and what every check writes back to the graph.',
    group: 'How it works',
  },
  {
    slug: 'agent',
    file: 'agent.md',
    title: 'The agent',
    summary: 'The agent loop, its system prompt and stop condition, model providers (Claude or Anthropic-compatible), budgets, and graph mode.',
    group: 'How it works',
  },
  {
    slug: 'rules',
    file: 'rules.md',
    title: 'Lint rules',
    summary: 'Every staleproof lint rule: default severity, where it looks, an example of the stale text and the message it gets.',
    group: 'Reference',
    generated: true,
  },
  {
    slug: 'tools',
    file: 'tools.md',
    title: 'Tools reference',
    summary: 'The fourteen tools the agent and MCP clients call: parameters, results, errors and the Cypher each one runs.',
    group: 'Reference',
  },
  {
    slug: 'configuration',
    file: 'configuration.md',
    title: 'Configuration',
    summary: 'Every environment variable and global CLI option, with defaults, and the per-repository .staleproof.toml.',
    group: 'Reference',
  },
  {
    slug: 'graph-model',
    file: 'GRAPH-MODEL.md',
    title: 'Graph model and Cypher',
    summary: 'Every Cypher statement Staleproof sends to FalkorDB, named and explained, generated from the code.',
    group: 'Reference',
    generated: true,
  },
  {
    slug: 'facts',
    file: 'FACTS.md',
    title: 'Facts from the graph',
    summary: 'Every number Staleproof quotes about FalkorDB’s repositories, computed from the graph.',
    group: 'Reference',
    generated: true,
  },
  {
    slug: 'architecture',
    file: 'ARCHITECTURE.md',
    title: 'Architecture',
    summary: 'Source layout and a check end to end, for contributors.',
    group: 'Reference',
  },
  {
    slug: 'deploy',
    file: 'DEPLOY.md',
    title: 'Deploy',
    summary: 'Run Staleproof on Vercel with FalkorDB Cloud, on a VM with Docker Compose, or without Docker; hosted mode and its limits.',
    group: 'Operate',
  },
  {
    slug: 'troubleshooting',
    file: 'troubleshooting.md',
    title: 'Troubleshooting and FAQ',
    summary: 'Common errors and what they mean, limits stated plainly, and answers to frequent questions.',
    group: 'Operate',
  },
];

/** GitHub-style heading anchors, so links written for GitHub work on the site too. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export function docBySlug(slug: string): DocEntry | undefined {
  return DOCS.find((d) => d.slug === slug);
}

export function docByFile(file: string): DocEntry | undefined {
  return DOCS.find((d) => d.file === file);
}

const PITCH =
  `${PRODUCT} keeps a software organisation’s documentation true to its code. For a GitHub pull request it walks a FalkorDB graph of code ` +
  '(Python, TypeScript and JavaScript symbols and call edges across repositories), docs (Markdown, MDX and reStructuredText sections and code examples), ' +
  'maintainers’ decisions and past verdicts; flags the examples whose calls no longer fit the changed code; runs the impacted docs examples before and after ' +
  'the change in a sandbox; and proposes the docs fix with the graph path behind each paragraph. With no pull request it audits the docs (a health score, ' +
  'examples that no longer fit the code, API coverage) and checks a working tree before it is pushed. ' +
  `Open source (MIT), published on npm as \`${PACKAGE}\`.`;

/**
 * llms.txt (https://llmstxt.org): what Staleproof is in a paragraph, then one
 * link per page. `link` turns an entry into the URL to put in the list.
 */
export function llmsTxt(link: (d: DocEntry) => string, extra: { title: string; url: string; summary: string }[] = []): string {
  const out = [
    `# ${PRODUCT}`,
    '',
    `> ${PITCH}`,
    '',
    'Quick facts for assistants:',
    '',
    `- Run: \`npx -y ${PACKAGE} <command>\` (Node 20+). Commands: \`db start|stop|status\`, \`index <owner/repo...>\`, \`check <pr-url> [--no-agent] [--with <repo...>]\`, \`check\` with no pull request (the working tree; \`--fail-on-predicted\` for a pre-push hook), \`audit [owner/repo...] [--run <n>] [--format text|markdown|json] [--fail-under <score>]\`, \`docs-for <symbol>\`, \`run <example-id> --pr <url>\`, \`decide <text> --governs <id...>\`, \`verdict accept|reject <id>\`, \`patch <pr-url> [--open-pr]\`, \`mcp\`, \`serve [--hosted]\`, \`facts\`.`,
    `- No install: paste a pull request URL on ${SITE_URL} (any public repository, indexed on first use; no example runs there), or audit a repository at ${SITE_URL}/#/audit. GitHub Action: \`uses: rajkaria/staleproof@v1\` with no inputs or secrets; on a schedule it audits the docs and keeps one issue up to date.`,
    `- MCP, hosted: \`claude mcp add --transport http staleproof ${SITE_URL}/api/mcp\`. Local: \`claude mcp add staleproof -- npx -y ${PACKAGE} mcp\`. Tools: check_pull_request (the whole report in one call), check_changes (edits before a pull request), docs_for_symbol (the docs that depend on a symbol), audit_docs (the docs audit), impact, clearance, read_section, run_example (local only), decisions_for, rank_sections, propose_edit, record_verdict, write_decision, docs_patch.`,
    '- Needs a FalkorDB server (`FALKORDB_URL`, default `falkor://localhost:6379`); the CLI starts a local one when none is configured, and `check` indexes the pull request\'s repository on first use. Agent mode needs `ANTHROPIC_API_KEY` (Claude, or an Anthropic-compatible provider via `ANTHROPIC_BASE_URL`); without it, `--no-agent` (graph mode) runs the same tools in a fixed order with no model.',
    '- Ids: Symbol `owner/repo:qualname`; DocSection `owner/repo:path#anchor`; CodeExample `owner/repo:path:index`.',
    '- Limits: code is read as Python, or TypeScript and JavaScript in npm packages; docs as Markdown, MDX or reStructuredText; only Python examples run or get argument checks; GitHub repositories only, private ones with `GITHUB_TOKEN` (the hosted site reads public ones only).',
    '',
  ];
  for (const group of DOC_GROUPS) {
    out.push(`## ${group}`, '');
    for (const d of DOCS.filter((x) => x.group === group)) out.push(`- [${d.title}](${link(d)}): ${d.summary}`);
    out.push('');
  }
  if (extra.length) {
    out.push('## Optional', '');
    for (const e of extra) out.push(`- [${e.title}](${e.url}): ${e.summary}`);
    out.push('');
  }
  return out.join('\n');
}

/** llms-full.txt: every page in one file, in reading order, each under its own header. */
export function llmsFullTxt(read: (d: DocEntry) => string, link: (d: DocEntry) => string): string {
  const parts = [`# ${PRODUCT} — full documentation`, '', `> ${PITCH}`, '', `Index: ${SITE_URL}/llms.txt`, ''];
  for (const group of DOC_GROUPS) {
    for (const d of DOCS.filter((x) => x.group === group)) {
      parts.push('---', '', `<!-- page: ${d.title} · ${group} · source: ${link(d)} -->`, '', read(d).trim(), '');
    }
  }
  return parts.join('\n');
}
