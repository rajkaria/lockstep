import { posix } from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { pythonParser, tsParser } from '../indexer/treesitter.js';
import type { RepoFacts } from './facts.js';
import { joinDir, scriptFacts, type ScriptFacts } from './facts-scripts.js';

/**
 * Static models of the repository's own command-line tools: which subcommands and
 * options each one accepts, read from the code that defines it (commander and yargs
 * in JS/TS; click, typer and argparse in Python). A definition counts only when it is
 * fully static: every command and option name a string literal, no plugin or lazy
 * registration, no "accept unknown options" switch. Anything else marks that part of
 * the model open, and the CLI rules do not judge it.
 */

export interface CliOption {
  names: string[];
  /** Values the option consumes: 0 (a flag), 1, or undefined when it varies (`nargs='?'`, variadic). */
  arity: 0 | 1 | undefined;
}

export interface CliCommand {
  name: string;
  aliases: string[];
  options: CliOption[];
  commands: CliCommand[];
  /** Every subcommand is known. */
  staticCommands: boolean;
  /** Every option is known (no unknown-option passthrough, no option helper we could not follow). */
  staticOptions: boolean;
  /** Takes positional arguments, or runs an action with them: an unknown word may be an argument. */
  acceptsArgs: boolean;
  /** `help <command>` is a subcommand (commander adds it to commands that have subcommands). */
  helpCommand: boolean;
  /** Long options may be abbreviated to a prefix (argparse). */
  abbrev: boolean;
  /** Several subcommands may follow each other (click `chain=True`). */
  chain?: boolean;
  parent?: CliCommand;
  /** commander: an action handler, which receives unknown words as arguments. */
  hasAction?: boolean;
  /** commander: `.helpCommand(false)` turned the implicit `help` command off. */
  noHelpCommand?: boolean;
  /** Unknown options pass through this command to code we do not see (`allowUnknownOption`, `ignore_unknown_options`, `parse_known_args`). */
  passthrough?: boolean;
}

export interface OwnCli {
  /** The name it is invoked by: a bin, a console script, or `python -m pkg`. */
  name: string;
  framework: 'commander' | 'yargs' | 'click' | 'typer' | 'argparse';
  /** The file that defines the root command. */
  source: string;
  /** Directory of the package or pyproject that declares it ('' for the root). */
  dir: string;
  root: CliCommand;
}

export interface CliFacts {
  /** By invocation name (`staleproof`, `httpx`, `python -m pkg`). */
  byName: Map<string, OwnCli>;
  /** By the bin's file and its source file (`dist/cli.js`, `src/cli.ts`), for `node dist/cli.js`, `tsx src/cli.ts`. */
  byPath: Map<string, OwnCli>;
  /** Package names whose (single) bin is one of these CLIs, for `npx @scope/pkg`. */
  byPackage: Map<string, OwnCli>;
  /** This repository's CLI names whose definition is not static (never judged, never mistaken for someone else's). */
  opaque: Set<string>;
}

export function newCommand(name: string, parent?: CliCommand): CliCommand {
  return { name, aliases: [], options: [], commands: [], staticCommands: true, staticOptions: true, acceptsArgs: false, helpCommand: false, abbrev: false, ...(parent ? { parent } : {}) };
}

/** Mark a command (and everything under it) as not judgeable. */
function open(cmd: CliCommand): void {
  cmd.staticCommands = false;
  cmd.staticOptions = false;
}

const cache = new WeakMap<RepoFacts, Promise<CliFacts>>();

export function cliFacts(facts: RepoFacts): Promise<CliFacts> {
  let p = cache.get(facts);
  if (!p) {
    p = loadCliFacts(facts);
    cache.set(facts, p);
  }
  return p;
}

/** Commands that are never a repository's own CLI, whatever a package.json says. */
const SYSTEM = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'python3', 'pip', 'git', 'make', 'just', 'task', 'docker', 'sh', 'bash', 'test', 'ls', 'cd', 'cat', 'echo', 'env', 'sudo', 'uv', 'uvx', 'poetry', 'hatch', 'tsc', 'tsx', 'go', 'cargo', 'curl', 'open', 'code']);

async function loadCliFacts(facts: RepoFacts): Promise<CliFacts> {
  const sf = await scriptFacts(facts);
  const out: CliFacts = { byName: new Map(), byPath: new Map(), byPackage: new Map(), opaque: new Set() };
  const trees = new TreeCache(facts);
  try {
    for (const pkg of sf.packages) {
      for (const [bin, file] of pkg.bins) {
        if (SYSTEM.has(bin)) continue;
        const binPath = joinDir(pkg.dir, file.replace(/^\.\//, ''));
        if (binPath === undefined) continue;
        const found = await jsCli(binPath, trees).catch(() => undefined);
        if (!found) {
          out.opaque.add(bin);
          continue;
        }
        const cli: OwnCli = { name: bin, framework: found.framework, source: found.source, dir: pkg.dir, root: found.root };
        if (!out.byName.has(bin)) out.byName.set(bin, cli);
        out.byPath.set(binPath, cli);
        out.byPath.set(found.source, cli);
        if (pkg.name && pkg.bins.size === 1) out.byPackage.set(pkg.name, cli);
      }
    }
    for (const py of sf.pyprojects) {
      for (const [name, entry] of py.scripts) {
        if (SYSTEM.has(name)) continue;
        const m = /^\s*([\w.]+)\s*:\s*([\w.]+)/.exec(entry);
        const found = m ? await pythonCli(m[1]!, m[2]!, py.dir, sf, trees).catch(() => undefined) : undefined;
        if (!found) {
          out.opaque.add(name);
          continue;
        }
        if (!out.byName.has(name)) out.byName.set(name, { name, framework: found.framework, source: found.source, dir: py.dir, root: found.root });
      }
    }
    // `python -m pkg` for the repository's packages that have a `__main__.py`.
    for (const [pkg, roots] of sf.pyPackages) {
      for (const root of roots) {
        const main = `${root}/__main__.py`;
        if (!facts.files.has(main)) continue;
        const found = await pythonMain(pkg, main, sf, trees).catch(() => undefined);
        const name = `python -m ${pkg}`;
        if (!found) out.opaque.add(name);
        else if (!out.byName.has(name)) out.byName.set(name, { name, framework: found.framework, source: found.source, dir: root, root: found.root });
        break;
      }
    }
  } finally {
    trees.dispose();
  }
  return out;
}

// ------------------------------------------------------------------ parsing helpers

class TreeCache {
  private trees = new Map<string, Promise<Tree | undefined>>();
  constructor(readonly facts: RepoFacts) {}

  get(path: string): Promise<Tree | undefined> {
    let t = this.trees.get(path);
    if (!t) {
      t = (async () => {
        const text = await this.facts.text(path);
        if (text === undefined || text.length > 2_000_000) return undefined;
        const parser = path.endsWith('.py') ? await pythonParser() : await tsParser(/\.(tsx|jsx|js|mjs|cjs)$/.test(path) || !/\.[cm]?ts$/.test(path));
        return parser.parse(text) ?? undefined;
      })();
      this.trees.set(path, t);
    }
    return t;
  }

  dispose(): void {
    for (const t of this.trees.values()) void t.then((x) => x?.delete());
    this.trees.clear();
  }
}

const kids = (n: Node | null | undefined): Node[] => (n?.namedChildren ?? []).filter((c): c is Node => !!c);

/** A JS/TS string literal's value (template strings without substitutions too). */
function jsString(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'string') return kids(n).map((c) => (c.type === 'escape_sequence' ? JSON.parse(`"${c.text}"`) : c.text)).join('');
  if (n.type === 'template_string' && !kids(n).some((c) => c.type === 'template_substitution')) return kids(n).map((c) => c.text).join('');
  if (n.type === 'parenthesized_expression') return jsString(kids(n)[0]);
  return undefined;
}

/** A Python string literal's value (no f-string interpolation; implicit concatenation joined). */
function pyString(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'concatenated_string') {
    const parts = kids(n).map(pyString);
    return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
  }
  if (n.type !== 'string' || kids(n).some((c) => c.type === 'interpolation')) return undefined;
  return kids(n)
    .filter((c) => c.type === 'string_content' || c.type === 'escape_sequence')
    .map((c) => c.text)
    .join('');
}

function walk(n: Node, visit: (n: Node) => boolean | void): void {
  if (visit(n) === false) return;
  for (const c of kids(n)) walk(c, visit);
}

// ------------------------------------------------------------------ JS/TS: commander, yargs

const SRC_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];

/** The source files a bin path may come from: itself, or `src/` for a build output (`dist/cli.js` → `src/cli.ts`). */
function sourcesFor(path: string, facts: RepoFacts): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (facts.files.has(p) && !out.includes(p)) out.push(p);
  };
  add(path);
  const stem = path.replace(/\.[cm]?[jt]sx?$/, '');
  for (const e of SRC_EXT) add(`${stem}${e}`);
  const m = /^(.*?)(?:^|\/)(dist|build|lib|out|esm|cjs|bin)\/(.*)$/.exec(stem);
  if (m) {
    const base = m[1] ? `${m[1]}/` : '';
    const rest = m[3]!;
    for (const dir of ['src', 'source', 'lib', 'bin', '']) {
      for (const e of SRC_EXT) {
        add(`${base}${dir ? `${dir}/` : ''}${rest}${e}`);
        add(`${base}${dir ? `${dir}/` : ''}${rest}/index${e}`);
        // `dist/bin/codemod.js` from `src/bin/codemod.ts`; `dist/index.js` from `src/cli.ts` is not guessed.
      }
    }
  }
  return out;
}

/** Relative imports and requires of a module, resolved to repository files. */
function jsImports(tree: Tree, from: string, facts: RepoFacts): string[] {
  const out: string[] = [];
  walk(tree.rootNode, (n) => {
    let spec: string | undefined;
    if (n.type === 'import_statement' || n.type === 'export_statement') spec = jsString(n.childForFieldName('source'));
    else if (n.type === 'call_expression' && ['require', 'import'].includes(n.childForFieldName('function')?.text ?? '')) spec = jsString(kids(n.childForFieldName('arguments'))[0]);
    if (spec?.startsWith('.')) {
      const p = joinDir(posix.dirname(from) === '.' ? '' : posix.dirname(from), spec);
      if (p !== undefined) for (const s of sourcesFor(p, facts)) out.push(s);
    }
  });
  return out;
}

interface Found {
  framework: OwnCli['framework'];
  source: string;
  root: CliCommand;
}

/** Follow a bin to the file that defines its commander/yargs program (through thin wrappers, up to 3 hops). */
async function jsCli(binPath: string, trees: TreeCache): Promise<Found | undefined> {
  const seen = new Set<string>();
  let frontier = sourcesFor(binPath, trees.facts);
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      if (seen.has(file)) continue;
      seen.add(file);
      const tree = await trees.get(file);
      if (!tree) continue;
      const text = tree.rootNode.text;
      if (/['"](commander|@commander-js\/extra-typings)['"]/.test(text)) {
        const root = await commanderProgram(file, tree, trees);
        return root ? { framework: 'commander', source: file, root } : undefined;
      }
      if (/['"]yargs(\/yargs)?['"]/.test(text)) {
        const root = yargsProgram(tree);
        return root ? { framework: 'yargs', source: file, root } : undefined;
      }
      // Another CLI framework (or none we read): not modelled.
      if (/['"](cac|meow|clipanion|oclif|@oclif\/core|citty|sade|minimist|mri|arg|clime|gunshi|cleye|@effect\/cli|cmd-ts|vorpal|caporal|optionator|ink)['"]|process\.argv/.test(text) && !/['"]\.\.?\//.test(text)) return undefined;
      next.push(...jsImports(tree, file, trees.facts));
    }
    frontier = next;
  }
  return undefined;
}

type JsVal =
  | { k: 'cmd'; cmd: CliCommand }
  | { k: 'option'; option: CliOption | undefined }
  | { k: 'func'; node: Node; file: string }
  | { k: 'module'; file: string }
  /** A relative import, read only when a command needs it. */
  | { k: 'lazy'; spec: string; name: string; from: string }
  /** A variable whose value is computed only when a command needs it (`const lint = makeLint()`). */
  | { k: 'deferred'; node: Node; scope: JsScope; path: string; memo?: JsVal }
  | { k: 'commander' }
  | { k: 'unknown' };

const UNKNOWN: JsVal = { k: 'unknown' };

/** `-x, --xx <v>`, `-x|--xx`, `--no-x` → names and arity. */
export function commanderFlags(flags: string): CliOption {
  const names = flags.split(/[ ,|]+/).filter((t) => /^--?[\w-]/.test(t));
  const arity = /<[^>]*>/.test(flags) ? 1 : /\[[^\]]*\]/.test(flags) ? undefined : 0;
  return { names, arity: /\.\.\./.test(flags) && arity !== 0 ? undefined : arity };
}

interface JsScope {
  vars: Map<string, JsVal>;
  parent?: JsScope;
}

function lookup(scope: JsScope, name: string): JsVal | undefined {
  for (let s: JsScope | undefined = scope; s; s = s.parent) if (s.vars.has(name)) return s.vars.get(name);
  return undefined;
}

/**
 * Interpret a commander program statically: `new Command()`, `program`, chains of
 * `.command()`, `.option()`, `.addCommand()`, `.argument()`, `.action()`, `.alias()`,
 * variables holding commands, and functions (in this file or imported relatively)
 * that build or extend commands. Anything else that touches a command marks it open.
 */
async function commanderProgram(file: string, tree: Tree, trees: TreeCache): Promise<CliCommand | undefined> {
  const parsedRoots: CliCommand[] = [];
  const created: CliCommand[] = [];
  let programCmd: CliCommand | undefined;
  let dynamic = false;
  const files = new Map<string, Tree>([[file, tree]]);
  const moduleScopes = new Map<string, JsScope>();
  let budget = 4000;

  const program = () => (programCmd ??= newCommand(''));

  /** A value handed to code we do not follow: a command may get anything added; a callback may add to any command. */
  const markEscaped = (v: JsVal) => {
    if (v.k === 'cmd') open(v.cmd);
    if (v.k === 'func' && /\.(option|requiredOption|addOption|command|addCommand)\s*\(/.test(v.node.text)) dynamic = true;
  };

  const methods = new Set(['command', 'option', 'requiredOption', 'addOption', 'addCommand', 'argument', 'arguments', 'addArgument', 'alias', 'aliases', 'version', 'helpOption', 'helpCommand', 'addHelpCommand', 'allowUnknownOption', 'passThroughOptions', 'allowExcessArguments', 'action', 'name', 'parse', 'parseAsync']);

  async function moduleScope(path: string): Promise<JsScope | undefined> {
    if (moduleScopes.has(path)) return moduleScopes.get(path);
    const t = files.get(path) ?? (await trees.get(path));
    if (!t) return undefined;
    files.set(path, t);
    const scope: JsScope = { vars: new Map() };
    moduleScopes.set(path, scope);
    await execBlock(kids(t.rootNode), scope, path);
    return scope;
  }

  async function importBinding(spec: string, imported: string, from: string): Promise<JsVal> {
    if (spec === 'commander' || spec === '@commander-js/extra-typings') {
      if (imported === 'program' || imported === 'default') return { k: 'cmd', cmd: program() };
      if (imported === 'Command' || imported === 'createCommand' || imported === 'Option' || imported === 'Argument' || imported === '*') return { k: 'commander' };
      return UNKNOWN;
    }
    if (!spec.startsWith('.')) return UNKNOWN;
    return { k: 'lazy', spec, name: imported, from };
  }

  /** The value behind a lazy import or deferred variable. */
  async function force(v: JsVal | undefined, depth = 0): Promise<JsVal> {
    if (!v) return UNKNOWN;
    if (depth > 8) return UNKNOWN;
    if (v.k === 'deferred') {
      v.memo ??= await evalExpr(v.node, v.scope, v.path, true);
      return force(v.memo, depth + 1);
    }
    if (v.k !== 'lazy') return v;
    const base = joinDir(posix.dirname(v.from) === '.' ? '' : posix.dirname(v.from), v.spec);
    const target = base !== undefined ? sourcesFor(base, trees.facts)[0] : undefined;
    if (!target) return UNKNOWN;
    if (v.name === '*') return { k: 'module', file: target };
    const scope = await moduleScope(target);
    return force(scope?.vars.get(v.name === 'default' ? '\0default' : v.name), depth + 1);
  }

  async function execBlock(stmts: Node[], scope: JsScope, path: string): Promise<JsVal | undefined> {
    // Function declarations are hoisted.
    for (const s of stmts) {
      const d = s.type === 'export_statement' ? (s.childForFieldName('declaration') ?? s) : s;
      if (d.type === 'function_declaration' || d.type === 'generator_function_declaration') {
        const name = d.childForFieldName('name')?.text;
        if (name) scope.vars.set(name, { k: 'func', node: d, file: path });
        if (s.type === 'export_statement' && /^export\s+default\b/.test(s.text)) scope.vars.set('\0default', { k: 'func', node: d, file: path });
      }
    }
    let ret: JsVal | undefined;
    for (const s of stmts) {
      const r = await exec(s, scope, path);
      if (r && !ret) ret = r;
    }
    return ret;
  }

  async function exec(s: Node, scope: JsScope, path: string): Promise<JsVal | undefined> {
    if (--budget < 0) {
      dynamic = true;
      return undefined;
    }
    switch (s.type) {
      case 'import_statement': {
        const spec = jsString(s.childForFieldName('source'));
        if (!spec) return undefined;
        const clause = kids(s).find((c) => c.type === 'import_clause');
        for (const c of kids(clause)) {
          if (c.type === 'identifier') scope.vars.set(c.text, await importBinding(spec, 'default', path));
          else if (c.type === 'namespace_import') {
            const id = kids(c).find((x) => x.type === 'identifier');
            if (id) scope.vars.set(id.text, spec.startsWith('.') ? await importBinding(spec, '*', path) : spec.includes('commander') ? { k: 'commander' } : UNKNOWN);
          } else if (c.type === 'named_imports') {
            for (const spec2 of kids(c).filter((x) => x.type === 'import_specifier')) {
              const name = spec2.childForFieldName('name')?.text;
              const alias = spec2.childForFieldName('alias')?.text ?? name;
              if (name && alias) scope.vars.set(alias, await importBinding(spec, name, path));
            }
          }
        }
        return undefined;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of kids(s).filter((x) => x.type === 'variable_declarator')) {
          const nameNode = d.childForFieldName('name');
          const valueNode = d.childForFieldName('value');
          if (!nameNode) continue;
          const req = valueNode?.type === 'call_expression' && valueNode.childForFieldName('function')?.text === 'require' ? jsString(kids(valueNode.childForFieldName('arguments'))[0]) : undefined;
          if (nameNode.type === 'object_pattern') {
            for (const p of kids(nameNode)) {
              const key = p.type === 'pair_pattern' ? p.childForFieldName('key')?.text : p.text;
              const local = p.type === 'pair_pattern' ? p.childForFieldName('value')?.text : p.text;
              if (key && local) scope.vars.set(local, req !== undefined ? await importBinding(req, key, path) : UNKNOWN);
            }
            continue;
          }
          if (nameNode.type !== 'identifier') continue;
          if (req !== undefined) {
            scope.vars.set(nameNode.text, req.includes('commander') ? { k: 'commander' } : req.startsWith('.') ? await importBinding(req, '*', path) : UNKNOWN);
            continue;
          }
          const v = valueNode ? await evalExpr(valueNode, scope, path) : UNKNOWN;
          scope.vars.set(nameNode.text, v.k === 'unknown' && valueNode && /^(call_expression|member_expression|identifier|await_expression)$/.test(valueNode.type) ? { k: 'deferred', node: valueNode, scope, path } : v);
        }
        return undefined;
      }
      case 'export_statement': {
        const decl = s.childForFieldName('declaration');
        if (decl) return exec(decl, scope, path);
        const value = s.childForFieldName('value') ?? kids(s).find((c) => c.type !== 'export_clause' && c.type !== 'string');
        if (value && /^export\s+default\b/.test(s.text)) scope.vars.set('\0default', await evalExpr(value, scope, path));
        return undefined;
      }
      case 'expression_statement':
        await evalExpr(kids(s)[0]!, scope, path);
        return undefined;
      case 'return_statement': {
        const v = kids(s)[0];
        return v ? evalExpr(v, scope, path) : UNKNOWN;
      }
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
        if (s.type === 'class_declaration' && /\bextends\s+(\w+\.)?Command\b/.test(s.text)) dynamic = true;
        return undefined;
      case 'statement_block':
        return execBlock(kids(s), { vars: new Map(), parent: scope }, path);
      default: {
        // if / for / while / try / switch / labeled: every branch, once.
        let ret: JsVal | undefined;
        for (const c of kids(s)) {
          if (/statement|block|clause|case|default/.test(c.type) || c.type === 'expression_statement') {
            const r = await exec(c, scope, path);
            if (r && !ret) ret = r;
          }
        }
        return ret;
      }
    }
  }

  async function callFunc(f: Extract<JsVal, { k: 'func' }>, args: JsVal[], scope: JsScope): Promise<JsVal> {
    const fscope: JsScope = { vars: new Map(), parent: (await moduleScope(f.file)) ?? scope };
    const params = kids(f.node.childForFieldName('parameters') ?? f.node.childForFieldName('parameter'));
    const single = f.node.childForFieldName('parameter');
    const list = single ? [single] : params;
    list.forEach((p, i) => {
      const id = p.type === 'identifier' ? p : (p.childForFieldName('pattern') ?? kids(p).find((c) => c.type === 'identifier'));
      if (id?.type === 'identifier') fscope.vars.set(id.text, args[i] ?? UNKNOWN);
    });
    const body = f.node.childForFieldName('body');
    if (!body) return UNKNOWN;
    if (body.type !== 'statement_block') return evalExpr(body, fscope, f.file);
    return (await execBlock(kids(body), fscope, f.file)) ?? UNKNOWN;
  }

  async function evalArgs(n: Node | null, scope: JsScope, path: string, want = false): Promise<{ vals: JsVal[]; nodes: Node[] }> {
    const nodes = kids(n).filter((c) => c.type !== 'comment');
    const vals: JsVal[] = [];
    for (const a of nodes) vals.push(a.type === 'arrow_function' || a.type === 'function_expression' || a.type === 'function' ? { k: 'func', node: a, file: path } : await evalExpr(a, scope, path, want));
    return { vals, nodes };
  }

  /** `want`: the caller needs a command here (`addCommand(x)`), so imports and deferred values are read. */
  async function evalExpr(n: Node, scope: JsScope, path: string, want = false): Promise<JsVal> {
    if (--budget < 0) {
      dynamic = true;
      return UNKNOWN;
    }
    switch (n.type) {
      case 'identifier': {
        const v = lookup(scope, n.text);
        return want ? force(v) : (v ?? UNKNOWN);
      }
      case 'parenthesized_expression':
      case 'await_expression':
      case 'as_expression':
      case 'satisfies_expression':
      case 'non_null_expression':
        return kids(n)[0] ? evalExpr(kids(n)[0]!, scope, path, want) : UNKNOWN;
      case 'arrow_function':
      case 'function_expression':
      case 'function':
        return { k: 'func', node: n, file: path };
      case 'new_expression': {
        const ctor = n.childForFieldName('constructor');
        const ctorVal = ctor ? (ctor.type === 'member_expression' ? await evalExpr(ctor.childForFieldName('object')!, scope, path) : lookup(scope, ctor.text)) : undefined;
        const ctorName = ctor?.type === 'member_expression' ? ctor.childForFieldName('property')?.text : ctor?.text;
        const { vals, nodes } = await evalArgs(n.childForFieldName('arguments'), scope, path);
        if (ctorVal?.k === 'commander') {
          if (ctorName === 'Command') {
            const name = nodes[0] ? jsString(nodes[0]) : '';
            const cmd = newCommand(name ?? '');
            if (name === undefined) open(cmd);
            created.push(cmd);
            return { k: 'cmd', cmd };
          }
          if (ctorName === 'Option') {
            const flags = jsString(nodes[0]);
            return { k: 'option', option: flags !== undefined ? commanderFlags(flags) : undefined };
          }
          return UNKNOWN;
        }
        for (const v of vals) markEscaped(v);
        return UNKNOWN;
      }
      case 'member_expression': {
        let obj = await evalExpr(n.childForFieldName('object')!, scope, path);
        const prop = n.childForFieldName('property')?.text ?? '';
        if (want && (obj.k === 'lazy' || obj.k === 'deferred')) obj = await force(obj);
        if (obj.k === 'commander' && prop === 'program') return { k: 'cmd', cmd: program() };
        if (obj.k === 'commander') return { k: 'commander' };
        if (obj.k === 'module') {
          const ms = await moduleScope(obj.file);
          return ms?.vars.get(prop) ?? UNKNOWN;
        }
        return UNKNOWN;
      }
      case 'call_expression': {
        const fn = n.childForFieldName('function')!;
        const argsNode = n.childForFieldName('arguments');
        if (fn.type === 'member_expression') {
          let base = await evalExpr(fn.childForFieldName('object')!, scope, path);
          const prop = fn.childForFieldName('property')?.text ?? '';
          // A chain on a variable (`lint.option(...)`) needs the command the variable holds.
          if (base.k === 'deferred' || (base.k === 'lazy' && (want || methods.has(prop)))) base = await force(base);
          const { vals, nodes } = await evalArgs(argsNode, scope, path, base.k === 'cmd' && (prop === 'addCommand' || prop === 'addOption'));
          if (base.k === 'cmd') return applyMethod(base.cmd, prop, vals, nodes);
          if (base.k === 'option') {
            // `new Option(...).default(x).choices([...])`
            return base;
          }
          if (base.k === 'commander' && prop === 'createCommand') {
            const name = jsString(nodes[0]);
            const cmd = newCommand(name ?? '');
            if (name === undefined) open(cmd);
            created.push(cmd);
            return { k: 'cmd', cmd };
          }
          if (base.k === 'lazy' && base.name === '*' && (want || vals.some((v) => v.k === 'cmd'))) base = await force(base);
          if (base.k === 'module') {
            const ms = await moduleScope(base.file);
            const f = await force(ms?.vars.get(prop));
            if (f.k === 'func') return callFunc(f, vals, scope);
          }
          // A command-shaped call on something we cannot follow (a parameter, a helper's result).
          if (base.k === 'unknown') {
            const first = jsString(nodes[0]);
            if (((prop === 'option' || prop === 'requiredOption') && first?.startsWith('-')) || (prop === 'command' && first !== undefined) || prop === 'addCommand' || prop === 'addOption') dynamic = true;
          }
          for (const v of vals) markEscaped(v);
          return UNKNOWN;
        }
        let callee = fn.type === 'identifier' ? lookup(scope, fn.text) : await evalExpr(fn, scope, path);
        const { vals, nodes } = await evalArgs(argsNode, scope, path);
        // An imported function is read when it builds a command we need or receives one.
        if ((callee?.k === 'lazy' || callee?.k === 'deferred') && (want || vals.some((v) => v.k === 'cmd'))) callee = await force(callee);
        if (callee?.k === 'commander' && fn.text.endsWith('createCommand')) {
          const name = jsString(nodes[0]);
          const cmd = newCommand(name ?? '');
          if (name === undefined) open(cmd);
          created.push(cmd);
          return { k: 'cmd', cmd };
        }
        if (callee?.k === 'func') return callFunc(callee, vals, scope);
        // A command handed to code we cannot read may get anything added.
        for (const v of vals) markEscaped(v);
        return UNKNOWN;
      }
      default:
        return UNKNOWN;
    }
  }

  function applyMethod(cmd: CliCommand, method: string, vals: JsVal[], nodes: Node[]): JsVal {
    const self: JsVal = { k: 'cmd', cmd };
    const str = (i: number) => jsString(nodes[i]);
    switch (method) {
      case 'command': {
        const spec = str(0);
        if (spec === undefined) {
          cmd.staticCommands = false;
          const child = newCommand('', cmd);
          open(child);
          return { k: 'cmd', cmd: child };
        }
        const [name, ...args] = spec.trim().split(/\s+/);
        const child = newCommand(name!, cmd);
        if (args.length) child.acceptsArgs = true;
        cmd.commands.push(child);
        const opts = nodes.find((x) => x.type === 'object');
        if (opts && /\bisDefault\s*:\s*true/.test(opts.text)) cmd.acceptsArgs = true;
        // `.command('x', 'description')`: a stand-alone executable subcommand; returns the parent.
        if (nodes[1] && jsString(nodes[1]) !== undefined) {
          open(child);
          return self;
        }
        if (opts && /\bexecutableFile\b/.test(opts.text)) open(child);
        return { k: 'cmd', cmd: child };
      }
      case 'addCommand': {
        const v = vals[0];
        if (v?.k === 'cmd' && v.cmd.name) {
          v.cmd.parent = cmd;
          if (!cmd.commands.includes(v.cmd)) cmd.commands.push(v.cmd);
          if (nodes[1] && /\bisDefault\s*:\s*true/.test(nodes[1].text)) cmd.acceptsArgs = true;
        } else cmd.staticCommands = false;
        return self;
      }
      case 'option':
      case 'requiredOption': {
        const flags = str(0);
        if (flags === undefined) cmd.staticOptions = false;
        else cmd.options.push(commanderFlags(flags));
        return self;
      }
      case 'addOption': {
        const v = vals[0];
        if (v?.k === 'option' && v.option) cmd.options.push(v.option);
        else cmd.staticOptions = false;
        return self;
      }
      case 'argument':
      case 'arguments':
      case 'addArgument':
      case 'allowExcessArguments':
        if (method !== 'allowExcessArguments' || nodes[0]?.text !== 'false') cmd.acceptsArgs = true;
        return self;
      case 'action':
        cmd.hasAction = true;
        return self;
      case 'alias':
      case 'aliases': {
        const list = nodes[0]?.type === 'array' ? kids(nodes[0]).map(jsString) : [str(0)];
        if (list.some((x) => x === undefined)) cmd.parent && (cmd.parent.staticCommands = false);
        else cmd.aliases.push(...(list as string[]));
        return self;
      }
      case 'name': {
        const name = str(0);
        if (name !== undefined) cmd.name = name;
        return self;
      }
      case 'version':
        cmd.options.push(commanderFlags(str(1) ?? '-V, --version'));
        return self;
      case 'helpOption':
        if (str(0) !== undefined) cmd.options.push(commanderFlags(str(0)!));
        return self;
      case 'helpCommand':
      case 'addHelpCommand':
        if (nodes[0]?.text === 'false') cmd.noHelpCommand = true;
        else cmd.helpCommand = true;
        return self;
      case 'allowUnknownOption':
      case 'passThroughOptions':
        if (nodes[0]?.text !== 'false') {
          cmd.staticOptions = false;
          cmd.passthrough = true;
        }
        return self;
      case 'parse':
      case 'parseAsync':
        parsedRoots.push(cmd);
        return UNKNOWN;
      case 'opts':
      case 'optsWithGlobals':
      case 'getOptionValue':
      case 'outputHelp':
      case 'help':
      case 'helpInformation':
        return UNKNOWN;
      default:
        // description, summary, usage, hook, configureHelp, showHelpAfterError, exitOverride, ...
        if (!methods.has(method)) for (const v of vals) if (v.k === 'cmd' && v.cmd !== cmd) open(v.cmd);
        return self;
    }
  }

  await moduleScope(file);
  if (dynamic) return undefined;
  const root = parsedRoots[0] ?? programCmd ?? created.find((c) => !c.parent);
  if (!root || (parsedRoots.length > 1 && new Set(parsedRoots).size > 1)) return undefined;
  finishCommander(root);
  return root;
}

/** Commander's implicit parts: `help` for commands with subcommands, and an action taking stray words. */
function finishCommander(cmd: CliCommand): void {
  if (cmd.commands.length) {
    if (!cmd.noHelpCommand) cmd.helpCommand = true;
    // A program with subcommands and its own action passes unknown words to that action.
    if (cmd.hasAction) cmd.acceptsArgs = true;
  }
  for (const c of cmd.commands) finishCommander(c);
}

/** yargs: only `.strict()` programs reject unknown commands and options; read `.command('x')` and `.option('x')`. */
function yargsProgram(tree: Tree): CliCommand | undefined {
  const text = tree.rootNode.text;
  const strictCommands = /\.\s*(strict|strictCommands)\s*\(\s*\)/.test(text);
  const strictOptions = /\.\s*(strict|strictOptions)\s*\(\s*\)/.test(text);
  if (!strictCommands && !strictOptions) return undefined;
  if (/\.\s*commandDir\s*\(|\.\s*command\s*\(\s*(?!['"`])|\.\s*options?\s*\(\s*(?!['"`{])/.test(text)) return undefined;
  const root = newCommand('');
  root.staticCommands = strictCommands;
  root.staticOptions = false; // per-command builders make option scope hard to follow statically
  for (const m of text.matchAll(/\.\s*command\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    const [name, ...rest] = m[2]!.trim().split(/\s+/);
    if (!name || name === '$0' || name === '*') {
      root.acceptsArgs = true;
      continue;
    }
    const child = newCommand(name, root);
    child.staticOptions = false;
    if (rest.length) child.acceptsArgs = true;
    root.commands.push(child);
  }
  for (const m of text.matchAll(/aliases\s*:\s*\[([^\]]*)\]/g)) root.staticCommands &&= /^[\s'"`\w,-]*$/.test(m[1]!);
  return root;
}

// ------------------------------------------------------------------ Python: click, typer, argparse

interface PyModuleInfo {
  module: string;
  path: string;
  tree: Tree;
  isPackage: boolean;
  /** Local name → (module, attribute) it was imported from (`attr` undefined for `import a.b as m`). */
  imports: Map<string, { module: string; attr?: string }>;
  /** Module-level functions (the decorated_definition when decorated). */
  defs: Map<string, Node>;
  /** Module-level `name = value`. */
  assigns: Map<string, Node>;
}

class PyWorld {
  private mods = new Map<string, Promise<PyModuleInfo | undefined>>();
  private texts = new Map<string, Promise<string | undefined>>();
  constructor(
    readonly sf: ScriptFacts,
    readonly trees: TreeCache,
    /** Directory of the pyproject that names the entry point (for single-file modules). */
    readonly baseDir = '',
  ) {}

  /** A file's text, read once (every group scans its package's files for registrations). */
  text(path: string): Promise<string | undefined> {
    let t = this.texts.get(path);
    if (!t) {
      t = this.trees.facts.text(path);
      this.texts.set(path, t);
    }
    return t;
  }

  /** The file of a dotted module, or undefined. */
  fileOf(module: string): { path: string; isPackage: boolean } | undefined {
    const parts = module.split('.');
    const files = this.trees.facts.files;
    const roots = this.sf.pyPackages.get(parts[0]!) ?? [];
    for (const root of roots) {
      const p = [root, ...parts.slice(1)].join('/');
      if (files.has(`${p}.py`)) return { path: `${p}.py`, isPackage: false };
      if (files.has(`${p}/__init__.py`)) return { path: `${p}/__init__.py`, isPackage: true };
    }
    for (const base of [this.baseDir, this.baseDir ? `${this.baseDir}/src` : 'src', '']) {
      const p = [base, ...parts].filter(Boolean).join('/');
      if (files.has(`${p}.py`)) return { path: `${p}.py`, isPackage: false };
      if (files.has(`${p}/__init__.py`)) return { path: `${p}/__init__.py`, isPackage: true };
    }
    return undefined;
  }

  load(module: string, path?: string): Promise<PyModuleInfo | undefined> {
    let m = this.mods.get(module);
    if (!m) {
      m = (async () => {
        const f = path ? { path, isPackage: path.endsWith('__init__.py') } : this.fileOf(module);
        if (!f) return undefined;
        const tree = await this.trees.get(f.path);
        if (!tree) return undefined;
        const info: PyModuleInfo = { module, path: f.path, tree, isPackage: f.isPackage, imports: new Map(), defs: new Map(), assigns: new Map() };
        const visit = (stmts: Node[]) => {
          for (const s of stmts) {
            if (s.type === 'import_from_statement' || s.type === 'import_statement') addImport(info, s);
            else if (s.type === 'function_definition' || s.type === 'decorated_definition') {
              const def = s.type === 'decorated_definition' ? s.childForFieldName('definition') : s;
              const name = def?.type === 'function_definition' ? def.childForFieldName('name')?.text : undefined;
              if (name) info.defs.set(name, s);
            } else if (s.type === 'expression_statement') {
              const a = kids(s)[0];
              if (a?.type === 'assignment' && a.childForFieldName('left')?.type === 'identifier') {
                const right = a.childForFieldName('right');
                if (right) info.assigns.set(a.childForFieldName('left')!.text, right);
              }
            } else if (s.type === 'try_statement') {
              // `try: from ._main import main` binds the real name; the `except ImportError:` fallback does not count.
              const body = s.childForFieldName('body');
              if (body) visit(kids(body));
            } else if (s.type === 'if_statement') {
              for (const c of kids(s)) if (c.type === 'block') visit(kids(c));
                else for (const cc of kids(c)) if (cc.type === 'block') visit(kids(cc));
            }
          }
        };
        visit(kids(tree.rootNode));
        return info;
      })();
      this.mods.set(module, m);
    }
    return m;
  }

  /** What a name in a module refers to: a def, an assignment, or (following imports) one in another module. */
  async resolve(mod: PyModuleInfo, name: string, depth = 0): Promise<{ mod: PyModuleInfo; name: string; def?: Node; value?: Node } | undefined> {
    if (depth > 6) return undefined;
    const def = mod.defs.get(name);
    if (def) return { mod, name, def };
    const value = mod.assigns.get(name);
    if (value) {
      if (value.type === 'identifier' && value.text !== name) return this.resolve(mod, value.text, depth + 1);
      return { mod, name, value };
    }
    const imp = mod.imports.get(name);
    if (!imp) return undefined;
    if (imp.attr) {
      // `from pkg import sub` may name a submodule rather than an attribute.
      const target = (await this.load(imp.module)) ?? undefined;
      if (target) {
        const r = await this.resolve(target, imp.attr, depth + 1);
        if (r) return r;
      }
      return undefined;
    }
    return undefined;
  }

  /** The module an attribute chain like `cli.commands` names (`import a.b as m`). */
  async moduleOf(mod: PyModuleInfo, name: string): Promise<PyModuleInfo | undefined> {
    const imp = mod.imports.get(name);
    if (!imp) return undefined;
    return this.load(imp.attr ? `${imp.module}.${imp.attr}` : imp.module);
  }
}

/** Record what an import statement binds in `info` (relative imports resolved against its package). */
function addImport(info: PyModuleInfo, s: Node): void {
  const pkg = info.isPackage ? info.module : info.module.split('.').slice(0, -1).join('.');
  if (s.type === 'import_from_statement') {
    const modNode = s.childForFieldName('module_name');
    let from = modNode?.text ?? '';
    if (modNode?.type === 'relative_import') {
      const dots = /^\.+/.exec(from)![0].length;
      const base = pkg.split('.').slice(0, Math.max(0, pkg.split('.').length - (dots - 1)));
      from = [...base, from.slice(dots)].filter(Boolean).join('.');
    }
    for (const nm of s.childrenForFieldName('name')) {
      const name = nm.type === 'aliased_import' ? nm.childForFieldName('name')!.text : nm.text;
      const alias = nm.type === 'aliased_import' ? nm.childForFieldName('alias')!.text : name;
      info.imports.set(alias, { module: from, attr: name });
    }
  } else if (s.type === 'import_statement') {
    for (const nm of s.childrenForFieldName('name')) {
      if (nm.type === 'aliased_import') info.imports.set(nm.childForFieldName('alias')!.text, { module: nm.childForFieldName('name')!.text });
      else info.imports.set(nm.text.split('.')[0]!, { module: nm.text.split('.')[0]! });
    }
  }
}

function pyArgs(call: Node): { positional: Node[]; keywords: Map<string, Node>; splat: boolean } {
  const positional: Node[] = [];
  const keywords = new Map<string, Node>();
  let splat = false;
  for (const a of kids(call.childForFieldName('arguments'))) {
    if (a.type === 'keyword_argument') keywords.set(a.childForFieldName('name')!.text, a.childForFieldName('value')!);
    else if (a.type === 'list_splat' || a.type === 'dictionary_splat') splat = true;
    else if (a.type !== 'comment') positional.push(a);
  }
  return { positional, keywords, splat };
}

/** The dotted text of a callee (`click.option`, `app.command`, `option`). */
const calleeText = (n: Node | null | undefined): string => (n?.type === 'call' ? (n.childForFieldName('function')?.text ?? '') : (n?.text ?? '')).replace(/\s+/g, '');

const kebab = (s: string) => s.replace(/_/g, '-');

/** Names a click/typer command derived from a function may be invoked by (click 8.2 strips `_command`-style suffixes). */
function derivedNames(fn: string): string[] {
  const k = kebab(fn).toLowerCase();
  const stripped = k.replace(/-(command|cmd|group|grp)$/, '');
  return [...new Set([k, stripped, fn])];
}

function clickDecls(call: Node, cmd: CliCommand, kind: 'option' | 'argument' | 'version' | 'help' | 'password' | 'confirmation'): void {
  const { positional, keywords, splat } = pyArgs(call);
  if (kind === 'argument') {
    cmd.acceptsArgs = true;
    return;
  }
  const decls = positional.map(pyString);
  if (decls.some((d) => d === undefined) || splat) {
    if (kind === 'option') cmd.staticOptions = false;
    return;
  }
  const names = (decls as string[]).flatMap((d) => d.split('/').map((x) => x.trim())).filter((d) => d.startsWith('-'));
  if (kind === 'version') names.push(...(names.length ? [] : ['--version']));
  if (kind === 'help') names.push(...(names.length ? [] : ['--help']));
  if (kind === 'password') names.push(...(names.length ? [] : ['--password']));
  if (kind === 'confirmation') names.push(...(names.length ? [] : ['--yes']));
  if (kind === 'option' && !names.length) {
    cmd.staticOptions = false;
    return;
  }
  const flag =
    kind !== 'option' ||
    (decls as string[]).some((d) => d.includes('/')) ||
    ['True'].includes(keywords.get('is_flag')?.text ?? '') ||
    ['True'].includes(keywords.get('count')?.text ?? '') ||
    keywords.has('flag_value');
  const nargs = keywords.get('nargs')?.text;
  cmd.options.push({ names, arity: flag ? 0 : nargs && nargs !== '1' ? undefined : 1 });
}

/** context_settings that let unknown options or extra arguments through. */
function permissiveContext(keywords: Map<string, Node>): boolean {
  const cs = keywords.get('context_settings');
  if (!cs) return false;
  if (cs.type !== 'dictionary' && cs.type !== 'call') return true;
  return /ignore_unknown_options['"]?\s*[:=]\s*True|allow_interspersed_args['"]?\s*[:=]\s*False/.test(cs.text) || !/^(dict\(|\{)/.test(cs.text.trim());
}

function helpNames(keywords: Map<string, Node>): string[] {
  const cs = keywords.get('context_settings');
  const m = cs ? /help_option_names['"]?\s*[:=]\s*\[([^\]]*)\]/.exec(cs.text) : null;
  return m ? [...m[1]!.matchAll(/['"](-[^'"]+)['"]/g)].map((x) => x[1]!) : [];
}

const CLICK_HARMLESS = /^(click\.)?(pass_context|pass_obj|pass_meta_key|make_pass_decorator|decorators\.pass_context)$|^(functools\.)?wraps$|^(staticmethod|classmethod|typing\.overload|overload)$/;

/** A click command or group from its decorated function. */
async function clickCommand(world: PyWorld, mod: PyModuleInfo, decorated: Node, fnName: string, depth = 0): Promise<CliCommand | undefined> {
  if (depth > 6) return undefined;
  const decorators = kids(decorated).filter((c) => c.type === 'decorator').map((d) => kids(d)[0]!);
  let head: { call?: Node; group: boolean } | undefined;
  let foreign = false;
  const cmd = newCommand('');
  for (const d of decorators) {
    const callee = calleeText(d);
    const last = callee.split('.').pop()!;
    if (/^(command|group)$/.test(last) && !head) {
      head = { group: last === 'group', ...(d.type === 'call' ? { call: d } : {}) };
      continue;
    }
    if (d.type !== 'call' && CLICK_HARMLESS.test(callee)) continue;
    if (d.type === 'call' && CLICK_HARMLESS.test(callee)) continue;
    if (/^(click\.)?option$/.test(callee) && d.type === 'call') clickDecls(d, cmd, 'option');
    else if (/^(click\.)?argument$/.test(callee) && d.type === 'call') clickDecls(d, cmd, 'argument');
    else if (/^(click\.)?version_option$/.test(callee)) d.type === 'call' ? clickDecls(d, cmd, 'version') : cmd.options.push({ names: ['--version'], arity: 0 });
    else if (/^(click\.)?help_option$/.test(callee)) d.type === 'call' ? clickDecls(d, cmd, 'help') : cmd.options.push({ names: ['--help'], arity: 0 });
    else if (/^(click\.)?password_option$/.test(callee)) d.type === 'call' && clickDecls(d, cmd, 'password');
    else if (/^(click\.)?confirmation_option$/.test(callee)) d.type === 'call' && clickDecls(d, cmd, 'confirmation');
    else foreign = true; // a decorator of the project's own (or a plugin loader): it may add options, or commands
  }
  if (!head) return undefined;
  if (foreign) {
    cmd.staticOptions = false;
    if (head.group) cmd.staticCommands = false;
  }
  const { positional, keywords } = head.call ? pyArgs(head.call) : { positional: [], keywords: new Map<string, Node>() };
  const explicit = positional[0] ? pyString(positional[0]) : keywords.get('name') ? pyString(keywords.get('name')) : undefined;
  if ((positional[0] || keywords.get('name')) && explicit === undefined) open(cmd);
  const names = explicit !== undefined ? [explicit] : derivedNames(fnName);
  cmd.name = names[0]!;
  cmd.aliases = names.slice(1);
  const cls = keywords.get('cls');
  if (cls && !/^(click\.)?(Group|Command|RichGroup|RichCommand)$/.test(cls.text)) open(cmd);
  if (permissiveContext(keywords)) {
    cmd.staticOptions = false;
    cmd.passthrough = true;
  }
  for (const h of helpNames(keywords)) cmd.options.push({ names: [h], arity: 0 });
  if (keywords.get('chain')?.text === 'True') cmd.chain = true;
  if (head.group) {
    if (keywords.has('commands')) cmd.staticCommands = false;
    await clickSubcommands(world, mod, fnName, cmd, depth);
  }
  return cmd;
}

/** Files that may register subcommands on `name` defined in `mod`: the module and its package's files that mention it. */
async function relatedModules(world: PyWorld, mod: PyModuleInfo, name: string): Promise<PyModuleInfo[]> {
  const out: PyModuleInfo[] = [mod];
  const top = mod.module.split('.')[0]!;
  const roots = world.sf.pyPackages.get(top) ?? [];
  const re = new RegExp(`\\b${name}\\.(command|group|add_command|add_typer|callback)\\b`);
  for (const root of roots) {
    for (const f of world.trees.facts.files) {
      if (!f.startsWith(`${root}/`) || !f.endsWith('.py') || f === mod.path) continue;
      const text = await world.text(f);
      if (!text || !re.test(text) || !new RegExp(`import[^\\n]*\\b${name}\\b`).test(text)) continue;
      const module = [top, ...f.slice(root.length + 1).replace(/(\/__init__)?\.py$/, '').split('/')].filter(Boolean).join('.');
      const m = await world.load(module, f);
      // A module that imports this object (`from .cli import cli`, or re-exported `from acme import cli`),
      // not another object of the same name.
      const imp = m?.imports.get(name);
      if (m && imp?.attr === name && imp.module.split('.')[0] === top) out.push(m);
    }
  }
  return out;
}

async function clickSubcommands(world: PyWorld, mod: PyModuleInfo, groupName: string, group: CliCommand, depth: number): Promise<void> {
  for (const m of await relatedModules(world, mod, groupName)) {
    // `@group.command()` / `@group.group()` on functions of these modules.
    for (const [fn, node] of m.defs) {
      if (node.type !== 'decorated_definition') continue;
      const decorators = kids(node).filter((c) => c.type === 'decorator').map((d) => kids(d)[0]!);
      if (!decorators.some((d) => new RegExp(`^${groupName}\\.(command|group)$`).test(calleeText(d)))) continue;
      const sub = await clickCommand(world, m, node, fn, depth + 1);
      if (sub) {
        sub.parent = group;
        group.commands.push(sub);
      } else group.staticCommands = false;
    }
    // `group.add_command(cmd, name="x")` anywhere in these modules; the group handed to other code
    // (`pm.hook.register_commands(cli=cli)`) may get any command.
    const calls: Node[] = [];
    walk(m.tree.rootNode, (n) => {
      if (n.type !== 'call') return;
      if (calleeText(n) === `${groupName}.add_command`) calls.push(n);
      else if (escapes(n, groupName)) open(group);
    });
    for (const call of calls) {
      const { positional, keywords } = pyArgs(call);
      const nameNode = keywords.get('name') ?? positional[1];
      const explicit = nameNode ? pyString(nameNode) : undefined;
      if (nameNode && explicit === undefined) {
        group.staticCommands = false;
        continue;
      }
      const target = positional[0];
      let sub: CliCommand | undefined;
      if (target?.type === 'identifier') {
        const r = await world.resolve(m, target.text);
        if (r?.def?.type === 'decorated_definition') sub = await clickCommand(world, r.mod, r.def, r.name, depth + 1);
      } else if (target?.type === 'attribute') {
        const modName = target.childForFieldName('object')?.text ?? '';
        const target2 = await world.moduleOf(m, modName);
        const attr = target.childForFieldName('attribute')!.text;
        const r = target2 ? await world.resolve(target2, attr) : undefined;
        if (r?.def?.type === 'decorated_definition') sub = await clickCommand(world, r.mod, r.def, r.name, depth + 1);
      }
      if (!sub && explicit === undefined) {
        group.staticCommands = false;
        continue;
      }
      if (!sub) {
        sub = newCommand(explicit!, group);
        open(sub);
      }
      if (explicit !== undefined) {
        sub.aliases = [];
        sub.name = explicit;
      }
      sub.parent = group;
      group.commands.push(sub);
    }
  }
}

/** A call that passes `name` itself to some other function (not one of its own methods). */
function escapes(call: Node, name: string): boolean {
  if (calleeText(call).startsWith(`${name}.`)) return false;
  if (!kids(call.childForFieldName('arguments')).some((a) => (a.type === 'keyword_argument' ? a.childForFieldName('value')?.text : a.text) === name)) return false;
  // Inside a function that binds the same name (a parameter, a local `logs = ...`), it is another value.
  for (let p = call.parent; p; p = p.parent) {
    if (p.type !== 'function_definition') continue;
    const params = p.childForFieldName('parameters');
    if (params && new RegExp(`(^|[(,\\s*])${name}\\b`).test(params.text)) return false;
    let bound = false;
    walk(p.childForFieldName('body')!, (n) => {
      if (n.type === 'function_definition' || bound) return false;
      if ((n.type === 'assignment' || n.type === 'augmented_assignment' || n.type === 'for_statement') && n.childForFieldName('left')?.text.split(/[\s,()]+/).includes(name)) bound = true;
      if (n.type === 'as_pattern_target' && n.text === name) bound = true;
    });
    if (bound) return false;
  }
  return true;
}

/** Python type annotation text says bool. */
const isBool = (t: string | undefined) => !!t && /^(bool|Optional\[bool\]|bool\s*\|\s*None|None\s*\|\s*bool|typing\.Optional\[bool\])$/.test(t.replace(/\s+/g, ' ').trim());

/** Typer parameters → options and arguments. */
function typerParams(fn: Node, cmd: CliCommand): void {
  for (const p of kids(fn.childForFieldName('parameters'))) {
    if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
      cmd.staticOptions = false;
      continue;
    }
    if (p.type === 'keyword_separator' || p.type === 'positional_separator' || p.type === 'comment') continue;
    const nameNode = p.type === 'identifier' ? p : (p.childForFieldName('name') ?? kids(p).find((c) => c.type === 'identifier'));
    const name = nameNode?.text ?? '';
    const typeNode = p.childForFieldName('type');
    const typeText = typeNode?.text ?? '';
    const value = p.childForFieldName('value');
    if (/(^|\.)Context$/.test(typeText) || name === 'self') continue;
    // `Annotated[T, typer.Option(...)]` or a default of `typer.Option(...)`.
    let marker: Node | undefined;
    let base = typeText;
    const gen = typeNode ? kids(typeNode).find((c) => c.type === 'generic_type') : undefined;
    if (gen && /^Annotated$|\.Annotated$/.test(kids(gen)[0]?.text ?? '')) {
      const params = kids(kids(gen).find((c) => c.type === 'type_parameter'));
      base = params[0]?.text ?? '';
      for (const t of params.slice(1)) {
        const call = kids(t).find((c) => c.type === 'call') ?? (t.type === 'call' ? t : undefined);
        if (call && /(^|\.)(Option|Argument)$/.test(calleeText(call))) marker = call;
      }
    }
    if (!marker && value?.type === 'call' && /(^|\.)(Option|Argument)$/.test(calleeText(value))) marker = value;
    const kind = marker ? (calleeText(marker).endsWith('Argument') ? 'argument' : 'option') : value ? 'option' : 'argument';
    if (kind === 'argument') {
      cmd.acceptsArgs = true;
      continue;
    }
    const args = marker ? pyArgs(marker).positional : [];
    const decls = args.map(pyString).filter((d): d is string => !!d && d.startsWith('-'));
    // The first positional may be the default value; any later one must be a literal name.
    if (args.slice(1).some((x) => pyString(x) === undefined)) cmd.staticOptions = false;
    const names = decls.length ? decls.flatMap((d) => d.split('/').map((x) => x.trim())).filter(Boolean) : [`--${kebab(name)}`];
    const bool = isBool(base);
    if (bool && !decls.some((d) => d.includes('/'))) for (const n of [...names]) if (n.startsWith('--')) names.push(`--no-${n.slice(2)}`);
    cmd.options.push({ names, arity: bool ? 0 : 1 });
  }
}

function functionOf(node: Node): Node | undefined {
  const def = node.type === 'decorated_definition' ? node.childForFieldName('definition') : node;
  return def?.type === 'function_definition' ? def : undefined;
}

/** A typer app (`app = typer.Typer()`) with its commands, callback and sub-apps. */
async function typerApp(world: PyWorld, mod: PyModuleInfo, appName: string, value: Node, depth = 0): Promise<CliCommand | undefined> {
  if (depth > 6) return undefined;
  const root = newCommand('');
  const { keywords } = pyArgs(value);
  const nm = keywords.get('name');
  if (nm && pyString(nm) !== undefined) root.name = pyString(nm)!;
  if (keywords.get('cls')) open(root);
  if (permissiveContext(keywords)) {
    root.staticOptions = false;
    root.passthrough = true;
  }
  root.options.push({ names: ['--help'], arity: 0 });
  // Completion options belong to the program, not to sub-apps.
  if (depth === 0 && keywords.get('add_completion')?.text !== 'False') root.options.push({ names: ['--install-completion'], arity: 0 }, { names: ['--show-completion'], arity: 0 });
  let callback = false;
  let groups = 0;
  for (const m of await relatedModules(world, mod, appName)) {
    for (const [fn, node] of m.defs) {
      if (node.type !== 'decorated_definition') continue;
      for (const d of kids(node).filter((c) => c.type === 'decorator').map((x) => kids(x)[0]!)) {
        const callee = calleeText(d);
        if (callee === `${appName}.command`) {
          const cmd = newCommand('', root);
          const { positional, keywords: kw } = d.type === 'call' ? pyArgs(d) : { positional: [], keywords: new Map<string, Node>() };
          const explicitNode = positional[0] ?? kw.get('name');
          const explicit = explicitNode ? pyString(explicitNode) : undefined;
          if (explicitNode && explicit === undefined) root.staticCommands = false;
          const names = explicit !== undefined ? [explicit] : derivedNames(fn);
          cmd.name = names[0]!;
          cmd.aliases = names.slice(1);
          if (kw.get('cls')) open(cmd);
          if (permissiveContext(kw)) {
            cmd.staticOptions = false;
            cmd.passthrough = true;
          }
          cmd.options.push({ names: ['--help'], arity: 0 });
          const f = functionOf(node);
          if (f) typerParams(f, cmd);
          for (const other of kids(node).filter((c) => c.type === 'decorator').map((x) => kids(x)[0]!)) if (other !== d) cmd.staticOptions = false;
          root.commands.push(cmd);
        } else if (callee === `${appName}.callback`) {
          callback = true;
          const f = functionOf(node);
          if (f) typerParams(f, root);
        }
      }
    }
    const calls: Node[] = [];
    walk(m.tree.rootNode, (n) => {
      if (n.type !== 'call') return;
      if (calleeText(n) === `${appName}.add_typer` || calleeText(n) === `${appName}.command` || calleeText(n) === `${appName}.add_command`) calls.push(n);
      else if (escapes(n, appName) && !/(^|\.)(get_command|main)$/.test(calleeText(n))) open(root);
    });
    for (const call of calls) {
      const callee = calleeText(call);
      if (callee.endsWith('.command')) {
        // `app.command()(fn)` registers fn; decorators were handled above.
        const parent = call.parent;
        if (parent?.type === 'call' && parent.childForFieldName('function')?.id === call.id) root.staticCommands = false;
        continue;
      }
      if (callee.endsWith('.add_command')) {
        root.staticCommands = false;
        continue;
      }
      groups++;
      const { positional, keywords: kw } = pyArgs(call);
      const nameNode = kw.get('name');
      const explicit = nameNode ? pyString(nameNode) : undefined;
      const target = positional[0];
      let sub: CliCommand | undefined;
      if (target?.type === 'identifier') {
        const r = await world.resolve(m, target.text);
        if (r?.value?.type === 'call' && /(^|\.)Typer$/.test(calleeText(r.value))) sub = await typerApp(world, r.mod, r.name, r.value, depth + 1);
      }
      const name = explicit ?? sub?.name;
      if (!name) {
        root.staticCommands = false;
        continue;
      }
      if (!sub) {
        sub = newCommand(name, root);
        open(sub);
      }
      sub.name = name;
      sub.parent = root;
      root.commands.push(sub);
    }
  }
  // One command and no callback: typer makes that command the whole program (a sub-app keeps it as a subcommand).
  if (depth === 0 && root.commands.length === 1 && !callback && !groups) {
    const only = root.commands[0]!;
    root.options.push(...only.options);
    root.acceptsArgs = true;
    root.staticOptions &&= only.staticOptions;
  }
  return root;
}

/** argparse, interpreted inside one function (helpers in the same module are followed). */
async function argparseProgram(world: PyWorld, mod: PyModuleInfo, fnNode: Node): Promise<CliCommand | undefined> {
  type V = { k: 'parser'; cmd: CliCommand } | { k: 'subs'; parent: CliCommand } | { k: 'unknown' };
  const parsers: CliCommand[] = [];
  /** Parsers only used as `parents=[...]` of others. */
  const sharedParents = new Set<CliCommand>();
  let parsed: CliCommand | undefined;
  let budget = 3000;
  let dynamic = false;

  const evalExpr = async (n: Node, vars: Map<string, V>, depth: number): Promise<V> => {
    if (--budget < 0) {
      dynamic = true;
      return { k: 'unknown' };
    }
    if (n.type === 'identifier') return vars.get(n.text) ?? { k: 'unknown' };
    if (n.type === 'parenthesized_expression') return evalExpr(kids(n)[0]!, vars, depth);
    if (n.type !== 'call') return { k: 'unknown' };
    const fn = n.childForFieldName('function')!;
    const callee = calleeText(n);
    const { positional, keywords, splat } = pyArgs(n);
    if (/(^|\.)ArgumentParser$/.test(callee)) {
      const cmd = newCommand('');
      cmd.abbrev = keywords.get('allow_abbrev')?.text !== 'False';
      if (keywords.has('prefix_chars')) dynamic = true;
      if (keywords.get('add_help')?.text !== 'False') cmd.options.push({ names: ['-h', '--help'], arity: 0 });
      const parents = keywords.get('parents');
      if (parents) await inherit(cmd, parents, vars, depth);
      parsers.push(cmd);
      return { k: 'parser', cmd };
    }
    if (fn.type === 'attribute') {
      const base = await evalExpr(fn.childForFieldName('object')!, vars, depth);
      const method = fn.childForFieldName('attribute')!.text;
      if (base.k === 'parser') {
        const cmd = base.cmd;
        switch (method) {
          case 'add_argument': {
            const decls = positional.map(pyString);
            if (splat || decls.some((d) => d === undefined)) {
              cmd.staticOptions = false;
              return { k: 'unknown' };
            }
            const names = (decls as string[]).filter((d) => d.startsWith('-'));
            const action = keywords.get('action')?.text ?? '';
            const nargs = keywords.get('nargs')?.text;
            if (!names.length) {
              cmd.acceptsArgs = true;
              if (nargs && /REMAINDER|\.\.\./.test(nargs)) cmd.staticOptions = false;
              return { k: 'unknown' };
            }
            const flag = /store_true|store_false|store_const|append_const|count|help|version|BooleanOptionalAction/.test(action);
            if (/BooleanOptionalAction/.test(action)) for (const x of [...names]) if (x.startsWith('--')) names.push(`--no-${x.slice(2)}`);
            // A custom Action class decides itself how many values it takes.
            const custom = !!action && !flag && !/^['"](store|append|extend)['"]$/.test(action);
            cmd.options.push({ names, arity: flag ? 0 : custom || (nargs && nargs !== '1') ? undefined : 1 });
            return { k: 'unknown' };
          }
          case 'add_argument_group':
          case 'add_mutually_exclusive_group':
            return base;
          case 'add_subparsers':
            return { k: 'subs', parent: cmd };
          case 'parse_args':
          case 'parse_intermixed_args':
            parsed ??= cmd;
            return { k: 'unknown' };
          case 'parse_known_args':
          case 'parse_known_intermixed_args':
            parsed ??= cmd;
            for (const p of parsers) {
              p.staticOptions = false;
              p.passthrough = true;
            }
            return { k: 'unknown' };
          default:
            return { k: 'unknown' };
        }
      }
      if (base.k === 'subs' && method === 'add_parser') {
        const name = positional[0] ? pyString(positional[0]) : undefined;
        const child = newCommand(name ?? '', base.parent);
        child.abbrev = base.parent.abbrev;
        child.options.push({ names: ['-h', '--help'], arity: 0 });
        if (name === undefined) {
          base.parent.staticCommands = false;
          open(child);
        }
        const aliases = keywords.get('aliases');
        if (aliases) {
          const list = kids(aliases).map(pyString);
          if (list.some((x) => x === undefined)) base.parent.staticCommands = false;
          else child.aliases.push(...(list as string[]));
        }
        const parents = keywords.get('parents');
        if (parents) await inherit(child, parents, vars, depth);
        base.parent.commands.push(child);
        parsers.push(child);
        return { k: 'parser', cmd: child };
      }
    }
    // A helper of this module: follow it with the parsers bound to its parameters.
    if (fn.type === 'identifier' && depth < 4) {
      const def = mod.defs.get(fn.text);
      const f = def ? functionOf(def) : undefined;
      if (f) {
        const inner = new Map<string, V>();
        const params = kids(f.childForFieldName('parameters')).filter((p) => p.type !== 'comment');
        const args: V[] = [];
        for (const a of positional) args.push(await evalExpr(a, vars, depth));
        params.forEach((p, i) => {
          const id = p.type === 'identifier' ? p.text : (p.childForFieldName('name')?.text ?? kids(p).find((c) => c.type === 'identifier')?.text);
          if (id) inner.set(id, args[i] ?? { k: 'unknown' });
        });
        for (const [k, v] of keywords) inner.set(k, await evalExpr(v, vars, depth));
        return (await execBody(kids(f.childForFieldName('body')), inner, depth + 1)) ?? { k: 'unknown' };
      }
    }
    // Parsers handed to code we cannot read may get anything added.
    for (const a of [...positional, ...keywords.values()]) {
      const v = a.type === 'identifier' ? vars.get(a.text) : undefined;
      if (v?.k === 'parser') open(v.cmd);
      if (v?.k === 'subs') v.parent.staticCommands = false;
    }
    return { k: 'unknown' };
  };

  const inherit = async (cmd: CliCommand, parents: Node, vars: Map<string, V>, depth: number) => {
    for (const p of kids(parents)) {
      const v = await evalExpr(p, vars, depth);
      if (v.k === 'parser') {
        cmd.options.push(...v.cmd.options);
        sharedParents.add(v.cmd);
      } else cmd.staticOptions = false;
    }
  };

  const execBody = async (stmts: Node[], vars: Map<string, V>, depth: number): Promise<V | undefined> => {
    let ret: V | undefined;
    for (const s of stmts) {
      if (s.type === 'expression_statement') {
        const e = kids(s)[0];
        if (!e) continue;
        if (e.type === 'assignment') {
          const left = e.childForFieldName('left');
          const right = e.childForFieldName('right');
          const v = right ? await evalExpr(right, vars, depth) : { k: 'unknown' as const };
          if (left?.type === 'identifier') vars.set(left.text, v);
        } else await evalExpr(e, vars, depth);
      } else if (s.type === 'return_statement') {
        const e = kids(s)[0];
        if (e && !ret) ret = await evalExpr(e, vars, depth);
      } else if (/^(if|for|while|try|with)_statement$|clause$|^block$/.test(s.type)) {
        for (const c of kids(s)) {
          if (c.type === 'block') {
            const r = await execBody(kids(c), vars, depth);
            if (r && !ret) ret = r;
          } else if (/clause$/.test(c.type)) {
            const r = await execBody([c], vars, depth);
            if (r && !ret) ret = r;
          }
        }
      }
    }
    return ret;
  };

  const ret = await execBody(kids(fnNode.childForFieldName('body') ?? fnNode), new Map(), 0);
  // Two top-level parsers in one program (`web` routed by hand to its own parser): which one runs is not static.
  if (dynamic || parsers.filter((p) => !p.parent && !sharedParents.has(p)).length > 1) return undefined;
  const root = parsed ?? (ret?.k === 'parser' ? ret.cmd : undefined) ?? parsers.find((p) => !p.parent && !sharedParents.has(p));
  return root;
}

/**
 * The CLI behind `module:attr`: a click command/group, a typer app, a function that builds an
 * argparse parser, or (for an entry point) a function that calls exactly one of those.
 * `callee`: reached from an entry point's body, so only a CLI object or a parser-building
 * function counts (no deeper call chains, which lead to unrelated parsers).
 */
async function pythonTarget(world: PyWorld, mod: PyModuleInfo, name: string, callee = false): Promise<Found | undefined> {
  const r = await world.resolve(mod, name);
  if (!r) return undefined;
  if (r.value) {
    if (r.value.type === 'call' && /(^|\.)Typer$/.test(calleeText(r.value))) {
      const root = await typerApp(world, r.mod, r.name, r.value);
      return root ? { framework: 'typer', source: r.mod.path, root } : undefined;
    }
    return undefined;
  }
  const node = r.def!;
  if (node.type === 'decorated_definition') {
    const decorators = kids(node).filter((c) => c.type === 'decorator').map((d) => calleeText(kids(d)[0]));
    if (decorators.some((d) => /(^|\.)(command|group)$/.test(d) && !/\.callback$/.test(d))) {
      const root = await clickCommand(world, r.mod, node, r.name);
      return root ? { framework: 'click', source: r.mod.path, root } : undefined;
    }
  }
  const fn = functionOf(node);
  const body = fn?.childForFieldName('body');
  if (!fn || !body) return undefined;
  if (/\bArgumentParser\s*\(/.test(body.text)) {
    const root = await argparseProgram(world, r.mod, fn);
    return root ? { framework: 'argparse', source: r.mod.path, root } : undefined;
  }
  if (callee) return undefined;
  // `def main(): app()` / `cli(obj={})` / `cli.main(...)` / `typer.run(fn)` / `_cli.run()`, with the function's own imports.
  const calls: Node[] = [];
  const local: PyModuleInfo = { ...r.mod, imports: new Map(r.mod.imports) };
  walk(body, (n) => {
    if (n.type === 'call') calls.push(n);
    if (n.type === 'import_from_statement' || n.type === 'import_statement') addImport(local, n);
    return n.type !== 'function_definition' || n === fn;
  });
  return onlyOne(await Promise.all(calls.map((c) => calledCli(world, local, c, r.name))));
}

/** The CLI a call in an entry point's body runs, if it runs one. */
async function calledCli(world: PyWorld, local: PyModuleInfo, c: Node, self: string): Promise<Found | undefined> {
  const callee = calleeText(c);
  if (/^typer\.run$/.test(callee)) {
    const target = pyArgs(c).positional[0];
    const tr = target?.type === 'identifier' ? await world.resolve(local, target.text) : undefined;
    const f = tr?.def ? functionOf(tr.def) : undefined;
    if (!f) return undefined;
    const root = newCommand('');
    root.options.push({ names: ['--help'], arity: 0 });
    typerParams(f, root);
    return { framework: 'typer', source: tr!.mod.path, root };
  }
  const dotted = /^(\w+)\.(\w+)$/.exec(callee);
  if (dotted && dotted[2] !== 'main' && local.imports.has(dotted[1]!) && !local.imports.get(dotted[1]!)!.attr?.match(/^[A-Z]/)) {
    // `module.func()` on an imported module.
    const target = await world.moduleOf(local, dotted[1]!);
    return target ? pythonTarget(world, target, dotted[2]!, true) : undefined;
  }
  const id = /^(\w+)(\.main)?$/.exec(callee)?.[1];
  if (!id || id === self || ['sys', 'exit', 'print', 'len', 'str', 'int', 'dict', 'list'].includes(id)) return undefined;
  return pythonTarget(world, local, id, true);
}

/** One CLI, or none when several different ones are reachable (the program picks at run time). */
function onlyOne(found: (Found | undefined)[]): Found | undefined {
  const all = found.filter((f): f is Found => !!f);
  const keys = new Set(all.map((f) => `${f.framework}\0${f.source}\0${f.root.name}`));
  return keys.size === 1 ? all[0] : undefined;
}

async function pythonCli(module: string, attr: string, baseDir: string, sf: ScriptFacts, trees: TreeCache): Promise<Found | undefined> {
  const world = new PyWorld(sf, trees, baseDir);
  const mod = await world.load(module);
  if (!mod) return undefined;
  return pythonTarget(world, mod, attr.split('.')[0]!);
}

/** `python -m pkg`: what `pkg/__main__.py` runs. */
async function pythonMain(pkg: string, mainPath: string, sf: ScriptFacts, trees: TreeCache): Promise<Found | undefined> {
  const world = new PyWorld(sf, trees);
  const mod = await world.load(`${pkg}.__main__`, mainPath);
  if (!mod) return undefined;
  const calls: Node[] = [];
  for (const s of kids(mod.tree.rootNode)) {
    if (s.type === 'expression_statement' || s.type === 'if_statement' || s.type === 'raise_statement') walk(s, (n) => {
      if (n.type === 'call') calls.push(n);
      return n.type !== 'function_definition';
    });
  }
  const found: (Found | undefined)[] = [];
  for (const c of calls) {
    const id = /^(\w+)(\.main)?$/.exec(calleeText(c))?.[1];
    if (!id || ['sys', 'exit', 'print'].includes(id)) continue;
    found.push(await pythonTarget(world, mod, id));
  }
  return onlyOne(found);
}
