import { posix } from 'node:path';
import { normalizeRepoPath, type RepoFacts } from './facts.js';
import type { ScannedDoc, Span } from './scan.js';
import type { RawFinding } from './engine.js';

/** Output and generated directories docs may rightly name before they exist. */
const GENERATED = /^(dist|build|out|target|coverage|node_modules|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.venv|venv|__pycache__|site|_build|public\/build)(\/|$)/;
/** The sentence says the path is created, not that it exists. */
const CREATED = /\b(creat(e|es|ed|ing)|generat(e|es|ed|ing)|writ(e|es|ten|ing)|output(s|ted)?|produc(e|es|ed)|emit(s|ted)?|will be|download(s|ed)?|sav(e|es|ed) (to|as|in)|scaffold(s|ed)?|touch|mkdir|new file|add (a|an|the) file)\b/i;
const EXT = /\.[A-Za-z0-9]{1,8}$/;
/** Folders a docs site is built from. */
const DOCS_ROOTS = ['docs', 'doc', 'documentation', 'website/docs', 'site/docs', 'docs/src', 'docs/content'];
const TEST_DIR = /(^|\/)(tests?|__tests__|fixtures?|testdata|spec|e2e)\//;

export interface PathRef {
  path: string;
  line?: number;
}

/**
 * The repository path a code span names, if it names one: `src/cli.ts`, `docs/`,
 * `./scripts/x.sh:12`, `src/a.ts#L40`. Not paths: URLs, absolute and home paths,
 * placeholders (`path/to/<file>`, `{name}`, `*.ts`), commands, package scopes, bare
 * file names.
 */
export function pathInSpan(text: string): PathRef | undefined {
  let t = text.trim().replace(/^["']|["']$/g, '');
  if (!t || /\s/.test(t) || t.length > 200) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[A-Za-z0-9_./-]+:\d+(?::\d+)?$/.test(t)) return undefined;
  if (/^(\/|~|\$|-|@|\\)/.test(t) || t.includes('://')) return undefined;
  let line: number | undefined;
  const lm = /^(.*?)(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(t);
  if (lm && lm[1]) {
    t = lm[1];
    line = Number(lm[2] ?? lm[3]);
  }
  if (/[<>{}*?[\]|,;=%$!`'"()\\:#&^]/.test(t) || t.includes('...')) return undefined;
  if (!t.includes('/')) return undefined;
  if (!/^(\.{1,2}\/)*[\w@.+-]+(\/[\w@.+-]+)*\/?$/.test(t)) return undefined;
  // Dotted identifiers and versions (`a.b/c` is fine, `1.2/3` is a ratio or date).
  if (/^\d/.test(t)) return undefined;
  return { path: t, ...(line ? { line } : {}) };
}

/** Where a path written in `docPath` can point: repository root first, then the page's directory. */
function candidates(ref: string, docPath: string): string[] {
  const docDir = posix.dirname(docPath);
  const explicit = ref.startsWith('./') || ref.startsWith('../');
  const join = (dir: string) => normalizeRepoPath(posix.join(dir === '.' ? '' : dir, ref));
  const rootRel = normalizeRepoPath(ref);
  // Skills and packages name paths from their own folder (`scripts/x.py` next to SKILL.md):
  // try the page's folder and each folder above it.
  const ancestors: (string | undefined)[] = [];
  for (let d = posix.dirname(docDir); d !== '.' && d !== '/'; d = posix.dirname(d)) ancestors.push(join(d));
  // `./scripts/test` in a nested page is usually a command run from the root; `a/b` is root first.
  const order = explicit
    ? [join(docDir), ...(ref.startsWith('./') ? [...ancestors, rootRel] : [])]
    : [rootRel, join(docDir), ...ancestors];
  return [...new Set(order.filter((x): x is string => x !== undefined))];
}

/** Judge a plain `a/b` only when `a` is something in the repository (else it is a slug, a MIME type, a branch name). */
function rooted(ref: string, docPath: string, facts: RepoFacts): boolean {
  if (ref.startsWith('./') || ref.startsWith('../')) return true;
  const first = ref.split('/')[0]!;
  const docDir = posix.dirname(docPath);
  return facts.topLevel.has(first) || facts.exists(docDir === '.' ? first : `${docDir}/${first}`);
}

export interface PathClaim {
  span: Span;
  ref: PathRef;
  candidates: string[];
  /** Its first folder is in the repository; otherwise only git history can make it a finding. */
  rooted: boolean;
}

/** Path claims of a page that `checkPaths` will judge (also used to batch the git-ignore lookup). */
export function pathClaims(doc: ScannedDoc, facts: RepoFacts): PathClaim[] {
  const out: PathClaim[] = [];
  for (const span of doc.spans) {
    const ref = pathInSpan(span.text);
    if (!ref) continue;
    const cands = candidates(ref.path, doc.path);
    if (!cands.length || cands.every((c) => GENERATED.test(c))) continue;
    out.push({ span, ref, candidates: cands, rooted: rooted(ref.path, doc.path, facts) });
  }
  return out;
}

/**
 * What is known about a path that does not exist: renamed (and to what), deleted in
 * history, or a file of the same name elsewhere (moved). Undefined when the
 * repository never had it.
 */
function whatHappened(path: string, facts: RepoFacts, sameName: boolean): { movedTo?: string; deletedIn?: string } | undefined {
  const movedTo = facts.movedTo(path);
  if (movedTo) return { movedTo };
  const under = facts.deleted.has(path) ? undefined : [...facts.deleted.keys()].find((d) => d.startsWith(`${path}/`));
  const deletedIn = facts.deleted.get(path) ?? (under ? facts.deleted.get(under) : undefined);
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (sameName && EXT.test(name)) {
    // Same name elsewhere under the same top-level directory, outside tests and fixtures: moved.
    const top = path.split('/')[0];
    const inTests = TEST_DIR.test(path);
    const same = facts.withBasename(name).filter((f) => f.split('/')[0] === top && (inTests || !TEST_DIR.test(f)));
    if (same.length === 1) return { movedTo: same[0] };
  }
  if (deletedIn) return { deletedIn };
  return undefined;
}

export async function checkPaths(doc: ScannedDoc, facts: RepoFacts, claims: PathClaim[], surface: 'agent' | 'readme' | 'docs' = 'docs'): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  for (const { span, ref, candidates: cands, rooted: isRooted } of claims) {
    const found = cands.find((c) => facts.exists(c));
    if (!found) {
      if (CREATED.test(doc.lines[span.line - 1] ?? '')) continue;
      const shown = ref.path.replace(/\/+$/, '');
      // Agent instructions describe this repository; docs often describe the reader's or another
      // project's layout, so there a missing path counts only when this repository had it.
      // A file of the same name elsewhere is a hint, not evidence: used for agent files only.
      const history = cands.map((c) => whatHappened(c.replace(/\/+$/, ''), facts, surface === 'agent')).find(Boolean);
      if (!history && (surface !== 'agent' || !isRooted)) continue;
      const message = history?.movedTo
        ? `\`${shown}\` does not exist; it moved to \`${history.movedTo}\`.`
        : history?.deletedIn
          ? `\`${shown}\` does not exist; it was deleted in ${history.deletedIn}.`
          : `\`${shown}\` does not exist in the repository.`;
      out.push({
        rule: 'path-missing',
        span,
        subject: shown,
        message,
        looked: cands.length > 1 ? `the repository root and ${posix.dirname(doc.path)}/` : 'the repository files',
        target: cands[0],
        ...(history?.movedTo ? { candidates: [history.movedTo] } : {}),
      });
      continue;
    }
    if (ref.line && !facts.isDir(found)) {
      const count = await facts.lineCount(found);
      if (count !== undefined && ref.line > count) {
        out.push({
          rule: 'line-out-of-range',
          span,
          subject: `${found}:${ref.line}`,
          message: `\`${found}\` has ${count} lines; line ${ref.line} does not exist.`,
          looked: found,
          target: found,
        });
      }
    }
  }
  return out;
}

/** Link targets that are not files of this repository. */
function externalLink(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(target) ||
    target.startsWith('//') ||
    target.startsWith('/') ||
    /[{}<>$]|\{\{/.test(target) ||
    target.startsWith('@')
  );
}

export interface LinkCandidates {
  file: string | undefined;
  anchor: string;
  /** Files the link may resolve to, in order. */
  tries: string[];
}

export function linkTarget(target: string, docPath: string, docsFramework: boolean): LinkCandidates | undefined {
  if (externalLink(target)) return undefined;
  const hash = target.indexOf('#');
  let file = hash >= 0 ? target.slice(0, hash) : target;
  const anchor = hash >= 0 ? target.slice(hash + 1) : '';
  file = file.replace(/\?.*$/, '');
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep it as written
  }
  if (!file) return { file: undefined, anchor, tries: [] };
  const docDir = posix.dirname(docPath);
  const base = normalizeRepoPath(posix.join(docDir === '.' ? '' : docDir, file));
  if (base === undefined) return undefined;
  const tries = [base];
  if (!EXT.test(file) || /\.(html?)$/.test(file)) {
    const stem = base.replace(/\.html?$/, '').replace(/\/+$/, '');
    tries.push(`${stem}.md`, `${stem}.mdx`, `${stem}.rst`, `${stem}/index.md`, `${stem}/index.mdx`, `${stem}/README.md`, `${stem}/readme.md`);
  }
  // Framework sites route extensionless links themselves; only a link with an extension is a file reference there.
  if (docsFramework && !EXT.test(file)) return { file: undefined, anchor: '', tries: [] };
  return { file: base, anchor, tries };
}

export async function checkLinks(doc: ScannedDoc, facts: RepoFacts): Promise<RawFinding[]> {
  const out: RawFinding[] = [];
  for (const link of doc.links) {
    const t = linkTarget(link.text, doc.path, facts.docsFramework);
    if (!t) continue;
    let resolved: string | undefined = doc.path;
    if (t.file !== undefined) {
      resolved = t.tries.find((c) => facts.exists(c));
      // A docs site generates pages into folders the repository does not have (API reference, plugins).
      if (!resolved && facts.docsFramework && !facts.exists(posix.dirname(t.file))) continue;
      // A root page included into a docs site (CONTRIBUTING.md) links relative to the docs folder.
      if (!resolved && DOCS_ROOTS.some((root) => facts.exists(`${root}/${link.text.split('#')[0]!.replace(/^\.\//, '')}`))) continue;
      if (!resolved) {
        const written = link.text.split('#')[0]!.replace(/\?.*$/, '');
        const fromRoot = normalizeRepoPath(written);
        const rootHit = fromRoot !== undefined && posix.dirname(doc.path) !== '.' && facts.exists(fromRoot) ? fromRoot : undefined;
        const up = rootHit ? posix.relative(posix.dirname(doc.path), rootHit) : undefined;
        out.push({
          rule: 'link-broken',
          span: link,
          subject: t.file,
          message: rootHit
            ? `The link is relative to this page, so it points to \`${t.file}\`, which does not exist; \`${rootHit}\` is at the repository root (link \`${up}\`).`
            : `The link target \`${t.file}\` does not exist.`,
          looked: t.tries.length > 1 ? t.tries.slice(0, 3).join(', ') : t.file,
          target: t.file,
          ...(up ? { candidates: [up] } : {}),
        });
        continue;
      }
    } else if (!link.text.startsWith('#')) continue;
    const anchor = t.anchor;
    if (!anchor || /^L\d+/.test(anchor) || anchor.startsWith(':~:') || /\.rst$/i.test(resolved)) continue;
    const anchors = await facts.anchors(resolved);
    if (!anchors) continue;
    let wanted = anchor;
    try {
      wanted = decodeURIComponent(anchor);
    } catch {
      // as written
    }
    if (anchors.has(wanted.toLowerCase())) continue;
    const where = resolved === doc.path ? 'This page' : `\`${resolved}\``;
    out.push({
      rule: 'anchor-missing',
      span: link,
      subject: `${resolved === doc.path ? '' : resolved}#${anchor}`,
      message: `${where} has no heading \`#${anchor}\`.`,
      looked: `headings of ${resolved}`,
      target: resolved,
      candidates: [...anchors],
    });
  }
  return out;
}
