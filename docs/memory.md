# Decisions and memory

This page covers what the graph remembers between checks and how people steer it: recording a maintainer decision, what a decision governs, superseding one, governed verdicts, accepting or rejecting verdicts, the "since your last check" summary, and exactly what every check writes back. It is for maintainers who want a check to stop flagging something on purpose, and for anyone reading a check's history.

## Record a decision

A decision is one sentence from a maintainer, attached to the doc sections or symbols it governs. Later checks find it and can cite it instead of flagging the docs again.

```bash
npx -y lockstep-docs decide "The async client keeps positional kwargs until 2.0" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --author "maintainer" --source "https://github.com/FalkorDB/falkordb-py/issues/<n>"
```

It prints `Recorded decision dec-<id> governing 1 node(s).` The same decision can be written three ways:

| Interface | How | Notes |
|---|---|---|
| CLI | `lockstep-docs decide <text> --governs <id...> [--source <url>] [--author <name>] [--supersedes <decision-id>]` | `--governs` is required and takes several ids |
| MCP | `write_decision` with `text`, `governs`, and optional `source_url`, `author`, `supersedes` | Meant for a person driving an MCP client; the tool description says so |
| HTTP | `POST /api/decisions` with the same JSON body as `write_decision` | Returns `{id, governed, summary}`; text is limited to 500 characters; rate-limited to 30 writes per hour per client |

In the web UI, each impacted section has a "Record a maintainer decision for this section" form; it posts to `POST /api/decisions` with that section as `governs` and `author: 'web demo'`.

Rules:

- `text` needs at least 5 characters; `governs` at least one id.
- `governs` takes [DocSection ids](concepts.md#ids) (`owner/repo:path#anchor`) and Symbol ids (`owner/repo:qualname`), mixed. Ids that match nothing are ignored; if none matches, nothing is recorded and the error is `none of <ids> is a DocSection or Symbol id; decision not recorded`.
- The `Decision` node stores `text`, `source_url` (empty by default), `author` (`unknown` by default), `status: 'active'` and `created_at`. Its id is `dec-` plus 10 hex characters.
- The agent cannot write decisions: `write_decision` is never offered to the model. Decisions come from people.

## What a decision governs

A decision has a `GOVERNS` edge to every section and symbol it names, and reaches further through the call graph:

- **For a doc section**, a decision applies when it governs the section itself, or governs a symbol within 2 calls below a symbol the section mentions in inline code, or below a symbol one of its examples calls.
- **For a symbol**, a decision applies when it governs that symbol or anything it calls within 2 hops.

So a decision on a function covers the docs of everything that calls it, up to two calls above it, in any repository. A decision on `FalkorDB.__init__` covers the README section whose example constructs `FalkorDB`; a GraphRAG-SDK section whose example called a helper that constructs the async `FalkorDB` would be covered too, one call further away. The reverse does not hold: a decision on a callee does not apply when you ask about a function it calls.

## Superseding a decision

Decisions change. Record the new one with `--supersedes` (or `supersedes` in MCP and HTTP):

```bash
npx -y lockstep-docs decide "The async client drops positional kwargs in 2.0; document keyword arguments only" \
  --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__" \
  --supersedes dec-<old-id>
```

This adds `(new)-[:SUPERSEDES]->(old)` and sets the old decision's status to `superseded`. It prints `Recorded decision dec-<new-id> governing 1 node(s), superseding dec-<old-id>.` A `--supersedes` id that does not exist is ignored without an error.

## How decisions_for resolves decisions

`decisions_for` takes a section id (anything containing `#`) or a symbol id and returns the active decisions that apply, as described above. Superseded decisions resolve to their successor: when a matched decision has been replaced, the tool follows `SUPERSEDES` edges back (up to 10 steps) to the newest active decision and returns that one, with `matched` set to the decision the graph actually reached. Only `active` decisions come back, one entry per decision, preferring a direct match over one reached through a superseded decision.

Each entry has `id`, `text`, `source`, `author`, `createdAt`, `matched` and `via`: the section's heading path when the decision governs the section itself, otherwise the qualified name of the governed symbol. The summary reads:

```text
1 active decision governs this: "The async client keeps positional kwargs until 2.0" (dec-<id>, via falkordb.asyncio.falkordb.FalkorDB.__init__).
```

A superseded match shows as `(dec-<new>, supersedes dec-<old>, via …)`. With no match the summary is `No decision governs this.`

## Governed verdicts

When a decision says a section stays as it is, the agent closes the section with a `governed` verdict that cites it. The system prompt says: "Check decisions_for before editing: a maintainer decision can mean the section is intentionally as it is. Cite it with a governed verdict."

```json
{
  "section_id": "FalkorDB/falkordb-py:README.md#asynchronous-example",
  "verdict": "governed",
  "reason": "The README keeps the positional-kwargs form on purpose until 2.0.",
  "cites": ["dec-<id>"]
}
```

A `governed` verdict without `cites` is refused: `a governed verdict must cite the decision id(s)`. Each cited id that exists gets a `CITES` edge from the verdict; an id that matches no decision is skipped without an error, so check the id you cite.

## Verdicts and maintainer review

Every verdict starts as `proposed`. A maintainer can accept or reject it:

```bash
npx -y lockstep-docs verdict accept ver-<id>
npx -y lockstep-docs verdict reject ver-<id> --by alice
```

The CLI prints `ver-<id> accepted` (or `rejected`); `--by` defaults to `$USER`, else `maintainer`. Over HTTP:

```bash
curl -X POST http://127.0.0.1:8080/api/verdicts/ver-<id>/review \
  -H 'content-type: application/json' -d '{"status": "rejected", "by": "alice"}'
```

`status` must be `accepted` or `rejected`; `by` defaults to `web` and is cut to 60 characters. An unknown id gives `no verdict <id>` on the CLI and 404 `no such verdict` over HTTP. The review sets `status`, `reviewed_by` and `reviewed_at` on the verdict. The web UI has no accept or reject buttons yet; use the CLI or the API.

To find verdict ids: `GET /api/patch?pr=<url>` lists the latest verdict per section with its `id`; `check --json` prints the check's events, including each `record_verdict` and `propose_edit` result; MCP results include them too.

What a review changes:

- **The docs patch** leaves out `stale` verdicts that were rejected.
- **The next check sees it.** `decisions_for` on a section returns its 5 most recent verdicts, on any pull request, with their status. The summary shows the status when it is not `proposed`, in the form `Earlier: stale (rejected) on <owner>/<repo>/pull/<n>, ok on …`. The system prompt tells the model to use this history.
- **Precision.** Reviews are the data for measuring how often verdicts are right. No command computes it yet; this query counts reviews per verdict kind:

```cypher
MATCH (v:Verdict)
WHERE v.status IN ['accepted', 'rejected']
RETURN v.verdict AS verdict,
       sum(CASE WHEN v.status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
       count(v) AS reviewed
ORDER BY verdict
```

Run it against the org graph (the graph name is the org slug, `falkordb` by default) with any FalkorDB client.

## Since your last check

At the start of an agent check, the loop looks up the most recent finished check in the graph (any pull request, either mode) and summarises what was written since it started:

- pull requests ingested for the first time (this can include the one being checked);
- verdicts, and how many of them are `stale`;
- new decisions, with their text and id;
- example runs, and how many failed.

The summary is appended to the model's first message as `Since the last check: …`, recorded on the `check_started` trace event, and printed by the CLI. Its format:

```text
<n> pull request(s) checked (<owner/repo/pull/n>, …); <n> verdict(s), <n> of them stale; <n> new decision(s): "<text>" (<id>); <n> example run(s), <n> failed
```

Parts with nothing to report are left out. Graph mode does not compute it.

## What every check writes

Nothing a check learns is kept only in memory. In order:

| When | Written | Edges |
|---|---|---|
| The first time the pull request is seen | `PullRequest` (URL, title, author, state, commits compared, `docs_touched`, `ingested_at`); symbols it removed that the graph no longer has, recreated with `status: 'removed'` | `CHANGED_IN {kind, before, after, renamed_to}` from each changed symbol; `late` `MENTIONS` and `USES` to recreated symbols |
| The check starts | `Check` with `status: 'running'`, the model name and `started_at` | `FOR` → PullRequest |
| Each `run_example` | `Run` per side, unless an identical run is reused | `OF` → CodeExample, `AT` → PullRequest |
| Each `propose_edit` or `record_verdict` | `Verdict` with `check` set to the check id | `ABOUT` → DocSection, `FOR` → PullRequest, `CITES` → Decision, `EVIDENCE` → Run |
| The check ends | The `Check`'s status, summary, turns, tool calls, tool order, open sections, token counts and full trace | `PRODUCED` → each Verdict of this check |

Graph mode writes the pull request, the check and its runs, but no verdicts. Tool calls over MCP write runs and verdicts (with an empty `check`) but no `Check` node. Decisions are only written by people.

## Nothing is deleted on re-index

Re-indexing never deletes `Symbol`, `DocSection` or `CodeExample` nodes. Those that disappeared from the repository are marked `status: 'gone'`, so verdicts keep their `ABOUT` edge, decisions keep their `GOVERNS` edges, and runs keep their `OF` edge; the history stays readable. Gone sections are no longer reached by an impact walk.

Two consequences to know:

- A section's id comes from its heading. Rename the heading (or move the file) and the section gets a new id; decisions and verdicts stay on the old, gone one. Re-record a decision on the new id if it still applies.
- Re-indexing a docs repository deletes and rebuilds its `MENTIONS` and `USES` edges, including the `late` ones made for removed symbols, and those are not recreated. See [Indexing](indexing.md#re-indexing).

## Worked example

falkordb-py#262 reaches one section, the README's "Asynchronous Example", through the path `Is_Cluster ← FalkorDB.__init__ ← FalkorDB/falkordb-py:README.md:4`: the example constructs the async `FalkorDB`.

1. **Record the decision**, governing the constructor:

   ```bash
   npx -y lockstep-docs decide "The async client keeps positional kwargs until 2.0" \
     --governs "FalkorDB/falkordb-py:falkordb.asyncio.falkordb.FalkorDB.__init__"
   ```

   The graph now has `(:Decision {status: 'active'})-[:GOVERNS]->(:Symbol {qualname: 'falkordb.asyncio.falkordb.FalkorDB.__init__'})`.

2. **Check the pull request again** in agent mode:

   ```bash
   npx -y lockstep-docs check https://github.com/FalkorDB/falkordb-py/pull/262
   ```

   The model's first message includes `Since the last check: … 1 new decision(s): "The async client keeps positional kwargs until 2.0" (dec-<id>) …`.

3. **The decision is found through the example.** When the model calls `decisions_for` on `FalkorDB/falkordb-py:README.md#asynchronous-example`, the section's example `USES` `FalkorDB.__init__` directly (0 call hops), so the result is the decision, `via falkordb.asyncio.falkordb.FalkorDB.__init__`, followed by the section's earlier verdicts.

4. **The verdict cites it.** If the model concludes the section stays as written because of the decision, it records `governed` with `cites: ["dec-<id>"]`. The verdict gets a `CITES` edge, the PR comment's verdicts table shows `governed`, and the docs patch lists the section under "sections checked and left unchanged" with the reason.

Whether the model uses the decision is its judgement: on #262 the example passes after the pull request, so an `ok` verdict is also correct. Graph mode never reads decisions.

## Limits

- No command computes verdict precision yet; reviews are stored, and the query above counts them.
- The web UI records decisions but cannot accept or reject verdicts.
- Decisions and verdicts are tied to section ids, which change when a heading is renamed.
- Unknown ids in `cites` and `--supersedes` are ignored without an error.
- A check that dies mid-way (process killed) leaves its `Check` at `running`; "since your last check" ignores it.

## Related

- [Core concepts](concepts.md#decisions): decisions, verdicts and memory in one paragraph each
- [The agent](agent.md): when the model calls `decisions_for` and records verdicts
- [CLI](cli.md): `decide` and `verdict`
- [HTTP API](http-api.md): `POST /api/decisions` and `POST /api/verdicts/:id/review`
- [Graph model and Cypher](GRAPH-MODEL.md#memory): every memory query
