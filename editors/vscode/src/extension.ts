import * as vscode from 'vscode';
import {
  ExecuteCommandRequest,
  LanguageClient,
  State,
  TransportKind,
  type LanguageClientOptions,
  type Location,
  type Position,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { resolveServer, STALEPROOF_VERSION, type ServerCommand } from './resolve.js';

/**
 * The Staleproof extension: starts `staleproof lsp` (the workspace's install, a global one,
 * or `npx -y staleproof@<version>`) and adds two commands. Everything else (diagnostics,
 * quick fixes, hover, go to definition, references, code lenses) comes from the language
 * server, so Cursor, Windsurf and other VS Code builds get the same features. Nothing
 * leaves the machine: the server reads the files, git and its local cache.
 */

/** Docs pages, agent files, code with docstrings, and the manifests docs commands name. */
const DOCUMENTS: { scheme: 'file'; language?: string; pattern?: string }[] = [
  { scheme: 'file', language: 'markdown' },
  { scheme: 'file', language: 'mdx' },
  { scheme: 'file', language: 'restructuredtext' },
  { scheme: 'file', pattern: '**/*.{md,mdx,mdc,markdown,rst}' },
  { scheme: 'file', pattern: '**/{.cursorrules,.windsurfrules,.clinerules}' },
  { scheme: 'file', language: 'python' },
  { scheme: 'file', language: 'typescript' },
  { scheme: 'file', language: 'typescriptreact' },
  { scheme: 'file', language: 'javascript' },
  { scheme: 'file', language: 'javascriptreact' },
  { scheme: 'file', language: 'go' },
  { scheme: 'file', pattern: '**/{package.json,pyproject.toml,Makefile,makefile,GNUmakefile,justfile,Justfile,Taskfile.yml,Taskfile.yaml,.env.example,.env.sample,.env.template}' },
];

let client: LanguageClient | undefined;
let output: vscode.LogOutputChannel;
let status: vscode.LanguageStatusItem;
let busy: Promise<void> = Promise.resolve();

const config = () => vscode.workspace.getConfiguration('staleproof');

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Staleproof', { log: true });
  status = vscode.languages.createLanguageStatusItem('staleproof', DOCUMENTS);
  status.name = 'Staleproof';
  status.command = { title: 'Show output', command: 'staleproof.showOutput' };
  context.subscriptions.push(
    output,
    status,
    vscode.commands.registerCommand('staleproof.fixAllInFile', fixAllInFile),
    vscode.commands.registerCommand('staleproof.auditWorkspace', auditWorkspace),
    vscode.commands.registerCommand('staleproof.restart', () => restart()),
    vscode.commands.registerCommand('staleproof.showOutput', () => output.show(true)),
    // Code lenses ask the editor to peek at the docs that reference a definition.
    vscode.commands.registerCommand('staleproof.showReferences', showReferences),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('staleproof.enable') || e.affectsConfiguration('staleproof.path')) void restart();
    }),
  );
  await restart();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

/** Stop the server if it runs, and start it again when enabled (one at a time). */
function restart(): Promise<void> {
  busy = busy.then(async () => {
    if (client) {
      await client.stop().catch(() => undefined);
      client = undefined;
    }
    if (!config().get<boolean>('enable', true)) {
      status.text = 'Staleproof off';
      status.detail = 'staleproof.enable is false';
      status.severity = vscode.LanguageStatusSeverity.Information;
      return;
    }
    await start();
  });
  return busy;
}

async function start(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  status.text = 'Staleproof';
  status.detail = 'starting';
  status.busy = true;
  let server: ServerCommand;
  try {
    server = await resolveServer({ configured: config().get<string>('path'), folders });
  } catch (err) {
    return failed(`Staleproof: could not find the staleproof command: ${(err as Error).message}`);
  }
  const how = server.source === 'npx' ? `npx -y staleproof@${STALEPROOF_VERSION}` : `${server.command}${server.version ? ` ${server.version}` : ''} (${server.source})`;
  output.info(`Starting the language server: ${how}`);
  const serverOptions: ServerOptions = {
    command: server.shell && /\s/.test(server.command) ? `"${server.command}"` : server.command,
    args: [...server.args, 'lsp'],
    transport: TransportKind.stdio,
    options: { cwd: folders[0], shell: server.shell, env: process.env },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENTS,
    outputChannel: output,
    synchronize: { configurationSection: 'staleproof' },
    initializationOptions: {
      clientCommands: ['staleproof.showReferences'],
      settings: { enable: config().get<boolean>('enable', true), codeLens: config().get<boolean>('codeLens', true) },
    },
    markdown: { isTrusted: false, supportHtml: false },
  };
  const c = new LanguageClient('staleproof', 'Staleproof', serverOptions, clientOptions);
  c.onDidChangeState((e) => {
    if (e.newState === State.Stopped && client === c) {
      status.severity = vscode.LanguageStatusSeverity.Error;
      status.detail = 'stopped (see the output)';
      status.busy = false;
    }
  });
  try {
    await c.start();
  } catch (err) {
    await c.stop().catch(() => undefined);
    return failed(
      `Staleproof: the language server did not start (${(err as Error).message}). ` +
        'Install Node.js 20 or later, add staleproof to the project (npm i -D staleproof), or set staleproof.path.',
    );
  }
  client = c;
  status.busy = false;
  status.severity = vscode.LanguageStatusSeverity.Information;
  status.detail = server.source === 'npx' ? `npx staleproof@${STALEPROOF_VERSION}` : `${server.version ?? ''} ${server.source}`.trim();
}

function failed(message: string): void {
  output.error(message);
  status.busy = false;
  status.severity = vscode.LanguageStatusSeverity.Error;
  status.detail = 'not running';
  void vscode.window.showErrorMessage(message, 'Show output').then((pick) => pick && output.show(true));
}

async function fixAllInFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !client) return;
  const r = (await client.sendRequest(ExecuteCommandRequest.type, {
    command: 'staleproof.fixAll',
    arguments: [client.code2ProtocolConverter.asUri(editor.document.uri)],
  })) as { applied: number } | null;
  if (r?.applied) vscode.window.setStatusBarMessage(`Staleproof: applied ${r.applied} fix${r.applied === 1 ? '' : 'es'}`, 5000);
}

async function auditWorkspace(): Promise<void> {
  const c = client;
  if (!c) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Staleproof: checking every docs page in the workspace' }, () =>
    c.sendRequest(ExecuteCommandRequest.type, { command: 'staleproof.audit', arguments: [] }),
  );
  await vscode.commands.executeCommand('workbench.actions.view.problems');
}

async function showReferences(uri: string, position: Position, locations: Location[]): Promise<void> {
  const c = client;
  if (!c) return;
  const p2c = c.protocol2CodeConverter;
  await vscode.commands.executeCommand('editor.action.showReferences', p2c.asUri(uri), p2c.asPosition(position), locations.map((l) => p2c.asLocation(l)));
}
