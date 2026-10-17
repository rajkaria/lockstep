import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { PACKAGE } from './docs/manifest';
import { ClearedList, SectionCard, TraceList, type PackageRepo } from './components';
import { Icon } from './layout';
import { replay, type CheckView, type IndexingView } from './state';
import type { ImpactData, KnownMismatch, PredictedBreak } from './types';

/** A lint finding (src/lint/types.ts): a reference in the docs or an AI agent file the repository does not have. */
export interface WebFinding {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path: string;
  line: number;
  surface: 'agent' | 'readme' | 'docs' | 'docstring' | 'example' | 'config';
  subject: string;
  fingerprint: string;
  evidence?: { looked: string; url?: string };
  fix?: { description: string; verified: boolean };
}

/** "Docs this pull request makes wrong" (src/agent/graph-check.ts `PrFindings`), carried on the impact step. */
interface PrFindingsView {
  base: string;
  head: string;
  findings: WebFinding[];
  total: number;
  fixed: number;
  files: number;
}

export const SURFACE_TITLE: Record<WebFinding['surface'], string> = {
  agent: 'AI agent instructions',
  readme: 'README and contributing guides',
  docs: 'Docs',
  example: 'Code examples',
  docstring: 'Docstrings',
  config: 'Configuration',
};

/** Findings under their surface title, in the order given (AI agent instructions first). */
export function findingGroups<F extends WebFinding>(findings: F[]): [string, F[]][] {
  const out = new Map<string, F[]>();
  for (const f of findings) out.set(SURFACE_TITLE[f.surface] ?? f.surface, [...(out.get(SURFACE_TITLE[f.surface] ?? f.surface) ?? []), f]);
  return [...out];
}

export function CheckResults({ view, packageRepo }: { view: CheckView; packageRepo: PackageRepo }) {
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
      {view.indexing && <IndexingPanel ix={view.indexing} />}
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
          {view.finished?.status === 'done' && view.impact && <InstallNudge repo={view.impact.pr.repo} />}
          {newFindingsOf(view.impact) && <NewFindingsList nf={newFindingsOf(view.impact)!} />}
          {view.impact?.predicted && view.impact.predicted.length > 0 && <PredictedList predicted={view.impact.predicted} />}
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
          {view.impact?.mismatched && view.impact.mismatched.length > 0 && <MismatchedList mismatched={view.impact.mismatched} />}
          {view.cleared && <ClearedList cleared={view.cleared} />}
        </div>
      </div>
    </section>
  );
}

const shortExample = (id: string) => id.split(':').slice(1).join(':');

const newFindingsOf = (impact?: ImpactData): PrFindingsView | undefined => (impact as (ImpactData & { newFindings?: PrFindingsView }) | undefined)?.newFindings;

/** Lint findings the pull request's head has and its base did not: certain, so they come first. */
function NewFindingsList({ nf }: { nf: PrFindingsView }) {
  if (!nf.total) {
    return (
      <p className="muted small">
        Docs references: none made wrong ({nf.files} docs and agent files checked at <code>{nf.base.slice(0, 7)}</code> and <code>{nf.head.slice(0, 7)}</code>
        {nf.fixed ? `; ${nf.fixed} fixed` : ''}).
      </p>
    );
  }
  return (
    <div className="predicted" role="region" aria-label="Docs this pull request makes wrong">
      <h3>
        Docs this pull request makes wrong <span className="chip sev breaking">{nf.total}</span>
      </h3>
      <p className="muted small">
        Paths, links, commands and settings the docs, READMEs and AI agent instructions name that were true at <code>{nf.base.slice(0, 7)}</code> and are not after
        this pull request. Read from the repository at both commits; no graph needed.
      </p>
      {findingGroups(nf.findings).map(([title, list]) => (
        <div key={title}>
          <strong className="small">{title}</strong>
          <ul>
            {list.map((f) => (
              <li key={f.fingerprint}>
                {f.evidence?.url ? (
                  <a href={f.evidence.url} target="_blank" rel="noreferrer">
                    <code>
                      {f.path}:{f.line}
                    </code>
                  </a>
                ) : (
                  <code>
                    {f.path}:{f.line}
                  </code>
                )}
                <span className="predicted-why">
                  {f.message} <span className="muted">({f.rule})</span>
                  {f.fix?.verified && <span> Fix: {f.fix.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {nf.total > nf.findings.length && <p className="muted small">{nf.total - nf.findings.length} more in the pull request comment.</p>}
      {nf.fixed > 0 && <p className="muted small">It also fixes {nf.fixed} that were wrong before.</p>}
    </div>
  );
}

/** Examples whose call no longer fits the changed code: known before anything runs. */
function PredictedList({ predicted }: { predicted: PredictedBreak[] }) {
  const examples = new Set(predicted.map((p) => p.example)).size;
  return (
    <div className="predicted" role="region" aria-label="Predicted to break">
      <h3>
        Predicted to break <span className="chip sev breaking">{examples} example{examples === 1 ? '' : 's'}</span>
      </h3>
      <p className="muted small">
        A static check of each call against the code after the pull request: a removed or renamed name, a keyword the new signature lacks, a new required
        argument. Running the example turns the prediction into proof.
      </p>
      <ul>
        {predicted.map((p) => (
          <li key={`${p.example}|${p.line}|${p.detail}`}>
            <a href={p.url} target="_blank" rel="noreferrer">
              <code>{shortExample(p.example)}</code> line {p.line}
            </a>
            <span className="predicted-call">
              <code>{p.call}</code>
            </span>
            <span className="predicted-why">
              {p.detail}
              {p.confidence === 'by-name' && <span className="muted"> (matched by name)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MismatchedList({ mismatched }: { mismatched: KnownMismatch[] }) {
  return (
    <details className="changed mismatched">
      <summary>{mismatched.length} impacted example line(s) already did not fit the code before this pull request</summary>
      <ul>
        {mismatched.map((m) => (
          <li key={`${m.example}|${m.line}|${m.detail}`}>
            <a href={m.url} target="_blank" rel="noreferrer">
              <code>{shortExample(m.example)}</code> line {m.line}
            </a>
            : {m.detail}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Hosted: the repository wasn't in any graph yet, so it was downloaded and indexed first. */
function IndexingPanel({ ix }: { ix: IndexingView }) {
  const f = ix.finished;
  const total = f?.repos.reduce((a, r) => ({ symbols: a.symbols + r.symbols, sections: a.sections + r.sections, examples: a.examples + r.examples }), { symbols: 0, sections: 0, examples: 0 });
  const last = ix.steps.at(-1)?.message;
  const why = ix.reason === 'new' ? 'first check of this repository' : ix.reason === 'stale' ? 'the index was over a week old' : ix.reason === 'added' ? 'a repository was added' : 'refresh';
  return (
    <div className={`indexing${f ? ' done' : ''}`} role="status" aria-live="polite">
      <div className="indexing-head">
        <span className={`indexing-dot${f ? ' done' : ''}`} aria-hidden="true" />
        <strong>{f ? 'Indexed' : 'Indexing'} {ix.repos.join(' + ')}</strong>
        <span className="muted small">
          {' '}
          · {why} · graph <code>{ix.graph}</code>
        </span>
      </div>
      {f && total ? (
        <p className="small">
          {total.symbols.toLocaleString()} code symbols, {total.sections.toLocaleString()} doc sections and {total.examples.toLocaleString()} examples in{' '}
          {(f.ms / 1000).toFixed(1)} s{f.repos.map((r) => ` · ${r.repo}@${r.sha.slice(0, 7)}`).join('')}. Next time this repository is checked straight away.
        </p>
      ) : (
        <p className="small muted">{last ?? 'Downloading the repository…'}</p>
      )}
    </div>
  );
}

/** After a check on someone's own repository: the way to get it on every pull request. */
function InstallNudge({ repo }: { repo: string }) {
  return (
    <a className="install-nudge" href={`#/install?repo=${encodeURIComponent(repo)}`}>
      <Icon name="pr" size={18} />
      <span>
        <strong>Get this on every pull request of {repo}.</strong> The GitHub Action comments on each PR and runs the examples before and after. One click to add.
      </span>
      <Icon name="arrow" size={16} />
    </a>
  );
}

function ChangedList({ view }: { view: CheckView }) {
  if (!view.impact?.changed.length) return null;
  return (
    <details className="changed">
      <summary>
        {view.impact.changed.length} changed symbol(s) in {view.impact.pr.repo}
      </summary>
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
            Open it as a pull request in your fork with <code>npx {PACKAGE} patch {pr} --open-pr</code>. Nothing is opened upstream unless you ask.
          </p>
        </>
      ) : (
        <p className="muted">No edits were proposed.</p>
      )}
    </div>
  );
}

export function StoredCheck({ id, packageRepo }: { id: string; packageRepo: PackageRepo }) {
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
      <a href="#/try" className="back-link">
        ← Back to the live demo
      </a>
      <div className="banner">
        Recorded check from {view.startedAt ? new Date(view.startedAt).toISOString().replace('T', ' ').slice(0, 16) : '?'} UTC, replayed from the trace stored on
        its Check node ({view.model}).
      </div>
      <CheckResults view={view} packageRepo={packageRepo} />
    </>
  );
}
