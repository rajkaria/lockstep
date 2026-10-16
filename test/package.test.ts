import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { testConfig, testGraph } from './helpers.js';

const root = join(import.meta.dirname, '..');

describe('package', () => {
  it('ships every runtime asset the code loads from the package root', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[]; bin: Record<string, string>; dependencies: Record<string, string> };
    for (const f of ['dist', 'web/dist', 'grammars', 'python', 'scripts/falkordb-local.sh']) expect(pkg.files).toContain(f);
    expect(pkg.bin['staleproof']).toBe('dist/cli.js');
    // Runtime imports must be dependencies, not devDependencies.
    for (const dep of ['falkordb', 'web-tree-sitter', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'hono', '@hono/node-server', 'zod', 'commander', 'diff', 'smol-toml']) {
      expect(pkg.dependencies[dep], dep).toBeDefined();
    }
    expect(pkg.dependencies['tree-sitter-python']).toBeUndefined();
  });

  it('serves the built web UI for any non-API route', async () => {
    const web = await mkdtemp(join(tmpdir(), 'staleproof-web-'));
    await writeFile(join(web, 'index.html'), '<div id="root"></div>');
    const { store, done } = await testGraph('pkg');
    try {
      const app = createApp({ store, config: testConfig(), webDir: web });
      const res = await app.request('/check/anything');
      expect(await res.text()).toContain('<div id="root">');
    } finally {
      await done();
    }
  });

  it('serves the docs as plain text for LLMs from the built web UI', async () => {
    const web = await mkdtemp(join(tmpdir(), 'staleproof-web-'));
    await writeFile(join(web, 'index.html'), '<div id="root"></div>');
    await writeFile(join(web, 'llms.txt'), '# Docs\n\n> one line’s summary\n');
    await writeFile(join(web, 'llms-full.txt'), '# Everything\n');
    await mkdir(join(web, 'docs'));
    await writeFile(join(web, 'docs', 'cli.md'), '# CLI\n');
    await writeFile(join(web, 'snapshot.json'), '{"takenAt":"x"}');
    const { store, done } = await testGraph('pkg2');
    try {
      const app = createApp({ store, config: testConfig(), webDir: web });
      const txt = await app.request('/llms.txt');
      expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await txt.text()).toContain('one line’s summary');
      expect(await (await app.request('/llms-full.txt')).text()).toBe('# Everything\n');
      const md = await app.request('/docs/cli.md');
      expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(await md.text()).toBe('# CLI\n');
      const snap = await app.request('/snapshot.json');
      expect(snap.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await snap.json()).toEqual({ takenAt: 'x' });
      // Unknown pages 404; anything that isn't a plain page name falls through to the app, never to the file system.
      expect((await app.request('/docs/nope.md')).status).toBe(404);
      expect(await (await app.request('/docs/..%2Findex.md')).text()).toContain('<div id="root">');
    } finally {
      await done();
    }
  });

  it('prerenders the home page into index.html for readers without JavaScript', async () => {
    const { injectPrerendered } = await import('../scripts/prerender.js');
    // Imported by path at run time: the root tsconfig doesn't compile the web app's JSX.
    const entry = join(root, 'web', 'src', 'prerender.tsx');
    const { renderStatic } = (await import(entry)) as { renderStatic(): string };
    const html = renderStatic();
    for (const text of ['Every merge can make a tutorial lie', 'FalkorDB/falkordb-py#262', 'himport_registry', 'How it works', 'Use cases', '/llms.txt', '#/docs/getting-started']) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/undefined|NaN|\[object Object\]/);
    expect(injectPrerendered('<body><div id="root"></div></body>', '<p>x</p>')).toBe('<body><div id="root"><p>x</p></div></body>');
    expect(() => injectPrerendered('<body></body>', 'x')).toThrow(/no <div id="root"><\/div>/);
  });
});
