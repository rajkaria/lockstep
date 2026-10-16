import { diffLines } from 'diff';
import { useEffect, useState } from 'react';
import { api } from './api';
import { pathNode, repoClass, repoShort, sevLabel } from './format';
import type { CheckView, TraceItem, Verdict } from './state';
import type { ClearedSymbol, DecisionHit, ImpactedSection, QueryTrace, RunExampleData } from './types';

export type PackageRepo = (qualname: string) => string | undefined;

export function RepoChip({ repo }: { repo: string }) {
  return <span className={`chip repo ${repoClass(repo)}`}>{repoShort(repo)}</span>;
}

/** The evidence path, drawn from the changed symbol to the doc it reaches. */
export function PathView({ evidence, packageRepo }: { evidence: string[]; packageRepo: PackageRepo }) {
  const nodes = evidence.map((n) => pathNode(n, packageRepo));
  return (
    <ol className="path" aria-label="Evidence path from the changed symbol to the doc">
      {nodes.map((n, i) => (
        <li key={i} className={`node ${n.kind} ${n.repo ? repoClass(n.repo) : ''}`} title={n.title}>
          {i > 0 && <span className="edge">{nodes[i]!.kind === 'symbol' ? 'called by' : n.kind === 'example' ? 'used in' : 'named in'}</span>}
          <span className="pill">
            <span className="label">{n.label}</span>
            {n.repo && <span className="repo-tag">{repoShort(n.repo)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function CypherList({ queries, catalogue }: { queries: QueryTrace[]; catalogue?: boolean }) {
  const shown = queries.filter((q) => q.name !== 'adhoc');
  if (!shown.length) return null;
  return (
    <details className="cypher">
      <summary>
        {shown.length} Cypher quer{shown.length === 1 ? 'y' : 'ies'} · {[...new Set(shown.map((q) => q.name))].join(', ')}
      </summary>
      {shown.map((q, i) => (
        <div key={i} className="query">
          <div className="query-meta">
            <code>{q.name}</code>
            {!catalogue && ` · ${q.rows} rows · ${q.ms.toFixed(2)} ms on FalkorDB`}
          </div>
          <pre>{q.cypher}</pre>
        </div>
      ))}
    </details>
  );
}

function inputSummary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([k]) => k !== 'new_text')
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v.replace('https://github.com/', '') : JSON.stringify(v);
      return `${k}: ${s.length > 70 ? `${s.slice(0, 67)}…` : s}`;
    })
    .join('  ');
}

export function TraceList({ view }: { view: CheckView }) {
  return (
    <ol className="trace">
      {view.items.map((it, i) => (
        <TraceRow key={i} item={it} />
      ))}
      {view.live.thinking && <li className="t-thinking live">{view.live.thinking}</li>}
      {view.live.text && <li className="t-text live">{view.live.text}</li>}
      {!view.finished && view.checkId && !view.error && (
        <li className="t-working">
          <span className="spinner" aria-hidden /> working…
        </li>
      )}
    </ol>
  );
}

function TraceRow({ item }: { item: TraceItem }) {
  if (item.kind === 'thinking') return <li className="t-thinking">{item.text}</li>;
  if (item.kind === 'text') return <li className="t-text">{item.text}</li>;
  if (item.kind === 'nudge') return <li className="t-nudge">{item.missing.length} impacted section(s) still had no verdict — Lockstep reminded the model.</li>;
  return (
    <li className={`t-tool ${item.result?.isError ? 'is-error' : ''} ${item.result ? '' : 'pending'}`}>
      <div className="t-call">
        <span className="t-name">{item.name}</span>
        <span className="t-input">{inputSummary(item.input)}</span>
        {item.result && <span className="t-ms">{item.result.ms} ms</span>}
      </div>
      {item.result ? (
        <>
          <div className="t-summary">{item.result.summary}</div>
          <CypherList queries={item.result.queries} />
        </>
      ) : (
        <div className="t-summary muted">
          <span className="spinner" aria-hidden /> running
        </div>
      )}
    </li>
  );
}

const RUN_LABEL: Record<string, string> = {
  breaks: 'Breaks: passes before, fails after',
  fixes: 'Fixed by this PR: fails before, passes after',
  passes: 'Passes before and after',
  'already-broken': 'Fails before and after: already broken',
  'changed-failure': 'Fails before and after, differently',
  fails: 'Fails',
  skipped: 'Not run',
  error: 'Sandbox error',
};

export function RunView({ run }: { run: RunExampleData }) {
  return (
    <div className={`run v-${run.verdict}`}>
      <div className="run-head">
        <span className="run-verdict">{RUN_LABEL[run.verdict] ?? run.verdict}</span>
        <a href={run.url} target="_blank" rel="noreferrer" className="muted">
          example source
        </a>
      </div>
      {run.runs.map((r) => (
        <div key={r.id + r.side} className={`run-side s-${r.status}`}>
          <span className="badge">{r.status}</span>
          <span className="muted">{r.side !== 'current' ? `${r.side} the PR` : 'indexed commit'} · {r.installed.map((i) => i.replace(/@(\w{7})\w+/, '@$1')).join(', ')}</span>
          {r.cached && <span className="muted"> · recorded earlier</span>}
          {r.reason && <div className="run-reason">{r.reason.split('\n')[0]}</div>}
          {r.reason?.includes('\n') && (
            <details className="tb">
              <summary>installer output</summary>
              <pre>{r.reason.split('\n').slice(1).join('\n')}</pre>
            </details>
          )}
          {r.status === 'fail' && r.traceback && (
            <details className="tb">
              <summary>{r.error}</summary>
              <pre>{r.traceback}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before.trim() + '\n', after.trim() + '\n');
  return (
    <pre className="diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? 'add' : p.removed ? 'del' : 'ctx'}>
          {p.value
            .replace(/\n$/, '')
            .split('\n')
            .map((l) => `${p.added ? '+ ' : p.removed ? '- ' : '  '}${l}`)
            .join('\n') + '\n'}
        </span>
      ))}
    </pre>
  );
}

function VerdictView({ id, verdict, body }: { id: string; verdict: Verdict; body?: string }) {
  const [old, setOld] = useState(body);
  useEffect(() => {
    if (verdict.newText && old === undefined) api.section(id).then((s) => setOld(s.body)).catch(() => setOld(''));
  }, [id, verdict.newText, old]);
  return (
    <div className={`verdict v-${verdict.verdict}`}>
      <div className="verdict-head">
        <span className="badge">{verdict.verdict === 'stale' ? 'edit proposed' : verdict.verdict}</span> {verdict.reason}
      </div>
      {verdict.newText && old !== undefined && <DiffView before={old} after={verdict.newText} />}
    </div>
  );
}

function DecisionForm({ section, existing }: { section: string; existing?: DecisionHit[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [state, setState] = useState<{ ok?: string; err?: string; busy?: boolean }>({});
  return (
    <div className="decisions">
      {existing?.map((d) => (
        <div key={d.id} className="decision">
          <span className="badge">decision</span> {d.text} <span className="muted">({d.id}, via {d.via})</span>
        </div>
      ))}
      {!open ? (
        <button className="link" onClick={() => setOpen(true)}>
          Record a maintainer decision for this section
        </button>
      ) : (
        <form
          onSubmit={async (ev) => {
            ev.preventDefault();
            setState({ busy: true });
            try {
              const r = await api.decide(text, [section]);
              setState({ ok: `${r.summary} Agent checks that reach this section read it through decisions_for and can cite it instead of re-flagging.` });
              setText('');
            } catch (err) {
              setState({ err: (err as Error).message });
            }
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="e.g. Keep the sync example; the async client is documented on its own page" />
          <button disabled={state.busy || text.trim().length < 5}>Save</button>
          {state.ok && <div className="ok">{state.ok}</div>}
          {state.err && <div className="err">{state.err}</div>}
        </form>
      )}
    </div>
  );
}

export function SectionCard({ s, view, packageRepo }: { s: ImpactedSection; view: CheckView; packageRepo: PackageRepo }) {
  const verdict = view.verdicts[s.section];
  const runs = s.examples.map((e) => view.runs[e]).filter((r): r is RunExampleData => !!r);
  return (
    <article className={`section sev-${s.severity}`}>
      <header>
        <span className={`chip sev ${s.severity}`}>{sevLabel(s.severity)}</span>
        <a href={s.url} target="_blank" rel="noreferrer" className="heading">
          {s.heading}
        </a>
        <RepoChip repo={s.repo} />
        {s.crossRepo && <span className="chip muted">other repository</span>}
      </header>
      <PathView evidence={s.evidence} packageRepo={packageRepo} />
      <div className="meta muted">
        {s.hops} hop{s.hops === 1 ? '' : 's'} · {s.confidence === 'exact' ? 'every edge resolved through imports and types' : s.confidence === 'late' ? 'linked by name to a symbol the PR removed' : 'includes a by-name edge'}
        {s.changes.map((c) => (
          <div key={c.symbol} className="change">
            <code>{c.change}</code> {c.before && c.after && c.before !== c.after ? (
              <>
                <code className="sig del">{c.before}</code> → <code className="sig add">{c.after}</code>
              </>
            ) : (
              <code className="sig">{c.symbol}</code>
            )}
          </div>
        ))}
      </div>
      {runs.map((r) => (
        <RunView key={r.example} run={r} />
      ))}
      {verdict && <VerdictView id={s.section} verdict={verdict} body={view.bodies[s.section]} />}
      {s.section.includes('#') && <DecisionForm section={s.section} existing={view.decisions[s.section]} />}
    </article>
  );
}

export function ClearedList({ cleared }: { cleared: ClearedSymbol[] }) {
  if (!cleared.length) return null;
  return (
    <section className="cleared">
      <h3>Cleared: no doc within 3 call hops ({cleared.length})</h3>
      <p className="muted">Proof of absence from the graph. Each line has the grep a reader can run to check it.</p>
      <ul>
        {cleared.map((c) => (
          <li key={c.symbol}>
            <code>{c.symbol}</code> <span className="muted">({c.change}; {c.textMatches} raw text matches)</span>
            <div className="grep">
              <code>{c.grep}</code>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
