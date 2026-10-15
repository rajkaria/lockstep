import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser } from 'web-tree-sitter';

let parserPromise: Promise<Parser> | undefined;

/** Locate the vendored grammar both from src/ (tsx, vitest) and dist/ (published package). */
function grammarPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'grammars', 'tree-sitter-python.wasm');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('tree-sitter-python.wasm not found (expected in <package>/grammars/)');
}

export function pythonParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const language = await Language.load(grammarPath());
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}
