import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api, streamCheck } from './api';
import { CheckResults } from './CheckResults';
import type { PackageRepo } from './components';
import { ago, runSummary } from './format';
import { emptyView, reduce, type CheckView } from './state';
import type { CheckRow, Health, PreloadedPr, TraceEvent } from './types';

/** Public pull requests outside the curated graph, to show any repository works (indexed on first use). */
const ELSEWHERE = ['https://github.com/encode/httpx/pull/3571', 'https://github.com/psf/requests/pull/7502'];

/** Check any pull request: paste one (or pick one) and watch the check stream in. */
export function TryIt({ health, packageRepo, initialPr }: { health?: Health; packageRepo: PackageRepo; initialPr?: string }) {
  const [view, dispatch] = useReducer((v: CheckView, e: TraceEvent | { type: 'reset' }) => (e.type === 'reset' ? emptyView() : reduce(v, e)), undefined, emptyView);
  const [prUrl, setPrUrl] = useState('');
  const [mode, setMode] = useState<'agent' | 'graph'>('graph');
  const [withRepos, setWithRepos] = useState('');
  const [showWith, setShowWith] = useState(false);
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

  const start = async (url: string, scrollDelayMs = 50) => {
    setFormError(undefined);
    setPrUrl(url);
    abort.current?.abort();
    abort.current = new AbortController();
    dispatch({ type: 'reset' });
    setRunning(true);
    setTimeout(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), scrollDelayMs);
    try {
      const extra = withRepos
        .split(/[\s,]+/)
        .map((r) => r.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''))
        .filter(Boolean);
      await streamCheck(url, mode, dispatch, abort.current.signal, extra);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFormError((err as Error).message);
    } finally {
      setRunning(false);
      refresh();
    }
  };

  // A link like #/try?pr=<url> (from the install page) starts that check once the server is known.
  const started = useRef(false);
  useEffect(() => {
    if (!initialPr || started.current || !health || health.snapshot) return;
    started.current = true;
    // After the page's own scroll to #try (App scrolls section routes again at 700 ms).
    void start(initialPr, 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPr, health]);

  const agentOff = health && !health.agent.available;
  const snapshot = !!health?.snapshot;
  const hosted = !!health?.hosted?.enabled;
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
            placeholder={hosted ? 'https://github.com/<owner>/<repo>/pull/<number>' : 'https://github.com/FalkorDB/falkordb-py/pull/267'}
            aria-label="Pull request URL"
            spellCheck={false}
          />
          <button className="btn btn-primary" disabled={running || !prUrl.trim() || snapshot}>
            {running ? 'Checking…' : 'Check'}
          </button>
        </form>
        <div className="modes" role="radiogroup" aria-label="Mode">
          <label className={mode === 'graph' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'graph'} onChange={() => setMode('graph')} />
            Graph mode <span className="muted">(seconds, no model)</span>
          </label>
          <label className={mode === 'agent' ? 'on' : ''}>
            <input type="radio" name="mode" checked={mode === 'agent'} disabled={agentOff} onChange={() => setMode('agent')} />
            Agent mode{health?.agent.available ? <code>{health.agent.model}</code> : null} <span className="muted">(judges every section, 1–4 min)</span>
          </label>
          {hosted && (
            <button type="button" className="link small" onClick={() => setShowWith((v) => !v)} aria-expanded={showWith}>
              {showWith ? 'Docs in the same repository' : 'Docs in another repository?'}
            </button>
          )}
        </div>
        {hosted && showWith && (
          <div className="with-repos">
            <label htmlFor="with-repos">Index together with</label>
            <input
              id="with-repos"
              value={withRepos}
              onChange={(e) => setWithRepos(e.target.value)}
              placeholder="your-org/docs"
              spellCheck={false}
              aria-describedby="with-repos-help"
            />
            <span id="with-repos-help" className="muted small">
              Repositories whose docs use this code (a docs site, an SDK). Indexed together so paths across them resolve; up to {health?.hosted?.limits?.maxRepos ?? 4} per
              workspace.
            </span>
          </div>
        )}
        {hosted && (
          <p className="note">
            Works on any public Python repository on GitHub: the first check indexes it, which takes seconds for most projects. Examples run before and after the pull
            request in the <a href="#/install">GitHub Action</a> and the CLI; this server shows the runs recorded for FalkorDB's pull requests. No pull request
            in mind? <a href="#/audit">Audit the whole repository</a>: every example checked against the code, and the API the docs miss.
          </p>
        )}
        {agentOff && !snapshot && (
          <p className="note">
            Agent mode is off on this server: {health.agent.available ? '' : health.agent.reason}. Graph mode runs the real graph queries; agent traces recorded earlier
            are listed below with their dates.
          </p>
        )}
        {formError && <div className="banner err">{formError}</div>}
        {hosted && (
          <div className="elsewhere">
            <span className="muted small">Other projects:</span>
            {ELSEWHERE.map((u) => (
              <button key={u} type="button" className="chip-btn" disabled={running} onClick={() => void start(u)}>
                {u.replace('https://github.com/', '').replace('/pull/', '#')}
              </button>
            ))}
          </div>
        )}
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
