import { useState, type ReactNode } from 'react';
import { PACKAGE, PRODUCT, REPO_URL } from './docs/manifest';

/** Stroke icons (24×24, currentColor), inlined so the page loads no icon font. */
const ICONS: Record<string, ReactNode> = {
  github: (
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  graph: (
    <>
      <circle cx="5" cy="6" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7 7l3.6 9M17 7l-3.6 9M7.2 6h9.6" />
    </>
  ),
  repos: (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="8.5" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 7.5h4M6.5 11v1.5a2 2 0 0 0 2 2M17.5 11v1.5a2 2 0 0 1-2 2" />
    </>
  ),
  play: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7l5.5-3.5z" />
    </>
  ),
  path: (
    <>
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="6" r="2" />
      <path d="M7 18h5a3 3 0 0 0 3-3V9a3 3 0 0 1 3-3h-1" />
    </>
  ),
  memory: (
    <>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
      <path d="M4 5.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6M4 11.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
    </>
  ),
  rank: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  model: (
    <>
      <path d="M12 3l2.1 4.6L19 8.3l-3.6 3.4.9 4.9L12 14.3l-4.3 2.3.9-4.9L5 8.3l4.9-.7z" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M6.5 9l3 3-3 3M12 15h5" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="19" r="2" />
      <path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5" />
    </>
  ),
  plug: <path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" />,
  api: <path d="M8 6 2 12l6 6M16 6l6 6-6 6M14 4l-4 16" />,
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  book: <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5zM4 21.5A2.5 2.5 0 0 1 6.5 19H20v3H6.5" />,
  doc: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M8 13h8M8 17h5" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.2a6.5 6.5 0 0 1 3.5 5.8" />
    </>
  ),
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4M9 13v1.5M15 13v1.5M2 13v3M22 13v3" />
    </>
  ),
  layers: <path d="M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 9v14h6M17 9h6M17 16h6M17 23h6" stroke="var(--brand-ink)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={`copy-btn${done ? ' done' : ''}`}
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={15} />
    </button>
  );
}

/** A shell command or snippet with a copy button; `$` prompts are shown but never copied. */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  const copyText = code
    .split('\n')
    .map((l) => l.replace(/^\$ /, ''))
    .join('\n');
  return (
    <div className="codeblock">
      {(title || lang) && (
        <div className="codeblock-head">
          <span>{title ?? lang}</span>
          <CopyButton text={copyText} />
        </div>
      )}
      <pre>
        <code>{code}</code>
      </pre>
      {!title && !lang && <CopyButton text={copyText} />}
    </div>
  );
}

export const NAV: { href: string; label: string }[] = [
  { href: '#/install', label: 'Install' },
  { href: '#/audit', label: 'Audit' },
  { href: '#/how-it-works', label: 'How it works' },
  { href: '#/use-cases', label: 'Use cases' },
  { href: '#/integrations', label: 'Integrations' },
  { href: '#/docs', label: 'Docs' },
  { href: '#/model', label: 'Graph model' },
];

export function Header({ stats, current }: { stats?: ReactNode; current?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="top">
      <div className="top-inner">
        <a href="#/" className="brand" aria-label={`${PRODUCT} home`}>
          <Logo />
          <span>{PRODUCT}</span>
        </a>
        <nav className={open ? 'open' : ''} aria-label="Main">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className={current && n.href.startsWith(`#/${current}`) ? 'active' : ''} onClick={() => setOpen(false)}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="top-actions">
          {stats}
          <a className="icon-link" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="Source on GitHub">
            <Icon name="github" />
          </a>
          <a className="btn btn-ghost btn-sm hide-sm" href="#/try">
            Try it
          </a>
          <a className="btn btn-primary btn-sm" href="#/install">
            Install
          </a>
          <button type="button" className="menu-btn" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'x' : 'menu'} />
          </button>
        </div>
      </div>
    </header>
  );
}

export function Footer({ meta }: { meta?: ReactNode }) {
  return (
    <footer className="site-footer">
      <div className="footer-grid">
        <div className="footer-brand">
          <a href="#/" className="brand">
            <Logo size={24} />
            <span>{PRODUCT}</span>
          </a>
          <p>Docs that stay true to your code. Open source, MIT licensed, built on FalkorDB.</p>
          <code className="footer-cmd">npx -y {PACKAGE} --help</code>
        </div>
        <div>
          <h4>Product</h4>
          <a href="#/how-it-works">How it works</a>
          <a href="#/use-cases">Use cases</a>
          <a href="#/try">Check a pull request</a>
          <a href="#/audit">Audit a repository</a>
          <a href="#/install">Install</a>
          <a href="#/model">Graph model</a>
        </div>
        <div>
          <h4>Integrate</h4>
          <a href="#/docs/getting-started">Quickstart</a>
          <a href="#/docs/cli">CLI</a>
          <a href="#/docs/github-action">GitHub Action</a>
          <a href="#/docs/mcp">MCP server</a>
          <a href="#/docs/http-api">HTTP API</a>
        </div>
        <div>
          <h4>For LLMs</h4>
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">llms-full.txt</a>
          <a href="/docs/introduction.md">Docs as Markdown</a>
        </div>
        <div>
          <h4>Project</h4>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`https://www.npmjs.com/package/${PACKAGE}`} target="_blank" rel="noreferrer">
            npm
          </a>
          <a href="#/docs/facts">Facts from the graph</a>
          <a href="https://www.falkordb.com" target="_blank" rel="noreferrer">
            FalkorDB
          </a>
        </div>
      </div>
      {meta && <div className="footer-meta">{meta}</div>}
    </footer>
  );
}
