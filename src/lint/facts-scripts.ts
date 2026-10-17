import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { RepoFacts } from './facts.js';

/**
 * The commands a repository defines, read statically from its manifests: package.json
 * scripts and bins (every package of the repository), Makefile targets, justfile
 * recipes, Taskfile tasks and pyproject scripts. Anything a manifest computes at run
 * time (pattern rules, variable targets, unreadable includes) makes that manifest
 * "open": it could define any name, so no command against it is judged.
 */

/** Folders whose manifests describe someone else's code (or a test's). */
const FOREIGN_DIR = /(^|\/)(node_modules|bower_components|vendor|third[-_]party|\.venv|venv|site-packages|__pycache__|\.git|fixtures?|testdata|__fixtures__|__snapshots__)\//;

export interface PackageManifest {
  /** Repository-relative directory ('' for the root). */
  dir: string;
  path: string;
  name?: string;
  scripts: Map<string, string>;
  bins: Map<string, string>;
  /** Dependency names (all kinds). */
  deps: Set<string>;
  /** Workspace globs (npm/yarn `workspaces`, pnpm-workspace.yaml). */
  workspaces: string[];
}

export interface MakeFacts {
  dir: string;
  paths: string[];
  targets: Set<string>;
  /** `%` patterns of pattern rules (`%` alone matches anything). */
  patterns: string[];
  /** A target name is computed (`$(X):`, `$(eval ...)`, unreadable include): any name may exist. */
  open: boolean;
}

export interface JustFacts {
  dir: string;
  path: string;
  recipes: Set<string>;
  modules: Set<string>;
  open: boolean;
}

export interface TaskFacts {
  dir: string;
  path: string;
  tasks: Set<string>;
  patterns: string[];
  open: boolean;
}

export interface PyProjectFacts {
  dir: string;
  path: string;
  name?: string;
  /** Console scripts: name → `pkg.mod:func`. */
  scripts: Map<string, string>;
  /** Hatch environments → their script names. */
  hatchEnvs: Map<string, Set<string>>;
  /** Scripts of pdm and other runners that resolve names before the environment's PATH. */
  runnerScripts: Set<string>;
  deps: Set<string>;
}

export interface ScriptFacts {
  packages: PackageManifest[];
  packageByDir: Map<string, PackageManifest>;
  packageByName: Map<string, PackageManifest>;
  makefiles: Map<string, MakeFacts>;
  /** Directories with a file that generates a Makefile (configure, CMake, autotools, Makefile.PL, meson). */
  makeGenerated: Set<string>;
  justfiles: Map<string, JustFacts>;
  taskfiles: Map<string, TaskFacts>;
  pyprojects: PyProjectFacts[];
  pyprojectByDir: Map<string, PyProjectFacts>;
  /** Top-level Python package name → package roots (`src/pkg`, `pkg`). */
  pyPackages: Map<string, string[]>;
  /**
   * Programs this repository builds (bins, console scripts, Go `cmd/<x>` and module names, Cargo
   * packages and bins). When one of them is a task runner (go-task's `task`, casey's `just`), the
   * docs document the runner itself, and their `task deploy` is the reader's.
   */
  ownTools: Set<string>;
}

const cache = new WeakMap<RepoFacts, Promise<ScriptFacts>>();

/** Script facts of a repository, read once per lint run. */
export function scriptFacts(facts: RepoFacts): Promise<ScriptFacts> {
  let p = cache.get(facts);
  if (!p) {
    p = loadScriptFacts(facts);
    cache.set(facts, p);
  }
  return p;
}

const dirOf = (path: string) => {
  const d = posix.dirname(path);
  return d === '.' ? '' : d;
};

export const joinDir = (dir: string, rel: string): string | undefined => {
  const n = posix.normalize(dir ? `${dir}/${rel}` : rel);
  if (n === '..' || n.startsWith('../') || posix.isAbsolute(n)) return undefined;
  return n === '.' ? '' : n.replace(/\/+$/, '');
};

/** pip-style normalized distribution name. */
export function normalizeDist(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

async function loadScriptFacts(facts: RepoFacts): Promise<ScriptFacts> {
  const files = [...facts.files].filter((f) => !FOREIGN_DIR.test(f));
  const out: ScriptFacts = {
    packages: [],
    packageByDir: new Map(),
    packageByName: new Map(),
    makefiles: new Map(),
    makeGenerated: new Set(),
    justfiles: new Map(),
    taskfiles: new Map(),
    pyprojects: [],
    pyprojectByDir: new Map(),
    pyPackages: new Map(),
    ownTools: new Set(),
  };
  const base = (f: string) => f.slice(f.lastIndexOf('/') + 1);
  const jobs: Promise<void>[] = [];
  const pnpmWorkspaces = new Map<string, string[]>();

  for (const f of files) {
    const b = base(f);
    if (b === 'package.json') jobs.push(readPackage(facts, f).then((m) => void (m && out.packages.push(m))));
    else if (b === 'pnpm-workspace.yaml' || b === 'pnpm-workspace.yml')
      jobs.push(facts.text(f).then((t) => void (t !== undefined && pnpmWorkspaces.set(dirOf(f), yamlList(t, 'packages')))));
    else if (b === 'Makefile' || b === 'makefile' || b === 'GNUmakefile') {
      jobs.push(
        readMakefile(facts, f).then((m) => {
          const prev = out.makefiles.get(m.dir);
          if (!prev) out.makefiles.set(m.dir, m);
          else {
            // GNU make reads one of GNUmakefile/makefile/Makefile; knowing all of them is the safe side.
            for (const t of m.targets) prev.targets.add(t);
            prev.patterns.push(...m.patterns);
            prev.paths.push(...m.paths);
            prev.open ||= m.open;
          }
        }),
      );
    } else if (/^(configure(\.ac|\.in)?|CMakeLists\.txt|Makefile\.(am|in|PL)|meson\.build|BUILD\.gn|premake\d?\.lua|Kbuild)$/.test(b)) out.makeGenerated.add(dirOf(f));
    else if (/^(justfile|Justfile|JUSTFILE|\.justfile)$/.test(b)) jobs.push(readJustfile(facts, f).then((j) => void out.justfiles.set(j.dir, j)));
    else if (/^[Tt]askfile(\.dist)?\.ya?ml$/.test(b)) {
      jobs.push(
        readTaskfile(facts, f, 0).then((t) => {
          const prev = out.taskfiles.get(t.dir);
          // `Taskfile.yml` wins over `Taskfile.dist.yml`, as task itself picks it.
          if (!prev || !/\.dist\./.test(t.path)) out.taskfiles.set(t.dir, t);
        }),
      );
    } else if (b === 'pyproject.toml') jobs.push(readPyproject(facts, f).then((p) => void (p && out.pyprojects.push(p))));
    else if (b === 'setup.cfg' || b === 'setup.py') jobs.push(readSetupScripts(facts, f).then((p) => void (p && out.pyprojects.push(p))));
    else if (b === 'go.mod')
      jobs.push(facts.text(f).then((t) => void (t && /^module\s+(\S+)/m.test(t) && out.ownTools.add(/^module\s+(\S+)/m.exec(t)![1]!.replace(/\/v\d+$/, '').split('/').pop()!))));
    else if (b === 'Cargo.toml')
      jobs.push(
        facts.text(f).then((t) => {
          if (!t) return;
          try {
            const doc = parseToml(t) as Record<string, unknown>;
            const name = isRecord(doc.package) ? doc.package.name : undefined;
            if (typeof name === 'string') out.ownTools.add(name);
            if (Array.isArray(doc.bin)) for (const bin of doc.bin) if (isRecord(bin) && typeof bin.name === 'string') out.ownTools.add(bin.name);
          } catch {
            // not a manifest we can read
          }
        }),
      );
    const cmd = /(?:^|\/)cmd\/([\w.-]+)\/[^/]+\.go$/.exec(f);
    if (cmd) out.ownTools.add(cmd[1]!);
  }
  await Promise.all(jobs);

  for (const p of out.packages) for (const bin of p.bins.keys()) out.ownTools.add(bin);
  for (const p of out.pyprojects) for (const script of p.scripts.keys()) out.ownTools.add(script);
  for (const p of out.packages) {
    out.packageByDir.set(p.dir, p);
    if (p.name && !out.packageByName.has(p.name)) out.packageByName.set(p.name, p);
  }
  for (const [dir, globs] of pnpmWorkspaces) {
    const root = out.packageByDir.get(dir);
    if (root) root.workspaces.push(...globs);
  }
  for (const p of out.pyprojects) {
    const prev = out.pyprojectByDir.get(p.dir);
    if (!prev) out.pyprojectByDir.set(p.dir, p);
    else {
      for (const [k, v] of p.scripts) prev.scripts.set(k, v);
      for (const d of p.deps) prev.deps.add(d);
      prev.name ??= p.name;
    }
  }

  // Python packages: a directory with `__init__.py` whose parent has none.
  const inits = new Set(files.filter((f) => base(f) === '__init__.py').map(dirOf));
  for (const d of inits) {
    if (inits.has(dirOf(d)) && dirOf(d) !== '') continue;
    const name = base(d);
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const list = out.pyPackages.get(name) ?? [];
    list.push(d);
    out.pyPackages.set(name, list);
  }
  return out;
}

async function readJson(facts: RepoFacts, path: string): Promise<Record<string, unknown> | undefined> {
  const text = await facts.text(path);
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function readPackage(facts: RepoFacts, path: string): Promise<PackageManifest | undefined> {
  const pkg = await readJson(facts, path);
  if (!pkg) return undefined;
  const name = typeof pkg.name === 'string' ? pkg.name : undefined;
  const scripts = new Map<string, string>();
  if (isRecord(pkg.scripts)) for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === 'string') scripts.set(k, v);
  const bins = new Map<string, string>();
  if (typeof pkg.bin === 'string' && name) bins.set(name.replace(/^@[^/]+\//, ''), pkg.bin);
  else if (isRecord(pkg.bin)) for (const [k, v] of Object.entries(pkg.bin)) if (typeof v === 'string') bins.set(k, v);
  const deps = new Set<string>();
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (isRecord(pkg[key])) for (const d of Object.keys(pkg[key] as object)) deps.add(d);
  }
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : isRecord(pkg.workspaces) && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : [];
  return { dir: dirOf(path), path, ...(name ? { name } : {}), scripts, bins, deps, workspaces: ws.filter((x): x is string => typeof x === 'string') };
}

/** Items of a top-level YAML list (`packages:\n  - 'a/*'`), enough for pnpm-workspace.yaml. */
function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (at < 0) return [];
  const inline = /:\s*\[(.*)\]/.exec(lines[at]!);
  if (inline) return inline[1]!.split(',').map((x) => unquote(x.trim())).filter(Boolean);
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\S/.test(l) && !l.startsWith('#')) break;
    const m = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(l);
    if (m) out.push(unquote(m[1]!));
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

// ---------------------------------------------------------------- Makefiles

/** Logical lines with `\` continuations joined. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let acc = '';
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/\\$/.test(raw)) {
      acc += raw.slice(0, -1) + ' ';
      continue;
    }
    out.push(acc + raw);
    acc = '';
  }
  if (acc) out.push(acc);
  return out;
}

async function readMakefile(facts: RepoFacts, path: string, seen = new Set<string>()): Promise<MakeFacts> {
  const dir = dirOf(path);
  const m: MakeFacts = { dir, paths: [path], targets: new Set(), patterns: [], open: false };
  seen.add(path);
  const text = await facts.text(path);
  if (text === undefined) {
    m.open = true;
    return m;
  }
  let inDefine = 0;
  for (const raw of logicalLines(text)) {
    if (raw.startsWith('\t')) continue;
    const line = raw.replace(/(^|[^\\])#.*$/, '$1').trimEnd();
    const t = line.trim();
    if (!t) continue;
    if (/^define\b/.test(t)) {
      inDefine++;
      continue;
    }
    if (inDefine) {
      if (/^endef\b/.test(t)) inDefine--;
      continue;
    }
    const inc = /^(-?include|sinclude)\s+(.+)$/.exec(t);
    if (inc) {
      for (const f of inc[2]!.split(/\s+/)) {
        if (/[$*?[]/.test(f)) {
          m.open = true;
          continue;
        }
        const p = joinDir(dir, f);
        if (p === undefined || seen.has(p)) continue;
        if (!facts.files.has(p) && !facts.exists(p)) {
          // `-include` of a generated file is silent; its rules are unknown either way.
          m.open = true;
          continue;
        }
        const sub = await readMakefile(facts, p, seen);
        for (const x of sub.targets) m.targets.add(x);
        m.patterns.push(...sub.patterns);
        m.paths.push(...sub.paths);
        m.open ||= sub.open;
      }
      continue;
    }
    if (/^(ifn?eq|ifn?def|else|endif|unexport|vpath|undefine)\b/.test(t)) continue;
    // `export X = 1`, `override CFLAGS += -O2`; `export target: dep` is still a rule.
    const body = t.replace(/^((?:export|override|private)\s+)+/, '');
    if (body !== t && !/:(?!=)/.test(body)) continue;
    // `$(eval ...)`, `$(foreach ...)` at the top level can define rules.
    if (/^\$[({]/.test(body) && !/:/.test(body.replace(/\$[({][^)}]*[)}]/g, ''))) {
      m.open = true;
      continue;
    }
    const colon = body.indexOf(':');
    const eq = body.search(/[?+!]?=/);
    if (colon < 0) continue;
    if (eq >= 0 && eq < colon) continue; // assignment
    if (/^:{0,2}:?=/.test(body.slice(colon))) continue; // `x := y`, `x ::= y`
    for (const name of body.slice(0, colon).trim().split(/\s+/).filter(Boolean)) {
      if (name === '.PHONY') {
        for (const p of body.slice(colon + 1).trim().split(/\s+/).filter(Boolean)) if (!/[$%]/.test(p)) m.targets.add(p);
        continue;
      }
      if (name === '.DEFAULT') {
        m.patterns.push('%');
        continue;
      }
      // A computed name (`$(BIN)/tool`, `install-$(X)`) is a pattern: the variable can be anything.
      const pattern = name.replace(/\$\([^)]*\)|\$\{[^}]*\}|\$\w/g, '%');
      if (pattern.includes('%')) m.patterns.push(pattern);
      else m.targets.add(name);
    }
  }
  return m;
}

/** Whether a make pattern (`%`, `build-%`, `%.o`) matches a target. */
export function patternMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('%')) return pattern === name;
  const source = pattern
    .split('%')
    .map((p) => p.replace(/[.*+?^$|()[\]{}\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(name);
}

// ---------------------------------------------------------------- justfiles

async function readJustfile(facts: RepoFacts, path: string, seen = new Set<string>()): Promise<JustFacts> {
  const dir = dirOf(path);
  const j: JustFacts = { dir, path, recipes: new Set(), modules: new Set(), open: false };
  seen.add(path);
  const text = await facts.text(path);
  if (text === undefined) {
    j.open = true;
    return j;
  }
  for (const raw of logicalLines(text)) {
    if (/^\s/.test(raw) || raw.startsWith('#')) continue;
    const t = raw.trimEnd();
    if (!t || t.startsWith('[')) continue;
    const alias = /^alias\s+([\w-]+)\s*:=/.exec(t);
    if (alias) {
      j.recipes.add(alias[1]!);
      continue;
    }
    const imp = /^import(\?)?\s+(['"])(.+?)\2/.exec(t);
    if (imp) {
      const p = joinDir(dir, imp[3]!);
      if (p === undefined || /[{$]/.test(imp[3]!)) j.open = true;
      else if (!seen.has(p)) {
        if (!facts.files.has(p)) {
          if (!imp[1]) j.open = true;
          continue;
        }
        const sub = await readJustfile(facts, p, seen);
        for (const r of sub.recipes) j.recipes.add(r);
        for (const r of sub.modules) j.modules.add(r);
        j.open ||= sub.open;
      }
      continue;
    }
    const mod = /^mod\??\s+([\w-]+)/.exec(t);
    if (mod) {
      j.modules.add(mod[1]!);
      continue;
    }
    if (/^(set|export|unexport)\b/.test(t) || /^[\w-]+\s*:=/.test(t)) continue;
    const recipe = /^@?([A-Za-z_][\w-]*)\b[^:=]*?(?:\s+[^:]*)?:(?!=)/.exec(t);
    if (recipe) j.recipes.add(recipe[1]!);
  }
  return j;
}

// ---------------------------------------------------------------- Taskfiles

interface YamlKey {
  key: string;
  indent: number;
  line: number;
  value: string;
}

/** Keys of a YAML block mapping (one level), with the lines that belong to each. */
function yamlChildren(lines: string[], parent: number, parentIndent: number): { key: YamlKey; body: string[] }[] {
  const out: { key: YamlKey; body: string[] }[] = [];
  let indent = -1;
  for (let i = parent + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim() || /^\s*#/.test(l)) {
      out.at(-1)?.body.push(l);
      continue;
    }
    const ind = /^\s*/.exec(l)![0].length;
    if (ind <= parentIndent) break;
    if (indent < 0) indent = ind;
    if (ind === indent) {
      // Plain keys may hold colons not followed by a space (`lint:fix:`).
      const m = /^\s*(?:(['"])(.+?)\1|([^\s'"#:](?:[^:#]|:(?!\s|$))*?))\s*:(?:\s+(.*)|\s*)$/.exec(l);
      if (m) {
        out.push({ key: { key: m[2] ?? m[3]!, indent: ind, line: i, value: (m[4] ?? '').trim() }, body: [] });
        continue;
      }
    }
    out.at(-1)?.body.push(l);
  }
  return out;
}

async function readTaskfile(facts: RepoFacts, path: string, depth: number): Promise<TaskFacts> {
  const dir = dirOf(path);
  const tf: TaskFacts = { dir, path, tasks: new Set(), patterns: [], open: false };
  const text = await facts.text(path);
  if (text === undefined) {
    tf.open = true;
    return tf;
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const top = (key: string) => lines.findIndex((l) => new RegExp(`^${key}\\s*:\\s*(#.*)?$`).test(l));
  const tasksAt = top('tasks');
  if (tasksAt >= 0) {
    for (const { key, body } of yamlChildren(lines, tasksAt, 0)) {
      if (key.key.includes('*')) tf.patterns.push(key.key.replace(/\*/g, '%'));
      else tf.tasks.add(key.key);
      const aliasLine = body.find((l) => /^\s*aliases\s*:/.test(l));
      if (aliasLine) {
        const inline = /:\s*\[(.*)\]/.exec(aliasLine);
        if (inline) for (const a of inline[1]!.split(',')) tf.tasks.add(unquote(a.trim()));
        else {
          const at = body.indexOf(aliasLine);
          for (const l of body.slice(at + 1)) {
            const item = /^\s*-\s*(.+?)\s*$/.exec(l);
            if (!item) break;
            tf.tasks.add(unquote(item[1]!));
          }
        }
      }
    }
  }
  const incAt = top('includes');
  if (incAt >= 0) {
    for (const { key, body } of yamlChildren(lines, incAt, 0)) {
      let file = key.value;
      let flatten = false;
      let optional = false;
      const names = [key.key];
      for (const l of body) {
        const m = /^\s*(taskfile|flatten|optional|aliases)\s*:\s*(.+?)\s*$/.exec(l);
        if (m?.[1] === 'taskfile') file = m[2]!;
        if (m?.[1] === 'flatten') flatten = m[2] === 'true';
        if (m?.[1] === 'optional') optional = m[2] === 'true';
        const list = m?.[1] === 'aliases' ? /^\[(.*)\]$/.exec(m[2]!) : null;
        if (list) names.push(...list[1]!.split(',').map((a) => unquote(a.trim())).filter(Boolean));
      }
      file = unquote(file.trim());
      if (!file || /\{\{|\$|:\/\//.test(file) || depth > 4) {
        tf.open = true;
        continue;
      }
      let p = joinDir(dir, file);
      if (p !== undefined && !/\.ya?ml$/.test(p)) {
        const inDir = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'].map((n) => (p ? `${p}/${n}` : n)).find((c) => facts.files.has(c));
        p = inDir;
      }
      if (p === undefined || !facts.files.has(p)) {
        if (!optional) tf.open = true;
        continue;
      }
      const sub = await readTaskfile(facts, p, depth + 1);
      for (const ns of names) {
        // `task website` runs the included Taskfile's default task.
        tf.tasks.add(ns);
        for (const t of sub.tasks) tf.tasks.add(`${ns}:${t}`);
        for (const pat of sub.patterns) tf.patterns.push(`${ns}:${pat}`);
      }
      if (flatten) {
        for (const t of sub.tasks) tf.tasks.add(t);
        tf.patterns.push(...sub.patterns);
      }
      tf.open ||= sub.open;
    }
  }
  return tf;
}

// ---------------------------------------------------------------- Python projects

function depName(spec: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? normalizeDist(m[1]!) : undefined;
}

async function readPyproject(facts: RepoFacts, path: string): Promise<PyProjectFacts | undefined> {
  const text = await facts.text(path);
  if (text === undefined) return undefined;
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const get = (obj: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), obj);
  const project = get(doc, 'project');
  const poetry = get(doc, 'tool', 'poetry');
  const name = (get(project, 'name') ?? get(poetry, 'name')) as string | undefined;
  const scripts = new Map<string, string>();
  for (const table of [get(project, 'scripts'), get(project, 'gui-scripts'), get(poetry, 'scripts')]) {
    if (!isRecord(table)) continue;
    for (const [k, v] of Object.entries(table)) {
      if (typeof v === 'string') scripts.set(k, v);
      else if (isRecord(v)) scripts.set(k, String(v.callable ?? v.reference ?? ''));
    }
  }
  const deps = new Set<string>();
  const addSpecs = (list: unknown) => {
    if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') depName(s) && deps.add(depName(s)!);
  };
  addSpecs(get(project, 'dependencies'));
  const optional = get(project, 'optional-dependencies');
  if (isRecord(optional)) for (const v of Object.values(optional)) addSpecs(v);
  const groups = get(doc, 'dependency-groups');
  if (isRecord(groups)) for (const v of Object.values(groups)) addSpecs(v);
  addSpecs(get(doc, 'tool', 'uv', 'dev-dependencies'));
  const pdmDev = get(doc, 'tool', 'pdm', 'dev-dependencies');
  if (isRecord(pdmDev)) for (const v of Object.values(pdmDev)) addSpecs(v);
  for (const t of [get(poetry, 'dependencies'), get(poetry, 'dev-dependencies')]) if (isRecord(t)) for (const k of Object.keys(t)) deps.add(normalizeDist(k));
  const pgroups = get(poetry, 'group');
  if (isRecord(pgroups)) for (const g of Object.values(pgroups)) if (isRecord(get(g, 'dependencies'))) for (const k of Object.keys(get(g, 'dependencies') as object)) deps.add(normalizeDist(k));
  const hatchEnvs = new Map<string, Set<string>>();
  const envs = get(doc, 'tool', 'hatch', 'envs');
  if (isRecord(envs)) {
    for (const [env, cfg] of Object.entries(envs)) {
      const s = new Set<string>(isRecord(get(cfg, 'scripts')) ? Object.keys(get(cfg, 'scripts') as object) : []);
      hatchEnvs.set(env, s);
      addSpecs(get(cfg, 'dependencies'));
      addSpecs(get(cfg, 'extra-dependencies'));
    }
  }
  const runnerScripts = new Set<string>();
  const pdmScripts = get(doc, 'tool', 'pdm', 'scripts');
  if (isRecord(pdmScripts)) for (const k of Object.keys(pdmScripts)) runnerScripts.add(k);
  const poeTasks = get(doc, 'tool', 'poe', 'tasks');
  if (isRecord(poeTasks)) for (const k of Object.keys(poeTasks)) runnerScripts.add(k);
  return { dir: dirOf(path), path, ...(typeof name === 'string' ? { name } : {}), scripts, hatchEnvs, runnerScripts, deps };
}

/** `console_scripts` of setup.cfg / setup.py, read as text. */
async function readSetupScripts(facts: RepoFacts, path: string): Promise<PyProjectFacts | undefined> {
  const text = await facts.text(path);
  if (text === undefined || !/console_scripts/.test(text)) return undefined;
  const scripts = new Map<string, string>();
  for (const m of text.matchAll(/(?:^|['"\s])([A-Za-z0-9][\w.-]*)\s*=\s*([A-Za-z_][\w.]*:[A-Za-z_][\w.]*)/gm)) scripts.set(m[1]!, m[2]!);
  const name = /\bname\s*=\s*['"]?([A-Za-z0-9][\w.-]*)/.exec(text)?.[1];
  return { dir: dirOf(path), path, ...(name ? { name } : {}), scripts, hatchEnvs: new Map(), runnerScripts: new Set(), deps: new Set() };
}

// ---------------------------------------------------------------- helpers for checks

/** Directories from `dir` up to the root, nearest first. */
export function upward(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (d === '') break;
    d = dirOf(d);
  }
  return out;
}

/** Levenshtein distance, capped (enough to rank close names). */
export function editDistance(a: string, b: string, cap = 4): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Names close to `name` (edit distance, or the same words in another order or separator), closest first. */
export function closeNames(name: string, names: Iterable<string>, max = 3): string[] {
  const words = (s: string) => s.toLowerCase().split(/[-_:.\s]+/).filter(Boolean).sort().join(' ');
  const w = words(name);
  const scored: [string, number][] = [];
  for (const n of names) {
    if (n === name) continue;
    const d = words(n) === w ? 0.5 : editDistance(name.toLowerCase(), n.toLowerCase(), 3);
    const limit = name.length <= 4 ? 1 : name.length <= 7 ? 2 : 3;
    if (d <= limit) scored.push([n, d]);
  }
  return scored
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([n]) => n);
}

/** "build, test, lint" (at most `max`, then "and N more"). */
export function listNames(names: Iterable<string>, max = 8): string {
  const all = [...names];
  if (!all.length) return 'none';
  return all.length > max ? `${all.slice(0, max).join(', ')} and ${all.length - max} more` : all.join(', ');
}
