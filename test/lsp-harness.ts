import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  createConnection,
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ClientCapabilities,
  type Diagnostic,
  type ProtocolConnection,
  type PublishDiagnosticsParams,
} from 'vscode-languageserver/node';
import { createLspServer, type LspServer, type LspServerOptions } from '../src/lsp/server.js';
import { pathToUri } from '../src/lsp/convert.js';

/** Test helpers for the language server: fixture checkouts and an in-process client. */

export const LSP_FIXTURES = join(import.meta.dirname, 'fixtures', 'lsp');

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A fixture copied into a temporary git checkout (one commit), `gitignore.txt` as its `.gitignore`. */
export async function fixtureRepo(src: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-lsp-'));
  await cp(src, dir, { recursive: true });
  if (existsSync(join(dir, 'gitignore.txt'))) await rename(join(dir, 'gitignore.txt'), join(dir, '.gitignore'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export const CLIENT_CAPABILITIES: ClientCapabilities = {
  workspace: { workspaceEdit: { documentChanges: true }, applyEdit: true, codeLens: { refreshSupport: false } },
  window: { showDocument: { support: true } },
  textDocument: { publishDiagnostics: { versionSupport: true } },
};

export interface TestClient {
  client: ProtocolConnection;
  server: LspServer;
  /** Every publishDiagnostics, in order. */
  published: PublishDiagnosticsParams[];
  /** Server → client requests and notifications other than diagnostics. */
  requests: { method: string; params: unknown }[];
  /** Resolve with the first diagnostics for `uri` (published after now) that satisfy `ok`. */
  diagnostics(uri: string, ok?: (d: Diagnostic[]) => boolean, timeoutMs?: number): Promise<Diagnostic[]>;
  uri(dir: string, path: string): string;
  close(): Promise<void>;
}

/** A client and the Staleproof server connected in memory (no process, no stdio). */
export function connect(opts: LspServerOptions = {}): TestClient {
  const up = new PassThrough();
  const down = new PassThrough();
  const serverConnection = createConnection(new StreamMessageReader(up), new StreamMessageWriter(down));
  const server = createLspServer(serverConnection, { debounceMs: 30, ...opts });
  serverConnection.listen();
  const client = createProtocolConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
  const published: PublishDiagnosticsParams[] = [];
  const requests: { method: string; params: unknown }[] = [];
  const waiters = new Set<{ uri: string; ok: (d: Diagnostic[]) => boolean; resolve: (d: Diagnostic[]) => void }>();
  client.onNotification('textDocument/publishDiagnostics', (p: PublishDiagnosticsParams) => {
    published.push(p);
    for (const w of [...waiters]) {
      if (w.uri === p.uri && w.ok(p.diagnostics)) {
        waiters.delete(w);
        w.resolve(p.diagnostics);
      }
    }
  });
  for (const method of ['window/showMessage', 'window/logMessage', '$/progress']) {
    client.onNotification(method, (params: unknown) => void requests.push({ method, params }));
  }
  const answers: Record<string, unknown> = {
    'workspace/applyEdit': { applied: true },
    'window/showMessageRequest': null,
    'window/showDocument': { success: true },
    'workspace/configuration': [null],
    'client/registerCapability': null,
    'window/workDoneProgress/create': null,
    'workspace/codeLens/refresh': null,
  };
  for (const [method, answer] of Object.entries(answers)) {
    client.onRequest(method, (params: unknown) => {
      requests.push({ method, params });
      return answer;
    });
  }
  client.listen();
  return {
    client,
    server,
    published,
    requests,
    diagnostics(uri, ok = () => true, timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        const w = { uri, ok, resolve };
        waiters.add(w);
        setTimeout(() => {
          if (waiters.delete(w)) reject(new Error(`no matching diagnostics for ${uri} within ${timeoutMs} ms`));
        }, timeoutMs).unref();
      });
    },
    uri: (dir, path) => pathToUri(join(dir, ...path.split('/'))),
    async close() {
      await client.sendRequest('shutdown').catch(() => {});
      client.dispose();
      serverConnection.dispose();
      await server.dispose();
    },
  };
}
