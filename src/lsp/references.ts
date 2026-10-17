import { fromRepl, JS_LANGS, narrow, pageContext, pseudoModule, usedScopes } from '../indexer/docs.js';
import { extractGoExample, goImportSpecs } from '../indexer/go.js';
import type { ExtractMemo } from '../indexer/index.js';
import { identifiersIn, scanDoc } from '../indexer/markdown.js';
import { extractPython, type PyModule } from '../indexer/python.js';
import type { Resolution, SymbolTable } from '../indexer/resolve.js';
import { extractTs } from '../indexer/typescript.js';
import { scanClaims } from '../lint/scan.js';

/**
 * Where the docs name the code: inline code spans that resolve to a symbol (MENTIONS in the
 * graph) and calls in docs code examples (USES), resolved in memory exactly as `staleproof
 * index` resolves them, so the editor shows what the graph would hold. Hover, go to
 * definition, find references and the "N docs reference this" code lens read this index.
 */

export interface DocRef {
  /** The symbol id (`owner/repo:qualname`). */
  symbol: string;
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based; end exclusive. */
  column: number;
  endColumn: number;
  /** As the docs write it: `Client.query`, `connect`. */
  text: string;
  kind: 'mention' | 'example';
  resolved: Resolution;
}

export interface RefContext {
  repo: string;
  table: SymbolTable;
  codeRepos: Set<string>;
  /** Top-level packages of the repository's own code (bare-name mentions link only into the page's context). */
  ownPackages: Set<string>;
  memo?: ExtractMemo;
}

/** Sphinx cross-reference roles: `:meth:`Client.query``. */
const RST_ROLE = /:(?:py:)?(?:meth|func|class|attr|obj|mod|data|exc|const|property):`([^`]+)`/g;
const REPL_LINE = /^\s*(>>>|\.\.\.)( |$)/;

type Row = {
  from: string;
  to: string;
  resolved: Resolution;
  ref: DocRef;
};

/** Column (1-based) of `needle` in a docs line, else of its last segment, else of the line's first character. */
function locate(lineText: string, needle: string): { column: number; endColumn: number; text: string } {
  for (const n of [needle, needle.split('.').pop() ?? '']) {
    const at = n ? lineText.indexOf(n) : -1;
    if (at >= 0) return { column: at + 1, endColumn: at + 1 + n.length, text: n };
  }
  const lead = lineText.length - lineText.trimStart().length;
  return { column: lead + 1, endColumn: lineText.length + 1, text: lineText.trim() };
}

/** The references one docs page makes to the code. */
export async function pageRefs(path: string, text: string, ctx: RefContext): Promise<DocRef[]> {
  const { repo, table, codeRepos } = ctx;
  const md = scanDoc(path, text);
  const claims = scanClaims(path, text);
  const lines = claims.lines;
  const contextRepos = pageContext(md, ctx.ownPackages, table);
  const keep = (to: string) => codeRepos.has(to.slice(0, to.indexOf(':')));

  // Calls in the page's examples, resolved cumulatively per page (a later block sees an earlier one's bindings).
  const callGroups: Row[][] = [];
  const pushCalls = (mod: PyModule, startLine: number, lineOf: (line: number) => number | undefined) => {
    for (const call of mod.calls) {
      if (call.lineno < startLine) continue;
      const line = lineOf(call.lineno);
      if (line === undefined) continue;
      const at = locate(lines[line - 1] ?? '', call.text);
      callGroups.push(
        table
          .resolveCall(repo, mod, call)
          .filter((r) => keep(r.to))
          .map((r) => ({ from: '', to: r.to, resolved: r.resolved, ref: { symbol: r.to, path, line, ...at, kind: 'example', resolved: r.resolved } })),
      );
    }
  };
  const extract = <O extends object>(kind: string, source: string, o: O, run: (o: O) => Promise<PyModule>) =>
    (ctx.memo ? ctx.memo.extract(kind, source, o, run) : run(o)).catch(() => undefined);

  let acc = '';
  let jsAcc = '';
  let goImports: string[] = [];
  for (const ex of md.examples) {
    if (ex.lang === 'python') {
      const code = fromRepl(ex.code);
      // A REPL transcript keeps only its prompt lines: map them back to the page.
      const raw = ex.code.split('\n');
      const kept = code === ex.code ? raw.map((_, i) => i) : raw.flatMap((l, i) => (REPL_LINE.test(l) ? [i] : []));
      const startLine = acc ? acc.split('\n').length + 1 : 1;
      acc = acc ? `${acc}\n${code}` : code;
      const mod = await extract('python', acc, { module: pseudoModule(repo, path), path }, (o) => extractPython(acc, o));
      if (!mod) continue;
      const dispose = table.addEphemeral(repo, mod);
      try {
        pushCalls(mod, startLine, (l) => {
          const i = kept[l - startLine];
          return i === undefined ? undefined : ex.lineno + i;
        });
      } finally {
        dispose();
      }
    } else if (JS_LANGS.has(ex.lang)) {
      const startLine = jsAcc ? jsAcc.split('\n').length + 1 : 1;
      jsAcc = jsAcc ? `${jsAcc}\n${ex.code}` : ex.code;
      const source = jsAcc;
      const mod = await extract('ts', source, { module: `${pseudoModule(repo, path)}_js`, path, tsx: true }, (o) => extractTs(source, o));
      if (!mod) continue;
      const dispose = table.addEphemeral(repo, mod);
      try {
        pushCalls(mod, startLine, (l) => ex.lineno + (l - startLine));
      } finally {
        dispose();
      }
    } else if (ex.lang === 'go') {
      const earlier = goImports;
      goImports = [...goImports, ...goImportSpecs(ex.code)];
      const mod = await extractGoExample(ex.code, { module: `${pseudoModule(repo, path)}_go`, path, earlierImports: earlier }).catch(() => undefined);
      if (!mod) continue;
      const dispose = table.addEphemeral(repo, mod);
      try {
        pushCalls(mod, 1, (l) => ex.lineno + l - 1);
      } finally {
        dispose();
      }
    }
  }
  // What the page's examples use exactly disambiguates its by-name guesses, as at index time.
  const used = usedScopes(callGroups);
  const out: DocRef[] = [];
  for (const g of callGroups) for (const r of narrow(g, used) as Row[]) out.push(r.ref);

  const mention = (spanText: string, line: number, column: number) => {
    for (const { ident, called } of identifiersIn(spanText)) {
      const at = Math.max(0, spanText.indexOf(ident));
      const group: Row[] = table.matchMention(ident, { called, codeRepos, contextRepos }).map((m) => ({
        from: '',
        to: m.sym.id,
        resolved: m.resolved,
        ref: { symbol: m.sym.id, path, line, column: column + at, endColumn: column + at + ident.length, text: ident, kind: 'mention', resolved: m.resolved },
      }));
      for (const r of narrow(group, used) as Row[]) out.push(r.ref);
    }
  };
  for (const s of claims.spans) mention(s.text, s.line, s.column);
  if (/\.rst$/i.test(path)) {
    const fenced = new Set(claims.fences.flatMap((f) => f.lines.map((l) => l.line)));
    for (const [i, line] of lines.entries()) {
      if (fenced.has(i + 1)) continue;
      for (const m of line.matchAll(RST_ROLE)) {
        const inner = m[1]!;
        const target = (/<([^>]+)>\s*$/.exec(inner)?.[1] ?? inner).trim().replace(/^[~!]/, '');
        if (!target.startsWith('.')) mention(target, i + 1, m.index! + m[0].indexOf(target) + 1);
      }
    }
  }
  return out;
}

/** Every page's references, by page and by symbol. */
export class DocsIndex {
  private readonly byPage = new Map<string, DocRef[]>();
  private bySymbol?: Map<string, DocRef[]>;

  setPage(path: string, refs: DocRef[]): void {
    this.byPage.set(path, refs);
    this.bySymbol = undefined;
  }

  deletePage(path: string): void {
    if (this.byPage.delete(path)) this.bySymbol = undefined;
  }

  pages(): string[] {
    return [...this.byPage.keys()];
  }

  /** References to a symbol, by page then line. */
  refsTo(symbol: string): DocRef[] {
    if (!this.bySymbol) {
      this.bySymbol = new Map();
      for (const refs of this.byPage.values()) {
        for (const r of refs) {
          const list = this.bySymbol.get(r.symbol) ?? [];
          list.push(r);
          this.bySymbol.set(r.symbol, list);
        }
      }
      for (const list of this.bySymbol.values()) list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    }
    return this.bySymbol.get(symbol) ?? [];
  }

  /** References on a page that cover a 1-based position. */
  refsAt(path: string, line: number, column: number): DocRef[] {
    return (this.byPage.get(path) ?? []).filter((r) => r.line === line && r.column <= column && column <= r.endColumn);
  }

  static async build(pages: { path: string; text: string }[], ctx: RefContext): Promise<DocsIndex> {
    const index = new DocsIndex();
    for (const p of pages) {
      index.setPage(p.path, await pageRefs(p.path, p.text, ctx).catch(() => []));
      // Cached parses resolve without I/O: yield, so an edit's check never waits for the whole index.
      await new Promise((r) => setImmediate(r));
    }
    return index;
  }
}

/** Distinct places (page and line) among references. */
export function places(refs: DocRef[]): DocRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.path}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
