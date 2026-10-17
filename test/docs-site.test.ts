import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoLlmsTxt, rulesReference, toolsReference, TOOLS_END, TOOLS_START } from '../scripts/gen-docs.js';
import { MCP_TOOLS } from '../src/mcp/server.js';
import { llmsFiles } from '../web/llms.js';
import { DOCS, slugify } from '../web/src/docs/manifest.js';

const root = join(import.meta.dirname, '..');
const docsDir = join(root, 'docs');

/** Docs files that exist on purpose without a page of their own on the site. */
const UNLISTED = new Set(['FACTS-encode.md']);

async function markdownFiles(): Promise<string[]> {
  return (await readdir(docsDir)).filter((f) => f.endsWith('.md'));
}

/** GitHub-style anchors of every heading in a Markdown file (code blocks skipped, duplicates numbered). */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let inCode = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const h = !inCode && /^#{1,6}\s+(.*)$/.exec(line);
    if (!h) continue;
    const text = h[1]!.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1');
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Markdown links outside code: [text](target). */
function links(markdown: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const prose = line.replace(/`[^`]*`/g, '');
    for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]!);
  }
  return out;
}

describe('the documentation set', () => {
  it('lists every page in docs/ in the manifest, and every manifest page exists', async () => {
    const files = await markdownFiles();
    for (const f of files.filter((x) => !UNLISTED.has(x))) expect(DOCS.map((d) => d.file), `docs/${f} is not in web/src/docs/manifest.ts`).toContain(f);
    for (const d of DOCS) expect(existsSync(join(docsDir, d.file)), d.file).toBe(true);
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
    for (const d of DOCS) expect(d.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('gives every page one H1 and a summary paragraph under it', async () => {
    for (const d of DOCS.filter((x) => !x.generated)) {
      const md = await readFile(join(docsDir, d.file), 'utf8');
      const lines = md.split('\n');
      expect(lines[0], `${d.file} starts with its H1`).toMatch(/^# \S/);
      expect(lines.filter((l) => /^# /.test(l)).length, `${d.file} has one H1`).toBe(1);
      const firstText = lines.slice(1).find((l) => l.trim());
      expect(firstText, `${d.file} opens with a paragraph`).toMatch(/^[A-Za-z*`[]/);
    }
  });

  it('has no broken relative links or anchors in docs/*.md and README.md', async () => {
    const files = [...(await markdownFiles()).map((f) => join(docsDir, f)), join(root, 'README.md')];
    const anchorCache = new Map<string, Set<string>>();
    const anchorsOf = async (file: string) => {
      if (!anchorCache.has(file)) anchorCache.set(file, anchors(await readFile(file, 'utf8')));
      return anchorCache.get(file)!;
    };
    const broken: string[] = [];
    for (const file of files) {
      for (const href of links(await readFile(file, 'utf8'))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
        const [path, anchor] = href.split('#') as [string, string | undefined];
        const target = path ? resolve(dirname(file), path) : file;
        const where = `${relative(root, file)} → ${href}`;
        if (!existsSync(target)) {
          broken.push(`${where} (no such file)`);
          continue;
        }
        if (anchor && target.endsWith('.md') && !(await anchorsOf(target)).has(anchor)) broken.push(`${where} (no such heading)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('docs/tools.md carries every tool the agent and MCP clients get (run `npm run docs` if this fails)', async () => {
    const doc = await readFile(join(docsDir, 'tools.md'), 'utf8');
    const section = doc.slice(doc.indexOf(TOOLS_START), doc.indexOf(TOOLS_END) + TOOLS_END.length);
    expect(section).toBe(toolsReference());
    for (const t of MCP_TOOLS) expect(doc).toContain(`### \`${t.name}\``);
  });

  it('docs/rules.md lists every lint rule from the registry (run `npm run docs` if this fails)', async () => {
    expect(await readFile(join(docsDir, 'rules.md'), 'utf8')).toBe(`${rulesReference()}\n`);
  });

  it('the repository llms.txt is generated from the manifest (run `npm run docs` if this fails)', async () => {
    const txt = await readFile(join(root, 'llms.txt'), 'utf8');
    expect(txt).toBe(repoLlmsTxt());
    for (const d of DOCS) expect(txt).toContain(`](docs/${d.file})`);
  });
});

describe('the docs as plain text for LLMs', () => {
  it('publishes /llms.txt, /llms-full.txt and one Markdown file per page', () => {
    const files = llmsFiles('https://example.test');
    expect(files['llms.txt']).toMatch(/^# \S+\n\n> /);
    for (const d of DOCS) {
      expect(files['llms.txt']).toContain(`(https://example.test/docs/${d.slug}.md)`);
      expect(files[`docs/${d.slug}.md`]?.length).toBeGreaterThan(100);
      expect(files['llms-full.txt']).toContain(`page: ${d.title}`);
    }
    expect(files['llms-full.txt']!.length).toBeGreaterThan(Object.keys(files).filter((f) => f.startsWith('docs/')).length * 100);
    expect(files['robots.txt']).toContain('Sitemap: https://example.test/sitemap.xml');
    for (const d of DOCS) expect(files['sitemap.xml']).toContain(`<loc>https://example.test/docs/${d.slug}.md</loc>`);
  });
});
