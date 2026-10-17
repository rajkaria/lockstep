import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles, parseRepo } from '../src/indexer/index.js';
import { moduleNames, nearestPackage, pythonSourceRoots, workspacePackages } from '../src/indexer/repo.js';
import { lintRepo } from '../src/lint/engine.js';
import { FIXTURES } from './helpers.js';

const MONO = { repo: 'acme/mono', dir: join(FIXTURES, 'ts-monorepo'), sha: 'fixture' };

describe('monorepos', () => {
  it('finds every package a repository declares: npm workspaces, Python projects, Go modules', async () => {
    const paths = (await listFiles(MONO.dir)).map((f) => f.path);
    const all = [...paths, 'package.json', 'packages/core/package.json', 'packages/cli/package.json', 'pyproject.toml', 'python/graph/pyproject.toml', 'python/tools/pyproject.toml', 'go/go.mod', 'node_modules/x/package.json'];
    const pkgs = workspacePackages(all);
    expect(pkgs.map((p) => `${p.kind} ${p.dir || '.'}`)).toEqual(['go go', 'npm .', 'npm packages/cli', 'npm packages/core', 'python .', 'python python/graph', 'python python/tools']);
    expect(nearestPackage('packages/core/README.md', pkgs, 'npm')?.manifest).toBe('packages/core/package.json');
    expect(nearestPackage('docs/usage.md', pkgs, 'npm')?.manifest).toBe('package.json');
    expect(nearestPackage('packages/core-extra/x.md', pkgs, 'npm')?.manifest).toBe('package.json');
  });

  it('names a namespace package split across uv workspace members from each source root', () => {
    const files = ['python/graph/src/acme/graph/__init__.py', 'python/graph/src/acme/graph/client.py', 'python/tools/src/acme/tools/__init__.py', 'scripts/x.py'];
    const roots = pythonSourceRoots([...files, 'python/graph/pyproject.toml', 'python/tools/pyproject.toml', 'pyproject.toml', 'docs/conf/setup.py']);
    expect(roots).toEqual(['python/graph/src', 'python/tools/src']);
    expect([...moduleNames(files, roots)].map(([f, m]) => `${f} → ${m.module}`)).toEqual([
      'python/graph/src/acme/graph/__init__.py → acme.graph',
      'python/graph/src/acme/graph/client.py → acme.graph.client',
      'python/tools/src/acme/tools/__init__.py → acme.tools',
      'scripts/x.py → scripts.x',
    ]);
    // Without the projects, the old rule names the packages from their top `__init__.py`.
    expect(moduleNames(files).get('python/graph/src/acme/graph/client.py')!.module).toBe('graph.client');
  });

  it('indexes each package of the repository as its own module tree', async () => {
    const p = await parseRepo(MONO);
    expect(p.parseErrors).toEqual([]);
    expect(p.modules.map((m) => m.module).sort()).toEqual([
      'acme.graph',
      'acme.graph.client',
      'acme.tools',
      'go-github-com-mono-store',
      'go-github-com-mono-store.store',
      'js-mono-core',
    ]);
  });

  it('checks every language’s docs examples against the package they import', async () => {
    const r = await lintRepo({ dir: MONO.dir, repo: MONO.repo, rules: ['example-too-many-arguments', 'example-missing-argument', 'example-missing-import', 'example-missing-attribute'] });
    expect(r.findings.map((f) => `${f.path}:${f.line} ${f.rule} ${f.message}`)).toEqual([
      'docs/usage.md:6 example-too-many-arguments `connect` takes at most 1 argument; the example passes 2.',
      'docs/usage.md:11 example-missing-import `acme.tools` has no `gone`.',
      'docs/usage.md:13 example-missing-argument `Client.query` requires `q`, which the example does not pass.',
      'docs/usage.md:25 example-too-many-arguments `Get` takes at most 1 argument; the example passes 2.',
    ]);
  });
});
