import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, streamCheck } from './api';
import { CheckResults } from './CheckResults';
import type { PackageRepo } from './components';
import { ago, runSummary } from './format';
import { emptyView, reduce, type CheckView } from './state';
import type { CheckRow, Health, PreloadedPr, TraceEvent } from './types';

/** The live demo: paste a pull request (or pick a preloaded one) and watch the check stream in. */
export function TryIt({ health, packageRepo }: { health?: Health; packageRepo: PackageRepo }) {
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
  const snapshot = !!health?.snapshot;
  return (
    <div className="tryit">
      <div className="demo-card">
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
          <button className="btn btn-primary" disabled={running || !prUrl.trim() || snapshot}>
            {running ? 'Checking…' : 'Check'}
          </button>
        </form>
        <div className="modes" role="radiogroup" aria-label="Mode">
          <label className={mode === 'agent' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'agent'} disabled={agentOff} onChange={() => setMode('agent')} />
            Agent mode{health?.agent.available ? <code>{health.agent.model}</code> : null}
          </label>
          <label className={mode === 'graph' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'graph'} onChange={() => setMode('graph')} />
            Graph mode <span className="muted">(no model)</span>
          </label>
        </div>
        {agentOff && !snapshot && (
          <p className="note">
            Agent mode is off on this server: {health.agent.available ? '' : health.agent.reason}. Graph mode runs the real graph queries and example runs; agent traces
            recorded earlier are listed below with their dates.
          </p>
        )}
        {formError && <div className="banner err">{formError}</div>}
        <div className="preloaded">
          {prs.map((p) => (
            <button
              key={p.url}
              type="button"
              className="pr-card"
              disabled={running || (snapshot && !p.latestCheck)}
              onClick={() => (snapshot && p.latestCheck ? (window.location.hash = `#/check/${encodeURIComponent(p.latestCheck.id)}`) : void start(p.url))}
            >
              <span className="pr-ref">
                {p.ref.fullName}#{p.ref.number}
              </span>
              <span className="pr-title">{p.title ?? 'not checked yet'}</span>
              {p.runs.length > 0 && <span className="pr-runs">{runSummary(p.runs)}</span>}
              <span className="pr-foot">
                {p.latestCheck ? <span className="muted small">last checked {ago(p.latestCheck.startedAt)}</span> : <span />}
                <span className="pr-go">{snapshot ? 'Replay' : 'Check'} →</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div ref={results}>{(view.checkId || view.error || view.queued) && <CheckResults view={view} packageRepo={packageRepo} />}</div>

      <RecentChecks checks={checks} />
    </div>
  );
}

/** Stored checks, finished ones first; failed or unfinished attempts are folded away but kept. */
function RecentChecks({ checks }: { checks: CheckRow[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!checks.length) return null;
  const done = checks.filter((c) => c.status === 'done');
  const other = checks.filter((c) => c.status !== 'done');
  const shown = showAll ? [...done, ...other] : done;
  return (
    <div className="history">
      <h3>Recent checks</h3>
      <p className="muted small">Every check is stored on a Check node in the graph with its full trace. Open one to replay it exactly as it ran.</p>
      <ul>
        {shown.map((c) => (
          <li key={c.id}>
            <span className={`status-dot st-${c.status}`} title={c.status} />
            <a href={`#/check/${encodeURIComponent(c.id)}`}>{c.title ?? c.pr}</a>
            <span className="muted">
              {' '}
              · {c.model}
              {c.status !== 'done' ? ` · ${c.status}` : ''} · {c.toolCalls} tool calls{c.verdicts ? ` · ${c.verdicts} verdicts` : ''} · {ago(c.startedAt)}
            </span>
          </li>
        ))}
      </ul>
      {other.length > 0 && (
        <button type="button" className="link small" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'Hide' : 'Show'} {other.length} unfinished or failed attempt{other.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}
