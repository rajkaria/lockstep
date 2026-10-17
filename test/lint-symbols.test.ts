import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSymbolTable, parseRepo } from '../src/indexer/index.js';
import { lintRepo } from '../src/lint/engine.js';
import type { LintResult } from '../src/lint/types.js';
import { gitIn } from './helpers.js';

/** A git repository (files added, not committed) with these files. */
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-symbols-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  return dir;
}

const brief = (r: LintResult) => r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.subject} | ${f.message}`);

const FILES: Record<string, string> = {
  'pkg/__init__.py': 'from .client import Client\nfrom . import util\n\n\ndef connect(host):\n    return Client(host)\n',
  'pkg/client.py': `class Client:
    """A client."""

    retries = 3

    def __init__(self, host):
        self.host = host

    def query(self, q):
        return q

    @property
    def name(self):
        return self.host

    class Options:
        def merged(self):
            return {}


class Dynamic:
    def __getattr__(self, name):
        return name


class Model(BaseModel):
    pass


class Flexible:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)
`,
  'pkg/util.py': 'def helper():\n    pass\n',
  'pkg/lazy/__init__.py': 'def __getattr__(name):\n    return name\n',
  'pkg/_native.pyi': 'def fast() -> None: ...\n',
  'pkg/twice_a.py': 'class Graph:\n    pass\n',
  'pkg/twice_b.py': 'class Graph:\n    pass\n',
  'pkg/session.py': 'class Session:\n    pass\n',
  'pkg/compat.py': 'from requests import Session\n',
  'pkg/hub.py': 'class Hub:\n    def __init__(self, resolve_headers=None):\n        self._resolve = resolve_headers\n',
  'mcp/__init__.py': 'from .server import Server\n',
  'mcp/server.py': 'class Server:\n    def run(self):\n        pass\n\n    def add_tool(self, fn):\n        pass\n',
  'docs/server.md': '# Server\n\n```python\nfrom mcp import Server\nmcp = Server()\n```\n\nThen `mcp.run()`, `mcp.add_tool()` and `mcp.add_prompt()`. `Hub.resolve_headers` is an option. `pkg.query()` is a method of a class.\n',
  'lib/package.json': JSON.stringify({ name: 'lib-demo', main: 'src/index.ts' }),
  'lib/src/index.ts': `export class Queue {
  size = 0;
  static create(): Queue {
    return new Queue();
  }
  push(x: number): void {}
  get length(): number {
    return this.size;
  }
}

export class Merged {}
export interface Merged {
  extra(): void;
}
`,
  'docs/api.md': `# API

- \`Client.query()\` runs a query; \`Client.query_v2()\` does not exist.
- \`pkg.client.Client.explain\` is missing too.
- \`pkg.connect()\` works; \`pkg.connect_async()\` does not.
- \`pkg.util.helper()\` exists and \`pkg.util.helpr()\` does not.
- \`Client.retries\`, \`Client.host\`, \`Client.name\` and \`Client.Options.merged()\` exist; \`Client.Options.gone()\` does not.
- \`db.query_v3()\` is an instance variable; \`json.dumps()\` is another package.
- \`Dynamic.anything\`, \`Model.anything\`, \`Flexible.anything\` and \`pkg.lazy.anything\` may exist.
- \`Graph.anything\`: two classes are named Graph. \`Session.mount()\`: the name is also an import.
- \`pkg._native\` is a stub module; \`Client.__init__\` is special.
- \`Queue.create()\`, \`Queue.push()\`, \`Queue.size\`, \`Queue.length\` exist; \`Queue.pop()\` does not. \`Merged.extra()\` is declared.
- \`Client.query_v2\` was renamed to \`Client.query\`.
- Edit \`setup.py\` and \`config.toml\`.
`,
  'docs/migration.md': '# Migration\n\n`Client.query_v2()` became `Client.query()`.\n',
  'docs/ref.rst': 'Reference\n=========\n\nCall :meth:`Client.querry` or :meth:`~pkg.client.Client.query`; :class:`pkg.Client` is the class.\n\n.. code-block:: python\n\n   Client.not_judged_in_code()\n',
};

describe('symbol-missing', () => {
  let dir: string;
  let result: LintResult;

  beforeAll(async () => {
    dir = await repoWith(FILES);
    result = await lintRepo({ dir, repo: 'acme/symbols', rules: ['symbol-missing'] });
  });

  it('reports members missing from a class or module the span names exactly', () => {
    expect(brief(result)).toEqual([
      'docs/api.md:3:35 symbol-missing Client.query_v2 | `Client` has no member `query_v2`.',
      'docs/api.md:4:4 symbol-missing pkg.client.Client.explain | `pkg.client.Client` has no member `explain`.',
      'docs/api.md:5:27 symbol-missing pkg.connect_async | `pkg` has no `connect_async`.',
      'docs/api.md:6:35 symbol-missing pkg.util.helpr | `pkg.util` has no `helpr`.',
      'docs/api.md:7:88 symbol-missing Client.Options.gone | `Client.Options` has no member `gone`.',
      'docs/api.md:12:74 symbol-missing Queue.pop | `Queue` has no member `pop`.',
      'docs/ref.rst:4:13 symbol-missing Client.querry | `Client` has no member `querry`.',
    ]);
  });

  it('locates every finding on the name as written', async () => {
    for (const f of result.findings) {
      const line = (await readFile(join(dir, f.path), 'utf8')).split('\n')[f.line - 1]!;
      expect(line.slice(f.column - 1, f.endColumn - 1)).toBe(f.subject);
    }
  });

  it('offers the members that do exist as close names', async () => {
    const parsed = await parseRepo({ repo: 'acme/symbols', dir, sha: 'worktree' });
    const table = buildSymbolTable([parsed]);
    expect(table.memberMissing('pkg.client.Client', 'query_v2')).toMatchObject({ kind: 'class', members: ['Options', '__init__', 'host', 'name', 'query', 'retries'] });
    expect(table.memberMissing('pkg', 'connect_async')?.members).toEqual(['Client', 'client', 'compat', 'connect', 'hub', 'lazy', 'session', 'twice_a', 'twice_b', 'util']);
    expect(table.memberMissing('pkg.client.Client', 'query')).toBeUndefined();
    expect(table.memberMissing('pkg.client.Dynamic', 'x')).toBeUndefined();
    expect(table.memberMissing('pkg.client.Model', 'x')).toBeUndefined();
  });

  it('never judges prose instances (a package name bound as a variable in the docs), other packages, ambiguous or open owners, options the owner names, history pages and lines, code blocks or file names', () => {
    const subjects = result.findings.map((f) => f.subject);
    for (const s of ['mcp.run', 'mcp.add_tool', 'mcp.add_prompt', 'Hub.resolve_headers', 'pkg.query', 'db.query_v3', 'json.dumps', 'Dynamic.anything', 'Model.anything', 'Flexible.anything', 'pkg.lazy.anything', 'Graph.anything', 'Session.mount', 'pkg._native', 'Client.__init__', 'Merged.extra', 'setup.py', 'config.toml', 'Client.not_judged_in_code']) {
      expect(subjects).not.toContain(s);
    }
    expect(result.findings.filter((f) => f.path === 'docs/migration.md')).toEqual([]);
    expect(result.findings.filter((f) => f.line === 13 && f.path === 'docs/api.md')).toEqual([]);
  });
});
