/**
 * Every Cypher statement Lockstep sends to FalkorDB lives in this file, named.
 * The README's query section is generated from it, and a test keeps them in sync,
 * so what the docs claim is exactly what runs.
 */
export interface NamedQuery {
  name: string;
  /** One line: what the product uses it for. */
  purpose: string;
  cypher: string;
  /** `tool` queries are what the agent calls; `index`/`memory` write the graph. */
  group: 'schema' | 'index' | 'tool' | 'memory' | 'report';
}

function q(group: NamedQuery['group'], name: string, purpose: string, cypher: string): NamedQuery {
  return { group, name, purpose, cypher: dedent(cypher) };
}

function dedent(s: string): string {
  const lines = s.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

/** Exact-match indexes on every lookup key. Created idempotently. */
export const SCHEMA_INDEXES: [label: string, prop: string][] = [
  ['Repo', 'name'],
  ['File', 'id'],
  ['Symbol', 'id'],
  ['Symbol', 'name'],
  ['Symbol', 'repo'],
  ['DocSection', 'id'],
  ['DocSection', 'repo'],
  ['CodeExample', 'id'],
  ['CodeExample', 'repo'],
  ['PullRequest', 'url'],
  ['Decision', 'id'],
  ['Verdict', 'id'],
  ['Run', 'id'],
  ['Check', 'id'],
];

// ─── index: code ────────────────────────────────────────────────────────────

export const upsertRepo = q('index', 'upsertRepo', 'Create or refresh a repository node.', `
  MERGE (r:Repo {name: $name})
  SET r += $props
`);

export const upsertFiles = q('index', 'upsertFiles', 'Create or refresh files and attach them to their repository.', `
  UNWIND $rows AS row
  MERGE (f:File {id: row.id})
  SET f += row.props, f.seen = $run
  WITH f, row
  MATCH (r:Repo {name: row.repo})
  MERGE (f)-[:IN_REPO]->(r)
`);

export const upsertSymbols = q('index', 'upsertSymbols', 'Create or refresh symbols (modules, classes, functions, methods) in their files.', `
  UNWIND $rows AS row
  MERGE (s:Symbol {id: row.id})
  SET s += row.props, s.status = 'live', s.seen = $run
  WITH s, row
  MATCH (f:File {id: row.file})
  MERGE (s)-[:DEFINED_IN]->(f)
`);

export const deleteRepoCalls = q('index', 'deleteRepoCalls', 'Drop the outgoing call edges of a repository before re-resolving them.', `
  MATCH (s:Symbol {repo: $repo})-[c:CALLS]->()
  DELETE c
`);

export const upsertCalls = q('index', 'upsertCalls', 'Write resolved call edges (exact = through imports and types; by-name = name match in an imported repository).', `
  UNWIND $rows AS row
  MATCH (a:Symbol {id: row.from})
  MATCH (b:Symbol {id: row.to})
  MERGE (a)-[c:CALLS]->(b)
  SET c.resolved = row.resolved, c.line = row.line, c.text = row.text
`);

export const markGoneSymbols = q('index', 'markGoneSymbols', 'Symbols no longer in the repository are kept (verdicts and decisions point at them) but marked gone.', `
  MATCH (s:Symbol {repo: $repo})
  WHERE s.seen <> $run AND s.status = 'live'
  SET s.status = 'gone'
  RETURN count(s) AS gone
`);

export const upsertDependsOn = q('index', 'upsertDependsOn', 'Record that one repository depends on another (from pyproject/requirements).', `
  UNWIND $rows AS row
  MATCH (a:Repo {name: row.from})
  MATCH (b:Repo {name: row.to})
  MERGE (a)-[d:DEPENDS_ON]->(b)
  SET d.spec = row.spec
`);

// ─── index: docs ────────────────────────────────────────────────────────────

export const upsertSections = q('index', 'upsertSections', 'Create or refresh doc sections (one per heading) with their text and identifiers.', `
  UNWIND $rows AS row
  MERGE (d:DocSection {id: row.id})
  SET d += row.props, d.status = 'live', d.seen = $run
  WITH d, row
  MATCH (f:File {id: row.file})
  MERGE (d)-[:DEFINED_IN]->(f)
`);

export const upsertExamples = q('index', 'upsertExamples', 'Create or refresh code examples (fenced blocks and example scripts) and place them in their section.', `
  UNWIND $rows AS row
  MERGE (e:CodeExample {id: row.id})
  SET e += row.props, e.status = 'live', e.seen = $run
  WITH e, row
  MATCH (f:File {id: row.file})
  MERGE (e)-[:DEFINED_IN]->(f)
  WITH e, row
  OPTIONAL MATCH (d:DocSection {id: row.section})
  FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END | MERGE (e)-[:IN_SECTION]->(d))
`);

export const deleteRepoDocEdges = q('index', 'deleteRepoDocEdges', 'Drop a docs repository\'s MENTIONS/USES/LINKS_TO edges before re-linking.', `
  MATCH (d {repo: $repo})-[r:MENTIONS|USES|LINKS_TO]->()
  WHERE d:DocSection OR d:CodeExample
  DELETE r
`);

export const upsertMentions = q('index', 'upsertMentions', 'Link a doc section to a symbol its prose names in inline code.', `
  UNWIND $rows AS row
  MATCH (d:DocSection {id: row.from})
  MATCH (s:Symbol {id: row.to})
  MERGE (d)-[m:MENTIONS]->(s)
  SET m.span = row.span, m.resolved = row.resolved
`);

export const upsertUses = q('index', 'upsertUses', 'Link a code example to a symbol it calls (resolved like code: imports, then types).', `
  UNWIND $rows AS row
  MATCH (e:CodeExample {id: row.from})
  MATCH (s:Symbol {id: row.to})
  MERGE (e)-[u:USES]->(s)
  SET u.line = row.line, u.resolved = row.resolved, u.text = row.text
`);

export const upsertLinks = q('index', 'upsertLinks', 'Link doc sections that hyperlink to each other (input to PageRank).', `
  UNWIND $rows AS row
  MATCH (a:DocSection {id: row.from})
  MATCH (b:DocSection {id: row.to})
  MERGE (a)-[:LINKS_TO]->(b)
`);

export const markGoneDocs = q('index', 'markGoneDocs', 'Doc sections and examples no longer present are kept but marked gone.', `
  MATCH (d {repo: $repo})
  WHERE (d:DocSection OR d:CodeExample) AND d.seen <> $run AND d.status = 'live'
  SET d.status = 'gone'
  RETURN count(d) AS gone
`);

// ─── report ─────────────────────────────────────────────────────────────────

export const repoSymbols = q('report', 'repoSymbols', 'List the live symbols of a repository.', `
  MATCH (s:Symbol {repo: $repo, status: 'live'})
  RETURN s.id AS id, s.qualname AS qualname, s.kind AS kind, s.signature AS signature
  ORDER BY s.qualname
`);

export const callsFrom = q('report', 'callsFrom', 'Outgoing calls of one symbol.', `
  MATCH (a:Symbol {id: $id})-[c:CALLS]->(b:Symbol)
  RETURN b.id AS to, c.resolved AS resolved, c.line AS line
  ORDER BY b.id
`);

export const graphCounts = q('report', 'graphCounts', 'Node and edge counts for FACTS.md.', `
  MATCH (n)
  RETURN labels(n)[0] AS label, count(n) AS n
  ORDER BY label
`);

export const edgeCounts = q('report', 'edgeCounts', 'Edge counts by type for FACTS.md.', `
  MATCH ()-[r]->()
  RETURN type(r) AS type, count(r) AS n
  ORDER BY type
`);

export const factsRepos = q('report', 'factsRepos', 'Per-repository counts for FACTS.md.', `
  MATCH (r:Repo)
  OPTIONAL MATCH (s:Symbol {repo: r.name, status: 'live'})
  WITH r, count(s) AS symbols
  OPTIONAL MATCH (d:DocSection {repo: r.name, status: 'live'})
  WITH r, symbols, count(d) AS sections
  OPTIONAL MATCH (e:CodeExample {repo: r.name, status: 'live'})
  RETURN r.name AS name, r.sha AS sha, symbols, sections, count(e) AS examples,
         sum(CASE WHEN e.lang = 'python' THEN 1 ELSE 0 END) AS pythonExamples
  ORDER BY name
`);

export const factsCalls = q('report', 'factsCalls', 'How CALLS edges were resolved, and how many cross repositories.', `
  MATCH (a:Symbol)-[c:CALLS]->(b:Symbol)
  RETURN sum(CASE WHEN c.resolved = 'exact' THEN 1 ELSE 0 END) AS exact,
         sum(CASE WHEN c.resolved = 'by-name' THEN 1 ELSE 0 END) AS byName,
         sum(CASE WHEN a.repo <> b.repo THEN 1 ELSE 0 END) AS crossRepo
`);

export const factsUses = q('report', 'factsUses', 'How USES edges (example → symbol) were resolved.', `
  MATCH (:CodeExample)-[u:USES]->(:Symbol)
  RETURN sum(CASE WHEN u.resolved = 'exact' THEN 1 ELSE 0 END) AS exact,
         sum(CASE WHEN u.resolved = 'by-name' THEN 1 ELSE 0 END) AS byName
`);

export const factsDependsOn = q('report', 'factsDependsOn', 'Repository dependency edges.', `
  MATCH (a:Repo)-[d:DEPENDS_ON]->(b:Repo)
  RETURN a.name AS from, b.name AS to, d.spec AS spec
  ORDER BY from, to
`);

export const factsCrossRepoDocPaths = q('report', 'factsCrossRepoDocPaths', 'Symbol → doc pairs connected through ≤ 3 call hops where the doc lives in another repository.', `
  MATCH (s:Symbol {status: 'live'})
  MATCH (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE (d:DocSection OR d:CodeExample) AND s.repo <> d.repo
  RETURN count(DISTINCT s.id + '|' + d.id) AS n
`);

export const factsSamplePaths = q('report', 'factsSamplePaths', 'For public symbols, the longest path where a call crosses a repository boundary before reaching a doc.', `
  MATCH (s:Symbol {status: 'live', visibility: 'public'})
  WHERE NOT s.qualname CONTAINS '._'
  MATCH p = (s)<-[:CALLS*1..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE (d:DocSection OR d:CodeExample) AND s.repo <> t.repo
  WITH s, d, p
  ORDER BY length(p) DESC, d.id
  WITH s, collect({doc: d.id, hops: length(p), path: [n IN nodes(p) | coalesce(n.qualname, n.id)]})[0] AS best
  RETURN s.qualname AS symbol, best.doc AS doc, best.hops AS hops, best.path AS path
  ORDER BY hops DESC, symbol
  LIMIT 5
`);

export const impactFromSymbol = q('report', 'impactFromSymbol', 'Docs reachable from one symbol (FACTS timing; the PR-scoped version is the impact tool).', `
  MATCH (s:Symbol {qualname: $qualname})
  MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE d:DocSection OR d:CodeExample
  RETURN d.id AS doc, length(p) AS hops
`);

export const ALL_QUERIES: NamedQuery[] = [
  upsertRepo,
  upsertFiles,
  upsertSymbols,
  deleteRepoCalls,
  upsertCalls,
  markGoneSymbols,
  upsertDependsOn,
  upsertSections,
  upsertExamples,
  deleteRepoDocEdges,
  upsertMentions,
  upsertUses,
  upsertLinks,
  markGoneDocs,
  repoSymbols,
  callsFrom,
  graphCounts,
  edgeCounts,
  factsRepos,
  factsCalls,
  factsUses,
  factsDependsOn,
  factsCrossRepoDocPaths,
  factsSamplePaths,
  impactFromSymbol,
];
