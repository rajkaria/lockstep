import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTextEdits } from '../src/lint/fixes.js';
import { LspWorkspace } from '../src/lsp/workspace.js';
import { fixtureRepo, LSP_FIXTURES } from './lsp-harness.js';

/** The quick fixes come from `addFixes` (src/lint/fixes.ts), verified against the buffer when it has unsaved edits. */
describe('quick fixes from addFixes', () => {
  let dir: string;
  let ws: LspWorkspace;
  let disk: string;
  const path = 'pkg/client.py';

  beforeAll(async () => {
    dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    ws = new LspWorkspace({ root: dir, cache: false });
    disk = await readFile(join(dir, path), 'utf8');
    await ws.setText(path, 'file:///client.py', 1, disk);
    await ws.fixesSettled();
  });

  afterAll(() => ws.dispose());

  it('offer the verified fix of a finding in a saved file', async () => {
    const [f] = (await ws.check(path)).findings;
    expect(f).toMatchObject({ rule: 'docstring-param-unknown', subject: 'Client.query(parameters)' });
    const fix = (await ws.fixFor(path, f!))!;
    expect(fix.verified).toBe(true);
    expect(fix.edits).toEqual([{ path, line: 16, column: 13, endLine: 16, endColumn: 23, newText: 'params' }]);
    expect(applyTextEdits(disk, fix.edits)).toContain('            params: Query parameters.');
  });

  it('move it under unsaved edits above, and check it against the buffer', async () => {
    const edited = disk.replace('import os\n', 'import os\nimport sys\n\n');
    await ws.setText(path, 'file:///client.py', 2, edited);
    const [f] = (await ws.check(path)).findings;
    expect(f!.line).toBe(18);
    const fix = (await ws.fixFor(path, f!))!;
    expect(fix.edits).toEqual([{ path, line: 18, column: 13, endLine: 18, endColumn: 23, newText: 'params' }]);
    const all = (await ws.fixAll(path))!;
    expect(all.applied).toEqual([fix.description]);
    expect(all.text).toBe(applyTextEdits(edited, fix.edits));
  });

  it('withhold it when the buffer changed the text it would replace', async () => {
    const edited = disk.replace('            parameters: Query parameters.', '            parameters: The query parameters, by name.');
    await ws.setText(path, 'file:///client.py', 3, edited);
    const [f] = (await ws.check(path)).findings;
    expect(f!.rule).toBe('docstring-param-unknown');
    expect(await ws.fixFor(path, f!)).toBeUndefined();
  });
});
