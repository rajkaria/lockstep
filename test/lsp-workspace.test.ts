import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LspWorkspace } from '../src/lsp/workspace.js';
import { fixtureRepo, LSP_FIXTURES } from './lsp-harness.js';

/** The workspace model behind the server: unsaved buffers of files that are not docs pages. */
describe('LspWorkspace: unsaved manifests', () => {
  let dir: string;
  let ws: LspWorkspace;
  const read = (p: string) => readFile(join(dir, p), 'utf8');

  beforeAll(async () => {
    dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    ws = new LspWorkspace({ root: dir, cache: false, renameBase: false, fixer: async (r) => r });
  });
  afterAll(() => ws.dispose());

  it('re-check the open docs pages when a Makefile buffer renames a target, before it is saved', async () => {
    await ws.setText('AGENTS.md', 'file:///AGENTS.md', 1, await read('AGENTS.md'));
    expect((await ws.check('AGENTS.md')).findings.map((f) => f.rule)).toEqual(['path-missing']);
    const makefile = await read('Makefile');
    await ws.setText('Makefile', 'file:///Makefile', 1, makefile);
    const affected = await ws.setText('Makefile', 'file:///Makefile', 2, makefile.replace('check:', 'verify:'));
    expect(affected).toEqual(['Makefile', 'AGENTS.md']);
    const now = (await ws.check('AGENTS.md')).findings;
    expect(now.map((f) => `${f.rule} ${f.subject}`).sort()).toEqual(['command-missing make check', 'path-missing pkg/settings.py']);
    // Closing the Makefile without saving: the docs read the file on disk again.
    expect(ws.close('Makefile')).toEqual(['AGENTS.md']);
    expect((await ws.check('AGENTS.md')).findings.map((f) => f.rule)).toEqual(['path-missing']);
  });

  it('keep the snapshot for a file whose buffer is the file on disk', async () => {
    const text = await read('README.md');
    await ws.setText('README.md', 'file:///README.md', 1, text);
    const r = await ws.check('README.md');
    expect(r.findings).toEqual(ws.snapshotFindings('README.md'));
    expect(r.envStale).toBe(false);
  });
});

describe('file changes the server re-lints for', () => {
  it('ignore dependencies, builds, git internals and the parse cache, inside the workspace only', async () => {
    const { relevantChange } = await import('../src/lsp/server.js');
    const { pathToUri } = await import('../src/lsp/convert.js');
    const roots = ['/w/build/repo'];
    const u = (p: string) => pathToUri(p);
    expect(relevantChange(u('/w/build/repo/README.md'), roots)).toBe(true);
    expect(relevantChange(u('/w/build/repo/docs/a.md'), roots)).toBe(true);
    for (const p of ['node_modules/x/README.md', '.git/index', '.staleproof/cache/.gitignore', 'dist/cli.js', 'pkg/__pycache__/a.py']) {
      expect(relevantChange(u(`/w/build/repo/${p}`), roots), p).toBe(false);
    }
    expect(relevantChange(u('/elsewhere/README.md'), roots)).toBe(false);
  });
});
