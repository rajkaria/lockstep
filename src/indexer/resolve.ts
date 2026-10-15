import type { Expr, PyBinding, PyCall, PyDef, PyModule } from './python.js';
import { exprText } from './python.js';

export type Resolution = 'exact' | 'by-name';

export interface SymbolInfo {
  /** `<repo>:<qualname>` */
  id: string;
  repo: string;
  module: string;
  def: PyDef;
}

export interface ResolvedCall {
  from: string;
  to: string;
  resolved: Resolution;
  line: number;
  text: string;
}

type Val =
  | { t: 'sym'; sym: SymbolInfo }
  | { t: 'instance'; cls: SymbolInfo }
  | { t: 'module'; name: string };

/**
 * Method names too generic to resolve by name alone: a by-name edge to every
 * `get` in a dependency would drown the real paths.
 */
const GENERIC = new Set([
  'get', 'set', 'add', 'pop', 'run', 'close', 'open', 'read', 'write', 'format', 'join', 'split', 'strip',
  'replace', 'lower', 'upper', 'encode', 'decode', 'copy', 'remove', 'sort', 'index', 'count', 'extend',
  'insert', 'clear', 'append', 'items', 'keys', 'values', 'update', 'send', 'start', 'stop', 'load', 'dump',
  'dumps', 'loads', 'exists', 'delete', 'execute', 'call', 'search', 'match', 'parse', 'validate', 'to_dict',
  'from_dict', 'info', 'debug', 'warning', 'error', 'exception', 'log', 'print', 'len', 'str', 'int', 'list',
  'dict', 'isinstance', 'getattr', 'setattr', 'hasattr', 'super', 'next', 'iter', 'range', 'enumerate', 'zip',
  'map', 'filter', 'sum', 'min', 'max', 'any', 'all', 'sorted', 'reversed', 'type', 'object', 'gather', 'sleep',
  'wait', 'wait_for', 'create_task', 'cancel', 'result', 'done', 'flush', 'reset', 'connect', 'disconnect',
  'render', 'process', 'handle', 'apply', 'build', 'create', 'name', 'id', 'text', 'value', 'data', 'size',
])

const MAX_BY_NAME = 4;

/**
 * An organisation-wide symbol table over every indexed Python module, used to
 * resolve call sites (and docs examples) to the symbols they reach — across
 * repositories, through imports, re-exports, attribute types and return types.
 */
export class SymbolTable {
  readonly modules = new Map<string, { mod: PyModule; repo: string }>();
  readonly byQualname = new Map<string, SymbolInfo[]>();
  readonly byName = new Map<string, SymbolInfo[]>();
  /** Top-level import package → repos that define it. */
  readonly packageRepos = new Map<string, Set<string>>();
  private readonly bindingsByScope = new Map<string, PyBinding[]>();

  add(repo: string, mod: PyModule): void {
    this.modules.set(mod.module, { mod, repo });
    const top = mod.module.split('.')[0]!;
    if (!this.packageRepos.has(top)) this.packageRepos.set(top, new Set());
    this.packageRepos.get(top)!.add(repo);
    for (const def of mod.defs) {
      const info: SymbolInfo = { id: symbolId(repo, def.qualname), repo, module: mod.module, def };
      push(this.byQualname, def.qualname, info);
      push(this.byName, def.name, info);
    }
    for (const b of mod.bindings) push(this.bindingsByScope, b.scope, b);
  }

  symbol(qualname: string, preferRepo?: string): SymbolInfo | undefined {
    const all = this.byQualname.get(qualname);
    if (!all?.length) return undefined;
    return all.find((s) => s.repo === preferRepo) ?? all[0];
  }

  /** Resolve every call site in a module. */
  resolveModule(repo: string, mod: PyModule): ResolvedCall[] {
    const out = new Map<string, ResolvedCall>();
    const reachable = this.reposImportedBy(mod, repo);
    for (const call of mod.calls) {
      const fromInfo = this.symbol(call.scope, repo) ?? this.symbol(mod.module, repo);
      if (!fromInfo) continue;
      for (const r of this.resolveCall(repo, mod, call, reachable)) {
        if (r.to === fromInfo.id) continue;
        const key = `${fromInfo.id}->${r.to}`;
        const prev = out.get(key);
        if (!prev || (prev.resolved === 'by-name' && r.resolved === 'exact')) {
          out.set(key, { from: fromInfo.id, to: r.to, resolved: r.resolved, line: call.lineno, text: call.text });
        }
      }
    }
    return [...out.values()];
  }

  resolveCall(
    repo: string,
    mod: PyModule,
    call: PyCall,
    reachable: Set<string> = this.reposImportedBy(mod, repo),
  ): { to: string; resolved: Resolution }[] {
    const ctx: Ctx = { repo, mod, scope: call.scope, depth: 0, seen: new Set() };
    const v = this.evalExpr(call.fn, ctx);
    if (v?.t === 'sym' && v.sym.def.kind !== 'module') {
      const targets = [{ to: v.sym.id, resolved: 'exact' as const }];
      if (v.sym.def.kind === 'class') {
        const init = this.findMethod(v.sym, '__init__', 0);
        if (init) targets.push({ to: init.id, resolved: 'exact' });
      }
      return targets;
    }
    // By-name fallback: `<unknown receiver>.method()` where `method` is defined in a
    // repository this module imports from (or its own repository).
    if (call.fn.k === 'attr' && v === undefined) {
      const name = call.fn.attr;
      if (GENERIC.has(name) || name.startsWith('__')) return [];
      const candidates = (this.byName.get(name) ?? []).filter(
        (s) => (s.def.kind === 'method' || s.def.kind === 'function') && reachable.has(s.repo),
      );
      if (candidates.length === 0 || candidates.length > MAX_BY_NAME) return [];
      return candidates.map((s) => ({ to: s.id, resolved: 'by-name' as const }));
    }
    return [];
  }

  /** Repositories whose packages this module imports (plus its own). */
  reposImportedBy(mod: PyModule, ownRepo?: string): Set<string> {
    const repos = new Set<string>();
    if (ownRepo) repos.add(ownRepo);
    for (const imp of mod.imports) {
      const top = imp.target.split('.')[0]!;
      for (const r of this.packageRepos.get(top) ?? []) repos.add(r);
    }
    return repos;
  }

  /** Resolve an absolute dotted name through modules, definitions and re-exports. */
  resolveDotted(dotted: string, depth = 0, preferRepo?: string): Val | undefined {
    if (depth > 8) return undefined;
    const direct = this.symbol(dotted, preferRepo);
    if (direct) return direct.def.kind === 'module' ? { t: 'module', name: dotted } : { t: 'sym', sym: direct };
    const parts = dotted.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join('.');
      const entry = this.modules.get(prefix);
      if (!entry) continue;
      const head = parts[i]!;
      const rest = parts.slice(i + 1);
      const imp = entry.mod.imports.find((x) => x.alias === head);
      if (imp) {
        const target = [imp.target, ...rest].join('.');
        if (target !== dotted) return this.resolveDotted(target, depth + 1, preferRepo);
      }
      const star = entry.mod.imports.filter((x) => x.alias === '*');
      for (const s of star) {
        const v = this.resolveDotted([s.target, head, ...rest].join('.'), depth + 1, preferRepo);
        if (v) return v;
      }
      // Attribute access on a class reached through a module path, e.g. falkordb.Graph.query
      const clsVal = rest.length ? this.resolveDotted(`${prefix}.${head}`, depth + 1, preferRepo) : undefined;
      if (clsVal?.t === 'sym' && clsVal.sym.def.kind === 'class') {
        let cur: SymbolInfo | undefined = clsVal.sym;
        for (const r of rest) {
          cur = cur ? this.findMethod(cur, r, 0) : undefined;
        }
        if (cur) return { t: 'sym', sym: cur };
      }
      return undefined;
    }
    return undefined;
  }

  private evalExpr(e: Expr, ctx: Ctx): Val | undefined {
    if (ctx.depth > 14) return undefined;
    const next: Ctx = { ...ctx, depth: ctx.depth + 1 };
    switch (e.k) {
      case 'name':
        return this.lookupName(e.id, next);
      case 'attr': {
        const base = this.evalExpr(e.obj, next);
        if (!base) return undefined;
        return this.member(base, e.attr, next);
      }
      case 'call': {
        const fn = this.evalExpr(e.fn, next);
        if (!fn) return undefined;
        return this.callResult(fn, next);
      }
      default:
        return undefined;
    }
  }

  private lookupName(name: string, ctx: Ctx): Val | undefined {
    const { mod } = ctx;
    if (name === 'self') {
      const cls = this.enclosingClass(ctx.scope, ctx.repo);
      return cls ? { t: 'instance', cls } : undefined;
    }
    // Local bindings, innermost scope first, then enclosing scopes up to the module.
    // (Class bodies are not enclosing scopes for their methods, as in Python.)
    let scope: string | undefined = ctx.scope;
    let first = true;
    while (scope) {
      const def: PyDef | undefined = this.symbol(scope, ctx.repo)?.def;
      if (!def) break;
      if (def.kind === 'module') break;
      if (def.kind !== 'class' || first) {
        const b = this.bindingFor(scope, name, ctx);
        if (b) return b;
        if (def.kind !== 'class') {
          const local = this.symbol(`${scope}.${name}`, ctx.repo);
          if (local) return { t: 'sym', sym: local };
        }
      }
      first = false;
      scope = def.parent ?? undefined;
    }
    const moduleBinding = this.bindingFor(mod.module, name, ctx);
    if (moduleBinding) return moduleBinding;
    const local = this.symbol(`${mod.module}.${name}`, ctx.repo);
    if (local) return local.def.kind === 'module' ? { t: 'module', name: local.def.qualname } : { t: 'sym', sym: local };
    const imp = [...mod.imports].reverse().find((x) => x.alias === name);
    if (imp) return this.resolveDotted(imp.target, ctx.depth, ctx.repo) ?? { t: 'module', name: imp.target };
    for (const star of mod.imports.filter((x) => x.alias === '*')) {
      const v = this.resolveDotted(`${star.target}.${name}`, ctx.depth, ctx.repo);
      if (v) return v;
    }
    return undefined;
  }

  private bindingFor(scope: string, name: string, ctx: Ctx): Val | undefined {
    const bindings = this.bindingsByScope.get(scope)?.filter((b) => b.target === name);
    if (!bindings?.length) return undefined;
    // Annotated bindings are the most reliable; then the latest assignment that evaluates.
    const ordered = [...bindings.filter((b) => b.annotation), ...bindings.filter((b) => !b.annotation).reverse()];
    for (const b of ordered) {
      const key = `${b.scope}|${b.target}|${b.lineno}`;
      if (ctx.seen.has(key)) continue;
      const seen = new Set(ctx.seen).add(key);
      const evalCtx: Ctx = { ...ctx, scope: b.at, seen, mod: this.modules.get(this.moduleOf(b.at, ctx))?.mod ?? ctx.mod };
      if (b.annotation) {
        const v = this.fromAnnotation(b.annotation, evalCtx);
        if (v) return v;
      }
      if (b.value) {
        const v = this.evalExpr(b.value, evalCtx);
        if (v) return v;
      }
    }
    return undefined;
  }

  private moduleOf(qualname: string, ctx: Ctx): string {
    let q: string | undefined = qualname;
    while (q) {
      if (this.modules.has(q)) return q;
      q = this.symbol(q, ctx.repo)?.def.parent ?? undefined;
    }
    return ctx.mod.module;
  }

  private member(base: Val, attr: string, ctx: Ctx): Val | undefined {
    if (base.t === 'module') return this.resolveDotted(`${base.name}.${attr}`, ctx.depth, ctx.repo);
    if (base.t === 'sym') {
      if (base.sym.def.kind === 'class') {
        const m = this.findMethod(base.sym, attr, 0);
        if (m) return { t: 'sym', sym: m };
        return this.classAttr(base.sym, attr, ctx);
      }
      return undefined;
    }
    const m = this.findMethod(base.cls, attr, 0);
    if (m) {
      // A @property reads as an attribute: its value is the property's return type.
      if (m.def.decorators.some((d) => d === 'property' || d.endsWith('cached_property'))) {
        return this.callResult({ t: 'sym', sym: m }, ctx);
      }
      return { t: 'sym', sym: m };
    }
    return this.classAttr(base.cls, attr, ctx);
  }

  private classAttr(cls: SymbolInfo, attr: string, ctx: Ctx, depth = 0): Val | undefined {
    if (depth > 6) return undefined;
    const v = this.bindingFor(cls.def.qualname, `self.${attr}`, { ...ctx, repo: cls.repo });
    if (v) return v;
    for (const base of this.basesOf(cls)) {
      const bv = this.classAttr(base, attr, ctx, depth + 1);
      if (bv) return bv;
    }
    return undefined;
  }

  private callResult(fn: Val, ctx: Ctx): Val | undefined {
    if (fn.t !== 'sym') return undefined;
    const def = fn.sym.def;
    if (def.kind === 'class') return { t: 'instance', cls: fn.sym };
    if (def.kind !== 'function' && def.kind !== 'method') return undefined;
    const modEntry = this.modules.get(fn.sym.module);
    const defCtx: Ctx = { ...ctx, repo: fn.sym.repo, mod: modEntry?.mod ?? ctx.mod, scope: def.qualname };
    if (def.returns) {
      const v = this.fromAnnotation(def.returns, defCtx);
      if (v) return v;
    }
    for (const r of def.returnExprs) {
      const key = `return|${def.qualname}`;
      if (ctx.seen.has(key)) break;
      const v = this.evalExpr(r, { ...defCtx, seen: new Set(ctx.seen).add(key) });
      if (v && v.t !== 'module') return v;
    }
    return undefined;
  }

  /** Turn an annotation like `Graph`, `"AsyncGraph"`, `Optional[Graph]`, `Graph | None` into an instance. */
  private fromAnnotation(annotation: string, ctx: Ctx): Val | undefined {
    const cleaned = annotation.replace(/^["']|["']$/g, '').trim();
    const candidates = cleaned
      .replace(/^(Optional|typing\.Optional|Awaitable|typing\.Awaitable|Coroutine)\[(.*)\]$/, '$2')
      .split(/[|,\[\]]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s && s !== 'None' && /^[A-Za-z_][\w.]*$/.test(s));
    for (const c of candidates) {
      const [head, ...rest] = c.split('.');
      let v = this.lookupName(head!, ctx);
      for (const r of rest) v = v ? this.member(v, r, ctx) : undefined;
      if (v?.t === 'sym' && v.sym.def.kind === 'class') return { t: 'instance', cls: v.sym };
      if (v?.t === 'instance') return v;
    }
    return undefined;
  }

  findMethod(cls: SymbolInfo, name: string, depth: number): SymbolInfo | undefined {
    if (depth > 8) return undefined;
    const own = this.symbol(`${cls.def.qualname}.${name}`, cls.repo);
    if (own) return own;
    for (const base of this.basesOf(cls)) {
      const m = this.findMethod(base, name, depth + 1);
      if (m) return m;
    }
    return undefined;
  }

  private basesOf(cls: SymbolInfo): SymbolInfo[] {
    const entry = this.modules.get(cls.module);
    if (!entry) return [];
    const out: SymbolInfo[] = [];
    for (const b of cls.def.bases) {
      const ctx: Ctx = { repo: cls.repo, mod: entry.mod, scope: cls.def.parent ?? cls.module, depth: 0, seen: new Set() };
      const [head, ...rest] = b.replace(/\[.*$/, '').split('.');
      let v = head ? this.lookupName(head, ctx) : undefined;
      for (const r of rest) v = v ? this.member(v, r, ctx) : undefined;
      if (v?.t === 'sym' && v.sym.def.kind === 'class' && v.sym.id !== cls.id) out.push(v.sym);
    }
    return out;
  }

  private enclosingClass(scope: string, repo: string): SymbolInfo | undefined {
    let q: string | undefined = scope;
    while (q) {
      const s = this.symbol(q, repo);
      if (!s) return undefined;
      if (s.def.kind === 'class') return s;
      q = s.def.parent ?? undefined;
    }
    return undefined;
  }
}

interface Ctx {
  repo: string;
  mod: PyModule;
  scope: string;
  depth: number;
  seen: Set<string>;
}

export function symbolId(repo: string, qualname: string): string {
  return `${repo}:${qualname}`;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export { exprText };
