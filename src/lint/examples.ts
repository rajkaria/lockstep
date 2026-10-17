import { fromRepl, JS_LANGS, pseudoModule } from '../indexer/docs.js';
import { scanDoc } from '../indexer/markdown.js';
import { matchesAny } from '../indexer/repo-config.js';
import type { ParsedRepo } from '../indexer/index.js';
import { extractPython } from '../indexer/python.js';
import type { Mismatch, SymbolTable } from '../indexer/resolve.js';
import { extractTs } from '../indexer/typescript.js';
import type { RawFinding } from './engine.js';

export interface ExampleMismatch {
  path: string;
  /** Line in the docs page. */
  line: number;
  mismatch: Mismatch;
}

/**
 * The static example checks the indexer stores as MISMATCH edges, computed in memory
 * for one repository's docs pages: Python and JS/TS blocks are resolved cumulatively
 * per page (a later fragment sees an earlier block's bindings), exactly as at index time.
 */
export async function exampleMismatches(
  p: ParsedRepo,
  pages: { path: string; text: string }[],
  table: SymbolTable,
  codeRepos: Set<string>,
): Promise<ExampleMismatch[]> {
  const repo = p.checkout.repo;
  const out: ExampleMismatch[] = [];
  const keep = (m: Mismatch) => codeRepos.has(m.target.split(':')[0]!);
  for (const page of pages) {
    const doc = scanDoc(page.path, page.text);
    const skipPage = matchesAny(page.path, p.config?.skipExamples ?? []);
    let acc = '';
    let jsAcc = '';
    for (const ex of doc.examples) {
      const judged = !ex.directive && !skipPage;
      if (ex.lang === 'python') {
        const code = fromRepl(ex.code);
        const startLine = acc ? acc.split('\n').length + 1 : 1;
        acc = acc ? `${acc}\n${code}` : code;
        if (!judged) continue;
        const mod = await extractPython(acc, { module: pseudoModule(repo, page.path), path: page.path }).catch(() => undefined);
        if (!mod) continue;
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const m of table.checkModule(repo, mod, startLine).filter(keep)) out.push({ path: page.path, line: ex.lineno + (m.line - startLine), mismatch: m });
        } finally {
          dispose();
        }
      } else if (JS_LANGS.has(ex.lang)) {
        const startLine = jsAcc ? jsAcc.split('\n').length + 1 : 1;
        jsAcc = jsAcc ? `${jsAcc}\n${ex.code}` : ex.code;
        if (!judged) continue;
        const mod = await extractTs(jsAcc, { module: `${pseudoModule(repo, page.path)}_js`, path: page.path, tsx: true }).catch(() => undefined);
        if (!mod) continue;
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const m of table.checkModule(repo, mod, startLine).filter(keep)) out.push({ path: page.path, line: ex.lineno + (m.line - startLine), mismatch: m });
        } finally {
          dispose();
        }
      }
    }
  }
  return out;
}

/** An example mismatch as a lint finding, located on the call as written in the page. */
export function exampleFinding(e: ExampleMismatch, lines: string[]): RawFinding {
  const text = lines[e.line - 1] ?? '';
  const needle = e.mismatch.text || e.mismatch.name.split('.').pop() || '';
  const at = needle ? text.indexOf(needle) : -1;
  const column = at >= 0 ? at + 1 : Math.max(1, text.length - text.trimStart().length + 1);
  const endColumn = at >= 0 ? at + 1 + needle.length : text.length + 1;
  const detail = e.mismatch.detail.replace(/\.?$/, '.');
  return {
    rule: `example-${e.mismatch.kind}` as RawFinding['rule'],
    span: { text: needle, line: e.line, column, endColumn },
    subject: e.mismatch.name,
    message: detail,
    looked: e.mismatch.target.replace(/^[^:]+:/, ''),
    target: e.mismatch.target,
  };
}
