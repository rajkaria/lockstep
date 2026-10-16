/** Hash routes: `#/`, `#/use-cases` (a home section), `#/check/<id>`, `#/model`, `#/docs/<slug>/<anchor>`. */

/** Sections of the home page that have their own route (`#/use-cases` scrolls there). */
export const HOME_SECTIONS = ['try', 'problem', 'how-it-works', 'use-cases', 'benefits', 'integrations', 'compare', 'for-llms', 'faq'];

export type Route =
  | { page: 'home'; section?: string }
  | { page: 'check'; id: string }
  | { page: 'model' }
  | { page: 'docs'; slug?: string; anchor?: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (h.startsWith('check/')) return { page: 'check', id: decodeURIComponent(h.slice(6)) };
  if (h === 'model') return { page: 'model' };
  if (h === 'docs' || h.startsWith('docs/')) {
    const [, slug, ...rest] = h.split('/');
    return { page: 'docs', slug: slug || undefined, anchor: rest.length ? decodeURIComponent(rest.join('/')) : undefined };
  }
  if (HOME_SECTIONS.includes(h)) return { page: 'home', section: h };
  return { page: 'home' };
}
