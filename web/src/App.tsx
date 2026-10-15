import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, streamCheck } from './api';
import { ClearedList, CypherList, RepoChip, SectionCard, TraceList, type PackageRepo } from './components';
import { ago, num, seedRepoColors } from './format';
import { emptyView, reduce, replay, type CheckView } from './state';
import type { CheckRow, Facts, Health, NamedQuery, PreloadedPr, TraceEvent } from './types';

type Route = { page: 'home' } | { page: 'check'; id: string } | { page: 'model' };

function parseRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('check/')) return { page: 'check', id: decodeURIComponent(h.slice(6)) };
  if (h === 'model') return { page: 'model' };
  return { page: 'home' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  const [health, setHealth] = useState<Health>();
  const [facts, setFacts] = useState<Facts>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    const on = () => {
      setRoute(parseRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    api.health().then(setHealth).catch((e: Error) => setLoadError(e.message));
    api.stats()
      .then((f) => {
        seedRepoColors(['FalkorDB/falkordb-py', 'FalkorDB/GraphRAG-SDK', 'FalkorDB/docs', ...f.repos.map((r) => r.name)]);
        setFacts(f);
      })
      .catch(() => undefined);
  }, []);

  const packageRepo: PackageRepo = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of facts?.repos ?? []) for (const p of r.packages ?? []) map.set(p, r.name);
    return (q: string) => map.get(q.split('.')[0]!);
  }, [facts]);

  return (
    <div className="app">
      <Header health={health} facts={facts} />
      {loadError && <div className="banner err">The API is unreachable: {loadError}</div>}
      <main>
        {route.page === 'home' && <Home health={health} packageRepo={packageRepo} />}
        {route.page === 'check' && <StoredCheck id={route.id} packageRepo={packageRepo} />}
        {route.page === 'model' && <ModelPage />}
      </main>
      <footer>
        <span>
          Lockstep {health?.version ?? ''} · graph <code>{health?.org ?? '…'}</code> on FalkorDB {health?.falkordb ?? ''}
        </span>
        <span>
          Public repositories only · <a href="#/model">Graph model and every Cypher query</a>
        </span>
      </footer>
    </div>
  );
}

function Header({ health, facts }: { health?: Health; facts?: Facts }) {
  return (
    <header className="top">
      <a href="#/" className="brand">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span>Lockstep</span>
      </a>
      <nav>
        <a href="#/">Check a PR</a>
        <a href="#/model">Graph model</a>
      </nav>
      <div className="stats">
        {facts && (
          <>
            <span>{facts.repos.length} repositories</span>
            <span>{num(facts.nodes.Symbol)} symbols</span>
            <span>{num(facts.nodes.DocSection)} doc sections</span>
            <span>{num(facts.calls.crossRepo)} cross-repo calls</span>
          </>
        )}
        {health && (
          <span className={`agent ${health.agent.available ? 'on' : 'off'}`} title={health.agent.available ? '' : health.agent.reason}>
            {health.agent.available ? `agent: ${health.agent.model}` : 'agent off · graph mode'}
          </span>
        )}
      </div>
    </header>
  );
}

function Home({ health, packageRepo }: { health?: Health; packageRepo: PackageRepo }) {
  const [view, dispatch] = useReducer((v: CheckView, e: TraceEvent | { type: 'reset' }) => (e.type === 'reset' ? emptyView() : reduce(v, e)), undefined, emptyView);
  const [prUrl, setPrUrl] = useState('');
  const [mode, setMode] = useState<'agent' | 'graph'>('graph');
  const [prs, setPrs] = useState<PreloadedPr[]>([]);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [running, setRunning] = useState(false);
  const [formError, setFormError] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);
  const results = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    api.prs().then((r) => setPrs(r.prs)).catch(() => undefined);
    api.checks().then((r) => setChecks(r.checks)).catch(() => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (health) setMode(health.agent.available ? 'agent' : 'graph');
  }, [health]);

  const start = async (url: string) => {
    setFormError(undefined);
    setPrUrl(url);
    abort.current?.abort();
    abort.current = new AbortController();
    dispatch({ type: 'reset' });
    setRunning(true);
    setTimeout(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    try {
      await streamCheck(url, mode, dispatch, abort.current.signal);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFormError((err as Error).message);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  const agentOff = health && !health.agent.available;
  return (
    <>
      <section className="hero">
        <h1>Every merge can make a tutorial lie. Lockstep finds which one, proves it, and fixes it.</h1>
        <p className="lede">
          Paste a pull request. Lockstep walks a FalkorDB graph of code, docs and maintainers' decisions across every repository of the organisation, runs the examples
          before and after the change, and proposes the docs fix with the path behind each paragraph.
        </p>
        <form
          className="check-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (prUrl.trim()) void start(prUrl.trim());
          }}
        >
          <input
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            placeholder="https://github.com/FalkorDB/falkordb-py/pull/267"
            aria-label="Pull request URL"
            spellCheck={false}
          />
          <button disabled={running || !prUrl.trim()}>{running ? 'Checking…' : 'Check'}</button>
        </form>
        <div className="modes" role="radiogroup" aria-label="Mode">
          <label className={mode === 'agent' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'agent'} disabled={agentOff} onChange={() => setMode('agent')} />
            Agent: Claude chooses the tools and writes the verdicts
          </label>
          <label className={mode === 'graph' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'graph'} onChange={() => setMode('graph')} />
            Graph only: the same tools in a fixed order, no model
          </label>
        </div>
        {agentOff && (
          <p className="note">
            Agent mode is off on this server: {health.agent.available ? '' : health.agent.reason}. Graph mode runs the real graph queries and example runs; agent
            traces recorded earlier are listed below with their dates.
          </p>
        )}
        {formError && <div className="banner err">{formError}</div>}
        <div className="preloaded">
          {prs.map((p) => (
            <button key={p.url} className="pr-card" disabled={running} onClick={() => void start(p.url)}>
              <span className="pr-ref">
                {p.ref.fullName}#{p.ref.number}
              </span>
              <span className="pr-title">{p.title ?? 'not checked yet'}</span>
              {p.runs.length > 0 && <span className="pr-runs">{runLine(p.runs)}</span>}
              {p.latestCheck && <span className="muted small">last checked {ago(p.latestCheck.startedAt)}</span>}
            </button>
          ))}
        </div>
      </section>

      <div ref={results}>{(view.checkId || view.error || view.queued) && <CheckResults view={view} packageRepo={packageRepo} />}</div>

      {checks.length > 0 && (
        <section className="history">
          <h2>Recent checks</h2>
          <p className="muted">Every check is stored on a Check node in the graph with its full trace. Open one to replay it.</p>
          <ul>
            {checks.map((c) => (
              <li key={c.id}>
                <a href={`#/check/${encodeURIComponent(c.id)}`}>{c.title ?? c.pr}</a>
                <span className="muted">
                  {' '}
                  · {c.model} · {c.status} · {c.toolCalls} tool calls{c.verdicts ? ` · ${c.verdicts} verdicts` : ''} · {ago(c.startedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function runLine(runs: PreloadedPr['runs']): string {
  const byExample = new Map<string, Record<string, string>>();
  for (const r of runs) byExample.set(r.example, { ...(byExample.get(r.example) ?? {}), [r.side]: r.status });
  const parts: string[] = [];
  for (const [ex, sides] of byExample) {
    const name = ex.split(':').slice(1).join(':');
    if (sides.before && sides.after) parts.push(`${name}: ${sides.before} before, ${sides.after} after`);
  }
  return parts.slice(0, 2).join(' · ');
}

function CheckResults({ view, packageRepo }: { view: CheckView; packageRepo: PackageRepo }) {
  const sections = useMemo(() => {
    const list = view.impact?.sections ?? [];
    if (!view.ranked) return list;
    const order = new Map(view.ranked.map((r, i) => [r.id, i]));
    return [...list].sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9));
  }, [view.impact, view.ranked]);
  const counts = view.impact?.counts ?? { breaking: 0, api: 0, behavior: 0 };
  if (!view.impact?.counts) for (const s of sections) counts[s.severity]++;
  return (
    <section className="results">
      <div className="results-head">
        <div>
          <h2>{view.impact?.pr.title ?? view.pr ?? 'Waiting for the check to start'}</h2>
          {view.pr && (
            <a href={view.pr} target="_blank" rel="noreferrer" className="muted">
              {view.pr.replace('https://github.com/', '')}
            </a>
          )}
          {view.model && <span className="chip muted">{view.model}</span>}
          {view.checkId && <span className="chip muted">{view.checkId}</span>}
        </div>
        {view.queued && <div className="banner">Another check is running; this one starts when it finishes.</div>}
        {view.error && <div className="banner err">{view.error}</div>}
        {view.since && <div className="since">Since the last check: {view.since}</div>}
      </div>
      <div className="columns">
        <div className="col trace-col">
          <h3>Trace</h3>
          <p className="muted small">Each step the {view.model?.startsWith('graph') ? 'pipeline' : 'agent'} took, with the Cypher it ran on FalkorDB.</p>
          <TraceList view={view} />
        </div>
        <div className="col findings-col">
          {view.finished && (
            <div className={`summary st-${view.finished.status}`}>
              <strong>{view.finished.status === 'done' ? 'Done' : view.finished.status}</strong> · {view.finished.toolCalls} tool calls
              {view.finished.verdicts ? ` · ${view.finished.verdicts} verdicts` : ''}
              <p>{view.finished.summary}</p>
              {view.finished.verdicts > 0 && view.pr && <PatchLink pr={view.pr} />}
            </div>
          )}
          {view.impact && (
            <>
              <h3>
                Impacted doc sections ({view.impact.totalSections})
                <span className="counts">
                  {counts.breaking > 0 && <span className="chip sev breaking">{counts.breaking} breaking</span>}
                  {counts.api > 0 && <span className="chip sev api">{counts.api} signature</span>}
                  {counts.behavior > 0 && <span className="chip sev behavior">{counts.behavior} behavior</span>}
                </span>
              </h3>
              <ChangedList view={view} />
              {view.ranked && <p className="muted small">Ordered by PageRank of the page over the docs' link graph (most-read first).</p>}
              {sections.length === 0 && <p className="muted">No doc section is reachable from this pull request's changes.</p>}
              {sections.map((s) => (
                <SectionCard key={s.section} s={s} view={view} packageRepo={packageRepo} />
              ))}
              {view.impact.truncated && <p className="muted">{view.impact.totalSections - view.impact.sections.length} more sections not shown.</p>}
            </>
          )}
          {view.cleared && <ClearedList cleared={view.cleared} />}
        </div>
      </div>
    </section>
  );
}

function ChangedList({ view }: { view: CheckView }) {
  if (!view.impact?.changed.length) return null;
  return (
    <details className="changed">
      <summary>{view.impact.changed.length} changed symbol(s) in {view.impact.pr.repo}</summary>
      <ul>
        {view.impact.changed.map((c) => (
          <li key={c.symbol}>
            <code>{c.change}</code> <code>{c.symbol}</code>
            {c.renamedTo && (
              <>
                {' '}
                → <code>{c.renamedTo}</code>
              </>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function PatchLink({ pr }: { pr: string }) {
  const [patch, setPatch] = useState<{ diff: string; title: string; body: string }>();
  return (
    <div className="patch">
      {!patch ? (
        <button className="link" onClick={() => void api.patch(pr).then(setPatch)}>
          Show the docs patch (git-apply-able)
        </button>
      ) : patch.diff ? (
        <>
          <pre className="diff raw">{patch.diff}</pre>
          <p className="muted small">
            Open it as a pull request in your fork with <code>npx lockstep-docs patch {pr} --open-pr</code>. Lockstep never opens a PR upstream unless asked.
          </p>
        </>
      ) : (
        <p className="muted">No edits were proposed.</p>
      )}
    </div>
  );
}

function StoredCheck({ id, packageRepo }: { id: string; packageRepo: PackageRepo }) {
  const [view, setView] = useState<CheckView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.check(id)
      .then((r) => setView(replay(r.events)))
      .catch((e: Error) => setError(e.message));
  }, [id]);
  if (error) return <div className="banner err">{error}</div>;
  if (!view) return <p className="muted">Loading the stored trace…</p>;
  return (
    <>
      <div className="banner">
        Recorded check from {view.startedAt ? new Date(view.startedAt).toISOString().replace('T', ' ').slice(0, 16) : '?'} UTC, replayed from the trace stored on
        its Check node ({view.model}).
      </div>
      <CheckResults view={view} packageRepo={packageRepo} />
    </>
  );
}

const NODES: [string, string][] = [
  ['Repo', 'A GitHub repository (one graph holds every repository of an organisation)'],
  ['File', 'A tracked file'],
  ['Symbol', 'A module, class, function or method, by qualified name; removed symbols are kept with status removed'],
  ['DocSection', 'One heading of a Markdown/MDX page, with its text and the identifiers it names'],
  ['CodeExample', 'A fenced code block, or an example script shipped in a code repository'],
  ['PullRequest', 'A checked pull request, with the commits before and after it'],
  ['Decision', "A maintainer's decision, what it governs and what it supersedes"],
  ['Verdict', "The agent's conclusion about one section for one pull request (stale with an edit, ok, governed, skipped)"],
  ['Run', 'One execution of a code example in the sandbox: status, error, traceback, commits installed'],
  ['Check', 'One agent (or graph-mode) check of a pull request, with its full trace'],
];
const EDGES: [string, string][] = [
  ['(Symbol)-[:CALLS {resolved}]->(Symbol)', 'call edges, across repositories, resolved through imports, attribute types and return annotations'],
  ['(DocSection)-[:MENTIONS]->(Symbol)', 'prose names a symbol in inline code'],
  ['(CodeExample)-[:USES]->(Symbol)', 'an example calls a symbol (resolved like code)'],
  ['(CodeExample)-[:IN_SECTION]->(DocSection)', 'an example sits under a heading'],
  ['(DocSection)-[:LINKS_TO]->(DocSection)', 'hyperlinks between pages (PageRank input)'],
  ['(Repo)-[:DEPENDS_ON]->(Repo)', 'declared dependencies and docs that import a package'],
  ['(Symbol)-[:CHANGED_IN {kind}]->(PullRequest)', 'removed, renamed, signature, modified, added, export-removed'],
  ['(Decision)-[:GOVERNS]->(DocSection|Symbol)', 'what a decision covers; SUPERSEDES chains to the current one'],
  ['(Verdict)-[:ABOUT|FOR|CITES|EVIDENCE]->(…)', 'section, pull request, decisions cited, runs as evidence'],
  ['(Run)-[:OF|AT]->(…)', 'the example run, and the pull request it was evidence for'],
];

function ModelPage() {
  const [queries, setQueries] = useState<NamedQuery[]>([]);
  useEffect(() => {
    api.model().then((m) => setQueries(m.queries)).catch(() => undefined);
  }, []);
  const groups: [string, string][] = [
    ['tool', 'Agent tools'],
    ['memory', 'Memory: decisions, verdicts, runs, checks'],
    ['index', 'Indexing'],
    ['report', 'Reporting (FACTS.md)'],
    ['schema', 'Schema'],
  ];
  return (
    <section className="model">
      <h1>The graph Lockstep runs on</h1>
      <p className="lede">One FalkorDB graph per organisation. Every step of the agent reads it, and every check writes back to it.</p>
      <div className="grid2">
        <div>
          <h2>Nodes</h2>
          <dl>
            {NODES.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <code>{k}</code>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h2>Edges</h2>
          <dl>
            {EDGES.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <code>{k}</code>
                </dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <h2>What breaks without FalkorDB</h2>
      <ul className="breaks">
        <li>
          <strong>Impact</strong> is a variable-length path across repositories: <code>changed symbol ← CALLS*0..3 ← symbol ← MENTIONS|USES ← doc</code>. A table needs a
          recursive join per hop and per repository; a vector store cannot express "reaches".
        </li>
        <li>
          <strong>Clearance</strong> is a proof of absence: the same pattern negated. Without the graph there is nothing to prove absence against.
        </li>
        <li>
          <strong>Decisions</strong> govern symbols transitively (<code>GOVERNS</code> + <code>CALLS*0..2</code>) and resolve through <code>SUPERSEDES</code> chains.
        </li>
        <li>
          <strong>Ranking</strong> runs <code>algo.pageRank</code> over the docs' link graph.
        </li>
        <li>
          <strong>Memory</strong>: verdicts, runs, decisions and checks are written back on every step and cited on the next pull request.
        </li>
      </ul>
      <h2>Every Cypher query</h2>
      <p className="muted">Generated from the code (src/graph/queries.ts): what is listed here is exactly what runs.</p>
      {groups.map(([g, title]) => (
        <div key={g}>
          <h3>{title}</h3>
          <CypherList catalogue queries={queries.filter((q) => q.group === g).map((q) => ({ name: q.name, cypher: `// ${q.purpose}\n${q.cypher}`, params: {}, ms: 0, rows: 0 }))} />
        </div>
      ))}
      <p className="muted small">
        Repository colors: <RepoChip repo="FalkorDB/falkordb-py" /> <RepoChip repo="FalkorDB/GraphRAG-SDK" /> <RepoChip repo="FalkorDB/docs" />
      </p>
    </section>
  );
}
