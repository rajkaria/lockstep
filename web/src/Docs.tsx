import { useEffect, useMemo, useRef, useState } from 'react';
import { DOC_GROUPS, DOCS, docBySlug, PRODUCT, REPO_URL, type DocEntry } from './docs/manifest';
import { renderDoc, searchDocs, type RenderedDoc, type SearchHit } from './docs/render';
import { CopyButton, Icon } from './layout';

/** docs/*.md, loaded per page (the reference pages are large). */
const SOURCES = import.meta.glob('../../docs/*.md', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

function loadMarkdown(doc: DocEntry): Promise<string> {
  const load = SOURCES[`../../docs/${doc.file}`];
  if (!load) return Promise.reject(new Error(`docs/${doc.file} is not in the build`));
  return load();
}

export function DocsPage({ slug, anchor }: { slug?: string; anchor?: string }) {
  const doc = docBySlug(slug ?? 'introduction');
  const [markdown, setMarkdown] = useState<string>();
  const [error, setError] = useState<string>();
  const article = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!doc) return;
    setMarkdown(undefined);
    setError(undefined);
    loadMarkdown(doc)
      .then(setMarkdown)
      .catch((e: Error) => setError(e.message));
  }, [doc]);

  const rendered: RenderedDoc | undefined = useMemo(() => (doc && markdown !== undefined ? renderDoc(markdown, doc) : undefined), [doc, markdown]);

  useEffect(() => {
    if (rendered) document.title = `${rendered.title} · ${PRODUCT} docs`;
  }, [rendered]);

  // Copy buttons on code blocks, then scroll to the requested heading.
  useEffect(() => {
    const root = article.current;
    if (!root || !rendered) return;
    for (const block of root.querySelectorAll<HTMLDivElement>('.doc-code')) {
      if (block.querySelector('.copy-btn')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.setAttribute('aria-label', 'Copy code');
      btn.title = 'Copy';
      btn.innerHTML = COPY_SVG;
      btn.addEventListener('click', () => {
        const text = block.querySelector('code')?.textContent ?? '';
        void navigator.clipboard?.writeText(text).then(() => {
          btn.classList.add('done');
          btn.innerHTML = CHECK_SVG;
          setTimeout(() => {
            btn.classList.remove('done');
            btn.innerHTML = COPY_SVG;
          }, 1600);
        });
      });
      block.appendChild(btn);
    }
    if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }, [rendered, anchor]);

  if (!doc) {
    return (
      <div className="docs-shell">
        <DocsNav current="" />
        <article className="doc">
          <h1>Page not found</h1>
          <p>
            There is no docs page called <code>{slug}</code>. Start at the <a href="#/docs/introduction">introduction</a>.
          </p>
        </article>
      </div>
    );
  }

  const i = DOCS.indexOf(doc);
  const prev = DOCS[i - 1];
  const next = DOCS[i + 1];
  return (
    <div className="docs-shell">
      <DocsNav current={doc.slug} />
      <article className="doc">
        <div className="doc-toolbar">
          <span className="crumb">
            Docs <span aria-hidden="true">/</span> {doc.group}
          </span>
          <div className="doc-actions">
            {markdown !== undefined && (
              <span className="copy-md">
                <CopyButton text={markdown} label="Copy page as Markdown" /> Copy as Markdown
              </span>
            )}
            <a href={`/docs/${doc.slug}.md`} target="_blank" rel="noreferrer">
              <Icon name="doc" size={15} /> View .md
            </a>
            {doc.generated ? (
              <span className="muted small" title="Regenerate it from the code or the graph; never edit by hand">
                Generated
              </span>
            ) : (
              <a href={`${REPO_URL}/edit/main/docs/${doc.file}`} target="_blank" rel="noreferrer">
                <Icon name="github" size={15} /> Edit
              </a>
            )}
          </div>
        </div>
        {error && <div className="banner err">{error}</div>}
        {!rendered && !error && <p className="muted">Loading…</p>}
        {rendered && <div ref={article} className="prose" dangerouslySetInnerHTML={{ __html: rendered.html }} />}
        <nav className="doc-pager" aria-label="Previous and next page">
          {prev ? (
            <a href={`#/docs/${prev.slug}`} className="prev">
              <span className="muted small">Previous</span>
              {prev.title}
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a href={`#/docs/${next.slug}`} className="next">
              <span className="muted small">Next</span>
              {next.title}
            </a>
          )}
        </nav>
      </article>
      <aside className="doc-toc" aria-label="On this page">
        {rendered && rendered.toc.length > 1 && (
          <>
            <h4>On this page</h4>
            <ul>
              {rendered.toc.map((t) => (
                <li key={t.id} className={`d${t.depth}${t.id === anchor ? ' on' : ''}`}>
                  <a href={`#/docs/${doc.slug}/${t.id}`}>{t.text}</a>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="toc-llm">
          <h4>For LLMs</h4>
          <a href="/llms.txt">llms.txt</a>
          <a href="/llms-full.txt">llms-full.txt</a>
          <a href={`/docs/${doc.slug}.md`}>This page as Markdown</a>
        </div>
      </aside>
    </div>
  );
}

function DocsNav({ current }: { current: string }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>();
  const [all, setAll] = useState<{ doc: DocEntry; markdown: string }[]>();

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits(undefined);
      return;
    }
    let cancelled = false;
    const sources = all
      ? Promise.resolve(all)
      : Promise.all(DOCS.map(async (doc) => ({ doc, markdown: await loadMarkdown(doc).catch(() => '') }))).then((s) => {
          setAll(s);
          return s;
        });
    void sources.then((s) => {
      if (!cancelled) setHits(searchDocs(query, s));
    });
    return () => {
      cancelled = true;
    };
  }, [query, all]);

  return (
    <nav className="docs-nav" aria-label="Documentation">
      <div className="docs-search">
        <Icon name="eye" size={15} />
        <input type="search" placeholder="Search the docs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the docs" />
      </div>
      {hits && (
        <div className="search-results" role="region" aria-live="polite">
          {hits.length === 0 && <p className="muted small">No matches.</p>}
          {hits.map((h, i) => (
            <a key={i} href={`#/docs/${h.doc.slug}${h.anchor ? `/${h.anchor}` : ''}`} onClick={() => setQuery('')}>
              <strong>{h.heading}</strong>
              <span className="muted small">{h.doc.title}</span>
              <span className="snippet">{h.snippet}</span>
            </a>
          ))}
        </div>
      )}
      <select className="docs-select" value={current} onChange={(e) => (window.location.hash = `#/docs/${e.target.value}`)} aria-label="Docs page">
        {DOC_GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {DOCS.filter((d) => d.group === g).map((d) => (
              <option key={d.slug} value={d.slug}>
                {d.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <div className="docs-groups">
        {DOC_GROUPS.map((g) => (
          <div key={g}>
            <h4>{g}</h4>
            {DOCS.filter((d) => d.group === g).map((d) => (
              <a key={d.slug} href={`#/docs/${d.slug}`} className={d.slug === current ? 'on' : ''} title={d.summary}>
                {d.title}
              </a>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

const COPY_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
const CHECK_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
