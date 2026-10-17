import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Expr, PyBinding, PyCall, PyDef, PyImport, PyModule, PyParam } from './python.js';
import type { Arity, ArityParam, CallArgs } from './signature.js';
import { goParser } from './treesitter.js';

/**
 * Go, read into the same module shape as Python and TypeScript so one resolver and one
 * graph serve all three. A Go package (a directory) is one module, named `go-<module
 * path>` (from `go.mod`) plus its directory inside the module, so Go names never collide
 * with Python's or npm's. Functions, methods (on their receiver's type), struct and
 * interface types (embedded types as bases, fields as attributes), package-level consts
 * and vars, imports and call sites with their argument counts. Exported-ness is Go's: a
 * name that starts with a capital letter. Unexported names are marked `private`.
 */

/** Go module paths indexed so far → module token; tokens back to paths (for messages). */
export const GO_MODULES = new Map<string, string>();
export const GO_NAMES = new Map<string, string>();
/** Every package directory of an indexed module: import path → declared package name ('' when not read). */
export const GO_PACKAGES = new Map<string, string>();
/** Module names of those directories (a directory of only tests or examples is a package too). */
export const GO_PACKAGE_MODULES = new Set<string>();

/** The top-level module segment for a Go module path: `github.com/acme/x/v2` → `go-github-com-acme-x-v2`. */
export function goToken(modulePath: string): string {
  const token = `go-${modulePath.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
  GO_NAMES.set(token, modulePath);
  return token;
}

export function registerGoModule(modulePath: string): string {
  const token = goToken(modulePath);
  GO_MODULES.set(modulePath, token);
  return token;
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The module name an import path names: inside an indexed module, its token plus the directories; else one external token. */
export function goModuleOf(importPath: string): string {
  let best = '';
  for (const m of GO_MODULES.keys()) if ((importPath === m || importPath.startsWith(`${m}/`)) && m.length > best.length) best = m;
  if (!best) return goToken(importPath);
  const rest = importPath.slice(best.length).split('/').filter(Boolean).map(sanitizeSegment);
  return [GO_MODULES.get(best)!, ...rest].join('.');
}

/** A Go module name as its users write it: `go-github-com-acme-x.sub` → `github.com/acme/x/sub`. */
export function goImportPath(module: string): string | undefined {
  const [token, ...rest] = module.split('.');
  const base = GO_NAMES.get(token!);
  return base === undefined ? undefined : [base, ...rest].join('/');
}

/**
 * The name an import binds without an alias: the package's declared name when it was
 * indexed, else the convention (`.../v5` → the element before it, `gopkg.in/yaml.v3` →
 * `yaml`, `go-redis` → `redis`).
 */
export function goPackageName(importPath: string): string {
  const known = GO_PACKAGES.get(importPath);
  if (known) return known;
  const parts = importPath.split('/');
  let last = parts.pop() ?? importPath;
  if (/^v\d+$/.test(last) && parts.length) last = parts.pop()!;
  return last.replace(/\.v\d+$/, '').replace(/^go-/, '').replace(/-go$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}

const exported = (name: string) => /^\p{Lu}/u.test(name);

/** A type as an annotation the resolver can follow: `*Graph` → `Graph`, `pkg.T`; slices, maps, funcs and chans are not instances. */
function annotation(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'pointer_type':
    case 'parenthesized_type':
      return annotation(node.namedChildren[0]);
    case 'type_identifier':
    case 'qualified_type':
      return node.text.replace(/\s+/g, '');
    case 'generic_type':
      return annotation(node.childForFieldName('type'));
    default:
      return undefined;
  }
}

/** What a call passes: positional only, `xs...` hides the count, and so does a lone call (`f(g())` may pass all of g's results). */
export function goCallArgs(node: Node | null): CallArgs | undefined {
  if (!node || node.type !== 'argument_list' || node.hasError) return undefined;
  const out: CallArgs = { positional: 0, keywords: [], starArgs: false, starKwargs: false };
  const args = node.namedChildren.filter((c): c is Node => !!c && c.type !== 'comment');
  for (const c of args) {
    if (c.type === 'variadic_argument') out.starArgs = true;
    else out.positional++;
  }
  if (args.length === 1 && args[0]!.type === 'call_expression') out.starArgs = true;
  return out;
}

/** A parameter list's arity: every parameter is required, `...T` takes the rest. */
export function goArity(node: Node | null): Arity {
  const params: ArityParam[] = [];
  let varArgs = false;
  for (const c of node?.namedChildren ?? []) {
    if (!c) continue;
    if (c.type === 'variadic_parameter_declaration') {
      varArgs = true;
    } else if (c.type === 'parameter_declaration') {
      const names = c.childrenForFieldName('name').filter((n): n is Node => !!n);
      if (names.length === 0) params.push({ name: `arg${params.length + 1}`, kind: 'pos', required: true });
      for (const n of names) params.push({ name: n.text, kind: 'pos', required: true });
    }
  }
  return { params, varArgs, varKw: false };
}

export interface GoExtractOptions {
  /** The package's module name (`go-<module path>[.<dir>…]`). */
  module: string;
  path: string;
}

/**
 * One Go file. Imports keep their raw import path (`go:<path>`) and explicit alias:
 * `withGoImports` turns them into module names once every package of the
 * organisation is known, so this result depends on the file alone (and can be cached).
 */
export async function extractGoFile(source: string, opts: GoExtractOptions): Promise<PyModule> {
  const parser = await goParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${opts.path}`);
  const root = tree.rootNode;
  const pkgName = root.namedChildren.find((c) => c?.type === 'package_clause')?.namedChildren[0]?.text ?? '';
  const mod = opts.module;
  const out: PyModule = { module: mod, path: opts.path, defs: [], imports: [], bindings: [], calls: [], idents: [], lang: 'go' };
  const idents = new Set<string>();
  out.defs.push({
    qualname: mod,
    name: mod.split('.').pop() ?? mod,
    kind: 'module',
    lineno: 1,
    endLineno: root.endPosition.row + 1,
    signature: pkgName ? `package ${pkgName}` : '',
    decorators: [],
    parent: null,
    returnExprs: [],
    bases: [],
    params: [],
    isAsync: false,
    file: opts.path,
  });
  const line = (n: Node) => n.startPosition.row + 1;
  /**
   * Go's block scopes: a name declared inside a nested block, a `for`/`if`/`switch`, or a
   * function literal (its parameters too) shadows the enclosing function's. Such names are
   * renamed with their block's position (`r#12.5`), so a handler's `r *http.Request` never
   * resolves to the router `r` outside it. Names at a function body's top level keep theirs.
   */
  let shadow = new Map<string, string>();
  let blockTag = '';
  const declare = (name: string): string => {
    if (!blockTag) {
      shadow.delete(name);
      return name;
    }
    const renamed = `${name}${blockTag}`;
    shadow.set(name, renamed);
    return renamed;
  };

  const toExpr = (node: Node | null | undefined): Expr => {
    if (!node) return { k: 'unknown' };
    switch (node.type) {
      case 'identifier':
        return { k: 'name', id: shadow.get(node.text) ?? node.text };
      case 'type_identifier':
      case 'package_identifier':
        return { k: 'name', id: node.text };
      case 'selector_expression': {
        const obj = node.childForFieldName('operand');
        const field = node.childForFieldName('field');
        return obj && field ? { k: 'attr', obj: toExpr(obj), attr: field.text } : { k: 'unknown' };
      }
      case 'qualified_type': {
        const pkg = node.childForFieldName('package');
        const name = node.childForFieldName('name');
        return pkg && name ? { k: 'attr', obj: { k: 'name', id: pkg.text }, attr: name.text } : { k: 'unknown' };
      }
      case 'call_expression':
        return { k: 'call', fn: toExpr(node.childForFieldName('function')) };
      // `&Graph{...}` and `Graph{...}` build an instance; `x.(Path)` asserts one.
      case 'composite_literal':
      case 'type_assertion_expression': {
        const type = node.childForFieldName('type');
        const t = type?.type === 'generic_type' ? type.childForFieldName('type') : type;
        return t && (t.type === 'type_identifier' || t.type === 'qualified_type') ? { k: 'call', fn: toExpr(t) } : { k: 'unknown' };
      }
      case 'unary_expression':
        return toExpr(node.childForFieldName('operand'));
      case 'parenthesized_expression':
        return toExpr(node.namedChildren[0]);
      default:
        return { k: 'unknown' };
    }
  };

  const head = (node: Node): string => {
    const body = node.childForFieldName('body');
    const text = body ? source.slice(node.startIndex, body.startIndex) : node.text;
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  };

  const resultType = (node: Node): string | undefined => {
    const result = node.childForFieldName('result');
    if (!result) return undefined;
    if (result.type === 'parameter_list') {
      const first = result.namedChildren.find((c) => c?.type === 'parameter_declaration');
      return annotation(first?.childForFieldName('type'));
    }
    return annotation(result);
  };

  const paramList = (node: Node | null, scope: string): PyParam[] => {
    const params: PyParam[] = [];
    for (const c of node?.namedChildren ?? []) {
      if (!c || (c.type !== 'parameter_declaration' && c.type !== 'variadic_parameter_declaration')) continue;
      const ann = c.type === 'parameter_declaration' ? annotation(c.childForFieldName('type')) : undefined;
      for (const n of c.childrenForFieldName('name')) {
        if (!n) continue;
        params.push({ name: n.text, annotation: ann });
        if (ann) out.bindings.push({ scope, at: scope, target: n.text, annotation: ann, lineno: line(c) });
      }
    }
    return params;
  };

  const newDef = (node: Node, fields: Pick<PyDef, 'qualname' | 'name' | 'kind' | 'parent'> & Partial<PyDef>): PyDef => {
    const def: PyDef = {
      lineno: line(node),
      endLineno: node.endPosition.row + 1,
      signature: head(node),
      decorators: exported(fields.name) ? [] : ['private'],
      returnExprs: [],
      bases: [],
      params: [],
      isAsync: false,
      file: opts.path,
      ...fields,
    };
    out.defs.push(def);
    idents.add(fields.name);
    return def;
  };

  /** Bindings for `a, b := x, y` / `a, err := f()` (each name gets its value; a lone call goes to the first). */
  const bindMany = (left: Node | null, right: Node | null, scope: string, at: string, declares: boolean) => {
    const names = (left?.type === 'expression_list' ? left.namedChildren : [left]).filter((n): n is Node => !!n);
    const values = (right?.type === 'expression_list' ? right.namedChildren : right ? [right] : []).filter((n): n is Node => !!n && n.type !== 'comment');
    // The values are read before the names are declared: `x := x.Next()` reads the outer x.
    const exprs = names.map((_, i) => {
      const value = values.length === names.length ? values[i] : i === 0 ? values[0] : undefined;
      return value ? toExpr(value) : undefined;
    });
    names.forEach((n, i) => {
      if (n.type !== 'identifier' || n.text === '_') return;
      const target = declares ? declare(n.text) : (shadow.get(n.text) ?? n.text);
      out.bindings.push({ scope, at, target, value: exprs[i], lineno: line(n) });
    });
  };

  const visitSpecs = (decl: Node, scope: string, at: string) => {
    for (const spec of decl.descendantsOfType(['var_spec', 'const_spec'])) {
      if (!spec) continue;
      const names = spec.childrenForFieldName('name').filter((n): n is Node => !!n);
      const ann = annotation(spec.childForFieldName('type'));
      const values = spec.childForFieldName('value');
      const vals = (values?.type === 'expression_list' ? values.namedChildren : values ? [values] : []).filter((n): n is Node => !!n);
      const exprs = names.map((_, i) => {
        const value = vals.length === names.length ? vals[i] : i === 0 ? vals[0] : undefined;
        return value ? toExpr(value) : undefined;
      });
      names.forEach((n, i) => {
        if (n.text === '_') return;
        out.bindings.push({ scope, at, target: declare(n.text), value: exprs[i], annotation: ann, lineno: line(n) });
      });
      if (values) visit(values, scope);
    }
  };

  const visit = (node: Node, scope: string): void => {
    switch (node.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
        idents.add(node.text);
        return;
      case 'short_var_declaration':
      case 'assignment_statement': {
        const right = node.childForFieldName('right');
        if (right) visit(right, scope);
        const left = node.childForFieldName('left');
        if (left) visit(left, scope);
        bindMany(left, right, scope, scope, node.type === 'short_var_declaration');
        return;
      }
      case 'range_clause': {
        const right = node.childForFieldName('right');
        if (right) visit(right, scope);
        const left = node.childForFieldName('left');
        for (const n of left?.type === 'expression_list' ? left.namedChildren : [left]) if (n?.type === 'identifier' && n.text !== '_') declare(n.text);
        return;
      }
      case 'func_literal':
      case 'block':
      case 'for_statement':
      case 'if_statement':
      case 'expression_switch_statement':
      case 'type_switch_statement':
      case 'select_statement': {
        const saved = shadow;
        const savedTag = blockTag;
        shadow = new Map(shadow);
        blockTag = `#${line(node)}.${node.startPosition.column}`;
        if (node.type === 'func_literal') {
          for (const c of node.childForFieldName('parameters')?.namedChildren ?? []) {
            const ann = c?.type === 'parameter_declaration' ? annotation(c.childForFieldName('type')) : undefined;
            for (const n of c?.childrenForFieldName('name') ?? []) {
              if (!n) continue;
              const target = declare(n.text);
              if (ann) out.bindings.push({ scope, at: scope, target, annotation: ann, lineno: line(n) });
            }
          }
          const body = node.childForFieldName('body');
          if (body) visitChildren(body, scope);
        } else {
          visitChildren(node, scope);
        }
        shadow = saved;
        blockTag = savedTag;
        return;
      }
      case 'var_declaration':
      case 'const_declaration':
        visitSpecs(node, scope, scope);
        return;
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          out.calls.push({ scope, fn: toExpr(fn), text: fn.text.replace(/\s+/g, ''), lineno: line(node), args: goCallArgs(node.childForFieldName('arguments')) } satisfies PyCall);
        }
        visitChildren(node, scope);
        return;
      }
      default:
        visitChildren(node, scope);
    }
  };

  const visitChildren = (node: Node, scope: string): void => {
    for (const c of node.namedChildren) if (c) visit(c, scope);
  };

  /** A function body's top level: its own names, nothing shadowed yet. */
  const visitBody = (body: Node, scope: string): void => {
    shadow = new Map();
    blockTag = '';
    visitChildren(body, scope);
  };

  const visitType = (spec: Node) => {
    const nameNode = spec.childForFieldName('name');
    const type = spec.childForFieldName('type');
    if (!nameNode) return;
    const name = nameNode.text;
    const qualname = `${mod}.${name}`;
    if (spec.type === 'type_alias') {
      // `type A = B`: a name the package binds (not a type of its own).
      out.bindings.push({ scope: mod, at: mod, target: name, annotation: annotation(type), lineno: line(spec) });
      idents.add(name);
      return;
    }
    const def = newDef(spec, { qualname, name, kind: 'class', parent: mod });
    def.signature = `type ${spec.text.replace(/\s+/g, ' ').slice(0, 120)}`.replace(/\{.*$/, '{…}');
    if (type?.type === 'struct_type') {
      for (const f of type.descendantsOfType('field_declaration')) {
        if (!f) continue;
        const names = f.childrenForFieldName('name').filter((n): n is Node => !!n);
        const ft = f.childForFieldName('type');
        // An embedded field promotes its type's methods: a base.
        if (names.length === 0) {
          const base = annotation(ft) ?? ft?.text.replace(/^\*/, '');
          if (base) def.bases.push(base);
          continue;
        }
        for (const n of names) out.bindings.push({ scope: qualname, at: qualname, target: `self.${n.text}`, annotation: annotation(ft), lineno: line(f) });
      }
    } else if (type?.type === 'interface_type') {
      for (const m of type.namedChildren) {
        if (!m) continue;
        if (m.type === 'method_elem') {
          const mname = m.childForFieldName('name')?.text;
          if (!mname) continue;
          const md = newDef(m, { qualname: `${qualname}.${mname}`, name: mname, kind: 'method', parent: qualname });
          md.signature = m.text.replace(/\s+/g, ' ').slice(0, 300);
          md.params = paramList(m.childForFieldName('parameters'), md.qualname);
          md.arity = goArity(m.childForFieldName('parameters'));
          md.returns = resultType(m);
        } else if (m.type === 'type_elem' && m.namedChildren.length === 1) {
          const base = annotation(m.namedChildren[0]);
          if (base) def.bases.push(base);
        }
      }
    }
    if (type) visitChildren(type, mod);
  };

  for (const node of root.namedChildren) {
    if (!node) continue;
    switch (node.type) {
      case 'import_declaration':
        for (const spec of node.descendantsOfType('import_spec')) {
          const path = spec?.childForFieldName('path')?.text.replace(/^["`]|["`]$/g, '');
          if (!spec || !path) continue;
          out.imports.push({ alias: spec.childForFieldName('name')?.text ?? '', target: `go:${path}`, lineno: line(spec) });
        }
        break;
      case 'function_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        const body = node.childForFieldName('body');
        // `init` (any number per package) and `_` are not callable.
        if (!name || name === 'init' || name === '_') {
          if (body) visitBody(body, mod);
          break;
        }
        const def = newDef(node, { qualname: `${mod}.${name}`, name, kind: 'function', parent: mod });
        def.params = paramList(node.childForFieldName('parameters'), def.qualname);
        def.arity = goArity(node.childForFieldName('parameters'));
        def.returns = resultType(node);
        if (body) visitBody(body, def.qualname);
        break;
      }
      case 'method_declaration': {
        const name = node.childForFieldName('name')?.text ?? '';
        const recv = node.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration');
        const recvType = annotation(recv?.childForFieldName('type'));
        if (!name || !recvType) break;
        const cls = `${mod}.${recvType}`;
        const def = newDef(node, { qualname: `${cls}.${name}`, name, kind: 'method', parent: cls });
        const recvName = recv?.childForFieldName('name')?.text;
        if (recvName && recvName !== '_') out.bindings.push({ scope: def.qualname, at: def.qualname, target: recvName, annotation: recvType, lineno: def.lineno });
        def.params = paramList(node.childForFieldName('parameters'), def.qualname);
        def.arity = goArity(node.childForFieldName('parameters'));
        def.returns = resultType(node);
        const body = node.childForFieldName('body');
        if (body) visitBody(body, def.qualname);
        break;
      }
      case 'type_declaration':
        for (const spec of node.namedChildren) if (spec && (spec.type === 'type_spec' || spec.type === 'type_alias')) visitType(spec);
        break;
      case 'var_declaration':
      case 'const_declaration':
        visitSpecs(node, mod, mod);
        break;
      default:
        // Statements outside a function: tree-sitter-go accepts them (a docs fragment), so their calls count.
        visit(node, mod);
    }
  }
  out.idents = [...idents].sort();
  tree.delete();
  return out;
}

/** Raw imports (`go:<path>`) to module names, with the alias each binds (`.` imports everything, `_` nothing). */
export function withGoImports(mod: PyModule): PyModule {
  const imports: PyImport[] = [];
  for (const i of mod.imports) {
    if (!i.target.startsWith('go:')) {
      imports.push(i);
      continue;
    }
    const path = i.target.slice(3);
    if (i.alias === '_') continue;
    imports.push({ alias: i.alias === '.' ? '*' : i.alias || goPackageName(path), target: goModuleOf(path), lineno: i.lineno });
  }
  return { ...mod, imports };
}

/** A Go source file, imports resolved against the modules indexed so far. */
export async function extractGo(source: string, opts: GoExtractOptions): Promise<PyModule> {
  return withGoImports(await extractGoFile(source, opts));
}

/** One package from its files: their definitions (each knows its file), imports, bindings and calls. */
export function mergeGoPackage(files: PyModule[]): PyModule {
  const sorted = [...files].sort((a, b) => (a.path.endsWith('/doc.go') || a.path === 'doc.go' ? -1 : 0) - (b.path.endsWith('/doc.go') || b.path === 'doc.go' ? -1 : 0) || a.path.localeCompare(b.path));
  const first = sorted[0]!;
  // The package's name: a `main` file among library files (a stray tool) does not name it.
  const signature = sorted.map((f) => f.defs[0]?.signature).find((x) => x && x !== 'package main') ?? first.defs[0]!.signature;
  const moduleDef = { ...first.defs[0]!, signature };
  return {
    module: first.module,
    path: first.path,
    defs: [moduleDef, ...sorted.flatMap((f) => f.defs.slice(1))],
    imports: sorted.flatMap((f) => f.imports),
    bindings: sorted.flatMap((f) => f.bindings),
    calls: sorted.flatMap((f) => f.calls),
    idents: [...new Set(sorted.flatMap((f) => f.idents))].sort(),
    lang: 'go',
  };
}

/** `module github.com/acme/x/v2` from a go.mod. */
export function goModulePath(gomod: string): string | undefined {
  return /^\s*module\s+"?([^\s"]+)"?/m.exec(gomod)?.[1];
}

/** A file the go tool leaves out of its package: `//go:build ignore` (generators, examples run with `go run`). */
function buildIgnored(source: string): boolean {
  const headLines = source.slice(0, 2000).split('\n');
  for (const l of headLines) {
    if (/^\s*package\s/.test(l)) return false;
    if (/^\s*\/\/\s*(go:build|\+build)\b.*\bignore\b/.test(l)) return true;
  }
  return false;
}

export interface GoRepoFiles {
  /** Library `.go` files (classified `go`). */
  files: string[];
  /** Every path of the checkout (for `go.mod` files and package directories). */
  all: string[];
  /** `owner/name`, for a module without `go.mod` (`github.com/owner/name`). */
  repo: string;
}

/**
 * Every Go package of a checkout as one module each: module paths from the nearest
 * `go.mod` (several per repository are fine: a multi-module repository or a `go.work`
 * workspace), package names from their `package` clauses.
 */
export async function parseGoPackages(
  /** A checkout directory, or a reader of the files at some commit. */
  dir: string | ((path: string) => Promise<string | undefined>),
  input: GoRepoFiles,
  extract: (source: string, opts: GoExtractOptions) => Promise<PyModule> = extractGoFile,
  errors: string[] = [],
): Promise<PyModule[]> {
  const read = typeof dir === 'string' ? (p: string) => readFile(join(dir, p), 'utf8') : async (p: string) => (await dir(p)) ?? '';
  const mods = new Map<string, string>();
  for (const p of input.all.filter((x) => posix.basename(x) === 'go.mod' && !/(^|\/)(vendor|testdata)\//.test(x))) {
    const path = goModulePath(await read(p).catch(() => ''));
    if (path) mods.set(posix.dirname(p) === '.' ? '' : posix.dirname(p), path);
  }
  const fallback = input.repo.includes('/') ? `github.com/${input.repo}` : input.repo;
  const moduleOfDir = (d: string): { root: string; path: string } => {
    let best: string | undefined;
    for (const root of mods.keys()) if ((root === '' || d === root || d.startsWith(`${root}/`)) && (best === undefined || root.length > best.length)) best = root;
    return best === undefined ? { root: '', path: fallback } : { root: best, path: mods.get(best)! };
  };
  const importPathOf = (d: string): string => {
    const m = moduleOfDir(d);
    registerGoModule(m.path);
    const rel = d === m.root ? '' : m.root ? d.slice(m.root.length + 1) : d;
    return rel ? `${m.path}/${rel}` : m.path;
  };
  // Directories with any Go file are packages, even when every file is a test or example.
  for (const p of input.all.filter((x) => x.endsWith('.go') && !/(^|\/)(vendor|testdata)\//.test(x))) {
    const d = posix.dirname(p) === '.' ? '' : posix.dirname(p);
    const ip = importPathOf(d);
    if (!GO_PACKAGES.has(ip)) GO_PACKAGES.set(ip, '');
    GO_PACKAGE_MODULES.add(goModuleOf(ip));
  }
  const byDir = new Map<string, string[]>();
  for (const f of input.files) {
    const d = posix.dirname(f) === '.' ? '' : posix.dirname(f);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  const packages: PyModule[] = [];
  for (const [d, files] of [...byDir].sort(([a], [b]) => a.localeCompare(b))) {
    const importPath = importPathOf(d);
    const module = goModuleOf(importPath);
    const parsed: PyModule[] = [];
    for (const f of files.sort()) {
      try {
        const source = await read(f);
        if (buildIgnored(source)) continue;
        parsed.push(await extract(source, { module, path: f }));
      } catch (err) {
        errors.push(`${f}: ${(err as Error).message}`);
      }
    }
    if (!parsed.length) continue;
    const pkg = mergeGoPackage(parsed);
    GO_PACKAGES.set(importPath, pkg.defs[0]!.signature.replace(/^package\s+/, ''));
    packages.push(pkg);
  }
  // Aliases of unaliased imports are the imported packages' names: resolved once all are known.
  return packages.map(withGoImports);
}

/** The Go block's import specs (`"fmt"`, `fdb "github.com/..."`), for later fragments on the same page. */
export function goImportSpecs(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/^\s*import\s+(?:\(([^)]*)\)|((?:[\w.]+\s+)?"[^"]+"))/gm)) {
    if (m[2]) out.push(m[2].trim());
    for (const l of (m[1] ?? '').split('\n')) {
      const spec = l.replace(/\/\/.*$/, '').trim();
      if (/^(?:[\w.]+\s+)?"[^"]+"$/.test(spec)) out.push(spec);
    }
  }
  return out;
}

/**
 * A Go docs example made parseable the way a reader fills it in: a block without a
 * `package` clause gets `package main`, and bare statements go into `func main()`. A
 * block without imports gets the page's earlier ones. Line numbers stay the block's own
 * (lines Staleproof added are 0).
 */
export async function extractGoExample(code: string, opts: GoExtractOptions & { earlierImports?: string[] }): Promise<PyModule> {
  const lines = code.split('\n');
  const own = goImportSpecs(code);
  const extra = own.length === 0 && opts.earlierImports?.length ? [`import (`, ...opts.earlierImports.map((s) => `\t${s}`), `)`] : [];
  const variants: { source: string; map: number[] }[] = [];
  const hasPackage = /^\s*package\s+\w+/m.test(code);
  if (hasPackage) {
    variants.push({ source: code, map: lines.map((_, i) => i + 1) });
  } else {
    const pre = ['package main', ...extra];
    variants.push({ source: [...pre, ...lines].join('\n'), map: [...pre.map(() => 0), ...lines.map((_, i) => i + 1)] });
    // Statements: everything after the imports goes into func main().
    let cut = 0;
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!.trim();
      if (inBlock) {
        if (l.startsWith(')')) inBlock = false;
        cut = i + 1;
      } else if (/^import\s*\(/.test(l)) {
        inBlock = !l.includes(')');
        cut = i + 1;
      } else if (/^import\s/.test(l) || l === '' || l.startsWith('//')) {
        if (/^import\s/.test(l)) cut = i + 1;
      } else break;
    }
    const top = lines.slice(0, cut);
    const rest = lines.slice(cut);
    variants.push({
      source: [...pre, ...top, 'func main() {', ...rest, '}'].join('\n'),
      map: [...pre.map(() => 0), ...top.map((_, i) => i + 1), 0, ...rest.map((_, i) => cut + i + 1), 0],
    });
  }
  let best: { mod: PyModule; map: number[]; errors: number } | undefined;
  const parser = await goParser();
  for (const v of variants) {
    const tree = parser.parse(v.source);
    const errors = tree ? tree.rootNode.descendantsOfType(['ERROR', 'MISSING']).length + (tree.rootNode.hasError ? 1 : 0) : Infinity;
    tree?.delete();
    if (best && errors >= best.errors) continue;
    best = { mod: await extractGoFile(v.source, opts), map: v.map, errors };
    if (errors === 0) break;
  }
  const { mod, map } = best!;
  const at = (n: number) => map[n - 1] ?? 0;
  return withGoImports({
    ...mod,
    defs: mod.defs.map((d) => (d.kind === 'module' ? d : { ...d, lineno: at(d.lineno), endLineno: at(d.endLineno) || at(d.lineno) })),
    imports: mod.imports.map((i) => ({ ...i, lineno: at(i.lineno) })),
    bindings: mod.bindings.map((b) => ({ ...b, lineno: at(b.lineno) })),
    calls: mod.calls.map((c) => ({ ...c, lineno: at(c.lineno) })),
  });
}

export type { PyBinding };
