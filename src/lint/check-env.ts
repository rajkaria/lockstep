import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { matchesAny, type RepoConfig } from '../indexer/repo-config.js';
import { HISTORY_LINE, HISTORY_PAGE } from './check-symbols.js';
import {
  claimContext,
  codeLang,
  consumedByDependency,
  dependencyNames,
  docEnvClaims,
  docEnvReads,
  docFamilies,
  docInstalls,
  envFileClaims,
  fileEnv,
  isWellKnown,
  looseName,
  namesProduct,
  ownNames,
  ownPrefix,
  type DynamicRead,
  type EnvClaim,
  type EnvRead,
  type FileEnv,
} from './facts-env.js';
import { closeNames, codeDoc, type CheckedPage, type PageFinding } from './facts-docstrings.js';
import type { ParseCache } from './cache.js';
import { envExampleFiles } from './files.js';
import { isSuppressed } from './scan.js';

/** Test code: its reads are not the product's settings (they still count as reads of documented names). */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|e2e|testing|fixtures?|testdata|__fixtures__|cypress|playwright)\/|\.(test|spec|e2e|stories|bench)\.[cm]?[jt]sx?$|[-.]test\.[cm]?[jt]s$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/;
/** Build and release tooling: CI scripts and tool configs read the CI's variables, not the product's. */
const TOOLING_PATH = /(^|\/)(scripts?|tools?|benchmarks?|bench|\.github|\.circleci|\.husky|\.devcontainer)\/|(^|\/)[\w.-]+\.config\.[cm]?[jt]s$|(^|\/)(setup|noxfile|fabfile|tasks|manage)\.py$/;
/** Third-party code checked into the repository: not read (for speed; it documents nothing of ours). */
const THIRD_PARTY = /(^|\/)(node_modules|vendor|third[-_]party|\.venv|venv|site-packages|bower_components)\//;
/** Files the token search reads: code, config, build and CI files. */
const SEARCHED = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|py|pyi|rs|go|rb|php|java|kt|kts|scala|swift|c|cc|cpp|h|hpp|cs|fs|ex|exs|erl|dart|lua|pl|r|jl|sh|bash|zsh|fish|ps1|bat|cmd|ya?ml|toml|json|jsonc|json5|ini|cfg|conf|properties|tf|hcl|nix|prisma|graphql|gql|sql|gradle|cmake|mk|bzl|bazel|star|xml|plist|service|envrc|npmrc|yarnrc|bazelrc|tmpl|tpl|j2|jinja|hbs|ejs)$|(^|\/)(Makefile|makefile|GNUmakefile|Dockerfile[^/]*|Containerfile|Procfile|Justfile|justfile|Rakefile|Gemfile|Taskfile|Vagrantfile|Caddyfile|\.envrc|\.npmrc|\.yarnrc|\.env\.vault)$/;
/** Extension-less files: hooks and scripts (`.husky/pre-commit`, `bin/dev`), not licences and readmes. */
const EXTENSIONLESS = /(^|\/)(?![^/]*\.)(?!(?:LICEN[CS]E|COPYING|AUTHORS|README|CHANGELOG|CHANGES|NOTICE|CODEOWNERS|OWNERS|VERSION|PATENTS|CONTRIBUTORS)$)[^/]+$/;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$/;
const MAX_BYTES = 1_500_000;

export interface EnvCheckInput {
  dir: string;
  /** `owner/name`: its parts are the repository's own names. */
  repo?: string;
  paths: string[];
  pages: CheckedPage[];
  config?: RepoConfig;
  /** The lint parse cache: each code file's environment reads are kept by content. */
  cache?: ParseCache;
  unused: boolean;
  undocumented: boolean;
}

interface Located {
  claim: EnvClaim;
  page: CheckedPage;
}

/** Read many files at once, a bounded number at a time. */
async function readAll(dir: string, paths: string[], each: (path: string, text: string) => void): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++]!;
      try {
        const s = await stat(join(dir, path));
        if (!s.isFile() || s.size > MAX_BYTES) continue;
        each(path, await readFile(join(dir, path), 'utf8'));
      } catch {
        // gone or unreadable: nothing to read
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
}

/**
 * `env-unused` and `env-undocumented`: the environment variables the docs and env example
 * files document, against the variables the repository's code reads (all of it: apps,
 * scripts and tests count as readers; only product code needs its variables documented).
 */
export async function checkEnv(o: EnvCheckInput): Promise<PageFinding[]> {
  const exclude = [...(o.config?.ignore ?? []), ...(o.config?.lint?.exclude ?? [])];
  const envFiles: { page: CheckedPage; claims: EnvClaim[] }[] = [];
  const refs = new Set<string>();
  for (const t of envExampleFiles(o.paths, o.config)) {
    const text = await readFile(join(o.dir, t.path), 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    const { claims, refs: r } = envFileClaims(text);
    for (const x of r) refs.add(x);
    envFiles.push({ page: { target: t, doc: codeDoc(t.path, text), text }, claims });
  }
  const docClaims: Located[] = [];
  for (const page of o.pages) {
    if (HISTORY_PAGE.test(page.target.path)) continue;
    for (const claim of docEnvClaims(page.doc)) {
      if (!HISTORY_LINE.test(page.doc.lines[claim.span.line - 1] ?? '')) docClaims.push({ claim, page });
    }
  }
  const claims: Located[] = [...envFiles.flatMap((e) => e.claims.map((claim) => ({ claim, page: e.page }))), ...docClaims];
  const unusedWork = o.unused && claims.length > 0;
  const undocumentedWork = o.undocumented && envFiles.length > 0;
  if (!unusedWork && !undocumentedWork) return [];

  // Claims no rule of thumb explains; the token search over the code decides them.
  const eligible: Located[] = [];
  if (unusedWork) {
    const own = await ownNames(o.dir, o.paths, o.repo);
    const docReads = new Set<string>();
    const families = new Set<string>();
    const installs = new Set<string>();
    for (const page of o.pages) {
      for (const r of docEnvReads(page.doc)) docReads.add(r);
      for (const f of docFamilies(page.doc)) families.add(f);
      for (const i of docInstalls(page.doc)) installs.add(i);
    }
    // Dependencies (and packages the docs install) read their variables; the repository's own packages are judged by their code.
    const deps = new Set([...(await dependencyNames(o.dir, o.paths)), ...installs].filter((d) => !own.packages.has(d)));
    for (const located of claims) {
      const { claim, page } = located;
      const name = claim.name;
      if (isWellKnown(name) || refs.has(name) || docReads.has(name) || consumedByDependency(name, deps)) continue;
      if ([...families].some((f) => name.startsWith(f))) continue;
      if (claim.how !== 'env-file') {
        // Docs pages often describe the reader's project or another product: only variables named after this repository count there.
        if (page.target.surface === 'docs' && !ownPrefix(name, own.tokens)) continue;
        if (namesProduct(name, claimContext(page.doc, claim), own.tokens)) continue;
      }
      eligible.push(located);
    }
  }
  const pending = new Set(eligible.map((c) => c.claim.name));

  const skip = new Set([...envFiles.map((e) => e.page.target.path), ...o.pages.map((p) => p.target.path)]);
  const files = o.paths.filter((p) => !skip.has(p) && !THIRD_PARTY.test(p) && !LOCKFILE.test(p) && (SEARCHED.test(p) || codeLang(p) || EXTENSIONLESS.test(p)));
  const reads: (EnvRead & { path: string })[] = [];
  const readNames = new Set<string>();
  const dynamic: (DynamicRead & { path: string })[] = [];
  const fileFragments = new Map<string, string[]>();
  const constants = new Map<string, string>();
  const derivedIdents = new Set<string>();
  const prefixes = new Set<string>();
  const codeFamilies = new Set<string>();
  const setByCode = new Set<string>();
  const texts = new Map<string, string>();
  let searched = 0;
  const wordRe = (names: Set<string>) => (names.size ? new RegExp(`(?<![A-Za-z0-9_])(?:${[...names].join('|')})(?![A-Za-z0-9_])`, 'g') : undefined);
  /** Remove from `names` every one that appears as a word in `text`. */
  const search = (names: Set<string>, text: string, re: RegExp | undefined): RegExp | undefined => {
    if (!re || !names.size) return re;
    let changed = false;
    for (const m of text.matchAll(re)) if (names.delete(m[0])) changed = true;
    return changed ? wordRe(names) : re;
  };
  let re = wordRe(pending);

  type StoredEnv = Omit<FileEnv, 'constants'> & { constants: [string, string][] };
  const envOf = (path: string, text: string): FileEnv | undefined => {
    if (!o.cache) return fileEnv(path, text);
    const stored = o.cache.valueSync<StoredEnv | null>('env-reads.v1', `${path}\0${text}`, () => {
      const e = fileEnv(path, text);
      return e ? { ...e, constants: [...e.constants] } : null;
    });
    return stored ? { ...stored, constants: new Map(stored.constants) } : undefined;
  };

  await readAll(o.dir, files, (path, text) => {
    searched++;
    const env = envOf(path, text);
    const product = !TEST_PATH.test(path);
    if (env) {
      for (const r of env.reads) {
        reads.push({ ...r, path });
        readNames.add(r.name);
      }
      if (env.reads.length && product) texts.set(path, text);
      if (product && env.dynamic.length) {
        for (const d of env.dynamic) dynamic.push({ ...d, path });
        fileFragments.set(path, env.fragments);
      }
      for (const [k, v] of env.constants) constants.set(k, v);
      for (const p of env.prefixes) prefixes.add(p);
      for (const f of env.families) codeFamilies.add(f);
      if (product) for (const n of env.sets) setByCode.add(n);
      // Names derived from fields or upper-cased: compare loosely with the file's identifiers and strings.
      if (env.derived) for (const m of text.matchAll(/[A-Za-z_]\w*/g)) derivedIdents.add(looseName(m[0]));
    }
    re = search(pending, text, re);
  });

  const out: PageFinding[] = [];
  if (unusedWork) {
    // Computed reads. A variable key takes its values from the code (a constant, or literals the
    // search already saw); fragments name a family (`STALEPROOF_` + a name the code spells out).
    let opaque = false;
    const remainders = new Map<string, Set<string>>();
    const family = (fragments: string[]) => {
      for (const name of [...pending]) {
        for (const f of fragments) {
          const rest = name === f ? '' : f.endsWith('_') && name.startsWith(f) ? name.slice(f.length) : f.startsWith('_') && name.endsWith(f) ? name.slice(0, -f.length) : undefined;
          if (rest === undefined) continue;
          if (!rest || derivedIdents.has(looseName(rest))) pending.delete(name);
          else remainders.set(rest, (remainders.get(rest) ?? new Set()).add(name));
        }
      }
    };
    for (const d of dynamic) {
      if (d.kind === 'splat' || (d.kind === 'computed' && !d.fragments.length)) opaque = true;
      if (d.kind === 'name') {
        const value = constants.get(d.key!);
        if (value) pending.delete(value);
        else family(fileFragments.get(d.path) ?? []);
      } else if (d.kind === 'iterate') family([...d.fragments, ...(fileFragments.get(d.path) ?? [])]);
      else family(d.fragments);
    }
    for (const name of [...pending]) if ([...codeFamilies].some((f) => name.startsWith(f))) pending.delete(name);
    for (const name of [...pending]) {
      const bare = [name, ...[...prefixes].filter((p) => p && name.toUpperCase().startsWith(p.toUpperCase())).map((p) => name.slice(p.length))];
      if (bare.some((b) => derivedIdents.has(looseName(b)))) pending.delete(name);
    }
    // A family member counts as read when the code spells out the rest of its name.
    const rests = new Set([...remainders.keys()].filter((r) => [...remainders.get(r)!].some((n) => pending.has(n))));
    if (rests.size) {
      let rre = wordRe(rests);
      const found = new Set(rests);
      await readAll(o.dir, files, (_path, text) => {
        rre = search(rests, text, rre);
      });
      for (const r of found) if (!rests.has(r)) for (const n of remainders.get(r)!) pending.delete(n);
    }
    // Code that reads a name it computes could read any documented name: judge none.
    if (!opaque) {
      const seen = new Set<string>();
      for (const { claim, page } of eligible) {
        if (!pending.has(claim.name)) continue;
        const key = `${page.target.path}\0${claim.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const near = closeNames(claim.name, readNames, 2, false);
        const where = claim.how === 'env-file' ? `is listed in ${posix.basename(page.target.path)}` : 'is documented';
        out.push({
          page,
          f: {
            rule: 'env-unused',
            span: claim.span,
            subject: claim.name,
            message: `\`${claim.name}\` ${where} but no code reads it${near.length === 1 ? ` (the code reads \`${near[0]}\`)` : ''}.`,
            looked: `the repository's code and config (${searched} files)`,
            ...(near.length ? { candidates: near } : {}),
          },
        });
      }
    }
  }

  if (undocumentedWork) {
    const listed = new Set([...envFiles.flatMap((e) => e.claims.map((c) => c.name)), ...docClaims.map((c) => c.claim.name)]);
    const envDirs = envFiles.map((e) => ({ dir: posix.dirname(e.page.target.path), path: e.page.target.path }));
    const covering = (path: string) =>
      envDirs.filter((e) => e.dir === '.' || path.startsWith(`${e.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
    const docs = new Map<string, ReturnType<typeof codeDoc>>();
    const docOf = (path: string) => {
      let d = docs.get(path);
      if (!d) docs.set(path, (d = codeDoc(path, texts.get(path) ?? '')));
      return d;
    };
    const product = reads
      .filter((r) => !listed.has(r.name) && !isWellKnown(r.name) && !setByCode.has(r.name) && texts.has(r.path) && !TOOLING_PATH.test(r.path) && !matchesAny(r.path, exclude) && covering(r.path))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    // One finding per variable, at its first read; a suppression at any read silences the variable.
    const reported = new Set(product.filter((r) => isSuppressed(docOf(r.path), r.line, 'env-undocumented')).map((r) => r.name));
    for (const r of product) {
      if (reported.has(r.name)) continue;
      const env = covering(r.path)!;
      const text = texts.get(r.path)!;
      reported.add(r.name);
      const near = closeNames(r.name, listed, 2, false);
      out.push({
        page: { target: { path: r.path, surface: 'config' }, doc: docOf(r.path), text },
        f: {
          rule: 'env-undocumented',
          span: { text: r.name, line: r.line, column: r.column, endColumn: r.endColumn },
          subject: r.name,
          message: `\`${r.name}\` is read in ${r.path} but not listed in ${env.path}.`,
          looked: envFiles.map((e) => e.page.target.path).join(', '),
          target: env.path,
          ...(near.length ? { candidates: near } : {}),
        },
      });
    }
  }
  return out;
}
