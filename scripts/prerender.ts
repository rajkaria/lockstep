/**
 * Writes the home page's static HTML into the built web/dist/index.html, so
 * readers that don't run JavaScript (crawlers, LLM fetchers) get the whole page.
 * The app replaces it on start. Runs after `vite build` (see `npm run build`):
 *
 *   tsx --tsconfig web/tsconfig.json scripts/prerender.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
export const ROOT_MARKER = '<div id="root"></div>';

export function injectPrerendered(html: string, body: string): string {
  if (!html.includes(ROOT_MARKER)) throw new Error(`index.html has no ${ROOT_MARKER} to fill`);
  return html.replace(ROOT_MARKER, `<div id="root">${body}</div>`);
}

async function main(): Promise<void> {
  const entry = pathToFileURL(join(root, 'web', 'src', 'prerender.tsx')).href;
  const { renderStatic } = (await import(entry)) as { renderStatic(): string };
  const file = join(root, 'web', 'dist', 'index.html');
  const html = await readFile(file, 'utf8');
  const body = renderStatic();
  await writeFile(file, injectPrerendered(html, body));
  console.log(`prerendered the home page into web/dist/index.html (${(body.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1]?.endsWith('prerender.ts')) await main();
