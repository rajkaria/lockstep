import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | undefined;
let initPromise: Promise<void> | undefined;
/** The runtime is loaded once for every grammar. */
const init = () => (initPromise ??= Parser.init());

/** Locate a vendored grammar both from src/ (tsx, vitest) and dist/ (published package). */
function grammarPath(file = 'tree-sitter-python.wasm'): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'grammars', file);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`${file} not found (expected in <package>/grammars/)`);
}

const tsParsers = new Map<boolean, Promise<Parser>>();

/** TypeScript (`.ts`) or TSX (`.tsx`, and JavaScript with JSX) parser. */
export function tsParser(tsx: boolean): Promise<Parser> {
  let p = tsParsers.get(tsx);
  if (!p) {
    p = (async () => {
      await init();
      const language = await Language.load(grammarPath(tsx ? 'tree-sitter-tsx.wasm' : 'tree-sitter-typescript.wasm'));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
    tsParsers.set(tsx, p);
  }
  return p;
}

export function pythonParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await init();
    const language = await Language.load(grammarPath());
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}
