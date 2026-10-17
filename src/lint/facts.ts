import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { scanDoc } from '../indexer/markdown.js';

const run = promisify(execFile);

/**
 * What the repository actually contains, as the claims are checked against it:
 * its files and directories, line counts and heading anchors (read lazily), and
 * which paths git ignores (generated files the docs may rightly mention).
 */
export class RepoFacts {
  readonly dirs = new Set<string>();
  readonly topLevel = new Set<string>();
  private lineCounts = new Map<string, Promise<number | undefined>>();
  private anchorSets = new Map<string, Promise<Set<string> | undefined>>();
  private ignored = new Set<string>();
  /** Paths git history says were deleted (path → short sha of the commit). */
  readonly deleted = new Map<string, string>();
  /** Paths git history says were renamed (old → new, followed to the latest name). */
  readonly renamed = new Map<string, string>();
  private basenames?: Map<string, string[]>;
  /** A docs framework routes extensionless links (`./intro`) itself. */
  readonly docsFramework: boolean;

  constructor(
    readonly root: string,
    readonly files: Set<string>,
    /** Look at the disk as well as the file list (a working tree; not a tarball listing). */
    private readonly onDisk = true,
  ) {
    for (const f of files) {
      const parts = f.split('/');
      this.topLevel.add(parts[0]!);
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'));
    }
    this.docsFramework = [...files].some((f) =>
      /^(?:[\w.-]+\/)?(docusaurus\.config\.[cm]?[jt]s|mint\.json|docs\.json|mkdocs\.ya?ml|conf\.py|astro\.config\.[cm]?[jt]s|vitepress\/config\.[cm]?[jt]s|\.vitepress\/config\.[cm]?[jt]s|theme\.config\.[jt]sx?|_config\.yml|hugo\.(toml|ya?ml)|book\.toml|nuxt\.config\.[jt]s|next\.config\.[cm]?[jt]s|source\.config\.ts)$/.test(f),
    );
  }

  /** A file or directory of the repository (tracked, on disk, or ignored by git). */
  exists(path: string): boolean {
    const p = path.replace(/\/+$/, '');
    if (p === '' || p === '.') return true;
    if (this.files.has(p) || this.dirs.has(p) || this.ignored.has(p)) return true;
    if (this.onDisk && existsSync(join(this.root, p))) return true;
    // Under an ignored directory (`dist/`, `.env.local`'s folder, ...).
    for (const ig of this.ignored) if (p.startsWith(`${ig}/`)) return true;
    return false;
  }

  isDir(path: string): boolean {
    const p = path.replace(/\/+$/, '');
    if (this.dirs.has(p)) return true;
    try {
      return this.onDisk && statSync(join(this.root, p)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Mark which of `paths` git ignores, in one `git check-ignore` call. */
  async loadIgnored(paths: string[]): Promise<void> {
    const todo = [...new Set(paths.map((p) => p.replace(/\/+$/, '')))].filter((p) => p && !this.files.has(p) && !this.dirs.has(p));
    if (!todo.length || !existsSync(join(this.root, '.git'))) return;
    try {
      const child = run('git', ['check-ignore', '--no-index', '--stdin'], { cwd: this.root, maxBuffer: 8 << 20, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
      child.child.stdin!.end(todo.join('\n'));
      const { stdout } = await child;
      for (const p of stdout.split('\n')) if (p.trim()) this.ignored.add(p.trim());
    } catch (err) {
      // Exit 1 means "none ignored"; anything else leaves the set as it is.
      const out = (err as { stdout?: string }).stdout ?? '';
      for (const p of out.split('\n')) if (p.trim()) this.ignored.add(p.trim());
    }
  }

  /**
   * Deleted and renamed paths from git history (every branch), so a missing path can be
   * told apart from a path that never was in this repository (an example of someone
   * else's layout). One `git log`; nothing when there is no history (a tarball, a
   * shallow clone).
   */
  async loadHistory(maxCommits = 20000): Promise<void> {
    if (!existsSync(join(this.root, '.git'))) return;
    let out = '';
    try {
      // No rename detection: it reads blobs, which a partial clone would fetch one by one.
      // Renames are paired from a deletion and an addition of the same file name in one commit.
      ({ stdout: out } = await run('git', ['log', '--all', '--no-renames', '--diff-filter=DA', '--name-status', `--max-count=${maxCommits}`, '--format=@%h'], {
        cwd: this.root,
        maxBuffer: 64 << 20,
        env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      }));
    } catch {
      return;
    }
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    let sha = '';
    let added = new Map<string, string[]>();
    let removed: string[] = [];
    const flush = () => {
      // Newest commit first: the first rename or deletion seen for a path is the latest.
      for (const p of removed) {
        const to = added.get(base(p));
        if (to?.length === 1 && !this.renamed.has(p)) this.renamed.set(p, to[0]!);
        if (!this.deleted.has(p)) this.deleted.set(p, sha);
      }
      added = new Map();
      removed = [];
    };
    for (const line of out.split('\n')) {
      if (line.startsWith('@')) {
        flush();
        sha = line.slice(1);
      } else if (line.startsWith('D\t')) removed.push(line.slice(2));
      else if (line.startsWith('A\t')) {
        const p = line.slice(2);
        const list = added.get(base(p)) ?? [];
        list.push(p);
        added.set(base(p), list);
      }
    }
    flush();
  }

  /** Where a path lives now, following renames; undefined when the trail ends at a missing path. */
  movedTo(path: string): string | undefined {
    let p = path;
    for (let i = 0; i < 20 && this.renamed.has(p); i++) p = this.renamed.get(p)!;
    if (p !== path && this.exists(p)) return p;
    // A renamed directory: `src/old/x.ts` when `src/old` → `src/new`.
    for (const [from, to] of this.renamed) {
      if (path.startsWith(`${from}/`)) {
        const cand = `${to}${path.slice(from.length)}`;
        if (this.exists(cand)) return cand;
      }
    }
    return undefined;
  }

  /** Files of the repository with this base name. */
  withBasename(name: string): string[] {
    if (!this.basenames) {
      this.basenames = new Map();
      for (const f of this.files) {
        const b = f.slice(f.lastIndexOf('/') + 1);
        const list = this.basenames.get(b) ?? [];
        list.push(f);
        this.basenames.set(b, list);
      }
    }
    return this.basenames.get(name) ?? [];
  }

  async text(path: string): Promise<string | undefined> {
    return readFile(join(this.root, path), 'utf8').catch(() => undefined);
  }

  lineCount(path: string): Promise<number | undefined> {
    let p = this.lineCounts.get(path);
    if (!p) {
      p = this.text(path).then((t) => (t === undefined ? undefined : t.replace(/\n$/, '').split('\n').length));
      this.lineCounts.set(path, p);
    }
    return p;
  }

  /** Heading anchors of a Markdown page (GitHub slugs, `{#id}`, explicit `id=`/`name=` attributes), lower case. */
  anchors(path: string): Promise<Set<string> | undefined> {
    let p = this.anchorSets.get(path);
    if (!p) {
      p = this.text(path).then((t) => {
        if (t === undefined || !/\.(md|mdx|markdown)$/i.test(path)) return undefined;
        const set = new Set(scanDoc(path, t).sections.map((s) => s.anchor.toLowerCase()));
        for (const m of t.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) set.add(m[1]!.toLowerCase());
        for (const m of t.matchAll(/\{#([\w-]+)\}/g)) set.add(m[1]!.toLowerCase());
        return set;
      });
      this.anchorSets.set(path, p);
    }
    return p;
  }
}

/** `a/./b/../c` → `a/c`; undefined when it climbs above the repository root. */
export function normalizeRepoPath(path: string): string | undefined {
  const n = posix.normalize(path);
  if (n === '..' || n.startsWith('../') || posix.isAbsolute(n)) return undefined;
  return n === '.' ? '' : n.replace(/^\.\//, '');
}
