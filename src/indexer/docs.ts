import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { OrgGraph } from '../graph/client.js';
import * as Q from '../graph/queries.js';
import { identifiersIn, packagesNamedIn, scanMarkdown, type MdDoc } from './markdown.js';
import { extractPython } from './python.js';
import type { ParsedRepo } from './index.js';
import { fileId, writeBatched } from './write.js';
import type { Resolution, SymbolTable } from './resolve.js';

export interface DocsIndexReport {
  repo: string;
  pages: number;
  sections: number;
  examples: { total: number; python: number };
  mentions: number;
  uses: { exact: number; byName: number };
  links: number;
  gone: number;
}

interface Row {
  from: string;
  to: string;
  resolved?: Resolution;
  [k: string]: unknown;
}

const MAX_BODY = 8000;
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
    docs.push(scanMarkdown(f.path, text));
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
  const sectionIdsByPath = new Map<string, Map<string, string>>();

  for (const doc of docs) {
    const anchors = new Map<string, string>();
    for (const s of doc.sections) anchors.set(s.anchor, sectionId(repo, doc.path, s.anchor));
    sectionIdsByPath.set(doc.path, anchors);
  }

  const ownPackages = new Set(p.modules.map((m) => m.module.split('.')[0]!));
  for (const doc of docs) {
    const contextRepos = pageContext(doc, ownPackages, table);
    for (const s of doc.sections) {
      const id = sectionId(repo, doc.path, s.anchor);
      const idents = new Set<string>();
      for (const span of s.inlineCode) {
        for (const { ident, called } of identifiersIn(span.text)) {
          idents.add(ident);
          idents.add(ident.split('.').pop()!);
          for (const m of table.matchMention(ident, { called, codeRepos, contextRepos })) {
            mentions.push({ from: id, to: m.sym.id, resolved: m.resolved, span: span.text });
          }
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

    // Python examples on a page are resolved cumulatively: a later fragment that uses
    // `g` from an earlier block resolves `g` through that earlier binding.
    let acc = '';
    for (const ex of doc.examples) {
      const id = exampleId(repo, doc.path, ex.index);
      const section = sectionId(repo, doc.path, ex.sectionAnchor);
      let idents: string[] = [];
      if (ex.lang === 'python') {
        const code = fromRepl(ex.code);
        const startLine = acc ? acc.split('\n').length + 1 : 1;
        acc = acc ? `${acc}\n${code}` : code;
        const mod = await extractPython(acc, { module: pseudoModule(repo, doc.path), path: doc.path });
        const dispose = table.addEphemeral(repo, mod);
        try {
          for (const call of mod.calls.filter((c) => c.lineno >= startLine)) {
            for (const r of table.resolveCall(repo, mod, call)) {
              if (!codeRepos.has(r.to.split(':')[0]!)) continue;
              uses.push({ from: id, to: r.to, resolved: r.resolved, line: ex.lineno + (call.lineno - startLine), text: call.text });
            }
          }
        } finally {
          dispose();
        }
        const own = await extractPython(code, { module: pseudoModule(repo, doc.path), path: doc.path });
        idents = own.idents;
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
          url: blob(doc.path, ex.lineno),
        },
      });
    }
  }

  // Example scripts shipped inside code repositories (examples/*.py) are docs too.
  for (const f of p.files.filter((x) => x.kind === 'python-example')) {
    const code = await readFile(join(p.checkout.dir, f.path), 'utf8');
    const id = exampleId(repo, f.path, 0);
    const mod = await extractPython(code, { module: pseudoModule(repo, f.path), path: f.path });
    const dispose = table.addEphemeral(repo, mod);
    try {
      for (const call of mod.calls) {
        for (const r of table.resolveCall(repo, mod, call)) {
          if (!codeRepos.has(r.to.split(':')[0]!)) continue;
          uses.push({ from: id, to: r.to, resolved: r.resolved, line: call.lineno, text: call.text });
        }
      }
    } finally {
      dispose();
    }
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
    gone: gone.rows[0]?.gone ?? 0,
  };
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

function pseudoModule(repo: string, path: string): string {
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
    const stem = base.replace(/\/$/, '').replace(/\.(mdx?|html)$/i, '');
    candidates = [base, `${stem}.mdx`, `${stem}.md`, `${stem}/index.mdx`, `${stem}/index.md`, `${stem}/README.md`];
  }
  for (const c of candidates) {
    const anchors = ids.get(c);
    if (!anchors) continue;
    if (anchor && anchors.has(anchor)) return anchors.get(anchor);
    return anchors.values().next().value;
  }
  return undefined;
}
