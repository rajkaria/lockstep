/**
 * The documentation as plain text next to the site, for LLMs and tools that
 * don't run JavaScript: /llms.txt (an index, https://llmstxt.org),
 * /llms-full.txt (every page in one file) and /docs/<slug>.md (each page), plus
 * robots.txt and sitemap.xml so crawlers find them.
 * Emitted by the Vite build (vite.config.ts) and served by its dev server.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, llmsFullTxt, llmsTxt, REPO_URL, SITE_URL, type DocEntry } from './src/docs/manifest.js';

const docsDir = fileURLToPath(new URL('../docs', import.meta.url));

export function llmsFiles(site = SITE_URL): Record<string, string> {
  const read = (d: DocEntry) => readFileSync(join(docsDir, d.file), 'utf8');
  const link = (d: DocEntry) => `${site}/docs/${d.slug}.md`;
  const files: Record<string, string> = {
    'llms.txt': llmsTxt(link, [
      { title: 'Everything in one file', url: `${site}/llms-full.txt`, summary: 'all the pages above, concatenated in reading order' },
      { title: 'Source code', url: REPO_URL, summary: 'TypeScript, MIT licensed' },
    ]),
    'llms-full.txt': llmsFullTxt(read, link),
  };
  for (const d of DOCS) files[`docs/${d.slug}.md`] = read(d);
  const urls = ['/', '/llms.txt', '/llms-full.txt', ...DOCS.map((d) => `/docs/${d.slug}.md`)];
  files['sitemap.xml'] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${site}${u}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
  files['robots.txt'] = `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n`;
  return files;
}

export function contentType(path: string): string {
  const type = path.endsWith('.md') ? 'text/markdown' : path.endsWith('.xml') ? 'application/xml' : 'text/plain';
  return `${type}; charset=utf-8`;
}
