import * as Q from '../graph/queries.js';
import { fromRepl } from '../indexer/docs.js';
import { arityOfSignature, extractPython, type PyCall } from '../indexer/python.js';
import { shown } from '../indexer/resolve.js';
import { bareModule, extractTs } from '../indexer/typescript.js';
import { checkArgs, trustsSignature, type Arity, type MismatchKind } from '../indexer/signature.js';
import type { Tracer } from '../tools/types.js';

/**
 * An example that calls what a pull request changed in a way the code after the
 * pull request no longer accepts — known before anything runs. Removed and renamed
 * symbols, stopped exports, and calls the new signature rejects (that the old one
 * accepted: an example that never fit is already broken, not broken by the PR).
 */
export interface PredictedBreak {
  example: string;
  url: string;
  section: string;
  repo: string;
  path: string;
  /** Line of the call in the doc file. */
  line: number;
  symbol: string;
  change: string;
  kind: MismatchKind;
  detail: string;
  /** The callee as written, or the import. */
  call: string;
  /** `exact` when the example's call resolved to the symbol through imports and types; `by-name` for a removed symbol matched by its name. */
  confidence: 'exact' | 'by-name';
}

/** An impacted example that already did not fit the code when it was indexed (MISMATCH edges). */
export interface KnownMismatch {
  example: string;
  url: string;
  line: number;
  kind: MismatchKind;
  detail: string;
  call: string;
}

interface Row {
  example: string;
  code: string;
  lang: string;
  lineno: number;
  url: string;
  repo: string;
  path: string;
  section: string;
  line: number | null;
  text: string | null;
  resolved: string;
  symbol: string;
  name: string;
  symbolKind: string;
  decorators: string[] | null;
  change: string;
  before: string;
  after: string;
  renamedTo: string;
}

export function lineUrl(url: string, line: number): string {
  return /#L\d+$/.test(url) ? url.replace(/#L\d+$/, `#L${line}`) : `${url}#L${line}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does the example import `name` from `module` (`from m import a, name`, parenthesised lists too)? */
export function importsName(code: string, module: string, name: string): boolean {
  const re = new RegExp(`from\\s+${escapeRe(module)}\\s+import\\s+(\\([^)]*\\b${escapeRe(name)}\\b[^)]*\\)|[^\\n]*\\b${escapeRe(name)}\\b)`);
  return re.test(code);
}

/**
 * Whether the call binds `self`/`cls` implicitly. `Graph.query(g, q)` through the
 * class passes it explicitly; `g.query(q)` through an instance does not.
 */
function dropsFirst(row: Row, call: PyCall): boolean | undefined {
  const decorators = row.decorators ?? [];
  if (row.symbolKind === 'function') return false;
  if (row.symbolKind !== 'method') return undefined;
  if (row.name === '__init__') return true;
  if (decorators.includes('staticmethod')) return false;
  if (decorators.includes('classmethod')) return true;
  const receiver = call.text.slice(0, Math.max(0, call.text.lastIndexOf('.')));
  const className = row.symbol.split('.').slice(-2, -1)[0];
  if (!receiver) return undefined;
  return receiver !== className && !receiver.endsWith(`.${className}`);
}

async function callsIn(code: string, lang: string): Promise<PyCall[]> {
  try {
    if (lang !== 'python') return (await extractTs(code, { module: '__predict__', path: '__predict__.tsx', tsx: true })).calls;
    return (await extractPython(fromRepl(code), { module: '__predict__', path: '__predict__.py' })).calls;
  } catch {
    return [];
  }
}

/** A JavaScript import of `name` from a specifier that names `module` (`import { X } from 'pkg'`, `require`). */
export function importsNameJs(code: string, module: string, name: string): boolean {
  for (const m of code.matchAll(/import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']|\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const names = (m[1] ?? m[3] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+|\s*:\s*/)[0]!.replace(/^type\s+/, ''));
    const spec = m[2] ?? m[4] ?? '';
    if (names.includes(name) && !spec.startsWith('.') && module.startsWith(bareModule(spec).split('.')[0]!)) return true;
  }
  return false;
}

/** The calls in an example that a USES edge points at: same callee text, closest to the recorded line. */
function matchingCalls(calls: PyCall[], row: Row): PyCall[] {
  const name = row.name === '__init__' ? row.symbol.split('.').slice(-2, -1)[0]! : row.name;
  // A late link records only the name: any call of it (`g.ro_query`, `Client().select_graph().ro_query`).
  const same =
    row.text && row.text.includes('.') ? calls.filter((c) => c.text === row.text) : calls.filter((c) => c.text === name || c.text.endsWith(`.${name}`));
  return same;
}

/**
 * The example as the pull request leaves it, for pages the pull request edits: its code,
 * `null` when the pull request removes it, undefined to judge the indexed version.
 */
export type CodeAfter = (example: { id: string; repo: string; path: string }) => Promise<string | null | undefined>;

/** Predicted breaks for every example that uses a symbol the pull request removed, renamed or re-signed. */
export async function predictBreaks(tracer: Tracer, prUrl: string, opts: { codeAfter?: CodeAfter } = {}): Promise<PredictedBreak[]> {
  return predictFromRows((await tracer.run<Row>(Q.predictedCalls, { pr: prUrl })).rows, 'this pull request', opts.codeAfter);
}

/** The same prediction for changes that are not a pull request (a working tree, an editor's buffers). */
export async function predictBreaksForChanges(tracer: Tracer, changes: ChangeRow[]): Promise<PredictedBreak[]> {
  if (!changes.length) return [];
  return predictFromRows((await tracer.run<Row>(Q.predictedCallsOfChanges, { changes })).rows, 'these changes');
}

/** One changed symbol as the `*OfChanges` queries take it. */
export interface ChangeRow {
  id: string;
  kind: string;
  before: string;
  after: string;
  renamed_to: string;
}

async function predictFromRows(rows: Row[], subject: string, codeAfter?: CodeAfter): Promise<PredictedBreak[]> {
  // "this pull request removes" / "these changes remove"
  const plural = subject.startsWith('these');
  const v = (verb: string) => (plural ? verb : `${verb}s`);
  const out: PredictedBreak[] = [];
  const parsed = new Map<string, Promise<PyCall[]>>();
  const arities = new Map<string, Promise<Arity | undefined>>();
  const arity = (sig: string) => {
    if (!arities.has(sig)) arities.set(sig, arityOfSignature(sig));
    return arities.get(sig)!;
  };
  const seen = new Set<string>();
  const add = (row: Row, line: number, kind: MismatchKind, detail: string, call: string) => {
    const key = `${row.example}|${row.symbol}|${kind}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      example: row.example,
      url: lineUrl(row.url, line),
      section: row.section,
      repo: row.repo,
      path: row.path,
      line,
      symbol: row.symbol,
      change: row.change,
      kind,
      detail,
      call,
      confidence: row.resolved === 'exact' ? 'exact' : 'by-name',
    });
  };

  // A page the pull request edits is judged as the pull request leaves it: an example it
  // removes can't break, and a call it rewrote must still be there to break.
  const codeAfterPr = new Map<string, Promise<string | null | undefined>>();
  const edited = new Set<string>();
  for (const row of rows) {
    if (row.resolved !== 'exact' && row.resolved !== 'late') continue;
    if (codeAfter) {
      if (!codeAfterPr.has(row.example)) codeAfterPr.set(row.example, codeAfter({ id: row.example, repo: row.repo, path: row.path }).catch(() => undefined));
      const code = await codeAfterPr.get(row.example)!;
      if (code === null) continue;
      if (code !== undefined && code !== row.code) {
        row.code = code;
        edited.add(row.example);
      }
    }
    if (!parsed.has(row.example)) parsed.set(row.example, callsIn(row.code, row.lang ?? 'python'));
    const calls = await parsed.get(row.example)!;
    const docLine = (call?: PyCall) => (call ? row.lineno + call.lineno - 1 : (row.line ?? row.lineno));
    const short = row.symbol.split('.').slice(-2).join('.');

    if (row.change === 'removed' || row.change === 'renamed') {
      const hits = matchingCalls(calls, row);
      // A late link is only a name match, and an edited example may no longer make the call: require one.
      if ((row.resolved === 'late' || edited.has(row.example)) && hits.length === 0) continue;
      const detail =
        row.change === 'renamed' && row.renamedTo
          ? `calls \`${short}\`, which ${subject} ${v('rename')} to \`${row.renamedTo.split('.').slice(-2).join('.')}\``
          : `calls \`${short}\`, which ${subject} ${v('remove')}`;
      add(row, docLine(hits[0]), 'removed', detail, hits[0]?.text ?? row.text ?? row.name);
      continue;
    }
    if (row.change === 'export-removed') {
      const m = /^from\s+(\S+)\s+import\s+(\S+)/.exec(row.before);
      if (!m) continue;
      const js = row.lang !== 'python';
      if (js ? !importsNameJs(row.code, m[1]!, m[2]!) : !importsName(row.code, m[1]!, m[2]!)) continue;
      const lines = js ? row.code.split('\n') : fromRepl(row.code).split('\n');
      const idx = lines.findIndex((l) => (js ? new RegExp(`\\b${escapeRe(m[2]!)}\\b`).test(l) && /\b(import|require)\b/.test(l) : importsName(l, m[1]!, m[2]!) || new RegExp(`from\\s+${escapeRe(m[1]!)}\\s+import`).test(l)));
      add(row, row.lineno + Math.max(0, idx), 'missing-import', `imports \`${m[2]}\` from \`${shown(m[1]!)}\`, which ${subject} ${v('stop')} exporting`, js ? `import { ${m[2]} }` : row.before);
      continue;
    }
    if (row.change !== 'signature' || row.resolved !== 'exact') continue;
    if (!trustsSignature(row.decorators ?? [])) continue;
    const [before, after] = await Promise.all([arity(row.before), arity(row.after)]);
    if (!before || !after) continue;
    for (const call of matchingCalls(calls, row)) {
      if (!call.args) continue;
      const drop = dropsFirst(row, call);
      if (drop === undefined) continue;
      const callee = row.name === '__init__' ? row.symbol.split('.').slice(-2, -1)[0]! : short;
      const wasOk = checkArgs(call.args, before, { dropFirst: drop, callee }).length === 0;
      if (!wasOk) continue;
      for (const m of checkArgs(call.args, after, { dropFirst: drop, callee })) add(row, docLine(call), m.kind, m.detail, call.text);
    }
  }
  return out.sort((a, b) => a.example.localeCompare(b.example) || a.line - b.line);
}

/** MISMATCH edges recorded at index time on the given examples. */
export async function knownMismatches(tracer: Tracer, examples: string[]): Promise<KnownMismatch[]> {
  if (!examples.length) return [];
  const rows = (
    await tracer.run<{ example: string; url: string; line: number; kind: MismatchKind; detail: string; call: string }>(Q.mismatchesFor, { ids: examples })
  ).rows;
  return rows.map((r) => ({ ...r, url: lineUrl(r.url, r.line) }));
}
