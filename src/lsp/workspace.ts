import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../indexer/repo.js';
import type { PyModule } from '../indexer/python.js';
import type { SymbolInfo, Resolution } from '../indexer/resolve.js';
import { cacheEnabled, ParseCache } from '../lint/cache.js';
import { isDirty } from '../lint/diff.js';
import { codeDoc, type CheckedPage } from '../lint/facts-docstrings.js';
import { isSuppressed, scanClaims } from '../lint/scan.js';
import { addFixes, applyTextEdits, type AddFixesOptions } from '../lint/fixes.js';
import { refTree, worktreeTree, type LintTree } from '../lint/sources.js';
import type { Finding, Fix, LintResult, RuleId, TextEdit } from '../lint/types.js';
import { BufferFacts } from './facts.js';
import { ignoreAction, type IgnoreAction } from './ignore.js';
import {
  checkedPage,
  CODE_RULES,
  ENV_PAGE_RULES,
  envClaimNames,
  envFindings,
  lintCode,
  lintPage,
  PAGE_RULES,
  parseBuffer,
  parsedModule,
} from './incremental.js';
import { carryEdits, carryFindings } from './lines.js';
import { buildModel, type LintModel } from './model.js';
import { DocsIndex, pageRefs, type DocRef } from './references.js';
import { definitionAt, definitionsIn } from './symbols.js';

/** Attaches verified fixes to findings (`addFixes` from src/lint/fixes.ts by default). */
export type Fixer = (result: LintResult, tree: LintTree, opts?: AddFixesOptions) => Promise<LintResult>;

export interface WorkspaceOptions {
  root: string;
  log?: (message: string) => void;
  /** Default `addFixes`. */
  fixer?: Fixer;
  /** The parse cache: default the checkout's own (`.staleproof/cache`), unless STALEPROOF_CACHE=off; `false` for none. */
  cache?: ParseCache | false;
  /** Compare with HEAD for renames when proposing fixes (default true). */
  renameBase?: boolean;
}

interface OpenDoc {
  uri: string;
  version: number;
  text: string;
}

/** What the last check of an open file found, in parts that update separately. */
interface FileState {
  text: string;
  /** Rules the fast pass recomputes. */
  own: Finding[];
  /** `env-unused` on a docs page, moved to the buffer's lines; the page's variables; and whether they were judged as they are now. */
  env: Finding[];
  envNames: string[];
  envFresh: boolean;
  /** Snapshot findings of other rules, moved to the buffer's lines. */
  carried: Finding[];
  /** The buffer's parse (code files): definitions at their current lines. */
  mod?: PyModule;
  model: LintModel;
}

export interface CheckResult {
  findings: Finding[];
  /** `env-unused` needs the slower whole-repository pass (`recheckEnv`). */
  envStale: boolean;
}

const byPath = new WeakMap<LintModel, Map<string, Finding[]>>();

function snapshotFindings(model: LintModel, path: string): Finding[] {
  let m = byPath.get(model);
  if (!m) {
    m = new Map();
    for (const f of model.result.findings) {
      const list = m.get(f.path) ?? [];
      list.push(f);
      m.set(f.path, list);
    }
    byPath.set(model, m);
  }
  return m.get(path) ?? [];
}

/** Quiet time before a background re-lint or index rebuild starts. */
const IDLE_MS = 500;
/** Quiet time before fixes are proposed and verified (several lints of the repository). */
const FIX_IDLE_MS = 1000;
/** How long a code action request waits for this file's fixes. */
const FIX_WAIT_MS = 5000;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * One workspace folder (a checkout) as the language server holds it: snapshots of the files
 * on disk (`buildModel`: the full `staleproof lint`, refreshed in the background after saves
 * and file changes), the open documents and their unsaved text, and the per-file checks that
 * re-lint one edited buffer against the snapshot. Nothing here talks to the network or a graph.
 */
export class LspWorkspace {
  readonly root: string;
  model?: LintModel;
  index?: DocsIndex;
  private indexModel?: LintModel;
  private building?: Promise<LintModel | undefined>;
  private again = false;
  private cache?: ParseCache;
  private cacheOpened = false;
  readonly docs = new Map<string, OpenDoc>();
  /** Unsaved text (differs from disk) by repository-relative path; BufferFacts reads it live. */
  readonly buffers = new Map<string, string>();
  private readonly bufferPages = new Map<string, CheckedPage>();
  private readonly state = new Map<string, FileState>();
  private readonly diskTexts = new WeakMap<LintModel, Map<string, Promise<string | undefined>>>();
  private factsStale = false;
  /** Verified fixes of the snapshot's findings, by fingerprint; and which files were asked for. */
  private fixes = new Map<string, Fix>();
  private fixedPaths = new Set<string>();
  private fixModel?: LintModel;
  private fixQueue: Promise<void> = Promise.resolve();
  private readonly pendingFixes = new Map<string, Promise<void>>();
  /** Start the queued fix run without waiting for the typing to pause (a quick fix was asked for). */
  private wantFixes?: () => void;
  private base?: { sha: string; tree?: LintTree };
  private readonly log: (message: string) => void;
  private disposed = false;
  /** When a buffer last changed: heavy background work (re-lints, fix verification) waits for a pause. */
  private lastEdit = 0;

  constructor(private readonly opts: WorkspaceOptions) {
    this.root = opts.root;
    this.log = opts.log ?? (() => {});
  }

  private async parseCache(): Promise<ParseCache | undefined> {
    if (!this.cacheOpened) {
      this.cacheOpened = true;
      if (this.opts.cache) this.cache = this.opts.cache;
      else if (this.opts.cache !== false && cacheEnabled()) this.cache = await ParseCache.open(this.root).catch(() => undefined);
    }
    return this.cache;
  }

  /** The current snapshot, building the first one if needed. */
  async ready(): Promise<LintModel | undefined> {
    return this.model ?? (await this.refresh());
  }

  /** Lint the files on disk again (coalesced: one build at a time, one more queued at most). */
  refresh(): Promise<LintModel | undefined> {
    if (this.building) {
      this.again = true;
      return this.building;
    }
    this.building = (async () => {
      let model: LintModel | undefined;
      do {
        this.again = false;
        try {
          // A whole-repository lint runs in this process: start it when the typing pauses.
          if (this.model) await this.idle(IDLE_MS);
          model = await buildModel(this.root, { cache: await this.parseCache(), buffers: this.buffers, previous: this.model });
          if (this.disposed) return undefined;
          // Saved buffers are the files on disk now.
          for (const [path, text] of [...this.buffers]) if ((await this.diskText(model, path)) === text) this.buffers.delete(path);
          this.adopt(model);
        } catch (err) {
          this.log(`Staleproof could not lint ${this.root}: ${(err as Error).stack ?? err}`);
        }
      } while (this.again && !this.disposed);
      return this.model;
    })().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private adopt(model: LintModel): void {
    this.model = model;
    this.factsStale = false;
    // Buffers of docs pages, scanned against the new snapshot's targets.
    this.bufferPages.clear();
    for (const [path, text] of this.buffers) {
      const page = checkedPage(model, path, text);
      if (page) this.bufferPages.set(path, page);
    }
    const s = model.result.summary;
    this.log(`Staleproof: ${model.repo}: ${model.result.findings.length} findings in ${s.files} docs files (${model.ms} ms)`);
    for (const w of model.result.warnings) this.log(`Staleproof: ${w}`);
    void this.warm(model).then(() => this.buildIndex(model));
    void this.queueFixes(model, [...this.docs.keys()]);
  }

  /**
   * The facts the page checks derive once per snapshot (scripts, Makefile targets, CLI
   * definitions), computed now rather than on the first keystroke.
   */
  private async warm(model: LintModel): Promise<void> {
    const open = [...this.docs.keys()].map((p) => model.pages.get(p)).find(Boolean);
    const page = open ?? model.pages.values().next().value;
    if (page && this.model === model) await lintPage(model, page).catch(() => undefined);
  }

  /** Resolve once no buffer has changed for `ms` (at once when nothing is being edited). */
  private async idle(ms: number): Promise<void> {
    for (let wait = this.lastEdit + ms - Date.now(); wait > 0 && !this.disposed; wait = this.lastEdit + ms - Date.now()) {
      await new Promise((r) => setTimeout(r, Math.min(wait, ms)));
    }
  }

  private async buildIndex(model: LintModel): Promise<void> {
    await this.idle(IDLE_MS);
    const ctx = this.refContext(model);
    const pages = [...model.pages.values()].map((p) => ({ path: p.target.path, text: this.buffers.get(p.target.path) ?? p.text }));
    try {
      const index = await DocsIndex.build(pages, ctx);
      if (this.model === model) {
        this.index = index;
        this.indexModel = model;
      }
    } catch (err) {
      this.log(`Staleproof: docs references: ${(err as Error).message}`);
    }
  }

  private refContext(model: LintModel) {
    const main = model.parsed[0];
    return {
      repo: model.repo,
      table: model.table,
      codeRepos: model.codeRepos,
      ownPackages: new Set((main?.modules ?? []).map((m) => m.module.split('.')[0]!)),
      ...(model.cache ? { memo: model.cache } : {}),
    };
  }

  /** The references index of the current snapshot (built in the background after each one). */
  async references(): Promise<DocsIndex | undefined> {
    const model = await this.ready();
    if (!model) return undefined;
    if (this.indexModel !== model) await this.buildIndex(model);
    return this.index;
  }

  private diskText(model: LintModel, path: string): Promise<string | undefined> {
    const page = model.pages.get(path);
    if (page) return Promise.resolve(page.text);
    let m = this.diskTexts.get(model);
    if (!m) this.diskTexts.set(model, (m = new Map()));
    let p = m.get(path);
    if (!p) m.set(path, (p = readFile(join(this.root, ...path.split('/')), 'utf8').catch(() => undefined)));
    return p;
  }

  isTarget(path: string): boolean {
    return !!this.model?.targets.has(path);
  }

  /** An open document's text changed (or it opened): which open files need checking again. */
  async setText(path: string, uri: string, version: number, text: string): Promise<string[]> {
    if (this.docs.has(path)) this.lastEdit = Date.now();
    this.docs.set(path, { uri, version, text });
    const model = await this.ready();
    if (!model) return [path];
    const disk = await this.diskText(model, path);
    // A newer edit arrived while this one waited: it does the work.
    if (this.docs.get(path)?.version !== version) return [];
    const wasDirty = this.buffers.has(path);
    if (text === disk) {
      this.buffers.delete(path);
      this.bufferPages.delete(path);
    } else {
      this.buffers.set(path, text);
      const page = checkedPage(model, path, text);
      if (page) this.bufferPages.set(path, page);
    }
    if (!this.fixedPaths.has(path) || this.fixModel !== model) void this.queueFixes(model, [path]);
    // A manifest, Makefile or config buffer changes what the docs' commands may name: re-check every open page.
    const isDoc = model.targets.has(path);
    const isCode = !!parsedModule(model, path);
    if (!isDoc && !isCode && (wasDirty || this.buffers.has(path))) {
      this.factsStale = true;
      return [path, ...[...this.docs.keys()].filter((p) => p !== path && model.targets.has(p))];
    }
    return [path];
  }

  /** The document closed: its unsaved text no longer counts. */
  close(path: string): string[] {
    this.docs.delete(path);
    this.state.delete(path);
    const wasDirty = this.buffers.delete(path);
    this.bufferPages.delete(path);
    if (wasDirty && this.model && !this.model.targets.has(path) && !parsedModule(this.model, path)) {
      this.factsStale = true;
      return [...this.docs.keys()].filter((p) => this.model!.targets.has(p));
    }
    return [];
  }

  private freshFacts(model: LintModel): void {
    if (!this.factsStale) return;
    const facts = new BufferFacts(model.root, new Set(model.paths), this.buffers);
    facts.adoptHistory(model.facts);
    model.facts = facts;
    this.factsStale = false;
  }

  /** Findings of a file as the snapshot has them (the file on disk). */
  snapshotFindings(path: string): Finding[] {
    return this.model ? snapshotFindings(this.model, path) : [];
  }

  /** Every finding of the snapshot, open files as their buffers are. */
  allFindings(): Map<string, Finding[]> {
    const out = new Map<string, Finding[]>();
    if (!this.model) return out;
    for (const f of this.model.result.findings) {
      if (this.docs.has(f.path)) continue;
      const list = out.get(f.path) ?? [];
      list.push(f);
      out.set(f.path, list);
    }
    for (const path of this.docs.keys()) out.set(path, this.current(path));
    return out;
  }

  /** The findings last computed for an open file (or the snapshot's). */
  current(path: string): Finding[] {
    const s = this.state.get(path);
    if (s && s.model === this.model) return [...s.own, ...s.env, ...s.carried];
    return this.snapshotFindings(path);
  }

  /**
   * Check an open file as its buffer is: the fast pass for a docs page or a code file, the
   * snapshot's other findings moved to the buffer's lines. `envStale` says the page's
   * variables changed and `recheckEnv` should run next.
   */
  async check(path: string): Promise<CheckResult> {
    const model = await this.ready();
    const doc = this.docs.get(path);
    if (!model || !doc) return { findings: this.snapshotFindings(path), envStale: false };
    this.freshFacts(model);
    const text = doc.text;
    const disk = (await this.diskText(model, path)) ?? '';
    const snap = snapshotFindings(model, path);
    if (text === disk && this.buffers.size === 0) {
      this.state.delete(path);
      return { findings: snap, envStale: false };
    }
    const others = new Map([...this.bufferPages].filter(([p]) => p !== path));
    const page = checkedPage(model, path, text);
    if (page) {
      const own = await lintPage(model, page, others);
      const prev = this.state.get(path);
      const base =
        prev && prev.model === model
          ? { findings: prev.env, names: prev.envNames, text: prev.text, fresh: prev.envFresh }
          : { findings: snap.filter((f) => ENV_PAGE_RULES.has(f.rule)), names: envClaimNames(model.pages.get(path) ?? page), text: disk, fresh: true };
      const env = carryFindings(base.findings, base.text, text);
      const names = envClaimNames(page);
      const carried = carryFindings(
        snap.filter((f) => !PAGE_RULES.has(f.rule) && !ENV_PAGE_RULES.has(f.rule)),
        disk,
        text,
      ).kept;
      // Until the env pass runs again, a page whose variables changed (or moved under an edit) keeps saying so.
      const envFresh = !model.enabled('env-unused') || (base.fresh && sameList(names, base.names) && env.dropped === 0);
      this.state.set(path, { text, own, env: env.kept, envNames: names, envFresh, carried, model });
      return { findings: [...own, ...env.kept, ...carried], envStale: !envFresh };
    }
    const mod = await parseBuffer(model, path, text);
    const own = mod ? await lintCode(model, path, text, mod) : [];
    const recomputed: ReadonlySet<RuleId> = mod ? CODE_RULES : new Set();
    const carried = carryFindings(
      snap.filter((f) => !recomputed.has(f.rule)),
      disk,
      text,
    ).kept;
    this.state.set(path, { text, own, env: [], envNames: [], envFresh: true, carried, ...(mod ? { mod } : {}), model });
    return { findings: [...own, ...carried], envStale: false };
  }

  /** `env-unused` for an open docs page, from its buffer (the whole-repository token search). */
  async recheckEnv(path: string): Promise<Finding[] | undefined> {
    const model = this.model;
    const doc = this.docs.get(path);
    const s = this.state.get(path);
    if (!model || !doc || !s || s.model !== model || s.text !== doc.text) return undefined;
    const page = checkedPage(model, path, doc.text);
    if (!page) return undefined;
    const env = await envFindings(model, page, new Map([...this.bufferPages].filter(([p]) => p !== path)));
    const now = this.state.get(path);
    if (now !== s || this.docs.get(path)?.text !== s.text) return undefined;
    now.env = env;
    now.envNames = envClaimNames(page);
    now.envFresh = true;
    return [...now.own, ...now.env, ...now.carried];
  }

  /** Update the references of an edited docs page (after its diagnostics are out). */
  async reindexPage(path: string): Promise<void> {
    const model = this.model;
    const doc = this.docs.get(path);
    if (!model || !doc || !model.targets.has(path) || !this.index || this.indexModel !== model) return;
    const refs = await pageRefs(path, doc.text, this.refContext(model)).catch(() => undefined);
    if (refs && this.indexModel === model) this.index.setPage(path, refs);
  }

  // ---- fixes ----

  private async renameBase(model: LintModel): Promise<LintTree | undefined> {
    if (this.opts.renameBase === false || !model.sha) return undefined;
    if (this.base?.sha === model.sha) return this.base.tree;
    await this.base?.tree?.dispose().catch(() => {});
    this.base = { sha: model.sha };
    // Never fetch: a partial clone would download the blobs HEAD's tree lacks.
    const partial = (await git(model.root, ['config', '--get', 'extensions.partialclone']).catch(() => '')).trim();
    if (partial || !(await isDirty(model.root))) return undefined;
    this.base.tree = await refTree(model.root, 'HEAD', { repo: model.repo }).catch(() => undefined);
    return this.base.tree;
  }

  /** Ask the fixer for fixes to the snapshot's findings in these files (serialized, in the background). */
  queueFixes(model: LintModel, paths: string[]): Promise<void> {
    this.fixQueue = this.fixQueue.then(async () => {
      // Verifying fixes re-lints the repository: never while someone is typing, unless a quick fix was asked for.
      await Promise.race([this.idle(FIX_IDLE_MS), new Promise<void>((r) => (this.wantFixes = r))]);
      this.wantFixes = undefined;
      if (this.model !== model || this.disposed) return;
      if (this.fixModel !== model) {
        this.fixModel = model;
        this.fixes = new Map();
        this.fixedPaths = new Set();
      }
      const todo = paths.filter((p) => !this.fixedPaths.has(p));
      for (const p of todo) this.fixedPaths.add(p);
      const findings = model.result.findings.filter((f) => todo.includes(f.path));
      if (!findings.length) return;
      try {
        const fixer = this.opts.fixer ?? addFixes;
        const baseTree = await this.renameBase(model);
        // Verified as `staleproof fix` verifies: the edited files re-linted in a mirror of the checkout, with the snapshot's config and parse cache.
        const fixed = await fixer({ ...model.result, findings }, worktreeTree(model.root, model.repo), {
          ...(baseTree ? { baseTree } : {}),
          ...(model.cache ? { cache: model.cache } : {}),
          ...(model.config ? { lint: { config: model.config } } : {}),
        });
        if (this.fixModel !== model) return;
        for (const f of fixed.findings) if (f.fix?.verified) this.fixes.set(f.fingerprint, f.fix);
      } catch (err) {
        this.log(`Staleproof: fixes: ${(err as Error).message}`);
      }
    });
    for (const p of paths) this.pendingFixes.set(p, this.fixQueue);
    const queued = this.fixQueue;
    void queued.then(() => {
      for (const p of paths) if (this.pendingFixes.get(p) === queued) this.pendingFixes.delete(p);
    });
    return this.fixQueue;
  }

  /** Wait for the fixes asked for so far. */
  fixesSettled(): Promise<void> {
    return this.fixQueue;
  }

  /** The fix of a finding as the buffer is now, if the snapshot has a verified one that still applies. */
  async fixFor(path: string, finding: Finding): Promise<Fix | undefined> {
    // Fixes for this file still being proposed: start them now and wait a little.
    const pending = this.pendingFixes.get(path);
    if (pending) {
      this.wantFixes?.();
      await Promise.race([pending, new Promise((r) => setTimeout(r, FIX_WAIT_MS))]);
    }
    const model = this.model;
    const fix = this.fixes.get(finding.fingerprint);
    if (!model || !fix?.verified || this.fixModel !== model) return undefined;
    const text = this.docs.get(path)?.text;
    const disk = await this.diskText(model, path);
    const edits: TextEdit[] = [];
    for (const [p, list] of groupEdits(fix.edits)) {
      if (p !== path) {
        // Another file's edits apply to its saved text only.
        if (this.buffers.has(p)) return undefined;
        edits.push(...list);
        continue;
      }
      if (text === undefined || disk === undefined) return undefined;
      const moved = carryEdits(list, disk, text);
      if (!moved) return undefined;
      edits.push(...moved);
    }
    const moved = { ...fix, edits };
    // Unsaved edits: check the fix against the buffer before offering it (spec R3.2, on the buffer).
    if (text !== undefined && text !== disk && !(await this.holds(path, text, finding, edits.filter((e) => e.path === path)))) return undefined;
    return moved;
  }

  /** Apply edits to a buffer in memory and re-check it: the finding is gone and nothing new appeared. */
  private async holds(path: string, text: string, finding: Finding, edits: TextEdit[]): Promise<boolean> {
    let after: string;
    try {
      after = applyTextEdits(text, edits);
    } catch {
      return false;
    }
    const before = await this.lintText(path, text, finding.rule);
    const now = await this.lintText(path, after, finding.rule);
    if (!before || !now) return false;
    const had = new Set(before.map((f) => f.fingerprint));
    return !now.some((f) => f.fingerprint === finding.fingerprint) && now.every((f) => had.has(f.fingerprint));
  }

  /** The recomputable findings of a file if its text were `text` (env rules only when asked for). */
  async lintText(path: string, text: string, rule?: RuleId): Promise<Finding[] | undefined> {
    const model = this.model;
    if (!model) return undefined;
    const others = new Map([...this.bufferPages].filter(([p]) => p !== path));
    const page = checkedPage(model, path, text);
    if (page) {
      if (rule && ENV_PAGE_RULES.has(rule)) return envFindings(model, page, others);
      if (rule && !PAGE_RULES.has(rule)) return undefined;
      return lintPage(model, page, others);
    }
    if (rule && !CODE_RULES.has(rule)) return undefined;
    return parsedModule(model, path) ? lintCode(model, path, text) : undefined;
  }

  /** "Ignore this rule here", when the comment really silences the finding. */
  async ignoreFor(path: string, finding: Finding): Promise<IgnoreAction | undefined> {
    const text = this.docs.get(path)?.text;
    if (text === undefined) return undefined;
    const mod = this.state.get(path)?.mod ?? (this.model ? parsedModule(this.model, path) : undefined);
    const action = ignoreAction(finding, text, {
      definitionLine: (line) => {
        const def = mod?.defs.find((d) => d.docLine !== undefined && d.docText !== undefined && line >= d.docLine && line < d.docLine + d.docText.split('\n').length);
        return def?.lineno;
      },
    });
    if (!action) return undefined;
    let after: string;
    try {
      after = applyTextEdits(text, [action.edit]);
    } catch {
      return undefined;
    }
    if (finding.rule.startsWith('env-')) {
      // The env pass reads the whole repository: check the comment the way lint applies it, at the finding's line.
      const e = action.edit;
      const shift = e.line < finding.line || (e.line === finding.line && e.column === 1) ? (e.newText.match(/\n/g)?.length ?? 0) : 0;
      const doc = this.model?.targets.has(path) ? scanClaims(path, after) : codeDoc(path, after);
      return isSuppressed(doc, finding.line + shift, finding.rule) ? action : undefined;
    }
    const now = await this.lintText(path, after, finding.rule);
    if (!now || now.some((f) => f.fingerprint === finding.fingerprint)) return undefined;
    return action;
  }

  /**
   * Every verified fix of a file applied, one at a time against the re-checked text (so
   * positions stay right): the file's new text, and the fixes applied.
   */
  async fixAll(path: string): Promise<{ text: string; applied: string[] } | undefined> {
    const doc = this.docs.get(path);
    const model = this.model;
    if (!doc || !model) return undefined;
    let text = doc.text;
    const applied: string[] = [];
    const tried = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const findings = (await this.lintText(path, text)) ?? [];
      let next: string | undefined;
      for (const f of findings) {
        if (tried.has(f.fingerprint)) continue;
        tried.add(f.fingerprint);
        const fix = this.fixes.get(f.fingerprint);
        if (!fix?.verified || fix.edits.some((e) => e.path !== path)) continue;
        const disk = (await this.diskText(model, path)) ?? '';
        const edits = carryEdits(fix.edits, disk, text);
        if (!edits || !(await this.holds(path, text, f, edits))) continue;
        next = applyTextEdits(text, edits);
        applied.push(fix.description);
        break;
      }
      if (next === undefined) break;
      text = next;
    }
    return applied.length ? { text, applied } : undefined;
  }

  // ---- symbols ----

  /** The buffer's parse of an open code file (definitions at their current lines). */
  async bufferModule(path: string): Promise<PyModule | undefined> {
    const model = await this.ready();
    const doc = this.docs.get(path);
    if (!model || !doc) return undefined;
    const s = this.state.get(path);
    if (s?.model === model && s.text === doc.text && s.mod) return s.mod;
    if (!this.buffers.has(path)) return undefined;
    return parseBuffer(model, path, doc.text);
  }

  /** Symbols a docs position names (a code span or a call in an example). */
  async symbolsAt(path: string, line: number, column: number): Promise<{ refs: DocRef[]; matches: { sym: SymbolInfo; resolved: Resolution }[] }> {
    const index = await this.references();
    const model = this.model;
    if (!index || !model) return { refs: [], matches: [] };
    const refs = index.refsAt(path, line, column);
    const matches: { sym: SymbolInfo; resolved: Resolution }[] = [];
    for (const r of refs) {
      const sym = model.table.byQualname.get(r.symbol.slice(r.symbol.indexOf(':') + 1))?.find((s) => s.id === r.symbol);
      if (sym && !matches.some((m) => m.sym.id === sym.id)) matches.push({ sym, resolved: r.resolved });
    }
    return { refs, matches };
  }

  /** The definition under a position in a code file, and the docs that reference it. */
  async definitionRefs(path: string, line: number, column: number, lineText: string): Promise<{ id: string; refs: DocRef[] } | undefined> {
    const model = await this.ready();
    const index = await this.references();
    if (!model || !index) return undefined;
    const defs = definitionsIn(model, path, await this.bufferModule(path));
    const d = definitionAt(defs, lineText, line, column);
    return d ? { id: d.id, refs: index.refsTo(d.id) } : undefined;
  }

  /** Every documentable definition of a code file with the docs that reference it. */
  async lenses(path: string): Promise<{ line: number; id: string; refs: DocRef[] }[]> {
    const model = await this.ready();
    const index = await this.references();
    if (!model || !index) return [];
    const out: { line: number; id: string; refs: DocRef[] }[] = [];
    for (const d of definitionsIn(model, path, await this.bufferModule(path))) {
      const refs = index.refsTo(d.id);
      if (refs.length) out.push({ line: d.def.lineno, id: d.id, refs });
    }
    return out;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.fixQueue.catch(() => {});
    await this.base?.tree?.dispose().catch(() => {});
    await this.cache?.save().catch(() => {});
  }
}

function groupEdits(edits: TextEdit[]): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();
  for (const e of edits) {
    const list = out.get(e.path) ?? [];
    list.push(e);
    out.set(e.path, list);
  }
  return out;
}
