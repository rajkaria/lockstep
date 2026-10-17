import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { identifiersIn, packagesNamedIn, scanDoc, type ExampleDirective, type MdDoc } from './markdown.js';
import { matchesAny } from './repo-config.js';
import { directoriesOf, olderOrTranslatedDocs } from './repo.js';
import { extractPython, type PyModule } from './python.js';
import { bareModule, extractTs } from './typescript.js';
import { extractGoExample, goImportSpecs, goModuleOf } from './go.js';
import type { ParsedRepo } from './index.js';
import { fileId, writeBatched } from './write.js';
import type { Mismatch, Resolution, SymbolTable } from './resolve.js';

export interface DocsIndexReport {
  repo: string;
  pages: number;
  sections: number;
  examples: { total: number; python: number };
  mentions: number;
  uses: { exact: number; byName: number };
  links: number;
  /** Example lines that no longer fit the code they call (MISMATCH edges). */
  mismatches: number;
  gone: number;
}

interface Row {
  from: string;
  to: string;
  resolved?: Resolution;
  [k: string]: unknown;
}

const MAX_BODY = 8000;
/** Fence languages read as JavaScript/TypeScript. */
export const JS_LANGS = new Set(['javascript', 'typescript', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'node']);
const MAX_CODE = 20000;

export function sectionId(repo: string, path: string, anchor: string): string {
  return `${repo}:${path}#${anchor}`;
}

export function exampleId(repo: string, path: string, index: number): string {
  return `${repo}:${path}:${index}`;
}

/** Strip `>>> ` / `... ` prompts and output lines from a REPL transcript. */
export function fromRepl(code: string): string {
  if (!/^\s*>>> /m.test(code)) return code;
  return code
    .split('\n')
    .filter((l) => /^\s*(>>>|\.\.\.)( |$)/.test(l))
    .map((l) => l.replace(/^\s*(>>>|\.\.\.) ?/, ''))
    .join('\n');
}

export async function readDocs(p: ParsedRepo): Promise<MdDoc[]> {
  const docs: MdDoc[] = [];
  for (const f of p.files.filter((x) => x.kind === 'markdown')) {
    const text = await readFile(join(p.checkout.dir, f.path), 'utf8');
    docs.push(scanDoc(f.path, text));
  }
  return docs;
}

/**
 * Write the docs half of the graph for one repository: DocSection and CodeExample
 * nodes, MENTIONS (prose → symbol), USES (example → symbol, resolved like code),
 * LINKS_TO (section → section).
 */
export async function writeDocs(
  graph: OrgGraph,
  p: ParsedRepo,
  table: SymbolTable,
  run: string,
  codeRepos: Set<string>,
): Promise<DocsIndexReport> {
  const { repo, sha } = p.checkout;
  const docs = await readDocs(p);
  const blob = (path: string, line: number) => `https://github.com/${repo}/blob/${sha}/${path}#L${line}`;

  const sectionRows: unknown[] = [];
  const exampleRows: unknown[] = [];
  const mentions: Row[] = [];
  const uses: Row[] = [];
  const links: Row[] = [];
  const mismatches: Row[] = [];
  const addMismatches = (from: string, found: Mismatch[], lineOf: (line: number) => number) => {
    for (const m of found) {
      if (!codeRepos.has(m.target.split(':')[0]!)) continue;
      mismatches.push({ from, to: m.target, kind: m.kind, name: m.name, detail: m.detail, line: lineOf(m.line), text: m.text });
    }
  };
  /** USES edges and MISMATCH findings for one example's calls in an (ephemeral) module. */
  const linkExample = (id: string, mod: PyModule, startLine: number, lineOf: (line: number) => number, directive?: ExampleDirective, groups = callGroupsRef.current) => {
    for (const call of mod.calls.filter((c) => c.lineno >= startLine)) {
      groups.push(
        table
          .resolveCall(repo, mod, call)
          .filter((r) => codeRepos.has(r.to.split(':')[0]!))
          .map((r) => ({ from: id, to: r.to, resolved: r.resolved, line: lineOf(call.lineno), text: call.text })),
      );
    }
    if (!directive) addMismatches(id, table.checkModule(repo, mod, startLine), lineOf);
  };
  const callGroupsRef: { current: Row[][] } = { current: [] };
  const sectionIdsByPath = new Map<string, Map<string, string>>();

  for (const doc of docs) {
    const anchors = new Map<string, string>();
    for (const s of doc.sections) anchors.set(s.anchor, sectionId(repo, doc.path, s.anchor));
    sectionIdsByPath.set(doc.path, anchors);
  }

  const ownPackages = new Set(p.modules.map((m) => m.module.split('.')[0]!));
  const docDirs = directoriesOf(p.files.map((f) => f.path));
  for (const doc of docs) {
    const contextRepos = pageContext(doc, ownPackages, table);

    // Python examples on a page are resolved cumulatively: a later fragment that uses
    // `g` from an earlier block resolves `g` through that earlier binding.
    const callGroups: Row[][] = [];
    callGroupsRef.current = callGroups;
    let acc = '';
    let jsAcc = '';
    let goImports: string[] = [];
    // Versioned copies of older docs and translated READMEs are linked, never judged against today's code.
    const skipPage = matchesAny(doc.path, p.config?.skipExamples ?? []) || olderOrTranslatedDocs(doc.path, docDirs);
    for (const ex of doc.examples) {
      const id = exampleId(repo, doc.path, ex.index);
      const section = sectionId(repo, doc.path, ex.sectionAnchor);
      const directive: ExampleDirective | undefined = ex.directive ?? (skipPage ? 'skip' : undefined);
      let idents: string[] = [];
      if (ex.lang === 'python') {
        const code = fromRepl(ex.code);
        const startLine = acc ? acc.split('\n').length + 1 : 1;
        acc = acc ? `${acc}\n${code}` : code;
        const mod = await extractPython(acc, { module: pseudoModule(repo, doc.path), path: doc.path });
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const call of mod.calls.filter((c) => c.lineno >= startLine)) {
            callGroups.push(
              table
                .resolveCall(repo, mod, call)
                .filter((r) => codeRepos.has(r.to.split(':')[0]!))
                .map((r) => ({ from: id, to: r.to, resolved: r.resolved, line: ex.lineno + (call.lineno - startLine), text: call.text })),
            );
          }
          // Marked skip or expect-error: still linked (and its bindings serve later blocks), never judged.
          if (!directive) addMismatches(id, table.checkModule(repo, mod, startLine), (line) => ex.lineno + (line - startLine));
        } finally {
          dispose();
        }
        const own = await extractPython(code, { module: pseudoModule(repo, doc.path), path: doc.path });
        idents = own.idents;
      } else if (JS_LANGS.has(ex.lang)) {
        // JavaScript/TypeScript examples resolve the same way, cumulatively per page, against npm packages.
        const startLine = jsAcc ? jsAcc.split('\n').length + 1 : 1;
        jsAcc = jsAcc ? `${jsAcc}\n${ex.code}` : ex.code;
        const mod = await extractTs(jsAcc, { module: `${pseudoModule(repo, doc.path)}_js`, path: doc.path, tsx: true });
        const dispose = table.addEphemeral(repo, mod);
        try {
          linkExample(id, mod, startLine, (line) => ex.lineno + (line - startLine), directive);
        } finally {
          dispose();
        }
        idents = [...new Set(ex.code.match(/[A-Za-z_$][\w$]*/g) ?? [])].sort();
      } else if (ex.lang === 'go') {
        // Each Go block is its own program; a fragment without imports gets the page's earlier ones.
        const earlier = goImports;
        goImports = [...goImports, ...goImportSpecs(ex.code)];
        const mod = await extractGoExample(ex.code, { module: `${pseudoModule(repo, doc.path)}_go`, path: doc.path, earlierImports: earlier });
        const dispose = table.addEphemeral(repo, mod);
        try {
          linkExample(id, mod, 1, (line) => ex.lineno + line - 1, directive);
        } finally {
          dispose();
        }
        idents = mod.idents;
      } else {
        idents = [...new Set(ex.code.match(/[A-Za-z_]\w*/g) ?? [])].sort();
      }
      exampleRows.push({
        id,
        file: fileId(repo, doc.path),
        section,
        props: {
          repo,
          path: doc.path,
          index: ex.index,
          lang: ex.lang,
          meta: ex.meta,
          code: ex.code.slice(0, MAX_CODE),
          lineno: ex.lineno,
          end_lineno: ex.endLineno,
          idents,
          kind: 'fenced',
          directive: directive ?? '',
          url: blob(doc.path, ex.lineno),
        },
      });
    }
    // What the page's examples use exactly disambiguates its by-name guesses:
    // `udf_load` on a page whose examples construct the sync `FalkorDB` is the sync one.
    const used = usedScopes(callGroups);
    for (const g of callGroups) uses.push(...narrow(g, used));

    for (const s of doc.sections) {
      const id = sectionId(repo, doc.path, s.anchor);
      const idents = new Set<string>();
      for (const span of s.inlineCode) {
        for (const { ident, called } of identifiersIn(span.text)) {
          idents.add(ident);
          idents.add(ident.split('.').pop()!);
          const group = table
            .matchMention(ident, { called, codeRepos, contextRepos })
            .map((m) => ({ from: id, to: m.sym.id, resolved: m.resolved, span: span.text }));
          mentions.push(...narrow(group, used));
        }
      }
      sectionRows.push({
        id,
        file: fileId(repo, doc.path),
        props: {
          repo,
          path: doc.path,
          anchor: s.anchor,
          title: s.title,
          page_title: doc.title,
          level: s.level,
          heading_path: s.headingPath.join(' > '),
          lineno: s.lineno,
          end_lineno: s.endLineno,
          body: s.body.slice(0, MAX_BODY),
          idents: [...idents].sort(),
          url: blob(doc.path, s.lineno),
        },
      });
      for (const link of s.links) {
        const target = resolveLink(doc.path, link.target, sectionIdsByPath);
        if (target && target !== id) links.push({ from: id, to: target });
      }
    }
  }

  // Go example programs shipped inside code repositories (examples/*/main.go) are docs too.
  for (const f of p.files.filter((x) => x.kind === 'go-example')) {
    const code = await readFile(join(p.checkout.dir, f.path), 'utf8');
    const id = exampleId(repo, f.path, 0);
    const mod = await extractGoExample(code, { module: `${pseudoModule(repo, f.path)}_go`, path: f.path });
    const dispose = table.addEphemeral(repo, mod);
    const groups: Row[][] = [];
    const skip = matchesAny(f.path, p.config?.skipExamples ?? []);
    try {
      linkExample(id, mod, 1, (line) => line, skip ? 'skip' : undefined, groups);
    } finally {
      dispose();
    }
    const used = usedScopes(groups);
    for (const g of groups) uses.push(...narrow(g, used));
    exampleRows.push({
      id,
      file: fileId(repo, f.path),
      section: '',
      props: {
        repo,
        path: f.path,
        index: 0,
        lang: 'go',
        meta: '',
        code: code.slice(0, MAX_CODE),
        lineno: 1,
        end_lineno: code.split('\n').length,
        idents: mod.idents,
        kind: 'script',
        directive: skip ? 'skip' : '',
        url: blob(f.path, 1),
      },
    });
  }

  // Example scripts shipped inside code repositories (examples/*.js, *.ts) are docs too.
  for (const f of p.files.filter((x) => x.kind === 'js-example')) {
    const code = await readFile(join(p.checkout.dir, f.path), 'utf8');
    const id = exampleId(repo, f.path, 0);
    const mod = await extractTs(code, { module: `${pseudoModule(repo, f.path)}_js`, path: f.path, tsx: !/\.(ts|mts|cts)$/.test(f.path) });
    const dispose = table.addEphemeral(repo, mod);
    const groups: Row[][] = [];
    try {
      linkExample(id, mod, 1, (line) => line, matchesAny(f.path, p.config?.skipExamples ?? []) ? 'skip' : undefined, groups);
    } finally {
      dispose();
    }
    const used = usedScopes(groups);
    for (const g of groups) uses.push(...narrow(g, used));
    exampleRows.push({
      id,
      file: fileId(repo, f.path),
      section: '',
      props: {
        repo,
        path: f.path,
        index: 0,
        lang: /\.(ts|tsx|mts|cts)$/.test(f.path) ? 'typescript' : 'javascript',
        meta: '',
        code: code.slice(0, MAX_CODE),
        lineno: 1,
        end_lineno: code.split('\n').length,
        idents: mod.idents,
        kind: 'script',
        directive: matchesAny(f.path, p.config?.skipExamples ?? []) ? 'skip' : '',
        url: blob(f.path, 1),
      },
    });
  }

  // Example scripts shipped inside code repositories (examples/*.py) are docs too.
  for (const f of p.files.filter((x) => x.kind === 'python-example')) {
    const code = await readFile(join(p.checkout.dir, f.path), 'utf8');
    const id = exampleId(repo, f.path, 0);
    const mod = await extractPython(code, { module: pseudoModule(repo, f.path), path: f.path });
    const dispose = table.addEphemeral(repo, mod);
    const groups: Row[][] = [];
    try {
      for (const call of mod.calls) {
        groups.push(
          table
            .resolveCall(repo, mod, call)
            .filter((r) => codeRepos.has(r.to.split(':')[0]!))
            .map((r) => ({ from: id, to: r.to, resolved: r.resolved, line: call.lineno, text: call.text })),
        );
      }
      if (!matchesAny(f.path, p.config?.skipExamples ?? [])) addMismatches(id, table.checkModule(repo, mod, 1), (line) => line);
    } finally {
      dispose();
    }
    const used = usedScopes(groups);
    for (const g of groups) uses.push(...narrow(g, used));
    exampleRows.push({
      id,
      file: fileId(repo, f.path),
      section: '',
      props: {
        repo,
        path: f.path,
        index: 0,
        lang: 'python',
        meta: '',
        code: code.slice(0, MAX_CODE),
        lineno: 1,
        end_lineno: code.split('\n').length,
        idents: mod.idents,
        kind: 'script',
        directive: matchesAny(f.path, p.config?.skipExamples ?? []) ? 'skip' : '',
        url: blob(f.path, 1),
      },
    });
  }

  await writeBatched(graph, Q.upsertSections, sectionRows, { run });
  await writeBatched(graph, Q.upsertExamples, exampleRows, { run });
  await graph.run(Q.deleteRepoDocEdges, { repo });
  const dedupedMentions = dedupe(mentions);
  const dedupedUses = dedupe(uses);
  const dedupedLinks = dedupe(links);
  await writeBatched(graph, Q.upsertMentions, dedupedMentions);
  await writeBatched(graph, Q.upsertUses, dedupedUses);
  await writeBatched(graph, Q.upsertLinks, dedupedLinks);
  const dedupedMismatches = [...new Map(mismatches.map((m) => [`${m.from}|${m.to}|${m.kind}|${m.name}|${m.detail}`, m])).values()];
  await writeBatched(graph, Q.upsertMismatches, dedupedMismatches);
  const gone = await graph.run<{ gone: number }>(Q.markGoneDocs, { repo, run });

  return {
    repo,
    pages: docs.length,
    sections: sectionRows.length,
    examples: {
      total: exampleRows.length,
      python: exampleRows.filter((r) => (r as { props: { lang: string } }).props.lang === 'python').length,
    },
    mentions: dedupedMentions.length,
    uses: {
      exact: dedupedUses.filter((u) => u.resolved === 'exact').length,
      byName: dedupedUses.filter((u) => u.resolved === 'by-name').length,
    },
    links: dedupedLinks.length,
    mismatches: dedupedMismatches.length,
    gone: gone.rows[0]?.gone ?? 0,
  };
}

function qualnameOf(id: string): string {
  return id.slice(id.indexOf(':') + 1);
}

function parentOf(qualname: string): string {
  return qualname.slice(0, Math.max(0, qualname.lastIndexOf('.')));
}

/** Symbols (and their classes/modules) that a page's examples reach through exact resolution. */
export function usedScopes(groups: Row[][]): Set<string> {
  const used = new Set<string>();
  for (const g of groups) {
    for (const r of g) {
      if (r.resolved !== 'exact') continue;
      const q = qualnameOf(r.to);
      used.add(q);
      used.add(parentOf(q));
    }
  }
  return used;
}

/** Among ambiguous by-name candidates, keep those in scopes the page uses exactly (if any are). */
export function narrow(group: Row[], used: Set<string>): Row[] {
  if (group.length <= 1 || group.every((r) => r.resolved === 'exact')) return group;
  const kept = group.filter((r) => {
    if (r.resolved === 'exact') return true;
    const q = qualnameOf(r.to);
    return used.has(q) || used.has(parentOf(q));
  });
  return kept.length ? kept : group;
}

/**
 * The repositories a page is about: its own repository's packages, packages its
 * Python examples import, and packages named in inline code (`falkordb`,
 * `pip install graphrag-sdk`). Bare-name mentions only link into these.
 */
export function pageContext(doc: MdDoc, ownPackages: Set<string>, table: SymbolTable): Set<string> {
  const packages = new Set(ownPackages);
  for (const ex of doc.examples) {
    if (ex.lang === 'python') {
      for (const m of ex.code.matchAll(/^\s*(?:from\s+(\w+)|import\s+(\w+))/gm)) packages.add(m[1] ?? m[2]!);
    } else if (ex.lang === 'bash') {
      for (const line of ex.code.split('\n')) for (const pkg of packagesNamedIn(line.replace(/^\$\s*/, ''))) packages.add(pkg);
    } else if (ex.lang === 'go') {
      for (const spec of goImportSpecs(ex.code)) packages.add(goModuleOf(spec.replace(/^[\w.]+\s+/, '').replace(/"/g, '')).split('.')[0]!);
    } else if (JS_LANGS.has(ex.lang)) {
      for (const m of ex.code.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["']([^"'./][^"']*)["']/g)) packages.add(bareModule(m[1]!).split('.')[0]!);
    }
  }
  for (const s of doc.sections) for (const span of s.inlineCode) for (const pkg of packagesNamedIn(span.text)) packages.add(pkg);
  const repos = new Set<string>();
  for (const pkg of packages) for (const r of table.packageRepos.get(pkg) ?? []) repos.add(r);
  return repos;
}

/** Keep one edge per (from, to); prefer an exact resolution over by-name. */
function dedupe(rows: Row[]): Row[] {
  const out = new Map<string, Row>();
  for (const r of rows) {
    const key = `${r.from}->${r.to}`;
    const prev = out.get(key);
    if (!prev || (prev.resolved === 'by-name' && r.resolved === 'exact')) out.set(key, r);
  }
  return [...out.values()];
}

export function pseudoModule(repo: string, path: string): string {
  return `__docs__.${createHash('sha1').update(`${repo}:${path}`).digest('hex').slice(0, 10)}`;
}

/**
 * Resolve a link target to a section id in the same repository: `#anchor`,
 * relative paths (`./x.mdx#a`, `../x.md`) and site-absolute routes (`/cypher/match`).
 */
export function resolveLink(fromPath: string, target: string, ids: Map<string, Map<string, string>>): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined; // http:, mailto:, ...
  const [rawPath = '', rawAnchor] = target.split('#');
  const anchor = rawAnchor ? decodeURIComponent(rawAnchor).toLowerCase() : undefined;
  let candidates: string[];
  if (!rawPath) {
    candidates = [fromPath];
  } else {
    const base = rawPath.startsWith('/')
      ? rawPath.replace(/^\/+/, '')
      : posix.normalize(posix.join(posix.dirname(fromPath), rawPath));
    const stem = base.replace(/\/$/, '').replace(/\.(mdx?|rst|html)$/i, '');
    candidates = [base, `${stem}.mdx`, `${stem}.md`, `${stem}.rst`, `${stem}/index.mdx`, `${stem}/index.md`, `${stem}/index.rst`, `${stem}/README.md`];
  }
  for (const c of candidates) {
    const anchors = ids.get(c);
    if (!anchors) continue;
    if (anchor && anchors.has(anchor)) return anchors.get(anchor);
    return anchors.values().next().value;
  }
  // Sphinx's absolute :doc:`/user/quickstart` is relative to the docs source root (docs/), not the repository's.
  if (rawPath.startsWith('/') || /\.rst$/i.test(fromPath)) {
    const tail = rawPath.replace(/^\/+/, '').replace(/\.(mdx?|rst|html)$/i, '');
    for (const [path, anchors] of ids) {
      if (!new RegExp(`(^|/)${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(rst|mdx?)$`).test(path)) continue;
      if (anchor && anchors.has(anchor)) return anchors.get(anchor);
      return anchors.values().next().value;
    }
  }
  return undefined;
}
