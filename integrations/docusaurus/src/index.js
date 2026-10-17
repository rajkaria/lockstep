import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export { sourcePath } from './source.js';

/**
 * Staleproof for Docusaurus: a "checked" stamp on every doc. The stamp script comes from the
 * Staleproof server (no cookies, no storage, no referrer); the theme wrapper around
 * `DocItem/Footer` adds `<meta name="staleproof:source">` with the doc's source file and the
 * slot the stamp renders into, and renders it again after client-side navigation.
 */

export const PLUGIN_NAME = 'docusaurus-plugin-staleproof';
const REPO = /^[\w.-]+\/[\w.-]+$/;

/** The nearest folder at or above `start` that holds a `.git`. */
export function repositoryRoot(start) {
  let here = resolve(start);
  for (;;) {
    if (existsSync(join(here, '.git'))) return here;
    const parent = dirname(here);
    if (parent === here) return undefined;
    here = parent;
  }
}

/** The site's folder relative to the repository root (`''` at the root), POSIX. */
export function sitePath(siteDir) {
  const root = repositoryRoot(siteDir) ?? siteDir;
  const rel = relative(root, resolve(siteDir)).split(sep).join('/');
  return rel === '.' ? '' : rel;
}

/** Docusaurus normalises options through this: every plugin instance needs an `id` (`default`). */
export function validateOptions({ options = {} }) {
  const out = { id: 'default', ...options };
  if (out.repo !== undefined && !REPO.test(out.repo)) throw new Error(`${PLUGIN_NAME}: repo must be "owner/name" (got ${JSON.stringify(out.repo)})`);
  if (out.server !== undefined && !/^https?:\/\/[^/\s]+/.test(out.server)) throw new Error(`${PLUGIN_NAME}: server must be an http(s) URL (got ${JSON.stringify(out.server)})`);
  if (out.sitePath !== undefined && typeof out.sitePath !== 'string') throw new Error(`${PLUGIN_NAME}: sitePath must be a string`);
  return out;
}

export default function staleproofPlugin(context, options = {}) {
  const { siteConfig = {}, siteDir } = context;
  const repo = options.repo ?? (siteConfig.organizationName && siteConfig.projectName ? `${siteConfig.organizationName}/${siteConfig.projectName}` : undefined);
  if (!repo || !REPO.test(repo)) throw new Error(`${PLUGIN_NAME}: set the repo option to the GitHub repository, "owner/name"`);
  const server = (options.server ?? 'https://staleproof.dev').replace(/\/+$/, '');
  const prefix = options.sitePath ?? sitePath(siteDir);
  return {
    name: PLUGIN_NAME,
    getThemePath() {
      return join(dirname(fileURLToPath(import.meta.url)), 'theme');
    },
    injectHtmlTags() {
      return {
        postBodyTags: [{ tagName: 'script', attributes: { src: `${server}/api/verified/${repo}/stamp.js`, async: true, referrerpolicy: 'no-referrer' } }],
      };
    },
    async contentLoaded({ actions }) {
      actions.setGlobalData({ repo, prefix });
    },
  };
}
