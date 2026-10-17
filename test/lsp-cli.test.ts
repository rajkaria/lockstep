import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProtocolConnection, InitializedNotification, InitializeRequest, StreamMessageReader, StreamMessageWriter, type PublishDiagnosticsParams } from 'vscode-languageserver/node';
import { pathToUri } from '../src/lsp/convert.js';
import { fixtureRepo, LSP_FIXTURES } from './lsp-harness.js';

// `staleproof lsp` through src/cli.ts.
const ROOT = join(import.meta.dirname, '..');

describe('staleproof lsp (CLI)', () => {
  it('speaks LSP on stdio, accepts the --stdio flag editors pass, and exits 0 after shutdown + exit', async () => {
    const dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'lsp', '--stdio', '--clientProcessId=1'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STALEPROOF_CACHE: 'off' } });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const client = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    const diagnostics = new Promise<PublishDiagnosticsParams>((resolve) => client.onNotification('textDocument/publishDiagnostics', resolve));
    client.listen();
    const init = await client.sendRequest(InitializeRequest.type, { processId: process.pid, rootUri: pathToUri(dir), capabilities: {}, workspaceFolders: null });
    expect(init.serverInfo).toMatchObject({ name: 'staleproof' });
    expect(init.capabilities.codeActionProvider).toBeTruthy();
    await client.sendNotification(InitializedNotification.type, {});
    const uri = pathToUri(join(dir, 'README.md'));
    const text = '# pkg\n\nSee [the guide](docs/guide.md#nowhere).\n';
    await client.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: 'markdown', version: 1, text } });
    expect((await diagnostics).diagnostics.map((d) => d.code)).toEqual(['anchor-missing']);
    await client.sendRequest('shutdown');
    await client.sendNotification('exit');
    expect(await exited).toBe(0);
    client.dispose();
  }, 60_000);
});
