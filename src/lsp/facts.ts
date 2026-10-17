import { RepoFacts } from '../lint/facts.js';

/** The facts of one file's text alone: its line count and heading anchors, from a buffer. */
class OneFileFacts extends RepoFacts {
  constructor(
    root: string,
    private readonly path: string,
    private readonly content: string,
  ) {
    super(root, new Set(), false);
  }

  override text(path: string): Promise<string | undefined> {
    return Promise.resolve(path === this.path ? this.content : undefined);
  }
}

/**
 * The repository's facts as the editor sees them: an open file with unsaved edits is
 * read from its buffer (its text, line count and anchors), everything else from disk.
 * One instance lives as long as a workspace snapshot, so the facts the checks derive from
 * it (scripts, CLI definitions, git-ignored paths) are computed once, not per keystroke.
 */
export class BufferFacts extends RepoFacts {
  private readonly asked = new Set<string>();
  private readonly views = new Map<string, { text: string; facts: RepoFacts }>();

  constructor(
    root: string,
    files: Set<string>,
    /** Unsaved buffers by repository-relative path (live: the workspace updates it). */
    private readonly buffers: ReadonlyMap<string, string>,
  ) {
    super(root, files, true);
  }

  override text(path: string): Promise<string | undefined> {
    const b = this.buffers.get(path);
    return b !== undefined ? Promise.resolve(b) : super.text(path);
  }

  override lineCount(path: string): Promise<number | undefined> {
    return this.view(path)?.lineCount(path) ?? super.lineCount(path);
  }

  override anchors(path: string): Promise<Set<string> | undefined> {
    return this.view(path)?.anchors(path) ?? super.anchors(path);
  }

  /** `git check-ignore` once per path for the life of the snapshot. */
  override async loadIgnored(paths: string[]): Promise<void> {
    const todo = [...new Set(paths.map((p) => p.replace(/\/+$/, '')))].filter((p) => !this.asked.has(p));
    for (const p of todo) this.asked.add(p);
    if (todo.length) await super.loadIgnored(todo);
  }

  /** Copy git history (deleted and renamed paths) from an earlier snapshot's facts. */
  adoptHistory(from: RepoFacts): void {
    for (const [k, v] of from.deleted) this.deleted.set(k, v);
    for (const [k, v] of from.renamed) this.renamed.set(k, v);
  }

  private view(path: string): RepoFacts | undefined {
    const text = this.buffers.get(path);
    if (text === undefined) return undefined;
    const v = this.views.get(path);
    if (v?.text === text) return v.facts;
    const facts = new OneFileFacts(this.root, path, text);
    this.views.set(path, { text, facts });
    return facts;
  }
}
