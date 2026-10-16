/**
 * Static call checking: does a call in a docs example still fit the signature it
 * reaches? Python's own rules, applied to what tree-sitter sees — an unknown keyword,
 * too many positional arguments, a required argument missing. Anything the source
 * can't settle (a `*args` splat at the call, a decorator that may rewrap the function)
 * is left alone: a mismatch reported here should fail the same way when run.
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
export function checkArgs(args: CallArgs, arity: Arity, opts: { dropFirst: boolean; callee: string }): ArgMismatch[] {
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
      detail: `\`${opts.callee}\` takes at most ${positional.length} positional argument${positional.length === 1 ? '' : 's'}; the example passes ${args.positional}`,
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
