import { useEffect, useRef, useState } from 'react';
import { streamAudit, type AuditEvent } from './api';
import { PACKAGE, PRODUCT, SITE_URL } from './docs/manifest';
import { CodeBlock, Icon } from './layout';
import { repoFromInput } from './install-links';
import type { AuditData, Health } from './types';

const PICKS = ['pallets/flask', 'encode/httpx', 'psf/requests', 'FalkorDB/falkordb-ts'];

const KIND_LABEL: Record<AuditData['mismatches'][number]['kind'], string> = {
  'unknown-keyword': 'unknown keyword',
  'too-many-arguments': 'too many arguments',
  'missing-argument': 'missing argument',
  'missing-import': 'name does not exist',
  'missing-attribute': 'attribute does not exist',
  removed: 'removed',
};

export function gradeClass(score: number): string {
  return score >= 90 ? 'g-a' : score >= 80 ? 'g-b' : score >= 70 ? 'g-c' : score >= 60 ? 'g-d' : 'g-f';
}

const short = (id: string) => id.split(':').slice(1).join(':');

type State =
  | { phase: 'idle' }
  | { phase: 'running'; repo: string; steps: string[] }
  | { phase: 'done'; repo: string; summary: string; data: Omit<AuditData, 'summary'>; indexedMs?: number }
  | { phase: 'error'; repo?: string; message: string };

export function AuditPage({ initialRepo, health }: { initialRepo?: string; health?: Health }) {
  const [input, setInput] = useState(initialRepo ?? '');
  const [state, setState] = useState<State>({ phase: 'idle' });
  const abort = useRef<AbortController | undefined>(undefined);
  const snapshot = !!health?.snapshot;

  const run = async (repo: string) => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setState({ phase: 'running', repo, steps: [] });
    let indexedMs: number | undefined;
    try {
      await streamAudit(
        repo,
        (e: AuditEvent) => {
          if (ctl.signal.aborted) return;
          if (e.type === 'queued') setState((s) => (s.phase === 'running' ? { ...s, steps: [...s.steps, 'Waiting for another check to finish…'] } : s));
          else if (e.type === 'index_started') setState((s) => (s.phase === 'running' ? { ...s, steps: [...s.steps, `Indexing ${e.repos.join(' + ')} (${e.reason === 'new' ? 'first audit' : 'refresh'})…`] } : s));
          else if (e.type === 'index_progress') setState((s) => (s.phase === 'running' ? { ...s, steps: [...s.steps.slice(-6), e.message] } : s));
          else if (e.type === 'index_finished') indexedMs = e.ms;
          else if (e.type === 'audit') setState({ phase: 'done', repo, summary: e.summary, data: e.data, indexedMs });
          else if (e.type === 'error') setState({ phase: 'error', repo, message: e.message });
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted) setState({ phase: 'error', repo, message: (err as Error).message });
    }
  };

  useEffect(() => {
    if (!initialRepo || !health || snapshot) return;
    const repo = repoFromInput(initialRepo);
    if (!repo) {
      setState({ phase: 'error', message: `"${initialRepo}" is not a GitHub repository (owner/name).` });
      return;
    }
    setInput(repo);
    void run(repo);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRepo, health, snapshot]);

  const submit = (raw: string) => {
    const repo = repoFromInput(raw);
    if (!repo) {
      setState({ phase: 'error', message: 'Enter a GitHub repository as owner/name or its URL.' });
      return;
    }
    if (repo === initialRepo) void run(repo);
    else window.location.hash = `#/audit?repo=${encodeURIComponent(repo)}`;
  };

  const running = state.phase === 'running';
  return (
    <section className="audit wrap page-pad">
      <span className="eyebrow">Docs audit</span>
      <h1>How true are your docs right now?</h1>
      <p className="lede">
        No pull request needed. {PRODUCT} indexes a public Python repository, checks every call in its docs examples against the code they reach — in that
        repository or another — and lists the ones the code no longer accepts, with the line. Then it measures how much of the public API the docs cover.
      </p>
      <div className="demo-card">
        <form
          className="check-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="owner/name or https://github.com/owner/name" aria-label="GitHub repository" spellCheck={false} />
          <button className="btn btn-primary" disabled={running || !input.trim() || snapshot}>
            {running ? 'Auditing…' : 'Audit'}
          </button>
        </form>
        <div className="elsewhere">
          <span className="muted small">Try:</span>
          {PICKS.map((r) => (
            <button key={r} type="button" className="chip-btn" disabled={running || snapshot} onClick={() => submit(r)}>
              {r}
            </button>
          ))}
        </div>
        {snapshot && <p className="note">This deployment shows a snapshot, so it can't audit. Run it yourself: <code>npx -y {PACKAGE} audit owner/name</code>.</p>}
        {state.phase === 'running' && (
          <div className="indexing" role="status" aria-live="polite">
            <div className="indexing-head">
              <span className="indexing-dot" aria-hidden="true" />
              <strong>Auditing {state.repo}</strong>
            </div>
            <p className="small muted">{state.steps.at(-1) ?? 'Looking the repository up…'}</p>
          </div>
        )}
        {state.phase === 'error' && <div className="banner err">{state.message}</div>}
      </div>
      {state.phase === 'done' && <AuditReport repo={state.repo} summary={state.summary} data={state.data} indexedMs={state.indexedMs} />}
    </section>
  );
}

function AuditReport({ repo, summary, data, indexedMs }: { repo: string; summary: string; data: Omit<AuditData, 'summary'>; indexedMs?: number }) {
  // The host serving this page serves the badge too (the canonical domain may not point here yet).
  const site = typeof window !== 'undefined' && /^https?:/.test(window.location.origin) ? window.location.origin : SITE_URL;
  const badge = `[![docs health](${site}/api/badge/${repo}.svg)](${site}/#/audit?repo=${encodeURIComponent(repo)})`;
  const failing = data.runs.filter((r) => r.status === 'fail' || r.status === 'timeout');
  return (
    <div className="audit-report">
      <div className="audit-head">
        <div className={`score ${gradeClass(data.score)}`} aria-label={`Docs health ${data.score} out of 100, grade ${data.grade}`}>
          <span className="score-num">{data.score}</span>
          <span className="score-grade">{data.grade}</span>
        </div>
        <div className="audit-summary">
          <h2>{repo}</h2>
          <p>{summary}</p>
          <p className="muted small">
            {data.repos.map((r) => `${r.name}@${(r.sha ?? '').slice(0, 7)}`).join(' · ')} · graph <code>{data.org}</code>
            {indexedMs !== undefined ? ` · indexed in ${(indexedMs / 1000).toFixed(1)} s` : ''}
          </p>
          {data.deductions.length > 0 && (
            <ul className="deductions">
              {data.deductions.map((d) => (
                <li key={d.why}>
                  <span className="minus">−{d.points}</span> {d.why}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {data.outdatedIndex && (
        <div className="banner">
          This graph was indexed by an earlier {PRODUCT}, before examples were checked against the code: its example checks and API coverage are incomplete
          until the repositories are indexed again (<code>npx -y {PACKAGE} index {data.repos.map((r) => r.name).join(' ')}</code>).
        </div>
      )}
      <h3>
        Examples that no longer fit the code{' '}
        <span className={`chip ${data.examples.mismatched ? 'sev breaking' : 'ok'}`}>
          {data.examples.mismatched} of {data.examples.linked}
        </span>
      </h3>
      {data.mismatches.length === 0 ? (
        <p className="audit-ok">
          <Icon name="check" size={16} /> Every call in the {data.examples.linked} examples that use the code fits the signature it reaches.
        </p>
      ) : (
        <>
          <p className="muted small">Found statically — each call checked against the current source, across repositories — before anything runs.</p>
          <ul className="mismatch-list">
            {data.mismatches.map((m) => (
              <li key={`${m.example}|${m.line}|${m.detail}`}>
                <div className="mm-top">
                  <a href={m.url} target="_blank" rel="noreferrer">
                    <code>{short(m.example)}</code> line {m.line}
                  </a>
                  <span className="chip sev breaking">{KIND_LABEL[m.kind]}</span>
                </div>
                <div className="mm-heading muted small">{m.heading}</div>
                <div className="mm-detail">
                  <code>{m.call}</code> — {m.detail}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {failing.length > 0 && (
        <>
          <h3>Examples that fail when run ({failing.length})</h3>
          <ul className="mismatch-list">
            {failing.map((r) => (
              <li key={r.example}>
                <a href={r.url} target="_blank" rel="noreferrer">
                  <code>{short(r.example)}</code>
                </a>
                <div className="mm-detail">
                  <code>{(r.error || r.reason).slice(0, 200)}</code>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>API coverage</h3>
      <div className="coverage" role="img" aria-label={`${data.coverage.percent}% of public symbols documented`}>
        <div className="coverage-bar" style={{ width: `${Math.min(100, data.coverage.percent)}%` }} />
      </div>
      <p className="small">
        <strong>{data.coverage.percent}%</strong> — {data.coverage.documented} of {data.coverage.api} public symbols (what the packages export) are named or called by a doc.
      </p>
      {data.undocumented.length > 0 && (
        <details className="undocumented">
          <summary>
            {data.coverage.api - data.coverage.documented} undocumented — the {data.undocumented.length} most used
          </summary>
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Kind</th>
                <th>Callers</th>
              </tr>
            </thead>
            <tbody>
              {data.undocumented.map((u) => (
                <tr key={`${u.repo}:${u.qualname}`}>
                  <td>
                    <a href={u.url} target="_blank" rel="noreferrer">
                      <code>{u.qualname}</code>
                    </a>
                  </td>
                  <td>{u.kind}</td>
                  <td>
                    {u.callers}
                    {u.crossRepoCallers ? <span className="muted"> ({u.crossRepoCallers} other repos)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="audit-next">
        <div>
          <h3>Put the score in your README</h3>
          <p className="badge-preview">
            <img src={`/api/badge/${repo}.svg`} alt={`docs health ${data.score} ${data.grade}`} height={20} />
          </p>
          <CodeBlock code={badge} title="README.md" />
        </div>
        <div>
          <h3>Keep it there</h3>
          <p className="small">
            The GitHub Action checks every pull request: which docs it can make false, which examples it breaks (run before and after), and the fix.
          </p>
          <a className="install-nudge" href={`#/install?repo=${encodeURIComponent(repo)}`}>
            <Icon name="pr" size={18} />
            <span>
              <strong>Add {PRODUCT} to {repo}</strong> in one click.
            </span>
            <Icon name="arrow" size={16} />
          </a>
          <CodeBlock code={`$ npx -y ${PACKAGE} audit ${repo} --run 20 --fail-on-mismatch`} title="Locally or in CI (runs the examples too)" />
        </div>
      </div>
    </div>
  );
}
