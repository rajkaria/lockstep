import { Marked, type Tokens } from 'marked';
import { docByFile, REPO_URL, slugify, type DocEntry } from './manifest';

export { slugify };

export interface TocItem {
  depth: number;
  text: string;
  id: string;
}

export interface RenderedDoc {
  html: string;
  title: string;
  toc: TocItem[];
}


function plain(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Where a link written in docs/<file>.md points on the site: other docs pages
 * become in-app routes, other repository files go to GitHub, anchors stay on
 * the page.
 */
export function resolveDocLink(href: string, current: DocEntry): { href: string; external: boolean } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { href, external: /^https?:/i.test(href) };
  if (href.startsWith('/')) return { href, external: false };
  if (href.startsWith('#')) return { href: `#/docs/${current.slug}/${href.slice(1)}`, external: false };
  const [path = '', anchor] = href.split('#');
  // Resolve against docs/ (where every page lives) into a repository path.
  const parts = ['docs'];
  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  const repoPath = parts.join('/');
  if (repoPath.startsWith('docs/')) {
    const target = docByFile(repoPath.slice(5));
    if (target) return { href: `#/docs/${target.slug}${anchor ? `/${anchor}` : ''}`, external: false };
  }
  return { href: `${REPO_URL}/blob/main/${repoPath}${anchor ? `#${anchor}` : ''}`, external: true };
}

export function renderDoc(markdown: string, doc: DocEntry): RenderedDoc {
  const toc: TocItem[] = [];
  const seen = new Map<string, number>();
  let title = doc.title;
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = slugify(plain(text)) || 'section';
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (depth === 1) title = plain(text);
        if (depth === 2 || depth === 3) toc.push({ depth, text: plain(text), id });
        const anchor = depth > 1 ? `<a class="h-anchor" href="#/docs/${doc.slug}/${id}" aria-label="Link to this section">#</a>` : '';
        return `<h${depth} id="${id}">${inner}${anchor}</h${depth}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { href, title: t, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const r = resolveDocLink(href, doc);
        const attrs = r.external ? ' target="_blank" rel="noreferrer"' : '';
        return `<a href="${escapeHtml(r.href)}"${t ? ` title="${escapeHtml(t)}"` : ''}${attrs}>${inner}</a>`;
      },
      code({ text, lang }: Tokens.Code) {
        const l = (lang ?? '').split(/\s/)[0] ?? '';
        return `<div class="codeblock doc-code"${l ? ` data-lang="${escapeHtml(l)}"` : ''}><pre><code${l ? ` class="language-${escapeHtml(l)}"` : ''}>${escapeHtml(text)}</code></pre></div>\n`;
      },
      table(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: 'th' | 'td') =>
          `<${tag}${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const body = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('');
        return `<div class="table-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(markdown, { async: false }) as string;
  return { html, title, toc };
}

export interface SearchHit {
  doc: DocEntry;
  anchor?: string;
  heading: string;
  snippet: string;
  score: number;
}

/** Full-text search over the docs' Markdown: headings weigh more than body lines. */
export function searchDocs(query: string, sources: { doc: DocEntry; markdown: string }[], limit = 12): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];
  for (const { doc, markdown } of sources) {
    let heading = doc.title;
    let anchor: string | undefined;
    const seen = new Map<string, number>();
    let inCode = false;
    for (const raw of markdown.split('\n')) {
      if (raw.startsWith('```')) inCode = !inCode;
      const h = !inCode && /^(#{1,4})\s+(.*)$/.exec(raw);
      if (h) {
        heading = plain(h[2]!);
        const base = slugify(heading) || 'section';
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        anchor = h[1]!.length > 1 ? (n ? `${base}-${n}` : base) : undefined;
      }
      const line = raw.toLowerCase();
      if (!terms.every((t) => line.includes(t) || heading.toLowerCase().includes(t))) continue;
      if (!terms.some((t) => line.includes(t))) continue;
      const score = (h ? 10 : 1) + (doc.title.toLowerCase().includes(terms[0]!) ? 3 : 0) + (inCode ? -0.5 : 0);
      const text = plain(raw.replace(/^#+\s+/, '').replace(/^[-*|>]\s*/, '')).trim();
      if (!text) continue;
      const i = text.toLowerCase().indexOf(terms[0]!);
      const snippet = text.length > 140 ? `${i > 50 ? '…' : ''}${text.slice(Math.max(0, i - 50), Math.max(0, i - 50) + 140)}…` : text;
      hits.push({ doc, anchor, heading, snippet, score });
    }
  }
  // One hit per section, best first.
  const best = new Map<string, SearchHit>();
  for (const h of hits) {
    const key = `${h.doc.slug}#${h.anchor ?? ''}`;
    const prev = best.get(key);
    if (!prev || h.score > prev.score) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
