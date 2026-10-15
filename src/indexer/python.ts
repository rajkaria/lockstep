import type { Node } from 'web-tree-sitter';
import { pythonParser } from './treesitter.js';

/**
 * A receiver/callee expression, kept structural so the resolver can follow
 * `self._driver.select_graph(x).query` through attribute and return types.
 */
export type Expr =
  | { k: 'name'; id: string }
  | { k: 'attr'; obj: Expr; attr: string }
  | { k: 'call'; fn: Expr }
  | { k: 'unknown' };

export type DefKind = 'module' | 'class' | 'function' | 'method';

export interface PyParam {
  name: string;
  annotation?: string;
}

export interface PyDef {
  qualname: string;
  name: string;
  kind: DefKind;
  lineno: number;
  endLineno: number;
  signature: string;
  decorators: string[];
  /** Qualname of the enclosing class/function/module. */
  parent: string | null;
  /** Return annotation text, if any. */
  returns?: string;
  /** Expressions in `return` statements (used when there is no annotation). */
  returnExprs: Expr[];
  /** Base class expressions as written. */
  bases: string[];
  params: PyParam[];
  doc?: string;
  isAsync: boolean;
}

export interface PyImport {
  /** Local name bound by the import. */
  alias: string;
  /** Absolute dotted target. */
  target: string;
  lineno: number;
}

export interface PyBinding {
  /** Qualname of the scope that owns the binding (function, or class for `self.x`). */
  scope: string;
  /** Qualname of the scope where the assignment is evaluated (the method, for `self.x`). */
  at: string;
  /** `x` for a local/module variable, `self.x` for an instance attribute. */
  target: string;
  value?: Expr;
  annotation?: string;
  lineno: number;
}

export interface PyCall {
  /** Qualname of the enclosing function, or the module for top-level calls. */
  scope: string;
  fn: Expr;
  /** Source text of the callee, e.g. `self._graph.query`. */
  text: string;
  lineno: number;
}

export interface PyModule {
  module: string;
  path: string;
  defs: PyDef[];
  imports: PyImport[];
  bindings: PyBinding[];
  calls: PyCall[];
  /** Every identifier that appears in the source (for docs examples' late linking). */
  idents: string[];
}

interface Scope {
  qualname: string;
  kind: 'module' | 'class' | 'function';
  /** Qualname of the class whose instance `selfName` refers to. */
  className?: string;
  selfName?: string;
  def?: PyDef;
}

export interface ExtractOptions {
  /** Dotted module name, e.g. `falkordb.asyncio.graph`. */
  module: string;
  path: string;
  /** True for `__init__.py` (relative imports resolve against the module itself). */
  isPackage?: boolean;
}

export async function extractPython(source: string, opts: ExtractOptions): Promise<PyModule> {
  const parser = await pythonParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${opts.path}`);
  const root = tree.rootNode;

  const out: PyModule = { module: opts.module, path: opts.path, defs: [], imports: [], bindings: [], calls: [], idents: [] };
  const idents = new Set<string>();

  const moduleDef: PyDef = {
    qualname: opts.module,
    name: opts.module.split('.').pop() ?? opts.module,
    kind: 'module',
    lineno: 1,
    endLineno: root.endPosition.row + 1,
    signature: '',
    decorators: [],
    parent: null,
    returnExprs: [],
    bases: [],
    params: [],
    doc: docstring(root),
    isAsync: false,
  };
  out.defs.push(moduleDef);

  const pkg = opts.isPackage ? opts.module : opts.module.split('.').slice(0, -1).join('.');

  const resolveRelative = (level: number, mod: string): string => {
    if (level === 0) return mod;
    const parts = pkg ? pkg.split('.') : [];
    const base = parts.slice(0, Math.max(0, parts.length - (level - 1)));
    return [...base, ...(mod ? [mod] : [])].join('.');
  };

  const visit = (node: Node, scope: Scope, decorators: string[] = []): void => {
    switch (node.type) {
      case 'identifier':
        idents.add(node.text);
        return;
      case 'decorated_definition': {
        const decs = node.namedChildren
          .filter((c): c is Node => !!c && c.type === 'decorator')
          .map((d) => d.text.replace(/^@/, '').trim());
        for (const d of node.namedChildren) if (d && d.type === 'decorator') visitChildren(d, scope);
        const def = node.childForFieldName('definition');
        if (def) visit(def, scope, decs);
        return;
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text ?? '?';
        const qualname = `${scope.qualname}.${name}`;
        const supers = node.childForFieldName('superclasses');
        const bases = supers
          ? supers.namedChildren.filter((c): c is Node => !!c && c.type !== 'keyword_argument').map((c) => c.text)
          : [];
        const def: PyDef = {
          qualname,
          name,
          kind: 'class',
          lineno: node.startPosition.row + 1,
          endLineno: node.endPosition.row + 1,
          signature: supers ? `class ${name}${supers.text}` : `class ${name}`,
          decorators,
          parent: scope.qualname,
          returnExprs: [],
          bases,
          params: [],
          doc: docstring(node.childForFieldName('body')),
          isAsync: false,
        };
        out.defs.push(def);
        idents.add(name);
        if (supers) visitChildren(supers, scope);
        const body = node.childForFieldName('body');
        if (body) visitChildren(body, { qualname, kind: 'class', className: qualname, def });
        return;
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '?';
        const qualname = `${scope.qualname}.${name}`;
        const paramsNode = node.childForFieldName('parameters');
        const returnType = node.childForFieldName('return_type');
        const params = paramsNode ? parseParams(paramsNode) : [];
        const isAsync = node.children.some((c) => c?.type === 'async');
        const kind: DefKind = scope.kind === 'class' ? 'method' : 'function';
        const def: PyDef = {
          qualname,
          name,
          kind,
          lineno: node.startPosition.row + 1,
          endLineno: node.endPosition.row + 1,
          signature: `${isAsync ? 'async ' : ''}def ${name}${paramsNode?.text ?? '()'}${returnType ? ` -> ${returnType.text}` : ''}`,
          decorators,
          parent: scope.qualname,
          returns: returnType?.text,
          returnExprs: [],
          bases: [],
          params,
          doc: docstring(node.childForFieldName('body')),
          isAsync,
        };
        out.defs.push(def);
        idents.add(name);
        const isStatic = decorators.some((d) => d === 'staticmethod');
        const inner: Scope = {
          qualname,
          kind: 'function',
          className: scope.kind === 'class' ? scope.qualname : scope.className,
          selfName: scope.kind === 'class' ? (isStatic ? undefined : params[0]?.name) : scope.selfName,
          def,
        };
        for (const p of params) {
          if (p.annotation && p.name !== inner.selfName) {
            out.bindings.push({ scope: qualname, at: qualname, target: p.name, annotation: p.annotation, lineno: def.lineno });
          }
        }
        if (paramsNode) visitChildren(paramsNode, scope);
        const body = node.childForFieldName('body');
        if (body) visitChildren(body, inner);
        return;
      }
      case 'import_statement': {
        for (const c of node.namedChildren) {
          if (!c) continue;
          if (c.type === 'dotted_name') {
            // `import a.b.c` binds `a`; the full dotted name stays reachable through it.
            const first = c.text.split('.')[0]!;
            out.imports.push({ alias: first, target: first, lineno: node.startPosition.row + 1 });
            if (c.text.includes('.')) out.imports.push({ alias: c.text, target: c.text, lineno: node.startPosition.row + 1 });
          } else if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name')?.text ?? '';
            const alias = c.childForFieldName('alias')?.text ?? name;
            out.imports.push({ alias, target: name, lineno: node.startPosition.row + 1 });
          }
        }
        return;
      }
      case 'import_from_statement': {
        const modNode = node.childForFieldName('module_name');
        let mod = '';
        let level = 0;
        if (modNode?.type === 'relative_import') {
          const prefix = modNode.namedChildren.find((c) => c?.type === 'import_prefix');
          level = prefix ? prefix.text.length : 0;
          mod = modNode.namedChildren.find((c) => c?.type === 'dotted_name')?.text ?? '';
        } else if (modNode) {
          mod = modNode.text;
        }
        const absolute = resolveRelative(level, mod);
        for (const c of node.childrenForFieldName('name')) {
          if (!c) continue;
          if (c.type === 'dotted_name') {
            out.imports.push({ alias: c.text, target: joinDotted(absolute, c.text), lineno: node.startPosition.row + 1 });
          } else if (c.type === 'aliased_import') {
            const name = c.childForFieldName('name')?.text ?? '';
            const alias = c.childForFieldName('alias')?.text ?? name;
            out.imports.push({ alias, target: joinDotted(absolute, name), lineno: node.startPosition.row + 1 });
          }
        }
        if (node.namedChildren.some((c) => c?.type === 'wildcard_import')) {
          out.imports.push({ alias: '*', target: absolute, lineno: node.startPosition.row + 1 });
        }
        return;
      }
      case 'assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        const type = node.childForFieldName('type');
        const target = left ? bindingTarget(left, scope) : undefined;
        if (target) {
          out.bindings.push({
            scope: target.scope,
            at: scope.qualname,
            target: target.name,
            value: right ? selfAware(toExpr(right), scope) : undefined,
            annotation: type?.text,
            lineno: node.startPosition.row + 1,
          });
        }
        visitChildren(node, scope);
        return;
      }
      case 'with_item': {
        const value = node.childForFieldName('value');
        if (value?.type === 'as_pattern') {
          const expr = value.namedChildren[0];
          const alias = value.childForFieldName('alias');
          const aliasId = alias?.namedChildren.find((c) => c?.type === 'identifier') ?? (alias?.type === 'identifier' ? alias : null);
          if (expr && aliasId) {
            out.bindings.push({
              scope: scope.qualname,
              at: scope.qualname,
              target: aliasId.text,
              value: selfAware(toExpr(expr), scope),
              lineno: node.startPosition.row + 1,
            });
          }
        }
        visitChildren(node, scope);
        return;
      }
      case 'return_statement': {
        const value = node.namedChildren[0];
        if (value && scope.def && scope.kind === 'function') scope.def.returnExprs.push(selfAware(toExpr(value), scope));
        visitChildren(node, scope);
        return;
      }
      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn) {
          out.calls.push({
            scope: scope.qualname,
            fn: selfAware(toExpr(fn), scope),
            text: fn.text,
            lineno: node.startPosition.row + 1,
          });
        }
        visitChildren(node, scope);
        return;
      }
      default:
        visitChildren(node, scope);
    }
  };

  const visitChildren = (node: Node, scope: Scope): void => {
    for (const c of node.namedChildren) if (c) visit(c, scope);
  };

  /** Rewrite `self.x` (with whatever the first parameter is called) to a canonical `self` name. */
  const selfAware = (e: Expr, scope: Scope): Expr => {
    if (!scope.selfName || !scope.className) return e;
    const rewrite = (x: Expr): Expr => {
      if (x.k === 'name') return x.id === scope.selfName ? { k: 'name', id: 'self' } : x;
      if (x.k === 'attr') return { k: 'attr', obj: rewrite(x.obj), attr: x.attr };
      if (x.k === 'call') return { k: 'call', fn: rewrite(x.fn) };
      return x;
    };
    return rewrite(e);
  };

  const bindingTarget = (left: Node, scope: Scope): { scope: string; name: string } | undefined => {
    if (left.type === 'identifier') return { scope: scope.qualname, name: left.text };
    if (
      left.type === 'attribute' &&
      scope.selfName &&
      scope.className &&
      left.childForFieldName('object')?.text === scope.selfName
    ) {
      const attr = left.childForFieldName('attribute')?.text;
      if (attr) return { scope: scope.className, name: `self.${attr}` };
    }
    return undefined;
  };

  visitChildren(root, { qualname: opts.module, kind: 'module', def: moduleDef });
  out.idents = [...idents].sort();
  tree.delete();
  return out;
}

export function toExpr(node: Node): Expr {
  switch (node.type) {
    case 'identifier':
      return { k: 'name', id: node.text };
    case 'attribute': {
      const obj = node.childForFieldName('object');
      const attr = node.childForFieldName('attribute');
      if (!obj || !attr) return { k: 'unknown' };
      return { k: 'attr', obj: toExpr(obj), attr: attr.text };
    }
    case 'call': {
      const fn = node.childForFieldName('function');
      return fn ? { k: 'call', fn: toExpr(fn) } : { k: 'unknown' };
    }
    case 'boolean_operator': {
      // `self._pool or Pool()` — the right operand is the value that gets constructed.
      const right = node.childForFieldName('right');
      return right ? toExpr(right) : { k: 'unknown' };
    }
    case 'conditional_expression':
    case 'await':
    case 'parenthesized_expression': {
      const inner = node.namedChildren[0];
      return inner ? toExpr(inner) : { k: 'unknown' };
    }
    default:
      return { k: 'unknown' };
  }
}

export function exprText(e: Expr): string {
  switch (e.k) {
    case 'name':
      return e.id;
    case 'attr':
      return `${exprText(e.obj)}.${e.attr}`;
    case 'call':
      return `${exprText(e.fn)}()`;
    default:
      return '?';
  }
}

function parseParams(node: Node): PyParam[] {
  const params: PyParam[] = [];
  for (const c of node.namedChildren) {
    if (!c) continue;
    switch (c.type) {
      case 'identifier':
        params.push({ name: c.text });
        break;
      case 'typed_parameter': {
        const id = c.namedChildren.find((x) => x?.type === 'identifier');
        const type = c.childForFieldName('type');
        if (id) params.push({ name: id.text, annotation: type?.text });
        break;
      }
      case 'default_parameter': {
        const name = c.childForFieldName('name');
        if (name) params.push({ name: name.text });
        break;
      }
      case 'typed_default_parameter': {
        const name = c.childForFieldName('name');
        const type = c.childForFieldName('type');
        if (name) params.push({ name: name.text, annotation: type?.text });
        break;
      }
      default:
        break;
    }
  }
  return params;
}

function docstring(body: Node | null): string | undefined {
  if (!body) return undefined;
  const first = body.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const str = first.namedChildren[0];
  if (str?.type !== 'string') return undefined;
  const text = str.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').trim();
  return text.split('\n')[0]?.trim() || undefined;
}

function joinDotted(a: string, b: string): string {
  return a ? `${a}.${b}` : b;
}
