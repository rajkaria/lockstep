import type { Expr, PyBinding, PyCall, PyDef, PyModule } from './python.js';
import { exprText } from './python.js';
import { GO_PACKAGE_MODULES, goImportPath } from './go.js';
import { checkArgs, trustsSignature, type MismatchKind, type SourceLang } from './signature.js';
import { NPM_NAMES } from './typescript.js';

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
  | { t: 'module'; name: string }
  /** Something from a package outside the organisation (redis, asyncio, ...). */
  | { t: 'external'; name: string };

/**
 * Method names too generic to resolve by name alone: a by-name edge to every
 * `get` in a dependency would drown the real paths.
 */
export const GENERIC = new Set([
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

/** A docs example line that no longer fits the code it reaches (see `SymbolTable.checkModule`). */
export interface Mismatch {
  kind: MismatchKind;
  /** Line in the checked module. */
  line: number;
  /** The symbol the finding is about: the callee, or the module/class missing a name. */
  target: string;
  /** The missing name or the callee's qualified name. */
  name: string;
  detail: string;
  /** Source text of the callee or import target. */
  text: string;
}

/**
 * External base classes that add no attributes a docs example would call
 * (so a class built on them still has a closed set of members).
 */
const INERT_BASES = new Set(['object', 'ABC', 'abc.ABC', 'Generic', 'typing.Generic', 'Protocol', 'typing.Protocol']);

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
  /** Modules registered by `addEphemeral` (a docs page's examples), not the organisation's code. */
  private readonly ephemeral = new Set<string>();

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

  /**
   * Temporarily register a module that is not library code (a docs page's examples),
   * so its own bindings resolve; its definitions never become by-name candidates.
   * Returns a disposer.
   */
  addEphemeral(repo: string, mod: PyModule): () => void {
    this.modules.set(mod.module, { mod, repo });
    this.ephemeral.add(mod.module);
    const infos: SymbolInfo[] = mod.defs.map((def) => ({ id: symbolId(repo, def.qualname), repo, module: mod.module, def }));
    for (const info of infos) push(this.byQualname, info.def.qualname, info);
    for (const b of mod.bindings) push(this.bindingsByScope, b.scope, b);
    return () => {
      this.modules.delete(mod.module);
      this.ephemeral.delete(mod.module);
      for (const info of infos) {
        const arr = this.byQualname.get(info.def.qualname)?.filter((x) => x !== info);
        if (arr?.length) this.byQualname.set(info.def.qualname, arr);
        else this.byQualname.delete(info.def.qualname);
      }
      for (const b of mod.bindings) {
        const arr = this.bindingsByScope.get(b.scope)?.filter((x) => x !== b);
        if (arr?.length) this.bindingsByScope.set(b.scope, arr);
        else this.bindingsByScope.delete(b.scope);
      }
    };
  }

  /**
   * Symbols a prose mention like `Graph.ro_query`, `falkordb.FalkorDB` or `select_graph()`
   * refers to. Fully qualified names resolve exactly; `Class.member` matches by suffix
   * anywhere in the org; a bare name links only when it looks like code (a call, a
   * snake_case or PascalCase name) and only into `contextRepos` — the repositories
   * the page itself is about.
   */
  matchMention(
    ident: string,
    opts: { called?: boolean; codeRepos?: Set<string>; contextRepos?: Set<string> } = {},
  ): { sym: SymbolInfo; resolved: Resolution }[] {
    const inOrg = (s: SymbolInfo) => (!opts.codeRepos || opts.codeRepos.has(s.repo)) && s.def.kind !== 'module';
    const parts = ident.split('.');
    if (parts.length >= 2) {
      const exact = this.resolveDotted(ident);
      if (exact?.t === 'sym' && inOrg(exact.sym)) return [{ sym: exact.sym, resolved: 'exact' }];
      const last = parts[parts.length - 1]!;
      const suffix = (this.byName.get(last) ?? []).filter((s) => inOrg(s) && s.def.qualname.endsWith(`.${ident}`));
      if (suffix.length > 0 && suffix.length <= MAX_BY_NAME) return suffix.map((sym) => ({ sym, resolved: 'by-name' }));
      // `db.select_graph()`: an instance variable in prose; fall back to the member name.
      if (/^[a-z_]/.test(parts[0]!) && !this.packageRepos.has(parts[0]!)) return this.matchMention(last, opts);
      return [];
    }
    if (ident.length < 3 || GENERIC.has(ident) || ident.startsWith('_')) return [];
    const looksLikeCode = opts.called || ident.includes('_') || /[A-Z]/.test(ident);
    if (!looksLikeCode) return [];
    const named = (this.byName.get(ident) ?? []).filter(
      (s) =>
        inOrg(s) &&
        (!opts.contextRepos || opts.contextRepos.has(s.repo)) &&
        !s.def.decorators.some((d) => d === 'property' || d.endsWith('cached_property') || d.endsWith('.setter')),
    );
    if (named.length === 0 || named.length > MAX_BY_NAME) return [];
    return named.map((sym) => ({ sym, resolved: 'by-name' }));
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
        const init = this.findMethod(v.sym, '__init__', 0) ?? this.findMethod(v.sym, 'constructor', 0);
        if (init) targets.push({ to: init.id, resolved: 'exact' });
      }
      return targets;
    }
    // By-name fallback: `<unknown receiver>.method()` where `method` is defined in a
    // repository this module imports from (or its own repository).
    if (call.fn.k === 'attr' && (v === undefined || v.t === 'external')) {
      if (v?.t === 'external' || this.evalExpr(call.fn.obj, ctx)?.t === 'external') return [];
      const name = call.fn.attr;
      // Go's exported methods are capitalised (`Close`, `Get`): just as generic.
      if (GENERIC.has(name) || name.startsWith('__') || (mod.lang === 'go' && GENERIC.has(name.charAt(0).toLowerCase() + name.slice(1)))) return [];
      const candidates = (this.byName.get(name) ?? []).filter(
        (s) => (s.def.kind === 'method' || s.def.kind === 'function') && reachable.has(s.repo),
      );
      if (candidates.length === 0 || candidates.length > MAX_BY_NAME) return [];
      return candidates.map((s) => ({ to: s.id, resolved: 'by-name' as const }));
    }
    return [];
  }

  /**
   * Static checks of a module that uses the organisation's code (a docs page's examples):
   * names imported from the org's packages that do not exist, attributes called on org
   * modules and classes that do not exist, and calls whose arguments the target's
   * signature rejects. Only exact resolutions are checked, and a check is skipped
   * whenever the code could supply the name or accept the call dynamically
   * (`__getattr__`, external base classes, metaclasses, decorators, splats).
   */
  checkModule(repo: string, mod: PyModule, fromLine = 1): Mismatch[] {
    const out: Mismatch[] = [];
    const listed = this.listingCalls(repo, mod, fromLine);
    for (const imp of mod.imports) {
      if (imp.lineno < fromLine || imp.alias === '*') continue;
      const m = this.missingImport(imp.target);
      if (m) out.push({ ...m, line: imp.lineno, text: imp.target });
    }
    for (const call of mod.calls) {
      if (call.lineno < fromLine) continue;
      const ctx: Ctx = { repo, mod, scope: call.scope, depth: 0, seen: new Set() };
      if (call.fn.k === 'attr' && !call.fn.attr.startsWith('__')) {
        const base = this.evalExpr(call.fn.obj, ctx);
        const missing = base ? this.missingMember(base, call.fn.attr, ctx) : undefined;
        if (missing) {
          out.push({ ...missing, line: call.lineno, text: call.text });
          continue;
        }
      }
      if (!call.args) continue;
      const target = this.callTarget(call, ctx);
      if (!target) continue;
      const found = checkArgs(call.args, target.def.arity!, { dropFirst: target.dropFirst, callee: target.label, lang: this.langOf(target.sym) });
      // A constructor is called through its class by name: no subclass is involved.
      const viaInstance = target.sym.def.kind === 'method' && target.sym.def.name !== '__init__' && target.sym.def.name !== 'constructor';
      if (found.length && viaInstance && this.overrideAccepts(target.sym, call.args, target.dropFirst)) continue;
      for (const a of found) {
        if (a.kind === 'missing-argument' && call.args.positional === 0 && listed.has(call)) continue;
        out.push({ kind: a.kind, line: call.lineno, target: target.sym.id, name: target.sym.def.qualname, detail: a.detail, text: call.text });
      }
    }
    return out;
  }

  /**
   * Calls in a block that lists a package's API rather than using it: three or more
   * statements like `z.map();`, `z.set();` on one imported module (`z.refine()` among
   * `z.regex(regex)`). An empty argument list there names the function; it does not call
   * it with nothing. Calls on objects (`db.close();`) are never a listing.
   */
  private listingCalls(repo: string, mod: PyModule, fromLine: number): Set<PyCall> {
    const byReceiver = new Map<string, PyCall[]>();
    for (const c of mod.calls) {
      if (!c.bare || c.lineno < fromLine || c.fn.k !== 'attr') continue;
      const recv = exprText(c.fn.obj);
      byReceiver.set(recv, [...(byReceiver.get(recv) ?? []), c]);
    }
    const out = new Set<PyCall>();
    for (const calls of byReceiver.values()) {
      if (new Set(calls.map((c) => c.lineno)).size < 3) continue;
      const c = calls[0]!;
      const recv = c.fn.k === 'attr' ? this.evalExpr(c.fn.obj, { repo, mod, scope: c.scope, depth: 0, seen: new Set() }) : undefined;
      if (recv?.t === 'module') for (const x of calls) out.add(x);
    }
    return out;
  }

  /** `from pkg.mod import Name` where `pkg` is the org's and `Name` exists nowhere. */
  private missingImport(target: string): Omit<Mismatch, 'line' | 'text'> | undefined {
    const parts = target.split('.');
    if (parts.length < 2 || !this.packageRepos.has(parts[0]!)) return undefined;
    if (this.modules.has(target) || this.resolveDotted(target)) return undefined;
    // Go imports name packages: a directory with Go files is one, even if nothing in it was indexed (tests, examples).
    if (target.startsWith('go-') && GO_PACKAGE_MODULES.has(target)) return undefined;
    // The longest prefix that is a real module of the org.
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join('.');
      const entry = this.modules.get(prefix);
      if (!entry) continue;
      const name = parts[i]!;
      if (!this.moduleIsClosed(prefix) || this.moduleBinds(prefix, name)) return undefined;
      const sym = this.symbol(prefix, entry.repo);
      if (!sym) return undefined;
      return {
        kind: 'missing-import',
        target: sym.id,
        name,
        detail: target.startsWith('go-')
          ? `\`${shown(target)}\` is not a package of \`${shown(prefix)}\``
          : i === parts.length - 1
            ? `\`${shown(prefix)}\` has no \`${name}\``
            : `\`${shown(prefix)}\` has no module \`${name}\``,
      };
    }
    return undefined;
  }

  /** `mod.gone()`, `Cls.gone()`, `obj.gone()` on an org module or a class whose members are all known. */
  private missingMember(base: Val, attr: string, ctx: Ctx): Omit<Mismatch, 'line' | 'text'> | undefined {
    if (base.t === 'module') {
      const entry = this.modules.get(base.name);
      if (entry?.mod.lang === 'go') {
        const own = this.symbol(`${base.name}.${attr}`, entry.repo);
        if (own && own.def.decorators.includes('private')) {
          return { kind: 'missing-attribute', target: own.id, name: attr, detail: `\`${attr}\` is unexported in \`${shown(base.name)}\`` };
        }
      }
      if (!entry || this.resolveDotted(`${base.name}.${attr}`, 0, ctx.repo)) return undefined;
      if (!this.moduleIsClosed(base.name) || this.moduleBinds(base.name, attr)) return undefined;
      const sym = this.symbol(base.name, entry.repo);
      return sym ? { kind: 'missing-attribute', target: sym.id, name: attr, detail: `\`${shown(base.name)}\` has no \`${attr}\`` } : undefined;
    }
    const cls = base.t === 'instance' ? base.cls : base.t === 'sym' && base.sym.def.kind === 'class' ? base.sym : undefined;
    if (!cls) return undefined;
    // Go: an unexported method can't be called from another package (a docs example is one).
    const method = this.findMethod(cls, attr, 0);
    if (method && this.langOf(method) === 'go' && method.def.decorators.includes('private')) {
      return { kind: 'missing-attribute', target: method.id, name: attr, detail: `\`${cls.def.name}.${attr}\` is unexported` };
    }
    if (!this.classIsClosed(cls)) return undefined;
    if (method || this.classHas(cls, attr, 0)) return undefined;
    // A subclass has it: the value may well be one (`isinstance`/type-guard narrowing, a factory's
    // declared base type), so the declared class is not the whole story.
    if (this.subclassHas(cls, attr)) return undefined;
    return {
      kind: 'missing-attribute',
      target: cls.id,
      name: attr,
      detail: `\`${cls.def.name}\` has no attribute \`${attr}\``,
    };
  }

  /**
   * A prose reference `owner.member` (`Client.query_v2`, `falkordb.connect_async`) whose
   * owner is an org class or module, by its dotted name, and whose member does not exist.
   * Undefined when the member exists, when the owner is not the org's, or when the owner
   * may supply names the source does not show (the same guards as `missing-attribute`).
   * `members` are the names that do exist (fix candidates).
   */
  memberMissing(owner: string, member: string, preferRepo?: string): { owner: SymbolInfo; kind: 'class' | 'module'; members: string[] } | undefined {
    const v = this.resolveDotted(owner, 0, preferRepo);
    if (v?.t === 'module') {
      const entry = this.modules.get(v.name);
      if (!entry || this.resolveDotted(`${v.name}.${member}`, 0, entry.repo)) return undefined;
      if (!this.moduleIsClosed(v.name) || this.moduleBinds(v.name, member)) return undefined;
      const sym = this.symbol(v.name, entry.repo);
      if (!sym) return undefined;
      const members = new Set<string>();
      for (const d of entry.mod.defs) if (d.parent === v.name) members.add(d.name);
      for (const i of entry.mod.imports) if (i.alias !== '*' && !i.alias.includes('.')) members.add(i.alias);
      for (const b of this.bindingsByScope.get(v.name) ?? []) members.add(b.target);
      for (const m of this.modules.keys()) if (m.startsWith(`${v.name}.`) && !m.slice(v.name.length + 1).includes('.')) members.add(m.slice(v.name.length + 1));
      return { owner: sym, kind: 'module', members: [...members].sort() };
    }
    if (v?.t !== 'sym' || v.sym.def.kind !== 'class') return undefined;
    const cls = v.sym;
    if (!this.classIsClosed(cls) || this.findMethod(cls, member, 0) || this.classHas(cls, member, 0)) return undefined;
    const members = new Set<string>();
    const collect = (c: SymbolInfo, depth: number) => {
      if (depth > 8) return;
      for (const [q, infos] of this.byQualname) {
        if (q.startsWith(`${c.def.qualname}.`) && !q.slice(c.def.qualname.length + 1).includes('.') && infos.some((i) => i.repo === c.repo)) members.add(q.slice(c.def.qualname.length + 1));
      }
      for (const b of this.bindingsByScope.get(c.def.qualname) ?? []) members.add(b.target.replace(/^self\./, ''));
      for (const b of this.basesOf(c)) collect(b, depth + 1);
    };
    collect(cls, 0);
    return { owner: cls, kind: 'class', members: [...members].sort() };
  }

  /** The function a call reaches, if its signature can be trusted to judge the call. */
  private callTarget(call: PyCall, ctx: Ctx): { sym: SymbolInfo; def: PyDef; dropFirst: boolean; label: string } | undefined {
    const v = this.evalExpr(call.fn, ctx);
    if (v?.t !== 'sym') return undefined;
    const sym = v.sym;
    const lang = this.langOf(sym);
    if (lang !== 'python') return this.callTargetTyped(call, ctx, sym, lang);
    if (sym.def.kind === 'class') {
      if (!this.classIsClosed(sym) || this.findMethod(sym, '__new__', 0)) return undefined;
      const init = this.findMethod(sym, '__init__', 0);
      if (!init || !this.trusted(init)) return undefined;
      return { sym: init, def: init.def, dropFirst: true, label: sym.def.name };
    }
    if (sym.def.kind !== 'function' && sym.def.kind !== 'method') return undefined;
    if (!this.trusted(sym)) return undefined;
    const label = sym.def.kind === 'method' ? `${sym.def.parent?.split('.').pop()}.${sym.def.name}` : sym.def.name;
    if (sym.def.kind === 'function') return { sym, def: sym.def, dropFirst: false, label };
    const isStatic = sym.def.decorators.includes('staticmethod');
    const isClassMethod = sym.def.decorators.includes('classmethod');
    if (isStatic) return { sym, def: sym.def, dropFirst: false, label };
    if (isClassMethod) return { sym, def: sym.def, dropFirst: true, label };
    // A plain method: bound when reached through an instance, unbound through the class.
    if (call.fn.k !== 'attr') return undefined;
    const recv = this.evalExpr(call.fn.obj, ctx);
    if (recv?.t === 'instance') return { sym, def: sym.def, dropFirst: true, label };
    if (recv?.t === 'sym' && recv.sym.def.kind === 'class') return { sym, def: sym.def, dropFirst: false, label };
    return undefined;
  }

  /**
   * TypeScript/JavaScript and Go have no bound first parameter: a method's parameters are
   * what the call passes. `new X(...)` checks X's constructor (its own or an org base's);
   * a Go type called is a conversion, and a method through its type is a method expression,
   * neither judged.
   */
  private callTargetTyped(call: PyCall, ctx: Ctx, sym: SymbolInfo, lang: SourceLang): { sym: SymbolInfo; def: PyDef; dropFirst: boolean; label: string } | undefined {
    if (sym.def.kind === 'class') {
      if (lang !== 'ts') return undefined;
      const ctor = this.findMethod(sym, 'constructor', 0);
      if (!ctor || !this.trusted(ctor)) return undefined;
      return { sym: ctor, def: ctor.def, dropFirst: false, label: sym.def.name };
    }
    if (sym.def.kind !== 'function' && sym.def.kind !== 'method') return undefined;
    if (!this.trusted(sym)) return undefined;
    if (sym.def.kind === 'function') return { sym, def: sym.def, dropFirst: false, label: sym.def.name };
    const label = `${sym.def.parent?.split('.').pop()}.${sym.def.name}`;
    if (call.fn.k !== 'attr') return undefined;
    const recv = this.evalExpr(call.fn.obj, ctx);
    if (recv?.t === 'instance') return sym.def.decorators.includes('staticmethod') ? undefined : { sym, def: sym.def, dropFirst: false, label };
    if (recv?.t === 'sym' && recv.sym.def.kind === 'class' && lang === 'ts' && sym.def.decorators.includes('staticmethod')) return { sym, def: sym.def, dropFirst: false, label };
    return undefined;
  }

  /** The language a symbol is written in (its module's). */
  langOf(sym: SymbolInfo): SourceLang {
    const lang = this.modules.get(sym.module)?.mod.lang;
    return lang === 'ts' || lang === 'go' ? lang : 'python';
  }

  /** One definition, a signature-preserving decorator stack, and a parsed arity. */
  private trusted(sym: SymbolInfo): boolean {
    if (!sym.def.arity || !trustsSignature(sym.def.decorators)) return false;
    if (sym.def.decorators.some((d) => d === 'property' || d.endsWith('.setter') || d.endsWith('cached_property'))) return false;
    // `@overload` stubs or conditional definitions: more than one def under the name.
    return (this.byQualname.get(sym.def.qualname) ?? []).filter((s) => s.repo === sym.repo).length === 1;
  }

  /** A module whose names are all visible: no module `__getattr__`, no star import from outside the org. */
  private moduleIsClosed(module: string): boolean {
    const entry = this.modules.get(module);
    if (!entry) return false;
    if (this.symbol(`${module}.__getattr__`, entry.repo)) return false;
    return entry.mod.imports.every((i) => i.alias !== '*' || this.packageRepos.has(i.target.split('.')[0]!));
  }

  /**
   * A module-level assignment, import or type declaration binds the name (`__version__ = ...`,
   * `Graph = _Graph`, `export interface Options`), here or in a module it star-imports.
   */
  private moduleBinds(module: string, name: string, depth = 0): boolean {
    const entry = this.modules.get(module);
    if (!entry || depth > 6) return false;
    if (entry.mod.imports.some((i) => i.alias === name)) return true;
    if ((this.bindingsByScope.get(module) ?? []).some((b) => b.target === name)) return true;
    return entry.mod.imports.some((i) => i.alias === '*' && this.moduleBinds(i.target, name, depth + 1));
  }

  /**
   * Every member of the class is visible in the org's source: bases are org classes
   * (or inert ones like `ABC`), no class decorators, no metaclass, no `__getattr__`.
   */
  private classIsClosed(cls: SymbolInfo, depth = 0): boolean {
    if (depth > 8) return false;
    if (cls.def.decorators.length > 0 || /metaclass\s*=/.test(cls.def.signature)) return false;
    if (this.findMethod(cls, '__getattr__', 0) || this.findMethod(cls, '__getattribute__', 0)) return false;
    const orgBases = this.basesOf(cls);
    const external = cls.def.bases.filter((b) => !INERT_BASES.has(b.replace(/\[.*$/s, '').trim()));
    if (orgBases.length < external.length) return false;
    return orgBases.every((b) => this.classIsClosed(b, depth + 1));
  }

  private subclassIndex: Map<string, SymbolInfo[]> | undefined;

  /** Whether an org class derived from `cls` (at any depth) defines `attr`. */
  /** The organisation's classes derived from `cls`, at any depth (docs examples' own classes left out). */
  private subclassesOf(cls: SymbolInfo): SymbolInfo[] {
    if (!this.subclassIndex) {
      // Built once, on the first candidate finding: base → direct subclasses.
      this.subclassIndex = new Map();
      for (const infos of this.byQualname.values()) {
        for (const c of infos) {
          if (c.def.kind !== 'class' || !c.def.bases.length || !this.modules.has(c.module) || this.ephemeral.has(c.module)) continue;
          for (const b of this.basesOf(c)) push(this.subclassIndex, b.id, c);
        }
      }
    }
    const out = new Map<string, SymbolInfo>();
    const queue = [...(this.subclassIndex.get(cls.id) ?? [])];
    while (queue.length && out.size <= 200) {
      const c = queue.shift()!;
      if (out.has(c.id)) continue;
      out.set(c.id, c);
      queue.push(...(this.subclassIndex.get(c.id) ?? []));
    }
    return [...out.values()];
  }

  /** Whether an org class derived from `cls` (at any depth) defines `attr`. */
  private subclassHas(cls: SymbolInfo, attr: string): boolean {
    return this.subclassesOf(cls).some((c) => this.symbol(`${c.def.qualname}.${attr}`, c.repo) || this.classHas(c, attr, 0));
  }

  /**
   * Whether a subclass's override of a method accepts the call its base rejects: the value
   * may be that subclass (a factory typed with the base), so the call is not judged.
   */
  private overrideAccepts(method: SymbolInfo, args: NonNullable<PyCall['args']>, dropFirst: boolean): boolean {
    const cls = method.def.parent ? this.symbol(method.def.parent, method.repo) : undefined;
    if (cls?.def.kind !== 'class') return false;
    return this.subclassesOf(cls).some((c) => {
      const m = this.symbol(`${c.def.qualname}.${method.def.name}`, c.repo);
      return !!m?.def.arity && checkArgs(args, m.def.arity, { dropFirst, callee: '' }).length === 0;
    });
  }

  /** Class-level names: `X = 1`, `y: int`, `self.z = ...` in any method, through org bases. */
  private classHas(cls: SymbolInfo, attr: string, depth: number): boolean {
    if (depth > 8) return false;
    const bindings = this.bindingsByScope.get(cls.def.qualname) ?? [];
    if (bindings.some((b) => b.target === attr || b.target === `self.${attr}`)) return true;
    return this.basesOf(cls).some((b) => this.classHas(b, attr, depth + 1));
  }

  /**
   * The repository's public API as its packages export it: names bound in a public
   * package's `__init__` (or a top-level module) that resolve to the org's definitions,
   * plus the public methods of exported classes and of their org base classes.
   */
  exportedIds(repo: string, modules: PyModule[]): Set<string> {
    const out = new Set<string>();
    const isPrivate = (q: string) => q.split('.').some((p) => p.startsWith('_') && !/^__.*__$/.test(p));
    const addClass = (cls: SymbolInfo, depth = 0) => {
      if (depth > 6) return;
      out.add(cls.id);
      for (const [q, infos] of this.byQualname) {
        if (!q.startsWith(`${cls.def.qualname}.`) || q.slice(cls.def.qualname.length + 1).includes('.')) continue;
        for (const m of infos) if (m.repo === cls.repo && m.def.kind === 'method' && !m.def.name.startsWith('_') && !m.def.decorators.includes('private')) out.add(m.id);
      }
      for (const b of this.basesOf(cls)) addClass(b, depth + 1);
    };
    /** Public names a module binds, following `from x import *` into the org's modules. */
    const namesOf = (module: string, depth = 0): Map<string, string> => {
      const names = new Map<string, string>();
      const entry = this.modules.get(module);
      if (!entry || depth > 4) return names;
      // TypeScript exports only what it says it exports; a Python module offers every name it binds.
      const ts = entry.mod.lang === 'ts';
      for (const d of entry.mod.defs) {
        if (d.parent === module && !d.name.startsWith('_') && !(ts && d.decorators.includes('internal'))) names.set(d.name, `${module}.${d.name}`);
      }
      for (const i of entry.mod.imports) {
        if (ts && !i.exported) continue;
        if (i.alias === '*') {
          for (const [n, q] of namesOf(i.target, depth + 1)) if (!names.has(n)) names.set(n, q);
        } else if (!i.alias.includes('.') && !i.alias.startsWith('_')) {
          names.set(i.alias, `${module}.${i.alias}`);
        }
      }
      return names;
    };
    for (const mod of modules) {
      // Go exports what is capitalised, from packages other code can import (not `main`, not under `internal/`).
      if (mod.lang === 'go') {
        if (mod.defs[0]?.signature === 'package main' || mod.module.split('.').slice(1).includes('internal')) continue;
        for (const d of mod.defs) {
          if (d.parent !== mod.module || d.decorators.includes('private')) continue;
          const info = this.symbol(d.qualname, repo);
          if (info?.def.kind === 'class') addClass(info);
          else if (info?.def.kind === 'function') out.add(info.id);
        }
        continue;
      }
      const isInit = /(^|\/)__init__\.py$/.test(mod.path) || (mod.lang === 'ts' && !mod.module.includes('.'));
      if ((!isInit && mod.module.includes('.')) || isPrivate(mod.module)) continue;
      // PEP 562 lazy exports: what the package offers isn't visible in its source.
      if (mod.defs.some((d) => d.parent === mod.module && d.name === '__getattr__')) return new Set();
      for (const dotted of namesOf(mod.module).values()) {
        const v = this.resolveDotted(dotted, 0, repo);
        if (v?.t !== 'sym' || v.sym.repo !== repo) continue;
        if (v.sym.def.kind === 'class') addClass(v.sym);
        else out.add(v.sym.id);
      }
    }
    return out;
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
    if (direct?.def.kind === 'module') {
      // `export { legacy } from './legacy'` (or `from .legacy import legacy`): the package's own
      // binding of the name shadows the submodule of the same name.
      const cut = dotted.lastIndexOf('.');
      const rebound = cut > 0 ? this.modules.get(dotted.slice(0, cut))?.mod.imports.find((i) => i.alias === dotted.slice(cut + 1) && i.target !== dotted) : undefined;
      if (rebound) return this.resolveDotted(rebound.target, depth + 1, preferRepo);
      return { t: 'module', name: dotted };
    }
    if (direct) return { t: 'sym', sym: direct };
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
    if (imp) {
      // resolveDotted counts its own recursion: an example's long chain of bindings must not use it up.
      const resolved = this.resolveDotted(imp.target, 0, ctx.repo);
      if (resolved) return resolved;
      const top = imp.target.split('.')[0]!;
      return this.packageRepos.has(top) ? { t: 'module', name: imp.target } : { t: 'external', name: imp.target };
    }
    for (const star of mod.imports.filter((x) => x.alias === '*')) {
      const v = this.resolveDotted(`${star.target}.${name}`, 0, ctx.repo);
      if (v) return v;
    }
    return undefined;
  }

  private bindingFor(scope: string, name: string, ctx: Ctx): Val | undefined {
    const bindings = this.bindingsByScope.get(scope)?.filter((b) => b.target === name);
    if (!bindings?.length) return undefined;
    // Annotated bindings are the most reliable; then the latest assignment that evaluates.
    // A binding that resolves into the org beats one typed `Any`/external (`self._graph: Any = None`
    // followed by `self._graph = driver.select_graph(...)`).
    const ordered = [...bindings.filter((b) => b.annotation), ...bindings.filter((b) => !b.annotation).reverse()];
    let external: Val | undefined;
    for (const b of ordered) {
      const key = `${b.scope}|${b.target}|${b.lineno}`;
      if (ctx.seen.has(key)) continue;
      const seen = new Set(ctx.seen).add(key);
      const evalCtx: Ctx = { ...ctx, scope: b.at, seen, mod: this.modules.get(this.moduleOf(b.at, ctx))?.mod ?? ctx.mod };
      if (b.annotation) {
        const v = this.fromAnnotation(b.annotation, evalCtx);
        if (v?.t === 'external') external ??= v;
        else if (v) return v;
      }
      if (b.value) {
        const v = this.evalExpr(b.value, evalCtx);
        if (v?.t === 'external') external ??= v;
        else if (v) return v;
      }
    }
    return external;
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
    if (base.t === 'external') return { t: 'external', name: `${base.name}.${attr}` };
    if (base.t === 'module') return this.resolveDotted(`${base.name}.${attr}`, 0, ctx.repo);
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
    if (fn.t === 'external') return { t: 'external', name: `${fn.name}()` };
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
    let external: Val | undefined;
    for (const c of candidates) {
      const [head, ...rest] = c.split('.');
      let v = this.lookupName(head!, ctx);
      for (const r of rest) v = v ? this.member(v, r, ctx) : undefined;
      if (v?.t === 'sym' && v.sym.def.kind === 'class') return { t: 'instance', cls: v.sym };
      if (v?.t === 'instance') return v;
      if (v?.t === 'external') external ??= v;
    }
    // Annotated with a type from outside the org (Any, redis.Redis, ...): known not to be ours.
    return external;
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

/** A module as its users write it: npm packages without the `js-` namespace (`js-falkordb.graph` → `falkordb/graph`). */
export function shown(module: string): string {
  if (module.startsWith('go-')) return goImportPath(module) ?? module.slice(3).replace(/\./g, '/');
  if (!module.startsWith('js-')) return module;
  const [token, ...rest] = module.split('.');
  return [NPM_NAMES.get(token!) ?? token!.slice(3), ...rest].join('/');
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
