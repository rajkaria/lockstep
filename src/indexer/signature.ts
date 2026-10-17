import { extractGoFile } from './go.js';
import { arityOfSignature } from './python.js';
import { extractTs } from './typescript.js';

/**
 * Static call checking: does a call in a docs example still fit the signature it
 * reaches? Python's own rules, applied to what tree-sitter sees — an unknown keyword,
 * too many positional arguments, a required argument missing. Anything the source
 * can't settle (a `*args` splat at the call, a decorator that may rewrap the function)
 * is left alone: a mismatch reported here should fail the same way when run.
 * JavaScript/TypeScript and Go follow the same model with positional arguments only
 * (`...rest` and `...T` play `*args`; TypeScript's `?` and defaults make a parameter optional).
 */

export interface ArityParam {
  name: string;
  /** `pos-only` before `/`, `kw-only` after `*` or `*args`. */
  kind: 'pos-only' | 'pos' | 'kw-only';
  required: boolean;
}

export interface Arity {
  params: ArityParam[];
  /** `*args` */
  varArgs: boolean;
  /** `**kwargs` */
  varKw: boolean;
}

export interface CallArgs {
  positional: number;
  keywords: string[];
  /** `f(*xs)`: the positional count is unknown. */
  starArgs: boolean;
  /** `f(**opts)`: the keywords are unknown. */
  starKwargs: boolean;
}

export type MismatchKind =
  | 'unknown-keyword'
  | 'too-many-arguments'
  | 'missing-argument'
  | 'missing-import'
  | 'missing-attribute'
  | 'removed';

export const MISMATCH_LABEL: Record<MismatchKind, string> = {
  'unknown-keyword': 'unknown keyword argument',
  'too-many-arguments': 'too many positional arguments',
  'missing-argument': 'missing required argument',
  'missing-import': 'imports a name that does not exist',
  'missing-attribute': 'calls an attribute that does not exist',
  removed: 'calls a removed symbol',
};

export interface ArgMismatch {
  kind: Extract<MismatchKind, 'unknown-keyword' | 'too-many-arguments' | 'missing-argument'>;
  detail: string;
}

/**
 * Decorators known to keep the wrapped function's signature. Any other decorator
 * (click commands, retry wrappers, `functools.wraps` shims) may change what the
 * function accepts, so calls to it are not checked.
 */
const SIGNATURE_PRESERVING = new Set([
  'staticmethod',
  'classmethod',
  'abstractmethod',
  'abc.abstractmethod',
  'override',
  'typing.override',
  'typing_extensions.override',
  'final',
  'typing.final',
  'cache',
  'functools.cache',
  'lru_cache',
  'functools.lru_cache',
  'deprecated',
  'warnings.deprecated',
  'typing_extensions.deprecated',
  'wraps',
]);

export function trustsSignature(decorators: string[]): boolean {
  return decorators.every((d) => SIGNATURE_PRESERVING.has(d.replace(/\(.*$/s, '').trim()));
}

/**
 * Check one call against a signature. `dropFirst` removes the bound `self`/`cls`
 * (a method called on an instance, a classmethod, a constructor's `__init__`).
 */
export function checkArgs(args: CallArgs, arity: Arity, opts: { dropFirst: boolean; callee: string; lang?: SourceLang }): ArgMismatch[] {
  const params = opts.dropFirst ? arity.params.slice(1) : arity.params;
  const positional = params.filter((p) => p.kind !== 'kw-only');
  const byKeyword = new Set(params.filter((p) => p.kind !== 'pos-only').map((p) => p.name));
  const out: ArgMismatch[] = [];

  if (!arity.varKw) {
    for (const k of args.keywords) {
      if (!byKeyword.has(k)) {
        out.push({ kind: 'unknown-keyword', detail: `\`${opts.callee}\` has no parameter \`${k}\`` });
      }
    }
  }
  if (!arity.varArgs && !args.starArgs && args.positional > positional.length) {
    out.push({
      kind: 'too-many-arguments',
      // JavaScript and Go have no keyword arguments: every argument is positional.
      detail:
        opts.lang && opts.lang !== 'python'
          ? `\`${opts.callee}\` takes ${positional.length === 0 ? 'no arguments' : `at most ${positional.length} argument${positional.length === 1 ? '' : 's'}`}; the example passes ${args.positional}`
          : `\`${opts.callee}\` takes at most ${positional.length} positional argument${positional.length === 1 ? '' : 's'}; the example passes ${args.positional}`,
    });
  }
  if (!args.starArgs && !args.starKwargs) {
    const given = new Set(args.keywords);
    const passedPositionally = (p: ArityParam) => p.kind !== 'kw-only' && positional.indexOf(p) < args.positional;
    const missing = params.filter((p) => p.required && !given.has(p.name) && !passedPositionally(p));
    if (missing.length) {
      out.push({
        kind: 'missing-argument',
        detail: `\`${opts.callee}\` requires ${missing.map((p) => `\`${p.name}\``).join(', ')}, which the example does not pass`,
      });
    }
  }
  return out;
}

export type SourceLang = 'python' | 'ts' | 'go';

/** The language a source path is written in (`.py`, JS/TS, `.go`). */
export function langOfPath(path: string | null | undefined): SourceLang {
  if (path && /\.go$/.test(path)) return 'go';
  if (path && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return 'ts';
  return 'python';
}

/**
 * The arity of a signature as stored on the graph, in its own language: Python's
 * `def f(a, *, b=1)`, a TypeScript head (`query(q: string, params?: P): R`,
 * `function connect(url)`, `(a, b = 1) =>`) or Go's `func (g *Graph) Query(q string, opts ...Option) error`.
 * `path` is the defining file: JavaScript files (unlike TypeScript) leave every parameter optional.
 */
export async function arityOf(signature: string, lang: SourceLang, path?: string): Promise<Arity | undefined> {
  const sig = signature.trim();
  if (lang === 'python') return arityOfSignature(sig);
  if (lang === 'go') {
    if (!/^func\b/.test(sig)) return undefined;
    const mod = await extractGoFile(`package sig\n${sig} {}\n`, { module: '__sig__', path: '__sig__.go' });
    return mod.defs.find((d) => d.kind === 'function' || d.kind === 'method')?.arity;
  }
  const js = !!path && /\.(js|jsx|mjs|cjs)$/.test(path);
  const file = js ? '__sig__.js' : '__sig__.ts';
  const head = sig.replace(/[;{]\s*$/, '').trim();
  const wrappers = /^(export\s+)?(default\s+)?(async\s+)?function\b/.test(head)
    ? [`${head} {}`]
    : /=>$/.test(head)
      ? [`const __sig__ = ${head} {};`]
      : [`class __Sig__ { ${head} {} }`, `abstract class __Sig__ { ${head}; }`];
  for (const source of wrappers) {
    const mod = await extractTs(source, { module: '__sig__', path: file, tsx: false }).catch(() => undefined);
    const def = mod?.defs.find((d) => d.kind === 'function' || d.kind === 'method');
    if (def?.arity) return def.arity;
  }
  return undefined;
}
