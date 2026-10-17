import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { ParsedRepo } from '../indexer/index.js';
import { identifiersIn } from '../indexer/markdown.js';
import type { PyModule } from '../indexer/python.js';
import type { SymbolInfo, SymbolTable } from '../indexer/resolve.js';
import { closeNames, type CheckedPage, type PageFinding } from './facts-docstrings.js';
import { sentenceAt } from './facts-env.js';
import type { Span } from './scan.js';

/** Pages whose job is to name what is gone: migration and upgrade guides, release notes. */
export const HISTORY_PAGE = /(^|\/)[^/]*(migrat|upgrad|changelog|changes|release[-_ ]?notes|history|deprecat|breaking|whats?[-_ ]?new|news)[^/]*$/i;
/** The sentence says the name is gone or replaced, so naming it is the point. */
export const HISTORY_LINE =
  /\b(remov(e|ed|es|al|ing)|renam(e|ed|es|ing)|deprecat\w*|replac(e|ed|es|ing)|no longer|formerly|previously|legacy|instead of|used to|dropped|in favou?r of|supersed\w*|obsolete|former|old(er)? (name|api|method|version))\b|→|->|⇒/i;
/** A last segment that makes the span a file name (`setup.py`, `config.toml`), not a member. */
const FILE_EXT = /^(py|pyi|pyx|js|mjs|cjs|ts|tsx|jsx|mts|cts|json|jsonc|toml|ya?ml|md|mdx|rst|txt|cfg|ini|lock|sh|bash|zsh|ps1|html?|css|scss|env|xml|csv|sql|log|so|dll|whl|gz|tgz|zip|tar|exe|bin|wasm|png|jpe?g|svg|gif|pdf|ipynb|mk|go|rs|java|rb|php|c|h|cc|cpp|hpp|swift|kt|lua|vue|svelte|astro|lockb|map|d)$/i;
/** Members a class or module can gain at run time, so absence in the source proves nothing. */
const DYNAMIC_CLASS = /\bsetattr\s*\(|__dict__|Object\.(assign|defineProperty|defineProperties)\s*\(\s*this\b|\bthis\s*\[|^\s*(?:readonly\s+)?\[\s*\w+\s*:\s*(?:string|number|symbol)\s*\]\s*:/m;
const DYNAMIC_MODULE = /\bglobals\s*\(\s*\)|\bsys\.modules\b|\bsetattr\s*\(|\b__getattr__\b|\blazy_import|\bimportlib\.import_module\b/;
/** Sphinx cross-reference roles in reStructuredText: `:meth:`Client.query``. */
const RST_ROLE = /:(?:py:)?(?:meth|func|class|attr|obj|mod|data|exc|const|property):`([^`]+)`/g;

interface Mention {
  ident: string;
  span: Span;
  /** Written as a call (`pkg.connect()`). */
  called: boolean;
  /** A Sphinx cross-reference (`:func:`pkg.connect``): explicitly code. */
  role: boolean;
}

/** Code spans (and Sphinx roles) of a page that name `owner.member`. */
function mentions(page: CheckedPage): Mention[] {
  const out: Mention[] = [];
  const add = (text: string, line: number, column: number, role: boolean) => {
    for (const { ident, called } of identifiersIn(text)) {
      if (!ident.includes('.')) continue;
      const at = text.indexOf(ident);
      const col = column + Math.max(0, at);
      out.push({ ident, span: { text: ident, line, column: col, endColumn: col + ident.length }, called, role });
    }
  };
  for (const s of page.doc.spans) add(s.text, s.line, s.column, false);
  if (/\.rst$/i.test(page.target.path)) {
    const fenced = new Set(page.doc.fences.flatMap((f) => f.lines.map((l) => l.line)));
    for (const [i, line] of page.doc.lines.entries()) {
      if (fenced.has(i + 1)) continue;
      for (const m of line.matchAll(RST_ROLE)) {
        // `text <target>` names the target; `~` and `!` only change how it is shown.
        const inner = m[1]!;
        const explicit = /<([^>]+)>\s*$/.exec(inner);
        const target = (explicit ? explicit[1]! : inner).trim().replace(/^[~!]/, '');
        if (target.startsWith('.')) continue;
        add(target, i + 1, m.index! + m[0].indexOf(target) + 1, true);
      }
    }
  }
  return out;
}

/**
 * `symbol-missing`: a code span `Owner.member`, `Owner.member()` or `module.func()` whose
 * owner resolves exactly to a class or module of the repository's code (and of `--with`
 * checkouts), and whose member does not exist there.
 *
 * Exact owners: a dotted name the symbol table resolves (`pkg.mod.Client`, `pkg`), a
 * top-level package of the code, or a class name defined exactly once in the code that no
 * module rebinds to something else (an import alias, an assignment). Instance variables in
 * prose (`db.query`), external packages and names defined more than once are never judged.
 */
export async function checkSymbols(pages: CheckedPage[], table: SymbolTable, parsed: ParsedRepo[]): Promise<PageFinding[]> {
  const repos = new Set(parsed.filter((p) => p.modules.length).map((p) => p.checkout.repo));
  const dirOf = new Map(parsed.map((p) => [p.checkout.repo, p.checkout.dir]));
  const modules = parsed.flatMap((p) => p.modules.filter((m) => !m.lang || m.lang === 'python' || m.lang === 'ts').map((m) => ({ repo: p.checkout.repo, mod: m })));
  // Names the docs' own examples bind as variables (`mcp = FastMCP(...)`): in prose they are that variable, not the package.
  const bound = new Set<string>();
  for (const page of pages) {
    for (const f of page.doc.fences) {
      for (const l of f.lines) {
        for (const m of l.text.matchAll(/(?:^|[\s(,;])(?:(?:const|let|var|async\s+with|with)\s+)?([A-Za-z_]\w*)\s*(?::\s*[\w.[\]]+\s*)?(?::?=)(?!=)|\bas\s+([A-Za-z_]\w*)|\bfor\s+([A-Za-z_]\w*)\s+in\b/g)) {
          bound.add(m[1] ?? m[2] ?? m[3]!);
        }
      }
    }
  }

  // Class names defined once, and names that something else may also mean.
  const classes = new Map<string, SymbolInfo[]>();
  const rebound = new Set<string>();
  for (const { repo, mod } of modules) {
    for (const d of mod.defs) {
      if (d.kind !== 'class' || d.name.startsWith('_')) continue;
      const parent = d.parent ? table.symbol(d.parent, repo) : undefined;
      if (parent && parent.def.kind !== 'module' && parent.def.kind !== 'class') continue;
      const info = table.symbol(d.qualname, repo);
      if (!info) continue;
      classes.set(d.name, [...(classes.get(d.name) ?? []), info]);
    }
  }
  for (const { mod } of modules) {
    for (const b of mod.bindings) if (b.scope === mod.module && classes.has(b.target)) rebound.add(b.target);
    for (const i of mod.imports) {
      if (!classes.has(i.alias)) continue;
      const v = table.resolveDotted(i.target);
      const only = classes.get(i.alias)!;
      if (only.length !== 1 || v?.t !== 'sym' || v.sym.id !== only[0]!.id) rebound.add(i.alias);
    }
  }
  // Public members of every class of the code (methods, class attributes).
  const memberNames = new Set<string>();
  for (const { mod } of modules) {
    const classQ = new Set(mod.defs.filter((d) => d.kind === 'class').map((d) => d.qualname));
    for (const d of mod.defs) if (d.kind === 'method' && !d.name.startsWith('_')) memberNames.add(d.name);
    for (const b of mod.bindings) if (classQ.has(b.scope)) memberNames.add(b.target.replace(/^self\./, ''));
  }
  const packages = new Set(modules.filter(({ mod }) => !mod.module.includes('.') && /(^|\/)__init__\.py$/.test(mod.path)).map(({ mod }) => mod.module));

  const sources = new Map<string, Promise<string>>();
  const sourceOf = (repo: string, path: string): Promise<string> => {
    const key = `${repo}\0${path}`;
    let p = sources.get(key);
    if (!p) {
      p = readFile(join(dirOf.get(repo) ?? '.', path), 'utf8').catch(() => '');
      sources.set(key, p);
    }
    return p;
  };
  const modEntry = (s: SymbolInfo): PyModule | undefined => table.modules.get(s.module)?.mod;

  /** The owner as the symbol table knows it, when it is exact. */
  const ownerOf = (parts: string[]): string | undefined => {
    const dotted = parts.join('.');
    if (parts.length > 1 || (packages.has(parts[0]!) && !bound.has(parts[0]!))) {
      const v = table.resolveDotted(dotted);
      if (v?.t === 'module' && repos.has(table.modules.get(v.name)?.repo ?? '')) return v.name;
      if (v?.t === 'sym' && v.sym.def.kind === 'class' && repos.has(v.sym.repo)) return v.sym.def.qualname;
    }
    const head = parts[0]!;
    const defs = classes.get(head);
    if (!/^[A-Z]/.test(head) || defs?.length !== 1 || rebound.has(head)) return undefined;
    let cur: SymbolInfo | undefined = defs[0];
    for (const p of parts.slice(1)) {
      cur = cur ? table.findMethod(cur, p, 0) : undefined;
      if (cur?.def.kind !== 'class') return undefined;
    }
    return cur?.def.qualname;
  };

  const out: PageFinding[] = [];
  for (const page of pages) {
    if (HISTORY_PAGE.test(page.target.path)) continue;
    for (const { ident, span, called, role } of mentions(page)) {
      if (HISTORY_LINE.test(page.doc.lines[span.line - 1] ?? '') || HISTORY_LINE.test(sentenceAt(page.doc, span.line, span.column))) continue;
      const parts = ident.split('.');
      const member = parts.pop()!;
      if (member.startsWith('__') || (FILE_EXT.test(member) && !/^[A-Z]/.test(parts[0]!))) continue;
      const owner = ownerOf(parts);
      if (!owner) continue;
      const missing = table.memberMissing(owner, member);
      if (!missing) continue;
      // `module.func()`: a module's member is judged when written as a call or a cross-reference
      // (`pkg.commands` may be an entry point group, `pkg.metric_name` a telemetry attribute).
      if (missing.kind === 'module' && !called && !role) continue;
      const mod = modEntry(missing.owner);
      if (!mod) continue;
      const source = await sourceOf(missing.owner.repo, mod.path);
      const shownOwner = parts.join('.');
      // The owner's file names it after all (a constructor option, a key, a comment about it).
      if (new RegExp(`(?<![\\w$])${member.replace(/\$/g, '\\$')}(?![\\w$])`).test(source)) continue;
      // A bare package name in prose may be a variable of that name (`mcp = FastMCP()`, then `mcp.run()`):
      // judge it only when no class of the code has the member either.
      if (missing.kind === 'module' && parts.length === 1 && memberNames.has(member)) continue;
      if (missing.kind === 'class') {
        const lines = source.split('\n').slice(missing.owner.def.lineno - 1, missing.owner.def.endLineno).join('\n');
        if (DYNAMIC_CLASS.test(lines)) continue;
        // TypeScript declaration merging: an interface or namespace of the same name adds members.
        if (mod.lang === 'ts' && mod.bindings.some((b) => b.scope === mod.module && b.target === missing.owner.def.name)) continue;
      } else {
        if (DYNAMIC_MODULE.test(source)) continue;
        // A submodule the code reader skipped (a stub, an extension module, a test helper).
        const dir = posix.dirname(mod.path);
        const root = dirOf.get(missing.owner.repo) ?? '.';
        if (/(^|\/)__init__\.py$/.test(mod.path) && ['.py', '.pyi', '.pyx', '.so', ''].some((x) => existsSync(join(root, dir, `${member}${x}`)))) continue;
      }
      out.push({
        page,
        f: {
          rule: 'symbol-missing',
          span,
          subject: ident,
          message: missing.kind === 'class' ? `\`${shownOwner}\` has no member \`${member}\`.` : `\`${shownOwner}\` has no \`${member}\`.`,
          looked: `${missing.kind === 'class' ? 'members of' : 'names in'} ${missing.owner.def.qualname} (${mod.path}:${missing.owner.def.lineno})`,
          target: mod.path,
          ...(() => {
            const c = closeNames(member, missing.members.filter((m) => !m.startsWith('__')));
            return c.length ? { candidates: c } : {};
          })(),
        },
      });
    }
  }
  return out;
}
