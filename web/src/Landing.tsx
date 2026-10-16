import { useState, type ReactNode } from 'react';
import { PACKAGE, PRODUCT, REPO_URL } from './docs/manifest';
import { CodeBlock, CopyButton, Icon } from './layout';

/**
 * The home page's static content. It renders the same in the browser and at
 * build time (scripts/prerender.ts writes it into index.html, so crawlers and
 * LLMs that don't run JavaScript read the whole page). The live parts — the
 * demo and the graph stats — come in as slots and are absent at build time.
 *
 * Every number here is from docs/FACTS.md, generated from the graph.
 */
export function Landing({ demo, stats }: { demo?: ReactNode; stats?: ReactNode }) {
  return (
    <div className="landing">
      <Hero />
      <Results />
      <section id="try" className="band try-band">
        <div className="wrap">
          <SectionHead
            eyebrow="Live demo"
            title="Check a real pull request"
            lede="Pick one of FalkorDB's pull requests or paste any public PR from the indexed repositories. The trace streams every tool call and the Cypher it ran on FalkorDB."
          />
          <Modes />
          {stats}
          {demo ?? <StaticDemo />}
        </div>
      </section>
      <Problem />
      <HowItWorks />
      <UseCases />
      <Benefits />
      <Integrations />
      <Compare />
      <ForLlms />
      <Faq />
      <FinalCta />
    </div>
  );
}

function SectionHead({ eyebrow, title, lede, center }: { eyebrow: string; title: ReactNode; lede?: ReactNode; center?: boolean }) {
  return (
    <div className={`section-head${center ? ' center' : ''}`}>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
    </div>
  );
}

function Hero() {
  return (
    <section className="hero-band">
      <div className="hero-bg" aria-hidden="true" />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <a className="pill-link" href="#/docs/introduction">
            <span className="dot" /> Open source · MIT · built on FalkorDB <Icon name="arrow" size={14} />
          </a>
          <h1>
            Every merge can make a tutorial lie. <span className="grad">{PRODUCT} finds which one, proves it, and fixes it.</span>
          </h1>
          <p className="lede">
            Paste a pull request. {PRODUCT} follows the changed code through a FalkorDB graph of every repository you own — code, docs and the decisions your
            maintainers made — to the paragraphs it can make false. It runs those examples before and after the change, and proposes the docs fix with the
            evidence behind each edit.
          </p>
          <div className="cta-row">
            <a className="btn btn-primary" href="#/try">
              <Icon name="play" /> Check a pull request
            </a>
            <a className="btn btn-ghost" href="#/docs/getting-started">
              <Icon name="book" /> Quickstart
            </a>
          </div>
          <div className="install">
            <span className="prompt">$</span>
            <code>npx -y {PACKAGE} check https://github.com/FalkorDB/falkordb-py/pull/262</code>
            <CopyButton text={`npx -y ${PACKAGE} check https://github.com/FalkorDB/falkordb-py/pull/262`} label="Copy command" />
          </div>
        </div>
        <WorkedExample />
      </div>
    </section>
  );
}

/** The first-screen proof: falkordb-py#262, as the graph and the runs saw it. */
function WorkedExample() {
  return (
    <figure className="worked" aria-label="Worked example: falkordb-py pull request 262">
      <figcaption className="worked-head">
        <span className="worked-pr">
          <Icon name="pr" size={16} /> FalkorDB/falkordb-py#262
        </span>
        <span className="worked-title">fix: only forward accepted kwargs from Is_Cluster to redis.Redis</span>
      </figcaption>
      <ol className="chain">
        <li>
          <span className="chain-kind">changed</span>
          <code>Is_Cluster</code>
          <span className="chain-repo">falkordb-py</span>
        </li>
        <li>
          <span className="chain-kind">called by</span>
          <code>FalkorDB.__init__</code>
          <span className="chain-repo">falkordb-py</span>
        </li>
        <li className="chain-doc">
          <span className="chain-kind">used in</span>
          <code>README · Asynchronous Example</code>
          <span className="chain-repo">falkordb-py</span>
        </li>
      </ol>
      <div className="runs">
        <div className="run-row fail">
          <span className="run-side">before the PR</span>
          <span className="run-status">fails</span>
          <code>TypeError: Redis.__init__() got an unexpected keyword argument 'himport_registry'</code>
        </div>
        <div className="run-row pass">
          <span className="run-side">after the PR</span>
          <span className="run-status">passes</span>
          <code>exit 0</code>
        </div>
      </div>
      <p className="worked-verdict">
        <Icon name="check" size={16} /> The README's async example was broken until this PR fixed it. A name search finds nothing: no doc mentions{' '}
        <code>Is_Cluster</code>. The call graph does.
      </p>
    </figure>
  );
}

function Results() {
  const tiles: { value: string; label: ReactNode; foot: string }[] = [
    { value: '43', label: <>doc sections one pull request can falsify — <strong>41 of them in other repositories</strong></>, foot: 'falkordb-py#276' },
    { value: '0 / 47', label: <>sections a grep for the changed names finds, of the 47 the graph reaches</>, foot: 'falkordb-py #262 · #267 · #276' },
    { value: '120 vs 30', label: <>sections reached by the graph vs found by grep, which also matches <strong>227 unrelated</strong> ones</>, foot: 'all 4 checked pull requests' },
    { value: '21', label: <>docs examples tried at both commits of one PR: 10 pass both times, 6 were already broken</>, foot: 'falkordb-py#276' },
  ];
  return (
    <section className="band results-band" aria-labelledby="results-title">
      <div className="wrap">
        <div className="results-head">
          <h2 id="results-title">What it found on FalkorDB's own repositories</h2>
          <a href="#/docs/facts">
            Every number comes from FACTS.md, generated from the graph <Icon name="arrow" size={14} />
          </a>
        </div>
        <div className="tiles">
          {tiles.map((t) => (
            <div key={t.value} className="tile">
              <div className="tile-value">{t.value}</div>
              <div className="tile-label">{t.label}</div>
              <div className="tile-foot">{t.foot}</div>
            </div>
          ))}
        </div>
        <div className="stories">
          <article>
            <h3>
              <a href="https://github.com/FalkorDB/falkordb-py/pull/267" target="_blank" rel="noreferrer">
                falkordb-py#267
              </a>{' '}
              fixed the execution-plan parser
            </h3>
            <p>
              The path <code>ExecutionPlan._operation_tree ← ExecutionPlan.__init__ ← Graph.explain</code> led into a different repository: the docs site's{' '}
              <code>GRAPH.EXPLAIN</code> page. Its example fails on a fresh server before <em>and</em> after the PR — it explains a query on a graph the page never
              creates. Not caused by the PR; already broken, and now known.
            </p>
          </article>
          <article>
            <h3>
              <a href="https://github.com/FalkorDB/falkordb-py/pull/276" target="_blank" rel="noreferrer">
                falkordb-py#276
              </a>{' '}
              changed four asyncio symbols
            </h3>
            <p>
              They reach 43 doc sections through paths like <code>AsyncGraph.query ← FalkorDBConnection.query (GraphRAG-SDK) ← … ← GraphRAG-SDK README</code>. Of the
              21 examples run at both commits, 10 pass both times, 6 were already broken, 3 can't be installed together at those commits (version skew) and 2 can't
              run as written.
            </p>
          </article>
        </div>
      </div>
    </section>
  );
}

function Modes() {
  return (
    <div className="modes-explainer">
      <div>
        <Icon name="model" />
        <div>
          <strong>Agent mode</strong>
          <p>A model chooses which tools to call, reads each affected section, and writes a verdict or an edit for every one of them.</p>
        </div>
      </div>
      <div>
        <Icon name="graph" />
        <div>
          <strong>Graph mode</strong>
          <p>The same tools in a fixed order with no model and no API key: impact, clearance, ranking, and a sample of up to three example runs. Deterministic and free.</p>
        </div>
      </div>
    </div>
  );
}

/** Shown where the live demo goes when the page is read without JavaScript. */
function StaticDemo() {
  const prs = [
    ['FalkorDB/falkordb-py#262', 'fix: only forward accepted kwargs from Is_Cluster to redis.Redis', 'https://github.com/FalkorDB/falkordb-py/pull/262'],
    ['FalkorDB/falkordb-py#267', 'test: assert the client parses execution plans, and fix a plan parser bug', 'https://github.com/FalkorDB/falkordb-py/pull/267'],
    ['FalkorDB/falkordb-py#276', 'fix(asyncio): prevent connection pool kwargs mutation and await schema refresh', 'https://github.com/FalkorDB/falkordb-py/pull/276'],
  ];
  return (
    <div className="static-demo">
      <p className="muted">The interactive demo needs JavaScript. These are the pull requests it opens with:</p>
      <ul>
        {prs.map(([ref, title, url]) => (
          <li key={ref}>
            <a href={url}>{ref}</a> — {title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Problem() {
  const items: [string, string, ReactNode][] = [
    ['repos', 'The paragraph is in another repository', <>A change to the client breaks a tutorial in the SDK and a page on the docs site. Code review only sees the repository the PR is in.</>],
    ['path', 'Nobody greps for the right name', <>The README calls <code>FalkorDB()</code>, whose constructor calls the function you changed. The docs never name that function, so search finds nothing.</>],
    ['play', 'Nobody re-runs the examples', <>Tutorials are code that never runs in CI. They break silently, and readers find out first.</>],
  ];
  return (
    <section className="band" id="problem">
      <div className="wrap">
        <SectionHead eyebrow="The problem" title="Docs drift where review can't see it" />
        <div className="grid3">
          {items.map(([icon, title, body]) => (
            <div key={title} className="card">
              <span className="card-icon">
                <Icon name={icon} />
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps: { icon: string; title: string; body: ReactNode; term?: [string, ReactNode] }[] = [
    {
      icon: 'layers',
      title: 'Index',
      body: <>Clone your repositories into one graph: Python functions and the calls between them across repositories, every docs section and code example, and the code each one mentions or calls.</>,
    },
    {
      icon: 'path',
      title: 'Trace the impact',
      body: <>From each function the PR changed, walk back up to three callers, in any repository, to the docs that mention or run them.</>,
      term: ['Evidence path', <>the chain from the changed function to the paragraph — the reason it is flagged, shown for every hit.</>],
    },
    {
      icon: 'lock',
      title: 'Clear the rest',
      body: <>Changed functions that no doc reaches within three calls are listed as cleared, with the grep a reviewer can run to double-check.</>,
      term: ['Clearance', <>a proof of absence: the graph shows no path from the change to any doc, so you can skip it with confidence.</>],
    },
    {
      icon: 'play',
      title: 'Prove it',
      body: <>Run each affected example at the commit before the PR and at the PR, in a sandbox. Passes before, fails after: the PR broke it. Fails both: it was already broken.</>,
    },
    {
      icon: 'doc',
      title: 'Judge and fix',
      body: <>Every affected section ends with a verdict. Edits are refused without a graph path, and come out as a <code>git apply</code>-able docs patch with the evidence per section.</>,
      term: ['Verdict', <>stale (with the edit), ok, governed by a maintainer decision, or skipped — always with the reason.</>],
    },
    {
      icon: 'memory',
      title: 'Remember',
      body: <>Verdicts, example runs and maintainers' decisions are written back to the graph. The next PR reads them before judging.</>,
      term: ['Verdict memory', <>a decision like "keep the old kwargs until 2.0" is cited instead of being re-flagged on every PR.</>],
    },
  ];
  return (
    <section className="band alt" id="how-it-works">
      <div className="wrap">
        <SectionHead
          eyebrow="How it works"
          title="From a pull request to a proven docs fix"
          lede={<>Each step is a tool that runs Cypher on FalkorDB and returns the queries it ran. The agent decides the order; graph mode runs them in a fixed one.</>}
        />
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className="step">
              <div className="step-num">
                <Icon name={s.icon} />
                <span>{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              {s.term && (
                <p className="term">
                  <strong>{s.term[0]}:</strong> {s.term[1]}
                </p>
              )}
            </li>
          ))}
        </ol>
        <div className="impact-query">
          <div className="impact-copy">
            <h3>The question is a graph question</h3>
            <p>
              "Which paragraphs, in which repositories, can this change make false?" is reachability over call edges that cross repositories. It is one Cypher
              pattern, and on FalkorDB it answers in about a millisecond.
            </p>
            <a href="#/model">
              The graph model and every query <Icon name="arrow" size={14} />
            </a>
          </div>
          <CodeBlock
            lang="cypher"
            title="impact (excerpt)"
            code={`MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
WHERE c.kind <> 'added'
MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
RETURN d.id, length(p) AS hops,
       [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence`}
          />
        </div>
      </div>
    </section>
  );
}

const USE_CASES: { icon: string; who: string; title: string; body: ReactNode; proof?: ReactNode; via: [string, string][] }[] = [
  {
    icon: 'repos',
    who: 'SDK and client-library teams',
    title: 'Ship a client change without breaking the docs site',
    body: <>Your client, the SDK built on it and the docs site live in three repositories. One graph spans them, so a change in the client surfaces the pages in the other two.</>,
    proof: <>On falkordb-py#276, 41 of the 43 reachable sections were in other repositories.</>,
    via: [
      ['GitHub Action', '#/docs/github-action'],
      ['CLI', '#/docs/cli'],
    ],
  },
  {
    icon: 'people',
    who: 'DevRel and docs teams',
    title: 'Know what a release falsified, most-read page first',
    body: <>Check every merged pull request, rank the affected sections by PageRank over your docs' own links, and ship one patch with the evidence for each edit.</>,
    via: [
      ['check + patch', '#/docs/cli'],
      ['--open-pr', '#/docs/cli'],
    ],
  },
  {
    icon: 'pr',
    who: 'Open-source maintainers',
    title: 'A docs-impact comment on every pull request',
    body: <>Each PR gets a comment listing the docs it can falsify, the path for each, and the changed functions no doc reaches. Graph mode needs no LLM key.</>,
    via: [['GitHub Action', '#/docs/github-action']],
  },
  {
    icon: 'bot',
    who: 'AI coding agents',
    title: 'Let Claude Code fix the docs in the same session as the code',
    body: <>Over MCP, your coding agent can ask what a change touches, run the affected examples, and produce the docs patch before you open the PR.</>,
    via: [['MCP server', '#/docs/mcp']],
  },
  {
    icon: 'layers',
    who: 'Platform teams',
    title: 'One graph per organisation, many on one server',
    body: <>Each organisation gets its own graph on the same FalkorDB. Serve the API to your tools, or embed the library in your own pipeline.</>,
    proof: <>A second graph from encode/httpx runs next to FalkorDB's on the same server.</>,
    via: [
      ['HTTP API', '#/docs/http-api'],
      ['Library', '#/docs/library'],
    ],
  },
];

function UseCases() {
  return (
    <section className="band" id="use-cases">
      <div className="wrap">
        <SectionHead eyebrow="Use cases" title="Built for teams whose docs live apart from their code" />
        <div className="usecases">
          {USE_CASES.map((u) => (
            <article key={u.title} className="card usecase">
              <div className="usecase-who">
                <span className="card-icon">
                  <Icon name={u.icon} />
                </span>
                {u.who}
              </div>
              <h3>{u.title}</h3>
              <p>{u.body}</p>
              {u.proof && <p className="proof">{u.proof}</p>}
              <div className="via">
                <span>Use it via</span>
                {u.via.map(([label, href]) => (
                  <a key={label} href={href} className="tag">
                    {label}
                  </a>
                ))}
              </div>
            </article>
          ))}
          <a className="card usecase more" href="#/docs/use-cases">
            <h3>Read the use-case guides</h3>
            <p>Setup, commands and what to expect for each scenario.</p>
            <span className="more-link">
              Use cases in the docs <Icon name="arrow" size={14} />
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}

function Benefits() {
  const items: [string, string, string][] = [
    ['repos', 'Across every repository', 'Call edges are resolved across repositories through imports, re-exports, attribute types and return annotations.'],
    ['play', 'Proof by execution', 'Examples run at both commits in a sandbox, so "this PR broke it" is a test result, not a guess.'],
    ['path', 'Evidence for every paragraph', 'Each flagged section carries the path that reached it. No path, no edit: the tool refuses.'],
    ['lock', 'Proof of absence', 'Clearance lists changed functions no doc reaches, so reviewers know what they can skip.'],
    ['memory', 'Remembers decisions', 'Maintainer decisions and past verdicts are cited on the next PR instead of re-flagged.'],
    ['rank', 'Most-read pages first', 'PageRank over your docs\' links orders the work, so the page readers land on gets fixed first.'],
    ['model', 'With or without a model', 'Agent mode uses Claude or any Anthropic-compatible API; graph mode needs no key at all.'],
    ['eye', 'Every query in the open', 'Every result lists the Cypher it ran and how long it took. Nothing is hidden behind a score.'],
  ];
  return (
    <section className="band alt" id="benefits">
      <div className="wrap">
        <SectionHead eyebrow="Why teams use it" title="Fewer broken tutorials, with receipts" />
        <div className="grid4">
          {items.map(([icon, title, body]) => (
            <div key={title} className="benefit">
              <span className="card-icon">
                <Icon name={icon} />
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const PR = 'https://github.com/FalkorDB/falkordb-py/pull/262';

const INTEGRATIONS: { id: string; icon: string; label: string; title: string; body: ReactNode; lang: string; file?: string; code: string; doc: string; note?: string }[] = [
  {
    id: 'cli',
    icon: 'terminal',
    label: 'CLI',
    title: 'Four commands from nothing to a docs patch',
    body: <>No install and no Docker: <code>db start</code> runs FalkorDB locally from a Python wheel. Add <code>ANTHROPIC_API_KEY</code> for agent mode, or pass <code>--no-agent</code>.</>,
    lang: 'bash',
    code: `$ npx -y ${PACKAGE} db start
$ npx -y ${PACKAGE} index FalkorDB/falkordb-py FalkorDB/GraphRAG-SDK FalkorDB/docs
$ npx -y ${PACKAGE} check ${PR} --no-agent
$ npx -y ${PACKAGE} patch ${PR}`,
    doc: '#/docs/cli',
  },
  {
    id: 'action',
    icon: 'pr',
    label: 'GitHub Action',
    title: 'A comment on every pull request',
    body: <>Point the action at the FalkorDB holding your graph. It checks each PR and posts (or updates) one comment with the docs it can falsify.</>,
    lang: 'yaml',
    file: '.github/workflows/lockstep.yml',
    code: `on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: rajkaria/lockstep/action@main
        with:
          falkordb-url: \${{ secrets.LOCKSTEP_FALKORDB_URL }}
          org: falkordb`,
    doc: '#/docs/github-action',
    note: 'The action is written and its commands are tested against the CLI; it has not yet run on a live repository.',
  },
  {
    id: 'mcp',
    icon: 'bot',
    label: 'Claude Code (MCP)',
    title: 'Ten tools for your coding agent',
    body: <>One command adds the MCP server. Every tool description includes its Cypher, and every result lists the queries it ran.</>,
    lang: 'bash',
    code: `$ claude mcp add lockstep -e FALKORDB_URL=falkor://localhost:6379 -- npx -y ${PACKAGE} mcp

# then ask:
> Which docs can ${PR} falsify? Run the examples and give me the patch.`,
    doc: '#/docs/mcp',
  },
  {
    id: 'api',
    icon: 'api',
    label: 'HTTP API',
    title: 'Stream a check over server-sent events',
    body: <><code>serve</code> runs this web app and its JSON API. A check streams every tool call and result as it happens, then stays stored on the graph.</>,
    lang: 'bash',
    code: `$ npx -y ${PACKAGE} serve --port 8080
$ curl -N localhost:8080/api/check \\
    -H 'content-type: application/json' \\
    -d '{"pr_url": "${PR}", "mode": "graph"}'`,
    doc: '#/docs/http-api',
  },
  {
    id: 'library',
    icon: 'box',
    label: 'Node.js library',
    title: 'Embed it in your own pipeline',
    body: <>The package exports the indexer, the tools, both check modes, the patch builder, the MCP server and the HTTP app.</>,
    lang: 'ts',
    code: `import { GraphStore, loadConfig, runGraphCheck } from '${PACKAGE}';

const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
const check = await runGraphCheck({ graph: store.org(config.org), config }, '${PR}');
console.log(check.status, check.summary);
await store.close();`,
    doc: '#/docs/library',
  },
  {
    id: 'deploy',
    icon: 'layers',
    label: 'Self-host',
    title: 'Vercel with FalkorDB Cloud, or any VM',
    body: <>The live demo runs as a Vercel Function against FalkorDB Cloud's free tier. A Docker Compose file runs the app with its graph and a scratch database.</>,
    lang: 'bash',
    code: `# Vercel: point the function at your FalkorDB, then deploy
$ vercel env add FALKORDB_URL production
$ vercel deploy --prod

# Any VM
$ docker compose up -d --build`,
    doc: '#/docs/deploy',
    note: 'The Vercel deployment is live; the Docker image is written but has not been built yet.',
  },
];

function Integrations() {
  const [active, setActive] = useState(INTEGRATIONS[0]!.id);
  return (
    <section className="band" id="integrations">
      <div className="wrap">
        <SectionHead
          eyebrow="Integrations"
          title="Plug it in where your docs already break"
          lede={<>One npm package, five ways in, and two ways to host it. Everything runs against your own FalkorDB.</>}
        />
        <div className="tabs" role="tablist" aria-label="Integrations">
          {INTEGRATIONS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active === t.id}
              aria-controls={`panel-${t.id}`}
              className={active === t.id ? 'on' : ''}
              onClick={() => setActive(t.id)}
            >
              <Icon name={t.icon} size={16} /> {t.label}
            </button>
          ))}
        </div>
        {INTEGRATIONS.map((t) => (
          <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={active !== t.id} className="tabpanel">
            <div className="tabpanel-copy">
              <h3>{t.title}</h3>
              <p>{t.body}</p>
              {t.note && <p className="note-status">{t.note}</p>}
              <a className="btn btn-ghost btn-sm" href={t.doc}>
                Read the {t.label} guide <Icon name="arrow" size={14} />
              </a>
            </div>
            <CodeBlock lang={t.lang} title={t.file ?? t.lang} code={t.code} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Compare() {
  const rows: [string, string, string, string][] = [
    ['Finds docs that reach the change through other functions', 'No — only the names you search for', 'No — similarity, not reachability', 'Yes — up to 3 call hops, in any repository'],
    ['Proves a change broke an example', 'No', 'No', 'Yes — runs it before and after'],
    ['Proves a change touches no docs', 'No — no match is not proof', 'No', 'Yes — clearance over the graph'],
    ['Says why a paragraph is flagged', 'The matching line', 'A similarity score', 'The evidence path'],
    ['Remembers what maintainers decided', 'No', 'No', 'Yes — decisions and verdicts on the graph'],
    ['Noise on FalkorDB’s 4 checked PRs', '227 unrelated matches', '—', 'Only sections the change reaches'],
  ];
  return (
    <section className="band alt" id="compare">
      <div className="wrap">
        <SectionHead eyebrow="Compared" title="Why not grep, or a vector store?" lede="Both find text. The question here is reachability, and whether the example still runs." />
        <div className="table-wrap">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">grep / code search</th>
                <th scope="col">Vector search over docs</th>
                <th scope="col" className="us">
                  {PRODUCT}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([q, a, b, c]) => (
                <tr key={q}>
                  <th scope="row">{q}</th>
                  <td>{a}</td>
                  <td>{b}</td>
                  <td className="us">{c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function ForLlms() {
  const items: [string, string, ReactNode, string][] = [
    ['doc', '/llms.txt', <>A one-page map of the docs in the llms.txt format, with quick facts for assistants.</>, '/llms.txt'],
    ['book', '/llms-full.txt', <>Every docs page in one plain-text file, ready to paste into a context window.</>, '/llms-full.txt'],
    ['terminal', '/docs/<page>.md', <>Each docs page as raw Markdown. Every page also has a "Copy as Markdown" button.</>, '/docs/getting-started.md'],
    ['bot', 'MCP tool descriptions', <>Each tool tells the model what it does and the Cypher it runs; each result lists the queries it ran.</>, '#/docs/tools'],
  ];
  return (
    <section className="band" id="for-llms">
      <div className="wrap">
        <SectionHead
          eyebrow="Docs for people and for models"
          title="Your assistant can read all of this"
          lede="The documentation is published as Markdown next to the site, so an LLM gets the same facts you do — without scraping a JavaScript app."
        />
        <div className="grid4">
          {items.map(([icon, title, body, href]) => (
            <a key={title} className="card llm-card" href={href}>
              <span className="card-icon">
                <Icon name={icon} />
              </span>
              <h3>
                <code>{title}</code>
              </h3>
              <p>{body}</p>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

export const FAQ: [string, ReactNode][] = [
  [
    'Which languages does it understand?',
    <>Code repositories are parsed as Python (tree-sitter). Docs can be any Markdown or MDX, in any repository. JavaScript examples in the docs are indexed but not yet linked to code or run.</>,
  ],
  [
    'Do I need an LLM API key?',
    <>No. Graph mode runs impact, clearance, PageRank ranking and up to three example runs with no model. Agent mode adds a model that reads each section and writes the verdicts and edits; it needs <code>ANTHROPIC_API_KEY</code>.</>,
  ],
  [
    'Which models does agent mode support?',
    <>Claude by default (<code>claude-sonnet-5-5</code>), or any Anthropic-compatible API through <code>ANTHROPIC_BASE_URL</code>. The live demo runs <code>deepseek-v4-pro</code> through DeepSeek's Anthropic-compatible endpoint.</>,
  ],
  [
    'Will it open pull requests on its own?',
    <>No. It proposes edits; <code>patch</code> prints a <code>git apply</code>-able diff, and <code>patch --open-pr</code> opens it in your fork only when you ask (<code>--upstream</code> targets the original repository).</>,
  ],
  [
    'Is running docs examples safe?',
    <>Each example runs with no inherited secrets, a temporary HOME and a timeout, and its outbound connections are refused except a disposable scratch FalkorDB. The install step that builds the repositories at the PR's commits gets only an allow-listed environment, so PR build code never sees your credentials. It is a guard, not a security boundary: for untrusted code, run it in a container.</>,
  ],
  [
    'Does my code leave my machine?',
    <>Indexing, the graph and example runs stay wherever you run them. In agent mode, tool results (doc text, signatures, run output) go to the model provider you configure; graph mode sends nothing to a model. Only public repositories are supported today.</>,
  ],
  [
    'What does it cost?',
    <>Nothing: it is MIT licensed. You run FalkorDB (locally, in Docker, or on FalkorDB Cloud's free tier) and pay your model provider in agent mode.</>,
  ],
  [
    'Why does it need a graph database?',
    <>Impact is a variable-length path across repositories, clearance is the same pattern negated, decisions govern code transitively, and ranking is PageRank. Take FalkorDB out and it is a grep over one repository.</>,
  ],
];

function Faq() {
  return (
    <section className="band alt" id="faq">
      <div className="wrap narrow">
        <SectionHead eyebrow="FAQ" title="Questions developers ask first" center />
        <div className="faq">
          {FAQ.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
        <p className="center muted">
          More in <a href="#/docs/troubleshooting">Troubleshooting and FAQ</a>.
        </p>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="band cta-band">
      <div className="wrap cta-inner">
        <h2>Check your next pull request before your readers do.</h2>
        <p>Index your repositories once; every PR after that gets its docs impact, with proof.</p>
        <div className="cta-row center">
          <a className="btn btn-primary" href="#/docs/getting-started">
            <Icon name="terminal" /> Start in five minutes
          </a>
          <a className="btn btn-ghost" href={REPO_URL} target="_blank" rel="noreferrer">
            <Icon name="github" /> Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
