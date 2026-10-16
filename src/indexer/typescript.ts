import type { Node } from 'web-tree-sitter';
import type { Expr, PyBinding, PyCall, PyDef, PyImport, PyModule, PyParam } from './python.js';
import { tsParser } from './treesitter.js';

/**
 * TypeScript and JavaScript, read into the same module shape as Python so one resolver
 * and one graph serve both: classes, functions (declarations and `const f = () => …`),
 * methods (the constructor included), ES imports/exports and `require`, call sites with
 * structural callees (`this.graph.query`, `new Client()`), typed bindings and return
 * types. Arguments are not recorded: JavaScript accepts any argument count, so only
 * names that do not exist are checked, never arity.
 */

/** npm package names by module token, for messages (`js-acme-minigraph` → `@acme/minigraph`). */
export const NPM_NAMES = new Map<string, string>();

/** Top-level module segment for an npm package: `js-` plus the name, so it never collides with a Python package. */
export function npmToken(pkg: string): string {
  const token = `js-${pkg.replace(/^@/, '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  NPM_NAMES.set(token, pkg);
  return token;
}

/** The module a bare specifier names: `falkordb` → js-falkordb, `@scope/pkg/sub` → js-scope-pkg.sub. */
export function bareModule(spec: string): string {
  const parts = spec.split('/');
  const pkgLen = spec.startsWith('@') ? 2 : 1;
  const pkg = parts.slice(0, pkgLen).join('/');
  const rest = parts.slice(pkgLen).filter(Boolean).map(sanitize);
  return [npmToken(pkg), ...rest].join('.');
}

export function sanitize(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_$-]/g, '_');
}

export interface TsExtractOptions {
  module: string;
  path: string;
  /** JSX syntax (.tsx, .jsx, .js): parsed with the TSX grammar. */
  tsx?: boolean;
  /** Module name for an import specifier (relative ones need the repository's file list). */
  resolve?: (spec: string) => string | undefined;
}

/** Strip `Promise<…>`, arrays and nullish unions; write generics with brackets like Python's annotations. */
export function normalizeType(t: string): string {
  let s = t.replace(/^:\s*/, '').trim();
  for (let i = 0; i < 3; i++) s = s.replace(/^(?:Promise|Awaited|Readonly)<(.*)>$/s, '$1').trim();
  return s
    .replace(/\[\]/g, '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x && x !== 'null' && x !== 'undefined')
    .join(' | ')
    .replace(/</g, '[')
    .replace(/>/g, ']');
}

interface Scope {
  qualname: string;
  kind: 'module' | 'class' | 'function';
  className?: string;
  def?: PyDef;
}

export async function extractTs(source: string, opts: TsExtractOptions): Promise<PyModule> {
  const parser = await tsParser(!!opts.tsx);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse ${opts.path}`);
  const root = tree.rootNode;
  const out: PyModule = { module: opts.module, path: opts.path, defs: [], imports: [], bindings: [], calls: [], idents: [], lang: 'ts' };
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
    isAsync: false,
  };
  out.defs.push(moduleDef);
  const target = (spec: string) => (spec.startsWith('.') ? opts.resolve?.(spec) : bareModule(spec));
  const imp = (alias: string, tgt: string | undefined, node: Node, exported = false) => {
    if (tgt) out.imports.push({ alias, target: tgt, lineno: node.startPosition.row + 1, ...(exported ? { exported: true } : {}) });
  };
  const exportedLocal = new Set<string>();

  const toExpr = (node: Node | null): Expr => {
    if (!node) return { k: 'unknown' };
    switch (node.type) {
      case 'identifier':
      case 'type_identifier':
        return { k: 'name', id: node.text };
      case 'this':
        return { k: 'name', id: 'self' };
      case 'member_expression': {
        const obj = node.childForFieldName('object');
        const prop = node.childForFieldName('property');
        return obj && prop ? { k: 'attr', obj: toExpr(obj), attr: prop.text } : { k: 'unknown' };
      }
      case 'call_expression':
        return { k: 'call', fn: toExpr(node.childForFieldName('function')) };
      case 'new_expression':
        return { k: 'call', fn: toExpr(node.childForFieldName('constructor')) };
      case 'await_expression':
      case 'parenthesized_expression':
      case 'non_null_expression':
      case 'as_expression':
      case 'satisfies_expression':
        return toExpr(node.namedChildren[0] ?? null);
      default:
        return { k: 'unknown' };
    }
  };

  const typeText = (node: Node | null): string | undefined => (node ? normalizeType(node.text) : undefined);

  const params = (node: Node | null, scope: string, cls?: string): PyParam[] => {
    const outParams: PyParam[] = [];
    for (const c of node?.namedChildren ?? []) {
      if (!c || (c.type !== 'required_parameter' && c.type !== 'optional_parameter')) continue;
      const pattern = c.childForFieldName('pattern');
      if (pattern?.type !== 'identifier') continue;
      const annotation = typeText(c.childForFieldName('type'));
      outParams.push({ name: pattern.text, annotation });
      if (annotation) out.bindings.push({ scope, at: scope, target: pattern.text, annotation, lineno: c.startPosition.row + 1 });
      // `constructor(private client: Client)` also declares the field.
      if (cls && c.namedChildren.some((x) => x?.type === 'accessibility_modifier' || x?.type === 'override_modifier')) {
        out.bindings.push({ scope: cls, at: scope, target: `self.${pattern.text}`, annotation, lineno: c.startPosition.row + 1 });
      }
    }
    return outParams;
  };

  const signatureOf = (node: Node): string => {
    const body = node.childForFieldName('body');
    const head = body ? source.slice(node.startIndex, body.startIndex) : node.text;
    return head.replace(/\s+/g, ' ').trim().slice(0, 300);
  };

  const addFunction = (name: string, node: Node, scope: Scope, kind: 'function' | 'method', decorators: string[]): PyDef => {
    const qualname = `${scope.qualname}.${name}`;
    const isAsync = node.children.some((c) => c?.type === 'async');
    const def: PyDef = {
      qualname,
      name,
      kind,
      lineno: node.startPosition.row + 1,
      endLineno: node.endPosition.row + 1,
      signature: signatureOf(node),
      decorators,
      parent: scope.qualname,
      returns: typeText(node.childForFieldName('return_type')),
      returnExprs: [],
      bases: [],
      params: [],
      isAsync,
    };
    def.params = params(node.childForFieldName('parameters'), qualname, kind === 'method' && name === 'constructor' ? scope.qualname : undefined);
    out.defs.push(def);
    idents.add(name);
    const body = node.childForFieldName('body');
    if (body) {
      const inner: Scope = { qualname, kind: 'function', className: scope.kind === 'class' ? scope.qualname : scope.className, def };
      // An arrow function's expression body is its return value.
      if (body.type !== 'statement_block') def.returnExprs.push(toExpr(body));
      visit(body, inner);
    }
    return def;
  };

  const visitClass = (node: Node, scope: Scope, decorators: string[]) => {
    const name = node.childForFieldName('name')?.text ?? 'default';
    const qualname = `${scope.qualname}.${name}`;
    const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
    const ext = heritage?.namedChildren.find((c) => c?.type === 'extends_clause')?.childForFieldName('value');
    const def: PyDef = {
      qualname,
      name,
      kind: 'class',
      lineno: node.startPosition.row + 1,
      endLineno: node.endPosition.row + 1,
      signature: signatureOf(node),
      decorators,
      parent: scope.qualname,
      returnExprs: [],
      bases: ext ? [ext.text] : [],
      params: [],
      isAsync: false,
    };
    out.defs.push(def);
    idents.add(name);
    const cls: Scope = { qualname, kind: 'class', className: qualname, def };
    for (const m of node.childForFieldName('body')?.namedChildren ?? []) {
      if (!m) continue;
      const nameNode = m.childForFieldName('name');
      const mname = nameNode?.text ?? '';
      const mods = m.namedChildren.filter((c): c is Node => !!c && c.type === 'accessibility_modifier').map((c) => c.text);
      const isPrivate = mods.includes('private') || mods.includes('protected') || mname.startsWith('#');
      const isStatic = m.children.some((c) => c?.type === 'static');
      const decs = [...(isPrivate ? ['private'] : []), ...(isStatic ? ['staticmethod'] : [])];
      if (m.type === 'method_definition' || m.type === 'abstract_method_signature') {
        if (m.children.some((c) => c?.type === 'get' || c?.type === 'set')) decs.push('property');
        addFunction(mname, m, cls, 'method', decs);
      } else if (m.type === 'public_field_definition' || m.type === 'field_definition') {
        const value = m.childForFieldName('value');
        const annotation = typeText(m.childForFieldName('type'));
        if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          addFunction(mname, value, cls, 'method', decs);
        } else {
          out.bindings.push({
            scope: qualname,
            at: qualname,
            target: isStatic ? mname : `self.${mname}`,
            value: value ? toExpr(value) : undefined,
            annotation,
            lineno: m.startPosition.row + 1,
          });
          if (value) visit(value, cls);
        }
      }
    }
    return def;
  };

  const visitDeclarator = (d: Node, scope: Scope, exported: boolean) => {
    const nameNode = d.childForFieldName('name');
    const value = d.childForFieldName('value');
    // `const { a, b: c } = require('m')` and `const m = require('m')`.
    if (value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require') {
      const spec = value.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0]?.text;
      const mod = spec ? target(spec) : undefined;
      if (mod && nameNode?.type === 'identifier') imp(nameNode.text, mod, d);
      if (mod && nameNode?.type === 'object_pattern') {
        for (const p of nameNode.namedChildren) {
          if (p?.type === 'shorthand_property_identifier_pattern') imp(p.text, `${mod}.${p.text}`, d);
          else if (p?.type === 'pair_pattern') imp(p.childForFieldName('value')?.text ?? '', `${mod}.${p.childForFieldName('key')?.text}`, d);
        }
      }
      return;
    }
    if (nameNode?.type !== 'identifier') {
      if (value) visit(value, scope);
      return;
    }
    if (value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function') && scope.kind === 'module') {
      addFunction(nameNode.text, value, scope, 'function', exported ? [] : ['internal']);
      return;
    }
    out.bindings.push({
      scope: scope.qualname,
      at: scope.qualname,
      target: nameNode.text,
      value: value ? toExpr(value) : undefined,
      annotation: typeText(d.childForFieldName('type')),
      lineno: d.startPosition.row + 1,
    });
    if (value) visit(value, scope);
  };

  const visit = (node: Node, scope: Scope, exported = false): void => {
    switch (node.type) {
      case 'identifier':
      case 'property_identifier':
      case 'type_identifier':
        idents.add(node.text);
        return;
      case 'import_statement': {
        const spec = node.childForFieldName('source')?.namedChildren[0]?.text ?? node.childForFieldName('source')?.text.slice(1, -1);
        const mod = spec ? target(spec) : undefined;
        const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
        for (const c of clause?.namedChildren ?? []) {
          if (!c) continue;
          if (c.type === 'identifier') imp(c.text, mod && `${mod}.default`, node);
          else if (c.type === 'namespace_import') imp(c.namedChildren[0]?.text ?? '', mod, node);
          else if (c.type === 'named_imports') {
            for (const s of c.namedChildren) {
              if (s?.type !== 'import_specifier') continue;
              const name = s.childForFieldName('name')?.text ?? '';
              imp(s.childForFieldName('alias')?.text ?? name, mod && `${mod}.${name}`, node);
            }
          }
        }
        return;
      }
      case 'export_statement': {
        const source = node.childForFieldName('source');
        const spec = source?.namedChildren[0]?.text;
        const mod = spec ? target(spec) : undefined;
        const decl = node.childForFieldName('declaration');
        const isDefault = node.children.some((c) => c?.type === 'default');
        if (decl) {
          const d = visitExported(decl, scope);
          if (isDefault && d) imp('default', `${opts.module}.${d}`, node, true);
          return;
        }
        const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
        if (clause) {
          for (const s of clause.namedChildren) {
            if (s?.type !== 'export_specifier') continue;
            const name = s.childForFieldName('name')?.text ?? '';
            const alias = s.childForFieldName('alias')?.text ?? name;
            if (mod) imp(alias, `${mod}.${name}`, node, true);
            else if (alias === name) exportedLocal.add(name);
            else imp(alias, `${opts.module}.${name}`, node, true);
          }
          return;
        }
        const ns = node.namedChildren.find((c) => c?.type === 'namespace_export');
        if (ns && mod) {
          const alias = ns.namedChildren.find((c) => c?.type === 'identifier')?.text;
          if (alias) imp(alias, mod, node, true);
          return;
        }
        if (mod) {
          imp('*', mod, node, true);
          return;
        }
        const value = node.childForFieldName('value');
        if (isDefault && value) {
          if (value.type === 'identifier') imp('default', `${opts.module}.${value.text}`, node, true);
          else visit(value, scope);
        }
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class':
        if (scope.kind === 'module') visitClass(node, scope, exported ? [] : ['internal']);
        else visitChildren(node, scope);
        return;
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name && scope.kind === 'module') addFunction(name, node, scope, 'function', exported ? [] : ['internal']);
        else visitChildren(node, scope);
        return;
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration':
      case 'internal_module':
      case 'module': {
        // Types, enums and namespaces: names an import can name, though not functions to call.
        const name = node.childForFieldName('name')?.text;
        if (name && scope.kind === 'module') out.bindings.push({ scope: scope.qualname, at: scope.qualname, target: name, lineno: node.startPosition.row + 1 });
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of node.namedChildren) if (d?.type === 'variable_declarator') visitDeclarator(d, scope, exported);
        return;
      case 'assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left?.type === 'member_expression' && left.childForFieldName('object')?.type === 'this' && scope.className) {
          out.bindings.push({
            scope: scope.className,
            at: scope.qualname,
            target: `self.${left.childForFieldName('property')?.text}`,
            value: right ? toExpr(right) : undefined,
            lineno: node.startPosition.row + 1,
          });
        }
        visitChildren(node, scope);
        return;
      }
      case 'return_statement': {
        const v = node.namedChildren[0];
        if (v && scope.def && scope.kind === 'function') scope.def.returnExprs.push(toExpr(v));
        visitChildren(node, scope);
        return;
      }
      case 'call_expression':
      case 'new_expression': {
        const fn = node.type === 'call_expression' ? node.childForFieldName('function') : node.childForFieldName('constructor');
        if (fn && fn.type !== 'super' && fn.type !== 'import' && fn.text !== 'require') {
          out.calls.push({ scope: scope.qualname, fn: toExpr(fn), text: fn.text.replace(/\s+/g, ''), lineno: node.startPosition.row + 1 } satisfies PyCall);
        }
        visitChildren(node, scope);
        return;
      }
      default:
        visitChildren(node, scope);
    }
  };

  /** An exported declaration; returns its name (for `export default class X`). */
  const visitExported = (decl: Node, scope: Scope): string | undefined => {
    if (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration') {
      for (const d of decl.namedChildren) if (d?.type === 'variable_declarator') visitDeclarator(d, scope, true);
      return undefined;
    }
    visit(decl, scope, true);
    return decl.childForFieldName('name')?.text;
  };

  const visitChildren = (node: Node, scope: Scope): void => {
    for (const c of node.namedChildren) if (c) visit(c, scope);
  };

  visitChildren(root, { qualname: opts.module, kind: 'module', def: moduleDef });
  // `export { a, b }` of local declarations: those are exported after all.
  for (const d of out.defs) {
    if (d.parent === opts.module && exportedLocal.has(d.name)) d.decorators = d.decorators.filter((x) => x !== 'internal');
  }
  out.idents = [...idents].sort();
  tree.delete();
  return out;
}

export type { PyBinding, PyImport };
