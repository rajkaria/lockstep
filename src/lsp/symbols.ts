import { join } from 'node:path';
import type { PyDef, PyModule } from '../indexer/python.js';
import { shown, symbolId, type Resolution, type SymbolInfo } from '../indexer/resolve.js';
import type { LintModel } from './model.js';
import { places, type DocRef } from './references.js';

/** Where a symbol is defined: its file (repository-relative and absolute) and line. */
export interface SymbolLocation {
  path: string;
  file: string;
  line: number;
}

const FENCE_LANG: Record<string, string> = { python: 'python', ts: 'typescript', go: 'go' };

export function moduleOf(model: LintModel, sym: SymbolInfo): PyModule | undefined {
  return model.table.modules.get(sym.module)?.mod;
}

export function symbolLocation(model: LintModel, sym: SymbolInfo): SymbolLocation | undefined {
  const mod = moduleOf(model, sym);
  if (!mod) return undefined;
  const dir = model.parsed.find((p) => p.checkout.repo === sym.repo)?.checkout.dir;
  if (!dir) return undefined;
  const path = sym.def.file ?? mod.path;
  return { path, file: join(dir, ...path.split('/')), line: sym.def.lineno };
}

/** `Client.query` in `falkordb.client`: the qualified name as its users write it. */
export function displayName(sym: SymbolInfo): { name: string; module: string } {
  const q = sym.def.qualname;
  const rest = q.startsWith(`${sym.module}.`) ? q.slice(sym.module.length + 1) : q;
  return { name: rest, module: shown(sym.module) };
}

function mdEscape(s: string): string {
  return s.replace(/([\\`*_{}[\]<>|])/g, '\\$1');
}

export type UriOf = (file: string) => string;

/** A link to a file and line that editors open in place (`file:///…#L12`). */
export function lineLink(uriOf: UriOf, file: string, line: number, label: string): string {
  return `[${mdEscape(label)}](${uriOf(file)}#L${line})`;
}

/** Hover for a docs span: the symbols it names, each with its signature and where it is defined. */
export function symbolHover(model: LintModel, matches: { sym: SymbolInfo; resolved: Resolution }[], uriOf: UriOf): string {
  const parts: string[] = [];
  for (const { sym, resolved } of matches.slice(0, 3)) {
    const mod = moduleOf(model, sym);
    const lang = FENCE_LANG[mod?.lang ?? 'python'] ?? '';
    const where = symbolLocation(model, sym);
    const { name, module } = displayName(sym);
    const lines = [`\`\`\`${lang}`, sym.def.signature || `${sym.def.kind} ${sym.def.name}`, '```'];
    let head = `**${mdEscape(name)}** in \`${module}\``;
    if (where) head += ` · ${lineLink(uriOf, where.file, where.line, `${where.path}:${where.line}`)}`;
    if (resolved === 'by-name') head += ' · matched by name';
    lines.push(head);
    if (sym.def.doc) lines.push('', mdEscape(sym.def.doc));
    parts.push(lines.join('\n'));
  }
  if (matches.length > 3) parts.push(`…and ${matches.length - 3} more with this name.`);
  return parts.join('\n\n---\n\n');
}

export const MAX_LISTED = 10;

/** `N docs reference this` / `1 doc references this`. */
export function lensTitle(refs: DocRef[]): string {
  const pages = new Set(refs.map((r) => r.path)).size;
  return pages === 1 ? '1 doc references this' : `${pages} docs reference this`;
}

/** Hover for a function or class in code: where the docs mention it or call it. */
export function documentedHover(refs: DocRef[], root: string, uriOf: UriOf): string {
  const where = places(refs);
  const pages = new Set(where.map((r) => r.path)).size;
  const head = `**Documented in ${where.length === 1 ? '1 place' : `${where.length} places`}**${pages > 1 ? ` across ${pages} docs` : ''} (Staleproof)`;
  const items = where.slice(0, MAX_LISTED).map((r) => {
    const how = r.kind === 'example' ? 'example' : `\`${r.text.replace(/`/g, '')}\``;
    return `- ${lineLink(uriOf, join(root, ...r.path.split('/')), r.line, `${r.path}:${r.line}`)} ${how}${r.resolved === 'by-name' ? ' (by name)' : ''}`;
  });
  if (where.length > MAX_LISTED) items.push(`- …and ${where.length - MAX_LISTED} more`);
  return [head, '', ...items].join('\n');
}

/** Definitions of a code file a reader can document: classes, functions and methods. */
export function definitionsIn(model: LintModel, path: string, buffer?: PyModule): { def: PyDef; id: string }[] {
  const repo = model.parsed[0]?.checkout.repo ?? model.repo;
  const mods = buffer ? [buffer] : (model.parsed[0]?.modules ?? []).filter((m) => m.path === path || m.defs.some((d) => d.file === path));
  const out: { def: PyDef; id: string }[] = [];
  for (const m of mods) {
    for (const def of m.defs) {
      if (def.kind === 'module' || (def.file ?? m.path) !== path) continue;
      out.push({ def, id: symbolId(repo, def.qualname) });
    }
  }
  return out;
}

/** The definition whose name is under a 1-based position on its `def`/`class`/`function` line. */
export function definitionAt(defs: { def: PyDef; id: string }[], lineText: string, line: number, column: number): { def: PyDef; id: string } | undefined {
  for (const d of defs) {
    if (d.def.lineno !== line) continue;
    const name = d.def.name;
    for (let at = lineText.indexOf(name); at >= 0; at = lineText.indexOf(name, at + 1)) {
      const before = lineText[at - 1] ?? ' ';
      const after = lineText[at + name.length] ?? ' ';
      if (/[\w$]/.test(before) || /[\w$]/.test(after)) continue;
      if (column >= at + 1 && column <= at + 1 + name.length) return d;
    }
  }
  return undefined;
}
