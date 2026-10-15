import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { MdDoc } from './markdown.js';
import type { ParsedRepo } from './index.js';
import { trackedOrWalked } from './files.js';

export interface DependsOn {
  from: string;
  to: string;
  spec: string;
}

/** PEP 503 normalisation: `GraphRAG_SDK` == `graphrag-sdk`. */
export function normalizeDist(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export interface PythonProject {
  name?: string;
  deps: string[];
}

/** Distribution name and dependency names from a pyproject.toml. */
export function readPyproject(text: string): PythonProject {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return { deps: [] };
  }
  const project = (data.project ?? {}) as { name?: string; dependencies?: string[]; 'optional-dependencies'?: Record<string, string[]> };
  const poetry = ((data.tool as Record<string, unknown> | undefined)?.poetry ?? {}) as {
    name?: string;
    dependencies?: Record<string, unknown>;
  };
  const deps = new Set<string>();
  for (const spec of project.dependencies ?? []) deps.add(distName(spec));
  for (const group of Object.values(project['optional-dependencies'] ?? {})) for (const spec of group) deps.add(distName(spec));
  for (const name of Object.keys(poetry.dependencies ?? {})) if (name !== 'python') deps.add(normalizeDist(name));
  return { name: project.name ?? poetry.name, deps: [...deps].filter(Boolean) };
}

/** `falkordb[hiredis]>=1.7,<2 ; python_version>"3.9"` → `falkordb` */
export function distName(spec: string): string {
  return normalizeDist(spec.trim().split(/[\s\[<>=!~;@(]/)[0] ?? '');
}

export function readRequirements(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('-'))
    .map(distName)
    .filter(Boolean);
}

/**
 * Repository → repository dependencies inside the organisation: declared ones
 * (pyproject, requirements) and, for docs, the packages their examples import.
 */
export async function dependencyEdges(parsed: ParsedRepo[], docsByRepo: Map<string, MdDoc[]>, packageRepos: Map<string, Set<string>>): Promise<DependsOn[]> {
  const projects = new Map<string, PythonProject[]>();
  for (const p of parsed) {
    const files = await trackedOrWalked(p.checkout.dir);
    const list: PythonProject[] = [];
    for (const f of files) {
      const base = posix.basename(f);
      if (base === 'pyproject.toml') list.push(readPyproject(await readFile(join(p.checkout.dir, f), 'utf8')));
      else if (/^requirements[\w.-]*\.txt$/.test(base)) list.push({ deps: readRequirements(await readFile(join(p.checkout.dir, f), 'utf8')) });
    }
    projects.set(p.checkout.repo, list);
  }
  const distToRepo = new Map<string, string>();
  for (const [repo, list] of projects) for (const proj of list) if (proj.name) distToRepo.set(normalizeDist(proj.name), repo);

  const edges = new Map<string, DependsOn>();
  for (const [repo, list] of projects) {
    for (const proj of list) {
      for (const dep of proj.deps) {
        const target = distToRepo.get(dep);
        if (target && target !== repo) edges.set(`${repo}->${target}`, { from: repo, to: target, spec: `declares ${dep}` });
      }
    }
  }
  for (const [repo, docs] of docsByRepo) {
    for (const doc of docs) {
      for (const ex of doc.examples.filter((e) => e.lang === 'python')) {
        for (const m of ex.code.matchAll(/^\s*(?:from\s+([\w]+)[\w.]*\s+import|import\s+([\w]+))/gm)) {
          const pkg = m[1] ?? m[2]!;
          for (const target of packageRepos.get(pkg) ?? []) {
            const key = `${repo}->${target}`;
            if (target !== repo && !edges.has(key)) edges.set(key, { from: repo, to: target, spec: `examples import ${pkg}` });
          }
        }
      }
    }
  }
  return [...edges.values()];
}
