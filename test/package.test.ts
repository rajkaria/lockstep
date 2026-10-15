import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    expect(pkg.bin['lockstep-docs']).toBe('dist/cli.js');
    // Runtime imports must be dependencies, not devDependencies.
    for (const dep of ['falkordb', 'web-tree-sitter', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'hono', '@hono/node-server', 'zod', 'commander', 'diff', 'smol-toml']) {
      expect(pkg.dependencies[dep], dep).toBeDefined();
    }
    expect(pkg.dependencies['tree-sitter-python']).toBeUndefined();
  });

  it('serves the built web UI for any non-API route', async () => {
    const web = await mkdtemp(join(tmpdir(), 'lockstep-web-'));
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
});
