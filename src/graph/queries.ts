/**
 * Every Cypher statement Staleproof sends to FalkorDB lives in this file, named.
 * The README's query section is generated from it, and a test keeps them in sync,
 * so what the docs claim is exactly what runs.
 *
 * Every variable-length pattern binds a path variable (`p = (a)<-[:CALLS*0..3]-(b)`), and none sits in a WHERE
 * pattern predicate: FalkorDB 4.18 can drop nodes reachable along two routes from an anonymous variable-length
 * pattern, which would turn clearance into a false proof of absence (test/traversal.test.ts). Ranges also start at
 * 0 or 1: FalkorDB 4.22 returns no rows for an exact length of 2 or more (`*2`, `*3..3`) toward a labelled node.
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
  ['Verdict', 'check'],
  ['Run', 'id'],
  ['Run', 'key'],
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

export const deleteRepoDocEdges = q('index', 'deleteRepoDocEdges', 'Drop a docs repository\'s MENTIONS/USES/LINKS_TO/MISMATCH edges before re-linking.', `
  MATCH (d {repo: $repo})-[r:MENTIONS|USES|LINKS_TO|MISMATCH]->()
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

export const upsertMismatches = q('index', 'upsertMismatches', 'Record an example line that no longer fits the code it calls: an unknown keyword, a wrong argument count, a name that does not exist.', `
  UNWIND $rows AS row
  MATCH (e:CodeExample {id: row.from})
  MATCH (s:Symbol {id: row.to})
  MERGE (e)-[m:MISMATCH {kind: row.kind, name: row.name, detail: row.detail}]->(s)
  SET m.line = row.line, m.text = row.text
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

// ─── pull requests ──────────────────────────────────────────────────────────

export const upsertPullRequest = q('index', 'upsertPullRequest', 'Record a pull request and forget its previous change set (re-checking is idempotent).', `
  MERGE (pr:PullRequest {url: $url})
  SET pr += $props
  WITH pr
  OPTIONAL MATCH (pr)<-[c:CHANGED_IN]-()
  DELETE c
`);

export const upsertMissingSymbols = q('index', 'upsertMissingSymbols', 'Symbols a PR removed or renamed that the graph (indexed after the PR) no longer has: recreate them as removed.', `
  UNWIND $rows AS row
  MERGE (s:Symbol {id: row.id})
  ON CREATE SET s += row.props, s.status = 'removed'
  WITH s, row
  MERGE (f:File {id: row.file})
  ON CREATE SET f.repo = row.props.repo, f.path = row.props.path, f.kind = 'python'
  MERGE (s)-[:DEFINED_IN]->(f)
`);

export const lateLinkSections = q('index', 'lateLinkSections', 'Link docs that still name a removed symbol (by the identifiers stored on each section), within repositories that document its repository.', `
  UNWIND $rows AS row
  MATCH (s:Symbol {id: row.id})
  MATCH (d:DocSection {status: 'live'})
  WHERE (row.name IN d.idents OR row.dotted IN d.idents)
    AND (d.repo = s.repo OR (:Repo {name: d.repo})-[:DEPENDS_ON]->(:Repo {name: s.repo}))
  MERGE (d)-[m:MENTIONS]->(s)
  ON CREATE SET m.resolved = 'late', m.span = row.name
  RETURN count(m) AS linked
`);

export const lateLinkExamples = q('index', 'lateLinkExamples', 'Link code examples that still use a removed symbol\'s name.', `
  UNWIND $rows AS row
  MATCH (s:Symbol {id: row.id})
  MATCH (e:CodeExample {status: 'live'})
  WHERE row.name IN e.idents
    AND (e.repo = s.repo OR (:Repo {name: e.repo})-[:DEPENDS_ON]->(:Repo {name: s.repo}))
  MERGE (e)-[u:USES]->(s)
  ON CREATE SET u.resolved = 'late', u.text = row.name
  RETURN count(u) AS linked
`);

export const upsertChangedIn = q('index', 'upsertChangedIn', 'Attach each changed symbol to the pull request with the kind of change.', `
  UNWIND $rows AS row
  MATCH (s:Symbol {id: row.id})
  MATCH (pr:PullRequest {url: $url})
  MERGE (s)-[c:CHANGED_IN]->(pr)
  SET c.kind = row.kind, c.before = row.before, c.after = row.after, c.renamed_to = row.renamed_to
`);

// ─── agent tools ────────────────────────────────────────────────────────────

export const impact = q('tool', 'impact', 'Every doc section and code example a pull request reaches: changed symbol ← up to 3 callers (any repository) ← doc. The path is the evidence.', `
  MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind <> 'added'
  MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE (d:DocSection OR d:CodeExample) AND d.status = 'live'
  OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
  RETURN s.qualname AS changed, c.kind AS change, c.before AS before, c.after AS after,
         t.qualname AS reached, labels(d)[0] AS kind, d.id AS doc, d.repo AS repo, d.path AS path,
         coalesce(sec.id, d.id) AS section, coalesce(sec.heading_path, d.heading_path, d.path) AS heading,
         d.url AS url, length(p) AS hops,
         [n IN nodes(p) | coalesce(n.qualname, n.id)] AS evidence,
         [x IN relationships(p) | coalesce(x.resolved, 'exact')] AS resolution
  ORDER BY hops, repo, doc
`);

export const predictedCalls = q('tool', 'predictedCalls', 'Examples that call a symbol the pull request removed, renamed, stopped exporting or re-signed, with the call as written (checked against the new signature in code).', `
  MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind IN ['removed', 'renamed', 'signature', 'export-removed']
  MATCH (e:CodeExample)-[u:USES]->(s)
  WHERE e.status = 'live' AND e.lang = 'python'
  OPTIONAL MATCH (e)-[:IN_SECTION]->(sec:DocSection)
  RETURN e.id AS example, e.code AS code, e.lineno AS lineno, e.url AS url, e.repo AS repo, e.path AS path,
         coalesce(sec.id, e.id) AS section, u.line AS line, u.text AS text, u.resolved AS resolved,
         s.qualname AS symbol, s.name AS name, s.kind AS symbolKind, s.decorators AS decorators,
         c.kind AS change, c.before AS before, c.after AS after, c.renamed_to AS renamedTo
  ORDER BY example, line
`);

export const mismatchesFor = q('tool', 'mismatchesFor', 'Example lines that already did not fit the code when indexed (MISMATCH edges), for the given examples.', `
  MATCH (e:CodeExample)-[m:MISMATCH]->(s:Symbol)
  WHERE e.id IN $ids AND e.status = 'live'
  RETURN e.id AS example, e.url AS url, m.line AS line, m.kind AS kind, m.detail AS detail, m.text AS call
  ORDER BY example, line
`);

export const clearance = q('tool', 'clearance', 'Proof of absence: changed symbols with no doc section or example within 3 call hops in any repository.', `
  MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind <> 'added'
  OPTIONAL MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-()
  WITH s, c, count(p) AS reach
  WHERE reach = 0
  RETURN s.qualname AS symbol, s.name AS name, s.repo AS repo, c.kind AS change, s.visibility AS visibility
  ORDER BY symbol
`);

export const prChanges = q('tool', 'prChanges', 'What a pull request changed, symbol by symbol.', `
  MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
  RETURN s.qualname AS symbol, s.kind AS kind, c.kind AS change, c.before AS before, c.after AS after,
         c.renamed_to AS renamedTo, s.repo AS repo, s.path AS path, s.status AS status
  ORDER BY change, symbol
`);

export const rankSections = q('tool', 'rankSections', 'Order doc sections by how central their page is: PageRank over LINKS_TO, summed per page.', `
  CALL algo.pageRank('DocSection', 'LINKS_TO') YIELD node, score
  WITH node.repo + ':' + node.path AS page, node.id AS id, node.heading_path AS heading, score
  WITH page, sum(score) AS pageScore, collect({id: id, heading: heading, score: score}) AS sections
  UNWIND sections AS sec
  WITH page, pageScore, sec
  WHERE sec.id IN $ids
  RETURN sec.id AS id, sec.heading AS heading, page, pageScore, sec.score AS score
  ORDER BY pageScore DESC, score DESC
`);

export const rankSectionsByLinks = q('tool', 'rankSectionsByLinks', 'Fallback ranking when graph algorithms are unavailable: inbound links per page.', `
  MATCH (d:DocSection)
  WHERE d.id IN $ids
  OPTIONAL MATCH (other:DocSection {repo: d.repo, path: d.path})<-[l:LINKS_TO]-()
  RETURN d.id AS id, d.heading_path AS heading, d.repo + ':' + d.path AS page, count(l) AS pageScore, 0 AS score
  ORDER BY pageScore DESC
`);

export const readSection = q('tool', 'readSection', 'The current text of a doc section, its code examples and its source link.', `
  MATCH (d:DocSection {id: $id})
  OPTIONAL MATCH (e:CodeExample)-[:IN_SECTION]->(d)
  WITH d, e ORDER BY e.index
  RETURN d.id AS id, d.repo AS repo, d.path AS path, d.heading_path AS heading, d.body AS body, d.url AS url,
         d.lineno AS lineno, d.end_lineno AS endLineno,
         collect(CASE WHEN e IS NULL THEN NULL ELSE {id: e.id, lang: e.lang, code: e.code, lineno: e.lineno} END) AS examples
`);

// ─── example runs ───────────────────────────────────────────────────────────

export const exampleForRun = q('tool', 'exampleForRun', 'A code example, the repositories its calls resolve into, and the earlier examples on its page (for stitching fragments).', `
  MATCH (e:CodeExample {id: $id})
  OPTIONAL MATCH (e)-[:USES]->(s:Symbol)
  WITH e, collect(DISTINCT s.repo) AS usedRepos
  OPTIONAL MATCH (prev:CodeExample {repo: e.repo, path: e.path, status: 'live'})
  WHERE prev.index < e.index
  WITH e, usedRepos, prev
  ORDER BY prev.index
  RETURN e.id AS id, e.lang AS lang, e.code AS code, e.repo AS repo, e.path AS path, e.url AS url, usedRepos,
         collect(CASE WHEN prev IS NULL THEN NULL ELSE {id: prev.id, lang: prev.lang, code: prev.code} END) AS earlier
`);

export const installSet = q('tool', 'installSet', 'Repositories to install for a run: the given ones plus their in-org dependencies (DEPENDS_ON), code repositories only.', `
  MATCH (r:Repo)
  WHERE r.name IN $repos
  OPTIONAL MATCH dep = (r)-[:DEPENDS_ON*1..3]->(d:Repo)
  WITH collect(DISTINCT r) + collect(DISTINCT d) AS repos
  UNWIND repos AS repo
  WITH DISTINCT repo
  WHERE repo IS NOT NULL AND size(repo.packages) > 0
  RETURN repo.name AS repo, repo.sha AS sha
  ORDER BY repo
`);

export const cachedRun = q('memory', 'cachedRun', 'An identical earlier run (same program, same commits): the graph remembers what already ran.', `
  MATCH (r:Run {key: $key})
  RETURN properties(r) AS props
  ORDER BY r.created_at DESC
  LIMIT 1
`);

export const upsertRun = q('memory', 'upsertRun', 'Record an example execution: status, error line, traceback, commits installed.', `
  MATCH (e:CodeExample {id: $example})
  MERGE (r:Run {id: $id})
  SET r += $props
  MERGE (r)-[:OF]->(e)
`);

export const linkRunToPr = q('memory', 'linkRunToPr', 'Attach a run to the pull request it was evidence for.', `
  MATCH (r:Run {id: $id})
  MATCH (pr:PullRequest {url: $pr})
  MERGE (r)-[:AT]->(pr)
`);

// ─── decisions and verdicts (memory) ───────────────────────────────────────

export const decisionsForSection = q('tool', 'decisionsForSection', 'Active decisions governing a doc section directly, or any symbol its prose or examples reach within 2 call hops; superseded decisions resolve to their successor.', `
  MATCH (d:DocSection {id: $id})
  OPTIONAL MATCH (dec0:Decision)-[:GOVERNS]->(d)
  OPTIONAL MATCH p1 = (d)-[:MENTIONS]->(:Symbol)-[:CALLS*0..2]->(g1:Symbol)<-[:GOVERNS]-(dec1:Decision)
  OPTIONAL MATCH p2 = (d)<-[:IN_SECTION]-(:CodeExample)-[:USES]->(:Symbol)-[:CALLS*0..2]->(g2:Symbol)<-[:GOVERNS]-(dec2:Decision)
  WITH collect(DISTINCT {dec: dec0, via: d.heading_path}) + collect(DISTINCT {dec: dec1, via: g1.qualname})
       + collect(DISTINCT {dec: dec2, via: g2.qualname}) AS hits
  UNWIND hits AS hit
  WITH hit.dec AS dec, hit.via AS via
  WHERE dec IS NOT NULL
  OPTIONAL MATCH chain = (newer:Decision {status: 'active'})-[:SUPERSEDES*1..10]->(dec)
  WITH coalesce(newer, dec) AS current, dec AS matched, via
  WHERE current.status = 'active'
  RETURN DISTINCT current.id AS id, current.text AS text, current.source_url AS source, current.author AS author,
         current.created_at AS createdAt, matched.id AS matched, via
`);

export const decisionsForSymbol = q('tool', 'decisionsForSymbol', 'Active decisions governing a symbol or anything it calls within 2 hops; superseded decisions resolve to their successor.', `
  MATCH p = (s:Symbol {id: $id})-[:CALLS*0..2]->(g:Symbol)<-[:GOVERNS]-(dec:Decision)
  OPTIONAL MATCH chain = (newer:Decision {status: 'active'})-[:SUPERSEDES*1..10]->(dec)
  WITH coalesce(newer, dec) AS current, dec AS matched, g.qualname AS via
  WHERE current.status = 'active'
  RETURN DISTINCT current.id AS id, current.text AS text, current.source_url AS source, current.author AS author,
         current.created_at AS createdAt, matched.id AS matched, via
`);

export const priorVerdicts = q('memory', 'priorVerdicts', 'What Staleproof concluded about this section on earlier pull requests, and what maintainers did with it.', `
  MATCH (v:Verdict)-[:ABOUT]->(:DocSection {id: $id})
  MATCH (v)-[:FOR]->(pr:PullRequest)
  RETURN v.id AS id, v.verdict AS verdict, v.status AS status, v.reason AS reason, pr.url AS pr, pr.title AS title, v.created_at AS createdAt
  ORDER BY createdAt DESC
  LIMIT 5
`);

export const createDecision = q('memory', 'createDecision', 'Record a maintainer decision.', `
  CREATE (dec:Decision {id: $id})
  SET dec += $props
  RETURN dec.id AS id
`);

export const governSections = q('memory', 'governSections', 'Attach a decision to the doc sections it governs.', `
  MATCH (dec:Decision {id: $id})
  MATCH (d:DocSection)
  WHERE d.id IN $governs
  MERGE (dec)-[:GOVERNS]->(d)
  RETURN count(d) AS n
`);

export const governSymbols = q('memory', 'governSymbols', 'Attach a decision to the symbols it governs.', `
  MATCH (dec:Decision {id: $id})
  MATCH (s:Symbol)
  WHERE s.id IN $governs
  MERGE (dec)-[:GOVERNS]->(s)
  RETURN count(s) AS n
`);

export const supersedeDecision = q('memory', 'supersedeDecision', 'Mark an older decision superseded by a newer one.', `
  MATCH (newer:Decision {id: $newer})
  MATCH (older:Decision {id: $older})
  MERGE (newer)-[:SUPERSEDES]->(older)
  SET older.status = 'superseded'
`);

export const createVerdict = q('memory', 'createVerdict', 'Record the agent\'s verdict on one section for one pull request, with the decisions and runs it cites.', `
  MATCH (d:DocSection {id: $section})
  MATCH (pr:PullRequest {url: $pr})
  CREATE (v:Verdict {id: $id})
  SET v += $props
  MERGE (v)-[:ABOUT]->(d)
  MERGE (v)-[:FOR]->(pr)
  WITH v
  OPTIONAL MATCH (dec:Decision) WHERE dec.id IN $cites
  FOREACH (_ IN CASE WHEN dec IS NULL THEN [] ELSE [1] END | MERGE (v)-[:CITES]->(dec))
  WITH DISTINCT v
  OPTIONAL MATCH (r:Run) WHERE r.id IN $runs
  FOREACH (_ IN CASE WHEN r IS NULL THEN [] ELSE [1] END | MERGE (v)-[:EVIDENCE]->(r))
  RETURN DISTINCT v.id AS id
`);

export const sectionReachedByPr = q('tool', 'sectionReachedByPr', 'Guard for edits: is there a path from this pull request\'s changes to the section (or one of its examples)?', `
  MATCH (pr:PullRequest {url: $pr})<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind <> 'added'
  MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE d.id = $section OR (d)-[:IN_SECTION]->(:DocSection {id: $section})
  WITH p
  ORDER BY length(p)
  LIMIT 1
  RETURN [n IN nodes(p) | coalesce(n.qualname, n.id)] AS path
`);

export const verdictsForPr = q('memory', 'verdictsForPr', 'The latest verdict per section for a pull request (what the docs patch is built from).', `
  MATCH (v:Verdict)-[:FOR]->(:PullRequest {url: $pr})
  MATCH (v)-[:ABOUT]->(d:DocSection)
  OPTIONAL MATCH (v)-[:CITES]->(dec:Decision)
  OPTIONAL MATCH (v)-[:EVIDENCE]->(r:Run)
  WITH v, d, collect(DISTINCT dec.id) AS cites, collect(DISTINCT {id: r.id, status: r.status, side: r.side, error: r.error}) AS runs
  ORDER BY v.created_at DESC
  WITH d, collect({v: v, cites: cites, runs: runs})[0] AS latest
  RETURN d.id AS section, d.repo AS repo, d.path AS path, d.heading_path AS heading, d.lineno AS lineno,
         d.end_lineno AS endLineno, d.url AS url, latest.v.id AS id, latest.v.verdict AS verdict,
         latest.v.status AS status, latest.v.reason AS reason, latest.v.new_text AS newText,
         latest.v.old_text AS oldText, latest.v.evidence AS evidence, latest.cites AS cites, latest.runs AS runs
  ORDER BY repo, path, lineno
`);

export const reviewVerdict = q('memory', 'reviewVerdict', 'A maintainer accepts or rejects a verdict; precision is measured from these.', `
  MATCH (v:Verdict {id: $id})
  SET v.status = $status, v.reviewed_by = $by, v.reviewed_at = $at
  RETURN v.id AS id
`);

export const sinceLastCheck = q('memory', 'sinceLastCheck', 'What changed in the graph since a moment: pull requests checked, verdicts, decisions, runs.', `
  OPTIONAL MATCH (pr:PullRequest) WHERE pr.ingested_at > $since
  WITH collect(DISTINCT {url: pr.url, title: pr.title}) AS prs
  OPTIONAL MATCH (v:Verdict) WHERE v.created_at > $since
  WITH prs, count(v) AS verdicts, sum(CASE WHEN v.verdict = 'stale' THEN 1 ELSE 0 END) AS stale
  OPTIONAL MATCH (dec:Decision) WHERE dec.created_at > $since
  WITH prs, verdicts, stale, collect(DISTINCT {id: dec.id, text: dec.text}) AS decisions
  OPTIONAL MATCH (r:Run) WHERE r.created_at > $since
  RETURN prs, verdicts, stale, decisions, count(r) AS runs,
         sum(CASE WHEN r.status = 'fail' THEN 1 ELSE 0 END) AS failedRuns
`);

// ─── agent checks ───────────────────────────────────────────────────────────

export const lastCheck = q('memory', 'lastCheck', 'When the previous agent check ran (for "since your last run").', `
  MATCH (c:Check)
  WHERE c.status <> 'running'
  RETURN c.id AS id, c.started_at AS startedAt, c.pr AS pr
  ORDER BY c.started_at DESC
  LIMIT 1
`);

export const createCheck = q('memory', 'createCheck', 'Start an agent check of a pull request.', `
  MATCH (pr:PullRequest {url: $pr})
  CREATE (c:Check {id: $id})
  SET c += $props
  MERGE (c)-[:FOR]->(pr)
`);

export const finishCheck = q('memory', 'finishCheck', 'Close an agent check: status, summary, and the full trace (every tool call with its Cypher).', `
  MATCH (c:Check {id: $id})
  SET c += $props
  WITH c
  MATCH (v:Verdict {check: $id})
  MERGE (c)-[:PRODUCED]->(v)
  RETURN count(v) AS verdicts
`);

export const sectionsWithVerdict = q('memory', 'sectionsWithVerdict', 'Sections that received a verdict during this check (the stop condition).', `
  MATCH (v:Verdict {check: $id})-[:ABOUT]->(d:DocSection)
  RETURN DISTINCT d.id AS id
`);

export const recentChecks = q('report', 'recentChecks', 'Agent checks, newest first.', `
  MATCH (c:Check)-[:FOR]->(pr:PullRequest)
  RETURN c.id AS id, pr.url AS pr, pr.title AS title, c.status AS status, c.model AS model, c.started_at AS startedAt,
         c.finished_at AS finishedAt, c.steps AS steps, c.tool_calls AS toolCalls, c.verdicts AS verdicts, c.summary AS summary,
         c.tool_order AS toolOrder
  ORDER BY startedAt DESC
  LIMIT $limit
`);

export const checkTrace = q('report', 'checkTrace', 'The stored trace of one agent check.', `
  MATCH (c:Check {id: $id})
  RETURN c.trace AS trace
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

export const graphCounts = q('report', 'graphCounts', 'Live node counts for FACTS.md (symbols and docs a re-index marked gone, or a PR removed, are not counted).', `
  MATCH (n)
  WHERE NOT (n:Symbol OR n:DocSection OR n:CodeExample) OR n.status = 'live'
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
  RETURN r.name AS name, r.sha AS sha, r.packages AS packages, symbols, sections, count(e) AS examples,
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
  MATCH p = (s)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE (d:DocSection OR d:CodeExample) AND s.repo <> d.repo
  RETURN count(DISTINCT s.id + '|' + d.id) AS n
`);

export const factsSamplePaths = q('report', 'factsSamplePaths', 'For public symbols, the longest path where a call crosses a repository boundary before reaching a doc.', `
  MATCH (s:Symbol {status: 'live', visibility: 'public'})
  WHERE NOT s.qualname CONTAINS '._'
  MATCH p = (s)<-[:CALLS*1..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE (d:DocSection OR d:CodeExample) AND s.repo <> t.repo
  WITH s, d, p, [n IN nodes(p) | coalesce(n.qualname, n.id)] AS names
  ORDER BY length(p) DESC, d.id, reduce(k = '', x IN names | k + x + ' ')
  WITH s, collect({doc: d.id, hops: length(p), path: names})[0] AS best
  RETURN s.qualname AS symbol, best.doc AS doc, best.hops AS hops, best.path AS path
  ORDER BY hops DESC, symbol
  LIMIT 5
`);

export const factsPullRequests = q('report', 'factsPullRequests', 'Pull requests checked so far, with how many symbols they changed and how many doc sections those reach.', `
  MATCH (pr:PullRequest)
  OPTIONAL MATCH (pr)<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind <> 'added'
  WITH pr, collect(s) AS changed
  OPTIONAL MATCH p = (pr)<-[c2:CHANGED_IN]-(s2:Symbol)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE c2.kind <> 'added' AND (d:DocSection OR d:CodeExample) AND d.status = 'live'
  OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
  WITH pr, changed, collect(DISTINCT coalesce(sec.id, d.id)) AS sections,
       collect(DISTINCT CASE WHEN d.repo <> pr.repo THEN coalesce(sec.id, d.id) END) AS elsewhere
  RETURN pr.url AS url, pr.title AS title, size(changed) AS changed, size(sections) AS sections,
         size(elsewhere) AS otherRepos
  ORDER BY url
`);

export const factsGrepBaseline = q('report', 'factsGrepBaseline', 'Per pull request: the names of the symbols it changed and the doc sections the impact traversal reaches from them (the grep baseline in FACTS compares the two).', `
  MATCH (pr:PullRequest)<-[c:CHANGED_IN]-(s:Symbol)
  WHERE c.kind <> 'added'
  WITH pr, collect(DISTINCT s.name) AS names
  OPTIONAL MATCH p = (pr)<-[c2:CHANGED_IN]-(:Symbol)<-[:CALLS*0..3]-(:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE c2.kind <> 'added' AND (d:DocSection OR d:CodeExample) AND d.status = 'live'
  OPTIONAL MATCH (d)-[:IN_SECTION]->(sec:DocSection)
  RETURN pr.url AS url, names, collect(DISTINCT coalesce(sec.id, d.id)) AS reached
  ORDER BY url
`);

export const factsSectionBodies = q('report', 'factsSectionBodies', 'The text of every live doc section, for the grep baseline.', `
  MATCH (d:DocSection)
  WHERE d.status = 'live'
  RETURN d.id AS id, d.body AS body
`);

export const factsRuns = q('report', 'factsRuns', 'Every recorded example execution (the latest attempt of each identical run), latest first per example and side.', `
  MATCH (r:Run)-[:OF]->(:CodeExample)
  WITH r.key AS key, max(r.created_at) AS latest
  MATCH (r:Run {key: key})-[:OF]->(e:CodeExample)
  WHERE r.created_at = latest
  OPTIONAL MATCH (r)-[:AT]->(pr:PullRequest)
  RETURN e.id AS example, e.url AS url, r.side AS side, r.status AS status, r.error AS error, r.reason AS reason,
         r.installed AS installed, pr.url AS pr, r.created_at AS at
  ORDER BY example, at DESC
`);

export const impactFromSymbol = q('report', 'impactFromSymbol', 'Docs reachable from one symbol (FACTS timing; the PR-scoped version is the impact tool).', `
  MATCH (s:Symbol {qualname: $qualname})
  MATCH p = (s)<-[:CALLS*0..3]-(t:Symbol)<-[:MENTIONS|USES]-(d)
  WHERE d:DocSection OR d:CodeExample
  RETURN d.id AS doc, length(p) AS hops
`);

export const auditRepos = q('report', 'auditRepos', 'The repositories a docs audit covers, with the commit each was indexed at.', `
  MATCH (r:Repo)
  WHERE size($repos) = 0 OR r.name IN $repos
  OPTIONAL MATCH (s:Symbol {repo: r.name})
  WITH r, count(s) AS symbols
  OPTIONAL MATCH (d:DocSection {repo: r.name})
  WHERE d.status = 'live'
  RETURN r.name AS name, r.sha AS sha, r.indexed_at AS indexedAt, symbols, count(d) AS sections
  ORDER BY name
`);

export const auditMismatches = q('report', 'auditMismatches', 'Every example line that does not fit the code it calls, in the audited repositories\' docs or against their code.', `
  MATCH (e:CodeExample)-[m:MISMATCH]->(s:Symbol)
  WHERE e.status = 'live' AND (e.repo IN $repos OR s.repo IN $repos)
  OPTIONAL MATCH (e)-[:IN_SECTION]->(sec:DocSection)
  RETURN e.id AS example, e.url AS url, e.repo AS repo, e.path AS path, coalesce(sec.heading_path, e.path) AS heading,
         m.line AS line, m.kind AS kind, m.detail AS detail, m.text AS call, s.qualname AS symbol, s.repo AS symbolRepo
  ORDER BY repo, path, line
`);

export const auditSymbols = q('report', 'auditSymbols', 'Every live symbol of the audited code repositories with how many docs reference it directly and how many symbols call it (API coverage).', `
  MATCH (s:Symbol)
  WHERE s.repo IN $repos AND s.status = 'live' AND s.kind <> 'module'
  OPTIONAL MATCH (s)<-[:MENTIONS|USES]-(d)
  WHERE d.status = 'live'
  WITH s, count(DISTINCT d) AS docs
  OPTIONAL MATCH (s)<-[:CALLS]-(caller:Symbol)
  WITH s, docs, collect(DISTINCT caller.repo) AS callerRepos, count(DISTINCT caller) AS callers
  RETURN s.id AS id, s.qualname AS qualname, s.name AS name, s.kind AS kind, s.repo AS repo, s.path AS path,
         s.lineno AS lineno, s.signature AS signature, s.visibility AS visibility, s.exported AS exported, docs, callers, callerRepos
`);

export const auditExamples = q('report', 'auditExamples', 'The live examples in the audited repositories\' docs, and examples elsewhere that call their code, with how many symbols each calls.', `
  MATCH (e:CodeExample)
  WHERE e.status = 'live' AND e.repo IN $repos
  OPTIONAL MATCH (e)-[u:USES]->(:Symbol)
  RETURN e.id AS id, e.lang AS lang, e.url AS url, e.repo AS repo, count(u) AS uses
  UNION
  MATCH (e:CodeExample)-[:USES]->(s:Symbol)
  WHERE e.status = 'live' AND s.repo IN $repos AND NOT e.repo IN $repos
  OPTIONAL MATCH (e)-[u:USES]->(:Symbol)
  RETURN e.id AS id, e.lang AS lang, e.url AS url, e.repo AS repo, count(u) AS uses
`);

export const auditRuns = q('report', 'auditRuns', 'Recorded runs of the audited examples at the indexed commits (not before/after a pull request).', `
  MATCH (r:Run)-[:OF]->(e:CodeExample)
  WHERE e.id IN $ids AND r.side = 'current'
  RETURN e.id AS example, e.url AS url, r.status AS status, r.error AS error, r.reason AS reason, r.installed AS installed, r.created_at AS at
  ORDER BY at ASC
`);

export const ALL_QUERIES: NamedQuery[] = [
  upsertPullRequest,
  upsertMissingSymbols,
  lateLinkSections,
  lateLinkExamples,
  upsertChangedIn,
  impact,
  clearance,
  prChanges,
  rankSections,
  rankSectionsByLinks,
  readSection,
  exampleForRun,
  installSet,
  cachedRun,
  upsertRun,
  linkRunToPr,
  decisionsForSection,
  decisionsForSymbol,
  priorVerdicts,
  createDecision,
  governSections,
  governSymbols,
  supersedeDecision,
  createVerdict,
  sectionReachedByPr,
  verdictsForPr,
  reviewVerdict,
  sinceLastCheck,
  lastCheck,
  createCheck,
  finishCheck,
  sectionsWithVerdict,
  recentChecks,
  checkTrace,
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
  upsertMismatches,
  upsertLinks,
  predictedCalls,
  mismatchesFor,
  auditRepos,
  auditMismatches,
  auditSymbols,
  auditExamples,
  auditRuns,
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
  factsPullRequests,
  factsGrepBaseline,
  factsSectionBodies,
  factsRuns,
  impactFromSymbol,
];
