import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProtocolConnection, InitializedNotification, InitializeRequest, StreamMessageReader, StreamMessageWriter, type PublishDiagnosticsParams } from 'vscode-languageserver/node';
import { pathToUri } from '../src/lsp/convert.js';
import { fixtureRepo, LSP_FIXTURES } from './lsp-harness.js';

const ROOT = join(import.meta.dirname, '..');

describe('startLsp over stdio', () => {
  it('serves a client on stdin/stdout, keeps stray output off stdout, and exits 0 after shutdown + exit', async () => {
    const dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    // What `staleproof lsp` runs, plus a console.log that must not reach the protocol stream.
    const entry = "import { startLsp } from './src/lsp/index.ts'; startLsp(); console.log('stray output');";
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', entry], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STALEPROOF_CACHE: 'off' } });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const client = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const diagnostics = new Promise<PublishDiagnosticsParams>((resolve) => client.onNotification('textDocument/publishDiagnostics', resolve));
    client.listen();
    const init = await client.sendRequest(InitializeRequest.type, { processId: process.pid, rootUri: pathToUri(dir), capabilities: {}, workspaceFolders: null });
    expect(init.serverInfo?.name).toBe('staleproof');
    await client.sendNotification(InitializedNotification.type, {});
    const uri = pathToUri(join(dir, 'AGENTS.md'));
    const text = '# Agent notes\n\n- Settings are in `pkg/settings.py`.\n';
    await client.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'markdown', version: 1, text } });
    const d = await diagnostics;
    expect(d.uri).toBe(uri);
    expect(d.diagnostics.map((x) => x.code)).toEqual(['path-missing']);
    await client.sendRequest('shutdown');
    await client.sendNotification('exit');
    expect(await exited).toBe(0);
    expect(stderr).toContain('stray output');
    client.dispose();
  }, 60_000);
});
