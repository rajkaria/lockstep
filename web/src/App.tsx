import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { StoredCheck } from './CheckResults';
import { CypherList, RepoChip, type PackageRepo } from './components';
import { DocsPage } from './Docs';
import { PACKAGE, PRODUCT } from './docs/manifest';
import { num, seedRepoColors } from './format';
import { Landing } from './Landing';
import { Footer, Header } from './layout';
import { HOME_SECTIONS, parseRoute, type Route } from './route';
import { TryIt } from './TryIt';
import type { Facts, Health, NamedQuery } from './types';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [health, setHealth] = useState<Health>();
  const [facts, setFacts] = useState<Facts>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    const on = () => {
      const next = parseRoute(window.location.hash);
      setRoute(next);
      if (next.page !== 'docs' && !(next.page === 'home' && next.section)) window.scrollTo(0, 0);
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
  useEffect(() => {
    if (route.page !== 'docs') document.title = `${PRODUCT} — keep docs true to code`;
  }, [route]);
  // Section routes (#/use-cases) scroll once the landing is on screen.
  useEffect(() => {
    if (route.page === 'home' && route.section && HOME_SECTIONS.includes(route.section)) {
      const id = route.section;
      const go = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
      // Again once the demo's data has loaded above it and moved it down.
      requestAnimationFrame(go);
      const t = setTimeout(go, 700);
      return () => clearTimeout(t);
    }
  }, [route]);

  const packageRepo: PackageRepo = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of facts?.repos ?? []) for (const p of r.packages ?? []) map.set(p, r.name);
    return (q: string) => map.get(q.split('.')[0]!);
  }, [facts]);

  const current = route.page === 'docs' ? 'docs' : route.page === 'model' ? 'model' : route.page === 'home' ? route.section : undefined;
  const banners = (
    <>
      {loadError && <div className="banner err">The API is unreachable: {loadError}</div>}
      {health?.snapshot && (
        <div className="banner snapshot">
          <strong>Snapshot.</strong> This deployment isn't connected to a FalkorDB server, so it shows the graph's answers recorded on{' '}
          {health.snapshot.takenAt.replace('T', ' ').slice(0, 16)} UTC: the preloaded pull requests open their recorded checks, replayed exactly as they ran. For live
          checks, run <code>npx {PACKAGE} serve</code> against an indexed graph (see the <a href="#/docs/getting-started">quickstart</a>).
        </div>
      )}
    </>
  );

  return (
    <div className="app">
      <Header current={current} />
      <main className={`page-${route.page}`}>
        {route.page === 'home' && (
          <Landing
            demo={
              <>
                {banners}
                <TryIt health={health} packageRepo={packageRepo} />
              </>
            }
            stats={<LiveStats facts={facts} health={health} />}
          />
        )}
        {route.page === 'check' && (
          <div className="wrap page-pad">
            {banners}
            <StoredCheck id={route.id} packageRepo={packageRepo} />
          </div>
        )}
        {route.page === 'model' && (
          <div className="wrap page-pad">
            <ModelPage />
          </div>
        )}
        {route.page === 'docs' && <DocsPage slug={route.slug} anchor={route.anchor} />}
      </main>
      <Footer
        meta={
          <>
            <span>
              {PRODUCT} {health?.version ?? ''} · graph <code>{health?.org ?? '…'}</code> on FalkorDB {health?.falkordb ?? ''}
            </span>
            <span>Public repositories only · MIT licensed</span>
          </>
        }
      />
    </div>
  );
}

/** What the demo is connected to right now: the graph's size and the agent's model. */
function LiveStats({ facts, health }: { facts?: Facts; health?: Health }) {
  if (!facts && !health) return null;
  return (
    <div className="live-stats" aria-label="The graph behind this demo">
      <span className={`live-dot${health?.snapshot ? ' off' : ''}`} aria-hidden="true" />
      <span className="muted">{health?.snapshot ? 'Snapshot of the graph' : 'Live graph'}</span>
      {facts && (
        <>
          <span>
            <strong>{facts.repos.length}</strong> repositories
          </span>
          <span>
            <strong>{num(facts.nodes.Symbol)}</strong> symbols
          </span>
          <span>
            <strong>{num(facts.nodes.DocSection)}</strong> doc sections
          </span>
          <span>
            <strong>{num(facts.crossRepoDocPaths)}</strong> cross-repo doc paths
          </span>
        </>
      )}
      {health && (
        <span className={`agent ${health.agent.available ? 'on' : 'off'}`} title={health.agent.available ? '' : health.agent.reason}>
          {health.agent.available ? `agent: ${health.agent.model}` : 'agent off · graph mode'}
        </span>
      )}
    </div>
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
      <span className="eyebrow">Graph model</span>
      <h1>The graph {PRODUCT} runs on</h1>
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
      <p className="muted">
        Generated from the code (src/graph/queries.ts): what is listed here is exactly what runs. Also in the docs: <a href="#/docs/graph-model">Graph model and Cypher</a>.
      </p>
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
