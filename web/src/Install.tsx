import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { PACKAGE, PRODUCT, SITE_URL } from './docs/manifest';
import { mcpLinks, newWorkflowUrl, repoFromInput, WORKFLOW_PATH, workflowYaml } from './install-links';
import { ago } from './format';
import { CodeBlock, CopyButton, Icon } from './layout';
import type { Health, RepoStatus } from './types';

/** This deployment's origin, so the MCP links point at the server the page came from. */
function origin(): string {
  return typeof window === 'undefined' ? SITE_URL : window.location.origin;
}

interface GhRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  language: string | null;
  archived: boolean;
}

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  updated_at: string;
}

export function InstallPage({ initialRepo, health }: { initialRepo?: string; health?: Health }) {
  return (
    <div className="install-page">
      <section className="band install-hero">
        <div className="wrap">
          <span className="eyebrow">Install</span>
          <h1>{PRODUCT} on every pull request, in one click</h1>
          <p className="lede">
            Pick where you want it. None of these needs an account, a database or an API key: the GitHub Action brings its own FalkorDB, the hosted endpoint indexes
            any public repository on first use, and the CLI starts a local one.
          </p>
          <nav className="install-jump" aria-label="Install options">
            <a href="#/install" onClick={(e) => jump(e, 'github')} className="card install-option">
              <span className="card-icon">
                <Icon name="pr" />
              </span>
              <strong>GitHub</strong>
              <span className="muted small">A comment on every pull request, examples run before and after.</span>
            </a>
            <a href="#/install" onClick={(e) => jump(e, 'assistant')} className="card install-option">
              <span className="card-icon">
                <Icon name="bot" />
              </span>
              <strong>AI assistant</strong>
              <span className="muted small">Claude, Cursor or VS Code ask it about any pull request.</span>
            </a>
            <a href="#/install" onClick={(e) => jump(e, 'terminal')} className="card install-option">
              <span className="card-icon">
                <Icon name="terminal" />
              </span>
              <strong>Terminal</strong>
              <span className="muted small">One command, on your machine, private repositories too.</span>
            </a>
          </nav>
        </div>
      </section>
      <GitHubInstall initialRepo={initialRepo} health={health} />
      <AssistantInstall />
      <TerminalInstall />
    </div>
  );
}

function jump(e: React.MouseEvent, id: string) {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function GitHubInstall({ initialRepo, health }: { initialRepo?: string; health?: Health }) {
  const [input, setInput] = useState(initialRepo ?? '');
  const repo = repoFromInput(input);
  const [gh, setGh] = useState<{ repo: string; info?: GhRepo; error?: string }>();
  const [pulls, setPulls] = useState<GhPull[]>([]);
  const [status, setStatus] = useState<RepoStatus>();
  const [branch, setBranch] = useState('main');
  const [docs, setDocs] = useState('');
  const [agent, setAgent] = useState(false);
  const [failOnBreaks, setFailOnBreaks] = useState(false);

  // Look the repository up on GitHub (from the browser: the visitor's own rate limit) once typing pauses.
  useEffect(() => {
    if (!repo) {
      setGh(undefined);
      setPulls([]);
      setStatus(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      fetch(`https://api.github.com/repos/${repo}`, { headers: { Accept: 'application/vnd.github+json' } })
        .then(async (r) => {
          if (!live) return;
          if (r.status === 404) return setGh({ repo, error: 'not-found' });
          if (!r.ok) return setGh({ repo, error: r.status === 403 ? 'rate-limited' : `GitHub answered ${r.status}` });
          const info = (await r.json()) as GhRepo;
          setGh({ repo, info });
          setBranch(info.default_branch);
          const p = await fetch(`https://api.github.com/repos/${info.full_name}/pulls?state=all&per_page=5&sort=updated&direction=desc`);
          if (live && p.ok) setPulls((await p.json()) as GhPull[]);
        })
        .catch(() => live && setGh({ repo, error: 'offline' }));
      api.repo(repo).then((s) => live && setStatus(s)).catch(() => live && setStatus(undefined));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [repo]);

  const withRepos = docs
    .split(/[\s,]+/)
    .map((d) => repoFromInput(d))
    .filter((d): d is string => !!d && d.toLowerCase() !== repo?.toLowerCase());
  const yaml = useMemo(() => workflowYaml({ withRepos, agent, failOnBreaks }), [withRepos.join(' '), agent, failOnBreaks]);
  const target = gh?.info?.full_name ?? repo;
  const link = target ? newWorkflowUrl(target, branch, yaml) : undefined;
  const hostedOk = !!health?.hosted?.enabled && !gh?.info?.private;

  return (
    <section className="band" id="github">
      <div className="wrap install-grid">
        <div className="install-copy">
          <span className="eyebrow">GitHub Action</span>
          <h2>Add it to a repository</h2>
          <p>
            Type the repository. The button opens GitHub's new-file page with the workflow filled in; click <strong>Commit changes</strong> and the next pull
            request gets a comment like the one below — the docs it can make false, the path from the changed code to each one, and the examples run before and
            after.
          </p>
          <form className="repo-form" onSubmit={(e) => e.preventDefault()}>
            <label htmlFor="repo-input">Repository</label>
            <div className="repo-input-row">
              <span className="prefix">github.com/</span>
              <input
                id="repo-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="owner/repository"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <RepoLine repo={repo} gh={gh} />
            <details className="options">
              <summary>Options</summary>
              <label htmlFor="docs-input">Docs in other repositories (indexed together, so paths across them resolve)</label>
              <input id="docs-input" value={docs} onChange={(e) => setDocs(e.target.value)} placeholder="your-org/docs" spellCheck={false} />
              <label className="check">
                <input type="checkbox" checked={agent} onChange={(e) => setAgent(e.target.checked)} /> Agent mode: a model judges every section and proposes the edits
                (needs an <code>ANTHROPIC_API_KEY</code> secret)
              </label>
              <label className="check">
                <input type="checkbox" checked={failOnBreaks} onChange={(e) => setFailOnBreaks(e.target.checked)} /> Fail the check when an example passes before the pull
                request and fails after it
              </label>
              {gh?.error && (
                <>
                  <label htmlFor="branch-input">Default branch</label>
                  <input id="branch-input" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} />
                </>
              )}
            </details>
            <div className="cta-row">
              <a className={`btn btn-primary${link ? '' : ' disabled'}`} href={link} target="_blank" rel="noreferrer" aria-disabled={!link}>
                <Icon name="github" /> {target ? `Add to ${target}` : 'Add to GitHub'}
              </a>
              <CopyButton text={yaml} label="Copy the workflow" />
              <span className="muted small">or copy the workflow</span>
            </div>
            {agent && target && (
              <p className="note">
                Then add your model key as a repository secret named <code>ANTHROPIC_API_KEY</code>:{' '}
                <a href={`https://github.com/${target}/settings/secrets/actions/new`} target="_blank" rel="noreferrer">
                  open {target}'s secrets
                </a>
                . Another Anthropic-compatible provider works too: add <code>model</code> and <code>base-url</code> to the workflow (
                <a href="#/docs/github-action">guide</a>).
              </p>
            )}
          </form>
          <ol className="install-steps">
            <li>GitHub opens <code>{WORKFLOW_PATH}</code>, filled in. Commit it to {branch} or open it as a pull request.</li>
            <li>On each pull request the job starts a FalkorDB, indexes the repository, checks the change and runs up to 3 affected examples before and after.</li>
            <li>One comment appears on the pull request (and stays updated); the report is also in the job summary. Private repositories work with the default token.</li>
          </ol>
          {target && pulls.length > 0 && hostedOk && (
            <div className="try-pulls">
              <h3>Or see it on {target} right now</h3>
              <p className="muted small">
                {status?.indexed ? `Indexed ${status.indexedAt ? ago(status.indexedAt) : ''} on this server.` : 'This server indexes it on the first check (seconds for most projects).'}
              </p>
              <ul>
                {pulls.map((p) => (
                  <li key={p.number}>
                    <a href={`#/try?pr=${encodeURIComponent(p.html_url)}`}>
                      <span className="pr-ref">#{p.number}</span> {p.title}
                    </a>
                    <span className="muted small"> · {p.merged_at ? 'merged' : p.state}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="install-preview">
          <CodeBlock lang="yaml" title={WORKFLOW_PATH} code={yaml} />
          <SampleComment />
        </div>
      </div>
    </section>
  );
}

function RepoLine({ repo, gh }: { repo?: string; gh?: { repo: string; info?: GhRepo; error?: string } }) {
  if (!repo) return <p className="muted small repo-line">Paste a repository or pull request URL, or type owner/name.</p>;
  if (!gh || gh.repo !== repo) return <p className="muted small repo-line">Looking up {repo}…</p>;
  if (gh.info) {
    return (
      <p className="small repo-line ok">
        <Icon name="check" size={14} /> {gh.info.full_name} · default branch <code>{gh.info.default_branch}</code>
        {gh.info.language ? ` · ${gh.info.language}` : ''}
        {gh.info.private ? ' · private' : ''}
        {gh.info.archived ? ' · archived (pull requests are closed)' : ''}
        {gh.info.language && gh.info.language !== 'Python' && !gh.info.private ? ' · Staleproof reads Python code; Markdown docs of any language are indexed' : ''}
      </p>
    );
  }
  if (gh.error === 'not-found') {
    return <p className="small repo-line">GitHub doesn't show {repo} publicly. If it is private, the button still works while you're signed in; check the branch under Options.</p>;
  }
  return <p className="small repo-line">Couldn't look {repo} up ({gh.error}); the button assumes the branch under Options.</p>;
}

/** What lands on the pull request, rendered from the report format (src/format/markdown.ts). */
function SampleComment() {
  return (
    <figure className="sample-comment" aria-label="Example pull request comment">
      <figcaption>
        <Icon name="bot" size={16} /> <strong>github-actions</strong> <span className="muted small">commented</span>
      </figcaption>
      <div className="sample-body">
        <h4>Staleproof: this pull request breaks 1 docs example</h4>
        <p className="small">1 changed symbol reaches 2 doc sections (1 breaking, 0 signature, 1 behavior; 1 in other repositories).</p>
        <table>
          <thead>
            <tr>
              <th>Example</th>
              <th>Before</th>
              <th>After</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>docs/quickstart.md:0</code>
              </td>
              <td>passes</td>
              <td>
                <code>AttributeError: 'Graph' object has no attribute 'ro_query'</code>
              </td>
              <td>
                <strong>breaks</strong>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small">
          <span className="chip sev breaking">breaking</span> Quickstart › Read-only queries · <code>Graph.ro_query</code> ← <code>docs/quickstart.md:0</code>
        </p>
      </div>
      <p className="muted small">An illustration of the format; the rows come from your repository.</p>
    </figure>
  );
}

/** For AGENTS.md / CLAUDE.md: when a coding agent should call Staleproof. */
export const AGENT_RULES = `## Docs stay true to code (Staleproof MCP)
- Before changing a public function, class or method, call docs_for_symbol with its name:
  update every doc section and example it lists in the same change.
- Before committing, call check_changes with the files you edited: fix every example
  it predicts to break (its call no longer fits the new signature).`;

const PRE_PUSH = `printf '#!/bin/sh\\nnpx -y ${PACKAGE} check --fail-on-predicted\\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push`;

function AssistantInstall() {
  const url = `${origin()}/api/mcp`;
  const links = mcpLinks(url);
  return (
    <section className="band alt" id="assistant">
      <div className="wrap install-grid">
        <div className="install-copy">
          <span className="eyebrow">MCP</span>
          <h2>Ask your AI assistant</h2>
          <p>
            The hosted MCP server needs nothing installed. Your assistant gets <code>check_pull_request</code> (the whole report in one call),{' '}
            <code>docs_for_symbol</code> (which docs depend on a function before it changes it), <code>check_changes</code> (which docs its edits make false and which
            examples they break, before anything is pushed), <code>audit_docs</code>, and the graph tools behind them: impact, clearance, read_section, decisions_for,
            rank_sections, propose_edit, record_verdict, write_decision and docs_patch. Any public repository is indexed on first use.
          </p>
          <div className="mcp-buttons">
            <a className="btn btn-primary" href={links.cursor}>
              <Icon name="plug" /> Add to Cursor
            </a>
            <a className="btn btn-ghost" href={links.vscode}>
              <Icon name="plug" /> Add to VS Code
            </a>
          </div>
          <dl className="mcp-list">
            <div>
              <dt>Claude Code</dt>
              <dd>
                <CodeBlock code={`$ ${links.claudeCode}`} />
              </dd>
            </div>
            <div>
              <dt>Claude (desktop and web)</dt>
              <dd>
                Settings → Connectors → <strong>Add custom connector</strong>, then paste{' '}
                <span className="inline-copy">
                  <code>{url}</code>
                  <CopyButton text={url} label="Copy the MCP URL" />
                </span>
              </dd>
            </div>
            <div>
              <dt>Any other client</dt>
              <dd>
                <CodeBlock lang="json" title="mcp.json" code={links.json} />
              </dd>
            </div>
          </dl>
          <p className="muted small">
            Examples are not executed on the hosted server (it has no sandbox). For runs, use the local server: <code>claude mcp add staleproof -- npx -y {PACKAGE} mcp</code>.
          </p>
          <h3>Make it a habit for your coding agent</h3>
          <p className="small">Add this to the repository's AGENTS.md or CLAUDE.md, so docs are updated in the same change as the code:</p>
          <CodeBlock code={AGENT_RULES} title="AGENTS.md" />
        </div>
        <div className="install-preview">
          <div className="chat-sample" aria-label="Example question">
            <p className="chat-q">Which docs can https://github.com/encode/httpx/pull/3571 make false? Show the evidence path for each.</p>
            <p className="chat-a">
              <span className="muted small">check_pull_request →</span> 7 doc sections, all in <code>docs/async.md</code> and <code>docs/advanced/transports.md</code>, reached
              from <code>AsyncHTTPTransport.__init__</code> through <code>AsyncClient.__init__</code>…
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function TerminalInstall() {
  const cmd = `npx -y ${PACKAGE} check https://github.com/<owner>/<repo>/pull/<number>`;
  return (
    <section className="band" id="terminal">
      <div className="wrap install-grid">
        <div className="install-copy">
          <span className="eyebrow">CLI</span>
          <h2>One command</h2>
          <p>
            Needs Node.js 20+, git, and uv or Python 3.12. The first run starts a local FalkorDB (no Docker) and indexes the repository; after that a check takes
            seconds. It runs up to 3 affected examples at the commit before the pull request and at the pull request, in a sandbox with no network.
          </p>
          <CodeBlock code={`$ ${cmd}`} />
          <ul className="plain small">
            <li>
              Before you push: <code>npx -y {PACKAGE} check</code> with no pull request checks your working tree (uncommitted and unpushed changes) and lists the
              examples your edits break. As a git hook: <code>{PRE_PUSH}</code>.
            </li>
            <li>
              The whole repository, no pull request: <code>npx -y {PACKAGE} audit owner/name</code> (<a href="#/audit">or on the web</a>).
            </li>
            <li>
              Docs in another repository: <code>--with your-org/docs</code>.
            </li>
            <li>
              Agent mode: set <code>ANTHROPIC_API_KEY</code> (or an Anthropic-compatible provider with <code>ANTHROPIC_BASE_URL</code>); without it, add{' '}
              <code>--no-agent</code>.
            </li>
            <li>
              Private repositories: set <code>GITHUB_TOKEN</code>.
            </li>
          </ul>
          <a className="btn btn-ghost btn-sm" href="#/docs/getting-started">
            Quickstart <Icon name="arrow" size={14} />
          </a>
        </div>
        <div className="install-preview">
          <CodeBlock
            lang="text"
            title="first run"
            code={`$ npx -y ${PACKAGE} check https://github.com/encode/httpx/pull/3571 --no-agent
No FalkorDB on localhost:6379: starting a local one (falkordblite)…
checkout  fetching encode/httpx
indexed encode/httpx@b5addb6 into graph "encode"
→ impact … 1 changed symbol reaches 7 doc sections
→ clearance … nothing is cleared
→ rank_sections … most central: ASGI Transport > Configuration
→ run_example encode/httpx:docs/async.md:6
← Passes before and after the PR (6c7af96, 336204f): no observable break.`}
          />
        </div>
      </div>
    </section>
  );
}
