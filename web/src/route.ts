/**
 * Hash routes: `#/`, `#/use-cases` (a home section), `#/try?pr=<url>` (start a check),
 * `#/check/<id>`, `#/install?repo=<owner/name>`, `#/model`, `#/docs/<slug>/<anchor>`.
 */

/** Sections of the home page that have their own route (`#/use-cases` scrolls there). */
export const HOME_SECTIONS = ['try', 'problem', 'how-it-works', 'use-cases', 'benefits', 'integrations', 'compare', 'for-llms', 'faq'];

export type Route =
  | { page: 'home'; section?: string; pr?: string }
  | { page: 'check'; id: string }
  | { page: 'install'; repo?: string }
  | { page: 'model' }
  | { page: 'docs'; slug?: string; anchor?: string };

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const h = (q >= 0 ? raw.slice(0, q) : raw).replace(/\/$/, '');
  const params = new URLSearchParams(q >= 0 ? raw.slice(q + 1) : '');
  if (h.startsWith('check/')) return { page: 'check', id: decodeURIComponent(h.slice(6)) };
  if (h === 'model') return { page: 'model' };
  if (h === 'install') return { page: 'install', repo: params.get('repo') ?? undefined };
  if (h === 'docs' || h.startsWith('docs/')) {
    const [, slug, ...rest] = h.split('/');
    return { page: 'docs', slug: slug || undefined, anchor: rest.length ? decodeURIComponent(rest.join('/')) : undefined };
  }
  if (HOME_SECTIONS.includes(h)) return { page: 'home', section: h, ...(params.get('pr') ? { pr: params.get('pr')! } : {}) };
  return { page: 'home' };
}
