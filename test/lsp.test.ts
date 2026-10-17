import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CodeActionRequest,
  CodeLensRequest,
  DefinitionRequest,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidChangeWatchedFilesNotification,
  DidOpenTextDocumentNotification,
  ExecuteCommandRequest,
  FileChangeType,
  HoverRequest,
  InitializedNotification,
  InitializeRequest,
  ReferencesRequest,
  type CodeAction,
  type Diagnostic,
  type InitializeResult,
  type Location,
  type MarkupContent,
  type TextDocumentEdit,
  type TextEdit,
} from 'vscode-languageserver/node';
import { lintRepo } from '../src/lint/engine.js';
import type { Finding, LintResult } from '../src/lint/types.js';
import { pathToUri } from '../src/lsp/convert.js';
import type { Fixer } from '../src/lsp/workspace.js';
import { CLIENT_CAPABILITIES, connect, fixtureRepo, LSP_FIXTURES, type TestClient } from './lsp-harness.js';

/** A fixer with one verified fix: the path the agent notes name, replaced with the file that exists. */
const fixer: Fixer = async (result: LintResult) => ({
  ...result,
  findings: result.findings.map((f): Finding =>
    f.rule === 'path-missing' && f.subject === 'pkg/settings.py'
      ? { ...f, fix: { description: 'Replace with `pkg/client.py`', verified: true, edits: [{ path: f.path, line: f.line, column: f.column, endLine: f.endLine, endColumn: f.endColumn, newText: 'pkg/client.py' }] } }
      : f,
  ),
});

const rules = (ds: Diagnostic[]) => ds.map((d) => d.code).sort();
const text = (d: Diagnostic) => (typeof d.message === 'string' ? d.message : d.message.value);
const edits = (a: CodeAction) => (a.edit!.documentChanges![0] as TextDocumentEdit).edits as TextEdit[];
const markdown = (h: unknown) => ((h as { contents: MarkupContent } | null)?.contents.value ?? '');

describe('staleproof lsp (in-process protocol)', () => {
  let dir: string;
  let t: TestClient;
  let init: InitializeResult;
  let lint: LintResult;
  const texts = new Map<string, { text: string; version: number }>();
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;

  const uri = (path: string) => t.uri(dir, path);
  async function open(path: string): Promise<Diagnostic[]> {
    const text = await readFile(join(dir, path), 'utf8');
    texts.set(path, { text, version: 1 });
    const got = t.diagnostics(uri(path));
    await t.client.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri: uri(path), languageId: path.endsWith('.py') ? 'python' : 'markdown', version: 1, text },
    });
    return got;
  }
  /** Replace the whole of one line (1-based) or insert before it, as an incremental change. */
  async function edit(path: string, line: number, newText: string, opts: { insert?: boolean } = {}): Promise<number> {
    const doc = texts.get(path)!;
    const lines = doc.text.split('\n');
    const range = opts.insert
      ? { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 0 } }
      : { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: lines[line - 1]!.length } };
    if (opts.insert) lines.splice(line - 1, 0, newText.replace(/\n$/, ''));
    else lines[line - 1] = newText;
    doc.text = lines.join('\n');
    doc.version++;
    await t.client.sendNotification(DidChangeTextDocumentNotification.type, {
      textDocument: { uri: uri(path), version: doc.version },
      contentChanges: [{ range, text: opts.insert ? `${newText.replace(/\n$/, '')}\n` : newText }],
    });
    return doc.version;
  }
  const at = (path: string, line: number, needle: string, offset = 0) => {
    const l = texts.get(path)!.text.split('\n')[line - 1]!;
    return { textDocument: { uri: uri(path) }, position: { line: line - 1, character: l.indexOf(needle) + offset } };
  };

  beforeAll(async () => {
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('the language server must not use the network');
    }) as typeof fetch;
    dir = await fixtureRepo(join(LSP_FIXTURES, 'basic'));
    lint = await lintRepo({ dir, cache: false });
    t = connect({ workspace: { cache: false, fixer, renameBase: false } });
    init = await t.client.sendRequest(InitializeRequest.type, {
      processId: null,
      rootUri: pathToUri(dir),
      workspaceFolders: [{ uri: pathToUri(dir), name: basename(dir) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: { clientCommands: ['staleproof.showReferences'] },
    });
    await t.client.sendNotification(InitializedNotification.type, {});
  });

  afterAll(async () => {
    await t?.close();
    globalThis.fetch = realFetch;
  });

  it('initialize: diagnostics, code actions, hover, definition, references, code lenses and commands', () => {
    const c = init.capabilities;
    expect(init.serverInfo?.name).toBe('staleproof');
    expect(c.hoverProvider).toBe(true);
    expect(c.definitionProvider).toBe(true);
    expect(c.referencesProvider).toBe(true);
    expect(c.codeLensProvider).toBeTruthy();
    expect(c.codeActionProvider).toMatchObject({ codeActionKinds: ['quickfix', 'source.fixAll.staleproof'] });
    expect(c.executeCommandProvider?.commands).toEqual(['staleproof.fixAll', 'staleproof.audit', 'staleproof.openReferences']);
    expect(c.textDocumentSync).toMatchObject({ openClose: true, change: 2 });
  });

  it('didOpen → publishDiagnostics: what staleproof lint reports for the file, .staleproof.toml applied', async () => {
    const ds = await open('README.md');
    const expected = lint.findings.filter((f) => f.path === 'README.md');
    expect(rules(ds)).toEqual(expected.map((f) => f.rule).sort());
    expect(rules(ds)).toEqual(['anchor-missing', 'command-missing', 'example-unknown-keyword', 'symbol-missing']);
    const anchor = ds.find((d) => d.code === 'anchor-missing')!;
    // `.staleproof.toml` raises anchor-missing from warning to error.
    expect(anchor.severity).toBe(DiagnosticSeverity.Error);
    expect(anchor).toMatchObject({ source: 'staleproof', range: { start: { line: 3, character: 22 }, end: { line: 3, character: 49 } } });
    expect(anchor.codeDescription?.href).toBe('https://staleproof.dev/#/docs/rules#anchor-missing');
    expect(text(anchor)).toContain('has no heading `#configuration`');
  });

  it('didChange → the unsaved text is re-checked within the debounce, positions follow the edit', async () => {
    const started = performance.now();
    const got = t.diagnostics(uri('README.md'), (ds) => ds.some((d) => d.code === 'link-broken'));
    await edit('README.md', 2, 'Read [the changes](docs/changes.md) too.', { insert: true });
    const ds = await got;
    expect(performance.now() - started).toBeLessThan(3000);
    const missing = ds.find((d) => d.code === 'link-broken')!;
    expect(missing.range).toEqual({ start: { line: 1, character: 19 }, end: { line: 1, character: 34 } });
    expect(text(missing)).toContain('`docs/changes.md` does not exist');
    // The anchor finding moved down one line with the text.
    expect(ds.find((d) => d.code === 'anchor-missing')!.range.start.line).toBe(4);
    expect(rules(ds)).toEqual(['anchor-missing', 'command-missing', 'example-unknown-keyword', 'link-broken', 'symbol-missing']);
  });

  it('code files: docstring findings from the buffer, cleared when the docstring is fixed', async () => {
    const ds = await open('pkg/client.py');
    expect(ds.map((d) => `${d.code} ${d.range.start.line + 1}:${d.range.start.character + 1}`)).toEqual(['docstring-param-unknown 16:13']);
    const cleared = t.diagnostics(uri('pkg/client.py'), (x) => x.length === 0);
    await edit('pkg/client.py', 16, '            params: Query parameters.');
    expect(await cleared).toEqual([]);
  });

  it('hover on a docs code span: the symbol, its signature and where it is defined', async () => {
    const h = markdown(await t.client.sendRequest(HoverRequest.type, at('README.md', 7, 'pkg.client.Client', 3)));
    expect(h).toContain('class Client');
    expect(h).toContain('in `pkg.client`');
    expect(h).toMatch(/\[pkg\/client\.py:4\]\(file:\/\/.*\/pkg\/client\.py#L4\)/);
    const q = markdown(await t.client.sendRequest(HoverRequest.type, at('README.md', 7, 'Client.query', 8)));
    expect(q).toContain('def query(self, cypher, params=None)');
    expect(q).toContain('pkg/client.py:11');
    // Prose is not a symbol.
    expect(await t.client.sendRequest(HoverRequest.type, at('README.md', 1, 'pkg'))).toBeNull();
  });

  it('go to definition from a docs span or an example call', async () => {
    const defs = (await t.client.sendRequest(DefinitionRequest.type, at('README.md', 7, 'Client.query', 2))) as Location[];
    expect(defs).toEqual([{ uri: uri('pkg/client.py'), range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } } }]);
    const call = (await t.client.sendRequest(DefinitionRequest.type, at('README.md', 13, 'query', 1))) as Location[];
    expect(call.map((l) => `${l.uri.endsWith('pkg/client.py')}:${l.range.start.line + 1}`)).toEqual(['true:11']);
  });

  it('hover on a function in code: documented in N places, with links', async () => {
    const h = markdown(await t.client.sendRequest(HoverRequest.type, at('pkg/client.py', 11, 'query', 2)));
    expect(h).toContain('**Documented in 3 places** across 2 docs');
    expect(h).toMatch(/\[README\.md:7\]\(file:\/\/.*README\.md#L7\) `Client\.query`/);
    expect(h).toContain('README.md:13');
    expect(h).toMatch(/docs\/guide\.md:\d+\]\(.*\) example/);
    // Not on a definition's name: nothing.
    expect(await t.client.sendRequest(HoverRequest.type, at('pkg/client.py', 11, 'cypher', 1))).toBeNull();
  });

  it('find references from a definition lists the docs that use it', async () => {
    const refs = (await t.client.sendRequest(ReferencesRequest.type, { ...at('pkg/client.py', 11, 'query', 1), context: { includeDeclaration: false } })) as Location[];
    expect(refs.map((l) => `${l.uri.slice(l.uri.lastIndexOf(basename(dir)) + basename(dir).length + 1)}:${l.range.start.line + 1}`).sort()).toEqual(['README.md:13', 'README.md:7', 'docs/guide.md:11']);
  });

  it('code lens: "N docs reference this", with the client\'s references command', async () => {
    const lenses = await t.client.sendRequest(CodeLensRequest.type, { textDocument: { uri: uri('pkg/client.py') } });
    const byLine = new Map(lenses!.map((l) => [l.range.start.line + 1, l.command]));
    expect(byLine.get(11)).toMatchObject({ title: '2 docs reference this', command: 'staleproof.showReferences' });
    expect(byLine.get(4)?.title).toBe('2 docs reference this');
    const args = byLine.get(11)!.arguments!;
    expect(args[0]).toBe(uri('pkg/client.py'));
    expect((args[2] as Location[]).length).toBe(3);
    // The setting turns them off.
    await t.client.sendNotification(DidChangeConfigurationNotification.type, { settings: { staleproof: { codeLens: false } } });
    expect(await t.client.sendRequest(CodeLensRequest.type, { textDocument: { uri: uri('pkg/client.py') } })).toEqual([]);
    await t.client.sendNotification(DidChangeConfigurationNotification.type, { settings: { staleproof: { codeLens: true } } });
  });

  it('code actions: the verified fix, and "ignore this rule here" when it silences the finding', async () => {
    const ds = await open('AGENTS.md');
    const d = ds.find((x) => x.code === 'path-missing')!;
    const actions = (await t.client.sendRequest(CodeActionRequest.type, { textDocument: { uri: uri('AGENTS.md') }, range: d.range, context: { diagnostics: [d] } })) as CodeAction[];
    expect(actions.map((a) => a.title)).toEqual(['Replace with `pkg/client.py`', 'Ignore path-missing here (staleproof: ignore)']);
    expect(actions[0]!.isPreferred).toBe(true);
    const fixEdit = actions[0]!.edit!.documentChanges![0] as TextDocumentEdit;
    expect(fixEdit.textDocument).toEqual({ uri: uri('AGENTS.md'), version: 1 });
    expect(fixEdit.edits).toEqual([{ range: d.range, newText: 'pkg/client.py' }]);
    const ignore = edits(actions[1]!)[0]!;
    expect(ignore.newText).toBe(' <!-- staleproof: ignore path-missing -->');
    expect(ignore.range.start).toEqual({ line: 2, character: texts.get('AGENTS.md')!.text.split('\n')[2]!.length });

    // An unsaved edit above the finding: the fix moves with it and is checked against the buffer.
    const moved = t.diagnostics(uri('AGENTS.md'), (x) => x.some((y) => y.code === 'path-missing' && y.range.start.line === 3));
    await edit('AGENTS.md', 2, 'A note added above.', { insert: true });
    const d2 = (await moved).find((x) => x.code === 'path-missing')!;
    const again = (await t.client.sendRequest(CodeActionRequest.type, { textDocument: { uri: uri('AGENTS.md') }, range: d2.range, context: { diagnostics: [d2] } })) as CodeAction[];
    const e2 = edits(again[0]!)[0]!;
    expect(e2.range).toEqual(d2.range);
    expect((again[0]!.edit!.documentChanges![0] as TextDocumentEdit).textDocument.version).toBe(2);

    // Applying the ignore comment clears the finding.
    const cleared = t.diagnostics(uri('AGENTS.md'), (x) => !x.some((y) => y.code === 'path-missing'));
    const line = texts.get('AGENTS.md')!.text.split('\n')[3]!;
    await edit('AGENTS.md', 4, `${line} <!-- staleproof: ignore path-missing -->`);
    expect(rules(await cleared)).toEqual(['command-missing'].filter((r) => lint.findings.some((f) => f.path === 'AGENTS.md' && f.rule === r)));
  });

  it('a finding inside a code example is silenced by skipping the example', async () => {
    const ds = t.published.filter((p) => p.uri === uri('README.md')).at(-1)!.diagnostics;
    const d = ds.find((x) => x.code === 'example-unknown-keyword')!;
    const actions = (await t.client.sendRequest(CodeActionRequest.type, { textDocument: { uri: uri('README.md') }, range: d.range, context: { diagnostics: [d] } })) as CodeAction[];
    const skip = actions.find((a) => a.title.startsWith('Skip this example'))!;
    const e = edits(skip)[0]!;
    expect(e.newText).toBe('<!-- staleproof: skip -->\n');
    expect(texts.get('README.md')!.text.split('\n')[e.range.start.line]).toBe('```python');
  });

  it('fix all in file: one edit with every verified fix, applied through the client', async () => {
    const before = t.requests.length;
    const r = await t.client.sendRequest(ExecuteCommandRequest.type, { command: 'staleproof.fixAll', arguments: [uri('AGENTS.md')] });
    // The ignore comment now silences the only fixable finding.
    expect(r).toEqual({ applied: 0 });
    await edit('AGENTS.md', 4, texts.get('AGENTS.md')!.text.split('\n')[3]!.replace(' <!-- staleproof: ignore path-missing -->', ''));
    await t.diagnostics(uri('AGENTS.md'), (x) => x.some((y) => y.code === 'path-missing'));
    const r2 = await t.client.sendRequest(ExecuteCommandRequest.type, { command: 'staleproof.fixAll', arguments: [uri('AGENTS.md')] });
    expect(r2).toEqual({ applied: 1, fixes: ['Replace with `pkg/client.py`'] });
    const applied = t.requests.slice(before).find((x) => x.method === 'workspace/applyEdit')!.params as { edit: { documentChanges: TextDocumentEdit[] } };
    expect(applied.edit.documentChanges[0]!.edits).toEqual([{ range: { start: { line: 3, character: 61 }, end: { line: 3, character: 69 } }, newText: 'client' }]);
    // source.fixAll for editors that fix on save.
    const src = (await t.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: uri('AGENTS.md') },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      context: { diagnostics: [], only: ['source.fixAll'] },
    })) as CodeAction[];
    expect(src.map((a) => `${a.kind} ${a.title}`)).toEqual(['source.fixAll.staleproof Staleproof: fix all (1)']);
  });

  it('a page\'s variables: the environment check runs after the fast pass', async () => {
    const ds = await open('docs/guide.md');
    expect(ds.filter((d) => d.code === 'env-unused').map((d) => text(d).split('\n')[0])).toEqual(['`PKG_TIMEOUT_SECONDS` is documented but no code reads it.']);
    const renamed = t.diagnostics(uri('docs/guide.md'), (x) => x.some((d) => text(d).includes('PKG_RETRY_LIMIT')));
    const lineNo = texts.get('docs/guide.md')!.text.split('\n').findIndex((l) => l.includes('PKG_TIMEOUT_SECONDS')) + 1;
    await edit('docs/guide.md', lineNo, '| `PKG_RETRY_LIMIT` | How many times to retry. |');
    const after = await renamed;
    expect(after.filter((d) => d.code === 'env-unused').map((d) => `${d.range.start.line + 1} ${text(d).split('\n')[0]}`)).toEqual([`${lineNo} \`PKG_RETRY_LIMIT\` is documented but no code reads it.`]);
  });

  it('audit workspace: every file\'s findings, and a summary', async () => {
    const before = t.published.length;
    const r = (await t.client.sendRequest(ExecuteCommandRequest.type, { command: 'staleproof.audit' })) as { errors: number; warnings: number; files: number; message: string };
    expect(r.files).toBeGreaterThanOrEqual(3);
    expect(r.message).toMatch(/^Staleproof: \d+ stale references in \d+ files/);
    expect(t.requests.map((x) => x.method)).toContain('window/showMessage');
    const after = t.published.slice(before);
    expect(after.some((p) => p.uri === uri('README.md'))).toBe(true);
  });

  it('a config change on disk is picked up: .staleproof.toml turns a rule off', async () => {
    await writeFile(join(dir, '.staleproof.toml'), '[rules]\n"anchor-missing" = "error"\n"command-missing" = "off"\n');
    const got = t.diagnostics(uri('README.md'), (ds) => ds.length > 0 && !ds.some((d) => d.code === 'command-missing'));
    await t.client.sendNotification(DidChangeWatchedFilesNotification.type, { changes: [{ uri: uri('.staleproof.toml'), type: FileChangeType.Changed }] });
    expect(rules(await got)).toEqual(['anchor-missing', 'example-unknown-keyword', 'link-broken', 'symbol-missing']);
  });

  it('nothing goes over the network', () => {
    expect(fetchCalls).toBe(0);
  });
});
