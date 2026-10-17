import { createConnection, StreamMessageReader, StreamMessageWriter, type Connection } from 'vscode-languageserver/node';
import { createLspServer, type LspServer, type LspServerOptions } from './server.js';

export { createLspServer, COMMANDS, FIX_ALL_KIND, SHOW_REFERENCES, type LspServer, type LspServerOptions, type LspSettings } from './server.js';
export { LspWorkspace, type Fixer, type WorkspaceOptions } from './workspace.js';

export interface StartLspOptions extends LspServerOptions {
  /** Default: this process's stdin and stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Start the Staleproof language server on a pair of streams (stdio by default) and serve
 * until the client exits (or, when the client gave its process id, until that process is
 * gone). Anything printed by code the server runs goes to stderr, never into the protocol
 * stream.
 */
export function startLsp(opts: StartLspOptions = {}): { connection: Connection; server: LspServer } {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  if (output === process.stdout) {
    // stdout carries the protocol: a stray console.log would corrupt it.
    const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
    console.log = toStderr;
    console.info = toStderr;
    console.warn = toStderr;
    console.debug = toStderr;
  }
  const connection = createConnection(new StreamMessageReader(input), new StreamMessageWriter(output));
  // `shutdown` disposes the workspaces (and saves the parse cache); `exit` then ends the process.
  const server = createLspServer(connection, opts);
  connection.listen();
  return { connection, server };
}
