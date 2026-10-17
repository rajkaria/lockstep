import { dirname, resolve, sep } from 'node:path';
import {
  CodeActionKind,
  CodeLensRefreshRequest,
  DidChangeWatchedFilesNotification,
  MessageType,
  ShowMessageNotification,
  TextDocuments,
  TextDocumentSyncKind,
  type ClientCapabilities,
  type CodeAction,
  type CodeLens,
  type Connection,
  type Diagnostic,
  type InitializeResult,
  type Location,
  type TextDocumentEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { gitRoot } from '../lint/sources.js';
import type { Finding, TextEdit } from '../lint/types.js';
import { packageVersion } from '../pkg.js';
import { findingRange, overlaps, pathToUri, repoRelative, SOURCE, toDiagnostic, toLspEdit, toRange, uriToPath, type DiagnosticData } from './convert.js';
import { diffEdit } from './lines.js';
import { places } from './references.js';
import { documentedHover, lensTitle, symbolHover, symbolLocation } from './symbols.js';
import { LspWorkspace, type WorkspaceOptions } from './workspace.js';

/** Commands the server runs (`workspace/executeCommand`). */
export const COMMANDS = {
  fixAll: 'staleproof.fixAll',
  audit: 'staleproof.audit',
  openReferences: 'staleproof.openReferences',
} as const;

/** A client-side command a client may declare (`initializationOptions.clientCommands`): VS Code's references peek. */
export const SHOW_REFERENCES = 'staleproof.showReferences';
export const FIX_ALL_KIND = `${CodeActionKind.SourceFixAll}.staleproof`;

export interface LspSettings {
  /** Diagnostics, code actions and lenses at all. */
  enable: boolean;
  /** "N docs reference this" above functions and classes. */
  codeLens: boolean;
}

export interface LspServerOptions {
  /** Per-folder options (tests inject a fixer or turn the parse cache off). */
  workspace?: Omit<WorkspaceOptions, 'root' | 'log'>;
  /** Quiet time after an edit before the buffer is re-checked (default 300 ms). */
  debounceMs?: number;
  /** Called after each publish of an edited document's diagnostics, with the time since the edit. */
  onPublish?: (uri: string, msSinceEdit: number, diagnostics: Diagnostic[]) => void;
}

export interface LspServer {
  dispose(): Promise<void>;
  /** The workspace that holds a file (created for its git checkout when outside every folder). */
  workspaceFor(file: string): Promise<{ ws: LspWorkspace; path: string } | undefined>;
}

const DEFAULT_SETTINGS: LspSettings = { enable: true, codeLens: true };

/** Files whose changes on disk can change a finding: docs, code, manifests, config, agent rule files. */
const WATCHED = [
  '**/*.{md,mdx,markdown,rst,mdc,txt,py,pyi,ts,tsx,mts,cts,js,jsx,mjs,cjs,go,toml,json,yml,yaml,cfg,ini,sh}',
  '**/{Makefile,makefile,GNUmakefile,justfile,Justfile,go.mod,.cursorrules,.windsurfrules,.clinerules,.gitignore,.env.example,.env.sample,.env.template}',
];
/** Folders whose churn never changes a finding (builds, dependencies, git's own files, Staleproof's cache). */
const CHURN = new Set(['node_modules', '.git', '.staleproof', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', '.next', '.turbo', '.cache', 'coverage', 'target']);

/** A file change in one of the workspace roots worth linting that workspace again for. */
export function relevantChange(uri: string, roots: Iterable<string>): boolean {
  const file = uriToPath(uri);
  if (!file) return false;
  for (const root of roots) {
    const rel = repoRelative(root, resolve(file));
    if (rel !== undefined && !rel.split('/').some((part) => CHURN.has(part))) return true;
  }
  return false;
}

function settingsFrom(value: unknown, base: LspSettings): LspSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<LspSettings> & { staleproof?: Partial<LspSettings> };
  const s = v.staleproof && typeof v.staleproof === 'object' ? v.staleproof : v;
  return { enable: typeof s.enable === 'boolean' ? s.enable : base.enable, codeLens: typeof s.codeLens === 'boolean' ? s.codeLens : base.codeLens };
}

/**
 * The Staleproof language server on a connection: diagnostics for open docs pages, agent
 * files and docstrings (re-checked 300 ms after an edit, from the unsaved text), verified
 * fixes and "ignore this rule here" as code actions, hover and go to definition from a docs
 * code span to the code, "documented in N places", find references and a code lens from the
 * code to the docs. Local only: the files, git and the parse cache; no graph, no network.
 */
export function createLspServer(connection: Connection, options: LspServerOptions = {}): LspServer {
  const documents = new TextDocuments(TextDocument);
  const debounce = options.debounceMs ?? 300;
  const folders = new Map<string, LspWorkspace>();
  const outside = new Map<string, Promise<LspWorkspace | undefined>>();
  let caps: ClientCapabilities = {};
  let settings: LspSettings = { ...DEFAULT_SETTINGS };
  let clientCommands = new Set<string>();
  /** After "Audit workspace": every file's findings are published, not only open files'. */
  let workspaceWide = false;
  const published = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const editedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  let refreshTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  const log = (m: string) => {
    try {
      connection.console.log(m);
    } catch {
      // The client is gone (shutting down): nowhere to log to.
    }
  };

  const info = (message: string) => void connection.sendNotification(ShowMessageNotification.type, { type: MessageType.Info, message }).catch(() => {});

  const workspaceOptions = (root: string): WorkspaceOptions => ({ ...options.workspace, root, log });

  function addFolder(root: string): LspWorkspace {
    let ws = folders.get(root);
    if (!ws) {
      ws = new LspWorkspace(workspaceOptions(root));
      folders.set(root, ws);
    }
    return ws;
  }

  async function workspaceFor(file: string): Promise<{ ws: LspWorkspace; path: string } | undefined> {
    const abs = resolve(file);
    let best: string | undefined;
    for (const root of folders.keys()) if ((abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep)) && (!best || root.length > best.length)) best = root;
    if (best) {
      const path = repoRelative(best, abs);
      return path ? { ws: folders.get(best)!, path } : undefined;
    }
    // A file outside every folder: its git checkout, if it has one (never a bare directory walk).
    const dir = dirname(abs);
    let p = outside.get(dir);
    if (!p) {
      p = gitRoot(dir).then((root) => (root ? (folders.get(root) ?? new LspWorkspace(workspaceOptions(root))) : undefined));
      outside.set(dir, p);
    }
    const ws = await p;
    const path = ws ? repoRelative(ws.root, abs) : undefined;
    return ws && path ? { ws, path } : undefined;
  }

  function allWorkspaces(): LspWorkspace[] {
    return [...new Set([...folders.values()])];
  }

  async function located(uri: string): Promise<{ ws: LspWorkspace; path: string } | undefined> {
    const file = uriToPath(uri);
    return file ? workspaceFor(file) : undefined;
  }

  function uriOf(ws: LspWorkspace, path: string): string {
    return ws.docs.get(path)?.uri ?? pathToUri(resolve(ws.root, ...path.split('/')));
  }

  function publish(uri: string, findings: Finding[], version?: number): Diagnostic[] {
    const diagnostics = settings.enable ? findings.map(toDiagnostic) : [];
    if (diagnostics.length) published.add(uri);
    else published.delete(uri);
    void connection.sendDiagnostics({ uri, diagnostics, ...(version !== undefined ? { version } : {}) });
    return diagnostics;
  }

  /** Re-check one open document and publish (one run per document at a time; a newer edit runs again after). */
  function check(uri: string): Promise<void> {
    if (running.has(uri)) {
      rerun.add(uri);
      return running.get(uri)!;
    }
    const run = (async () => {
      do {
        rerun.delete(uri);
        const doc = documents.get(uri);
        const at = await located(uri);
        if (!doc || !at || shuttingDown) return;
        const version = doc.version;
        try {
          const r = await at.ws.check(at.path);
          if (documents.get(uri)?.version !== version) continue;
          const diags = publish(uri, r.findings, version);
          const t = editedAt.get(uri);
          if (t !== undefined) {
            editedAt.delete(uri);
            options.onPublish?.(uri, performance.now() - t, diags);
          }
          if (r.envStale) {
            const env = await at.ws.recheckEnv(at.path);
            if (env && documents.get(uri)?.version === version) publish(uri, env, version);
          }
          void at.ws.reindexPage(at.path);
        } catch (err) {
          log(`Staleproof: checking ${at.path} failed: ${(err as Error).stack ?? err}`);
        }
      } while (rerun.has(uri) && !shuttingDown);
    })().finally(() => running.delete(uri));
    running.set(uri, run);
    return run;
  }

  function schedule(uri: string, ms: number): void {
    clearTimeout(timers.get(uri));
    timers.set(
      uri,
      setTimeout(() => {
        timers.delete(uri);
        void check(uri);
      }, ms),
    );
  }

  /** After a snapshot: every open document again, and every file when the workspace view is on. */
  async function republish(ws: LspWorkspace): Promise<void> {
    if (workspaceWide) {
      const all = ws.allFindings();
      for (const [path, findings] of all) if (!ws.docs.has(path)) publish(uriOf(ws, path), findings);
      for (const uri of [...published]) {
        const file = uriToPath(uri);
        const path = file ? repoRelative(ws.root, file) : undefined;
        if (path && !all.has(path) && !ws.docs.has(path)) publish(uri, []);
      }
    }
    await Promise.all([...ws.docs.values()].map((d) => check(d.uri)));
    if (caps.workspace?.codeLens?.refreshSupport && settings.codeLens) void connection.sendRequest(CodeLensRefreshRequest.type).catch(() => {});
  }

  async function refreshAll(): Promise<void> {
    await Promise.all(
      allWorkspaces().map(async (ws) => {
        await ws.refresh();
        await republish(ws);
      }),
    );
  }

  function scheduleRefresh(ms = 500): void {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshAll();
    }, ms);
  }

  documents.onDidChangeContent(async (e) => {
    editedAt.set(e.document.uri, performance.now());
    const at = await located(e.document.uri);
    if (!at) return;
    if (!folders.has(at.ws.root)) folders.set(at.ws.root, at.ws);
    const first = !at.ws.docs.has(at.path);
    const affected = await at.ws.setText(at.path, e.document.uri, e.document.version, e.document.getText());
    for (const path of affected) {
      const uri = at.ws.docs.get(path)?.uri;
      if (uri) schedule(uri, first && path === at.path ? 0 : debounce);
    }
  });

  documents.onDidClose(async (e) => {
    clearTimeout(timers.get(e.document.uri));
    timers.delete(e.document.uri);
    const at = await located(e.document.uri);
    if (!at) return;
    const affected = at.ws.close(at.path);
    publish(e.document.uri, workspaceWide ? at.ws.snapshotFindings(at.path) : []);
    for (const path of affected) {
      const uri = at.ws.docs.get(path)?.uri;
      if (uri) schedule(uri, debounce);
    }
  });

  documents.onDidSave(() => scheduleRefresh(debounce));

  connection.onInitialize((params): InitializeResult => {
    caps = params.capabilities;
    const init = (params.initializationOptions ?? {}) as { clientCommands?: unknown; settings?: unknown };
    settings = settingsFrom(init.settings ?? init, settings);
    if (Array.isArray(init.clientCommands)) clientCommands = new Set(init.clientCommands.filter((c): c is string => typeof c === 'string'));
    const roots = params.workspaceFolders?.length
      ? params.workspaceFolders.map((f) => uriToPath(f.uri)).filter((x): x is string => !!x)
      : [params.rootUri ? uriToPath(params.rootUri) : (params.rootPath ?? undefined)].filter((x): x is string => !!x);
    for (const r of roots) addFolder(resolve(r));
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, save: { includeText: false } },
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, FIX_ALL_KIND], resolveProvider: false },
        hoverProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        codeLensProvider: { resolveProvider: false },
        executeCommandProvider: { commands: Object.values(COMMANDS) },
        workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
      },
      serverInfo: { name: 'staleproof', version: packageVersion() },
    };
  });

  connection.onInitialized(async () => {
    if (caps.workspace?.didChangeWatchedFiles?.dynamicRegistration) {
      void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: WATCHED.map((globPattern) => ({ globPattern })) }).catch(() => {});
    }
    if (caps.workspace?.workspaceFolders) {
      connection.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const f of e.removed) {
          const p = uriToPath(f.uri);
          const ws = p ? folders.get(resolve(p)) : undefined;
          if (ws) {
            folders.delete(ws.root);
            void ws.dispose();
          }
        }
        for (const f of e.added) {
          const p = uriToPath(f.uri);
          if (p) void addFolder(resolve(p)).refresh();
        }
      });
    }
    await pullSettings();
    // The first snapshot of every folder, with progress where the client shows it.
    const progress = caps.window?.workDoneProgress ? await connection.window.createWorkDoneProgress().catch(() => undefined) : undefined;
    progress?.begin('Staleproof', undefined, 'Checking docs against the code');
    await Promise.all(allWorkspaces().map((ws) => ws.ready()));
    progress?.done();
    for (const ws of allWorkspaces()) await republish(ws);
  });

  async function pullSettings(): Promise<void> {
    if (!caps.workspace?.configuration) return;
    try {
      const [value] = (await connection.workspace.getConfiguration([{ section: 'staleproof' }])) as unknown[];
      settings = settingsFrom(value, settings);
    } catch {
      // The client keeps no settings for this section.
    }
  }

  connection.onDidChangeConfiguration(async (params) => {
    const before = settings;
    if (caps.workspace?.configuration) await pullSettings();
    else settings = settingsFrom(params.settings, settings);
    if (before.enable !== settings.enable) for (const ws of allWorkspaces()) await republish(ws);
    if (before.codeLens !== settings.codeLens && caps.workspace?.codeLens?.refreshSupport) void connection.sendRequest(CodeLensRefreshRequest.type).catch(() => {});
  });

  connection.onDidChangeWatchedFiles((params) => {
    const roots = allWorkspaces().map((ws) => ws.root);
    if (params.changes.some((c) => relevantChange(c.uri, roots))) scheduleRefresh();
  });

  function editFor(ws: LspWorkspace, edits: TextEdit[]): WorkspaceEdit {
    const byUri = new Map<string, TextEdit[]>();
    for (const e of edits) {
      const uri = uriOf(ws, e.path);
      byUri.set(uri, [...(byUri.get(uri) ?? []), e]);
    }
    if (caps.workspace?.workspaceEdit?.documentChanges) {
      const documentChanges: TextDocumentEdit[] = [...byUri].map(([uri, list]) => ({
        textDocument: { uri, version: documents.get(uri)?.version ?? null },
        edits: list.map(toLspEdit),
      }));
      return { documentChanges };
    }
    return { changes: Object.fromEntries([...byUri].map(([uri, list]) => [uri, list.map(toLspEdit)])) };
  }

  connection.onCodeAction(async (params) => {
    if (!settings.enable) return [];
    const at = await located(params.textDocument.uri);
    if (!at) return [];
    const { ws, path } = at;
    const out: CodeAction[] = [];
    const only = params.context.only;
    const wants = (kind: string) => !only?.length || only.some((k) => kind === k || kind.startsWith(`${k}.`));

    if (wants(CodeActionKind.QuickFix)) {
      const findings = ws.current(path);
      const diagnostics = params.context.diagnostics.filter((d) => d.source === SOURCE);
      const asked = diagnostics.length ? diagnostics : findings.filter((f) => overlaps(findingRange(f), params.range)).map(toDiagnostic);
      for (const d of asked) {
        const fp = (d.data as DiagnosticData | undefined)?.fingerprint;
        const f = findings.find((x) => (fp ? x.fingerprint === fp : x.rule === d.code && overlaps(findingRange(x), d.range)));
        if (!f) continue;
        const fix = await ws.fixFor(path, f);
        if (fix) out.push({ title: fix.description, kind: CodeActionKind.QuickFix, diagnostics: [d], isPreferred: true, edit: editFor(ws, fix.edits) });
        const ignore = await ws.ignoreFor(path, f);
        if (ignore) out.push({ title: ignore.title, kind: CodeActionKind.QuickFix, diagnostics: [d], edit: editFor(ws, [ignore.edit]) });
      }
    }
    if (only?.length && wants(FIX_ALL_KIND)) {
      const all = await fixAllEdit(ws, path);
      if (all) out.push({ title: `Staleproof: fix all (${all.applied.length})`, kind: FIX_ALL_KIND, edit: all.edit });
    }
    return out;
  });

  async function fixAllEdit(ws: LspWorkspace, path: string): Promise<{ edit: WorkspaceEdit; applied: string[] } | undefined> {
    const doc = ws.docs.get(path);
    const r = await ws.fixAll(path);
    if (!doc || !r) return undefined;
    const e = diffEdit(path, doc.text, r.text);
    return e ? { edit: editFor(ws, [e]), applied: r.applied } : undefined;
  }

  connection.onHover(async (params) => {
    if (!settings.enable) return null;
    const at = await located(params.textDocument.uri);
    if (!at) return null;
    const { ws, path } = at;
    const line = params.position.line + 1;
    const column = params.position.character + 1;
    const uriFor = (file: string) => pathToUri(file);
    if (ws.isTarget(path)) {
      const { refs, matches } = await ws.symbolsAt(path, line, column);
      if (!matches.length || !ws.model) return null;
      const r = refs[0]!;
      return { contents: { kind: 'markdown', value: symbolHover(ws.model, matches, uriFor) }, range: toRange(r.line, r.column, r.line, r.endColumn) };
    }
    const lineText = documents.get(params.textDocument.uri)?.getText({ start: { line: line - 1, character: 0 }, end: { line, character: 0 } }) ?? '';
    const d = await ws.definitionRefs(path, line, column, lineText.replace(/\r?\n$/, ''));
    if (!d?.refs.length) return null;
    return { contents: { kind: 'markdown', value: documentedHover(d.refs, ws.root, uriFor) } };
  });

  connection.onDefinition(async (params) => {
    if (!settings.enable) return null;
    const at = await located(params.textDocument.uri);
    if (!at || !at.ws.isTarget(at.path)) return null;
    const { matches } = await at.ws.symbolsAt(at.path, params.position.line + 1, params.position.character + 1);
    const model = at.ws.model;
    if (!model) return null;
    const out: Location[] = [];
    for (const { sym } of matches) {
      const where = symbolLocation(model, sym);
      if (where) out.push({ uri: pathToUri(where.file), range: toRange(where.line, 1, where.line, 1) });
    }
    return out.length ? out : null;
  });

  async function docsLocations(ws: LspWorkspace, refs: { path: string; line: number; column: number; endColumn: number }[]): Promise<Location[]> {
    return refs.map((r) => ({ uri: uriOf(ws, r.path), range: toRange(r.line, r.column, r.line, r.endColumn) }));
  }

  connection.onReferences(async (params) => {
    if (!settings.enable) return null;
    const at = await located(params.textDocument.uri);
    if (!at || at.ws.isTarget(at.path)) return null;
    const line = params.position.line + 1;
    const lineText = documents.get(params.textDocument.uri)?.getText({ start: { line: line - 1, character: 0 }, end: { line, character: 0 } }) ?? '';
    const d = await at.ws.definitionRefs(at.path, line, params.position.character + 1, lineText.replace(/\r?\n$/, ''));
    if (!d?.refs.length) return null;
    return docsLocations(at.ws, d.refs);
  });

  connection.onCodeLens(async (params) => {
    if (!settings.enable || !settings.codeLens) return [];
    const at = await located(params.textDocument.uri);
    if (!at || at.ws.isTarget(at.path)) return [];
    const out: CodeLens[] = [];
    for (const l of await at.ws.lenses(at.path)) {
      const range = toRange(l.line, 1, l.line, 1);
      const locations = await docsLocations(at.ws, places(l.refs));
      const title = lensTitle(l.refs);
      out.push({
        range,
        command: clientCommands.has(SHOW_REFERENCES)
          ? { title, command: SHOW_REFERENCES, arguments: [params.textDocument.uri, range.start, locations] }
          : { title, command: COMMANDS.openReferences, arguments: [locations] },
      });
    }
    return out;
  });

  connection.onExecuteCommand(async (params) => {
    const args = params.arguments ?? [];
    if (params.command === COMMANDS.fixAll) {
      const uri = typeof args[0] === 'string' ? args[0] : (args[0] as { uri?: string } | undefined)?.uri;
      const at = uri ? await located(uri) : undefined;
      if (!at) return { applied: 0 };
      const all = await fixAllEdit(at.ws, at.path);
      if (!all) {
        info('Staleproof: no verified fixes in this file.');
        return { applied: 0 };
      }
      const r = await connection.workspace.applyEdit({ label: 'Staleproof: fix all', edit: all.edit });
      return { applied: r.applied ? all.applied.length : 0, fixes: all.applied };
    }
    if (params.command === COMMANDS.audit) {
      workspaceWide = true;
      await refreshAll();
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      const files = new Set<string>();
      for (const ws of allWorkspaces()) {
        for (const [path, list] of ws.allFindings()) {
          if (list.length) files.add(`${ws.root}\0${path}`);
          for (const f of list) {
            if (f.severity === 'error') errors++;
            else if (f.severity === 'warning') warnings++;
            else infos++;
          }
        }
      }
      const total = errors + warnings + infos;
      const message = total
        ? `Staleproof: ${total} stale reference${total === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'} (${errors} errors, ${warnings} warnings, ${infos} info).`
        : 'Staleproof: no stale references in the docs.';
      info(message);
      return { errors, warnings, infos, files: files.size, message };
    }
    if (params.command === COMMANDS.openReferences) {
      const locations = (Array.isArray(args[0]) ? args[0] : []) as Location[];
      if (!locations.length) return null;
      let target: Location | undefined = locations[0];
      if (locations.length > 1) {
        const items = locations.slice(0, 20).map((l) => ({ title: `${uriToPath(l.uri) ?? l.uri}:${l.range.start.line + 1}` }));
        const picked = await connection.window.showInformationMessage('Docs that reference this:', ...items);
        target = picked ? locations[items.indexOf(items.find((i) => i.title === picked.title)!)] : undefined;
      }
      if (target && caps.window?.showDocument?.support) await connection.window.showDocument({ uri: target.uri, selection: target.range, takeFocus: true });
      return null;
    }
    return null;
  });

  connection.onShutdown(async () => {
    shuttingDown = true;
    for (const t of timers.values()) clearTimeout(t);
    clearTimeout(refreshTimer);
    await Promise.all(allWorkspaces().map((ws) => ws.dispose()));
  });

  documents.listen(connection);

  return {
    async dispose() {
      shuttingDown = true;
      for (const t of timers.values()) clearTimeout(t);
      clearTimeout(refreshTimer);
      await Promise.all(allWorkspaces().map((ws) => ws.dispose()));
    },
    workspaceFor,
  };
}
