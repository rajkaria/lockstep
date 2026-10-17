import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseRepo } from '../src/indexer/index.js';
import { extractPython } from '../src/indexer/python.js';
import { extractTs } from '../src/indexer/typescript.js';
import { checkDocstrings } from '../src/lint/check-docstrings.js';
import { lintRepo } from '../src/lint/engine.js';
import { closeNames, codeSuppressions, docParams, signatureParams } from '../src/lint/facts-docstrings.js';
import type { LintResult } from '../src/lint/types.js';
import { gitIn } from './helpers.js';

/** A git repository (files added, not committed) with these files. */
async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'staleproof-lint-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'add', '-A');
  return dir;
}

const brief = (r: LintResult) => r.findings.map((f) => `${f.path}:${f.line}:${f.column} ${f.rule} ${f.subject} | ${f.message}`);

const CLIENT_PY = `class Client:
    """A client.

    Args:
        host: Server host.
        prt: Server port.
    """

    def __init__(self, host, port=6379):
        self.host = host

    def query(self, cypher, params=None, timeout=None):
        """Run a query.

        Args:
            cypher (str): The query.
            parameters (dict): Query parameters.
            timeout: Seconds.
        """

    def ro_query(self, cypher, read_only=True):
        """Read-only.

        :param cypher: The query.
        :param str mode: How.
        """

    def explain(self, cypher, **kwargs):
        """Explain.

        Args:
            cypher: The query.
            verbose: Passed to the server.
        """

    def profile(self, cypher, **kwargs):
        """Profile.

        Args:
            cypher: The query.
            limit: Rows.

        Keyword Args:
            verbose: Passed on.
        """

    def call(self, *args):
        """Args:
            name: Packed into args.
        """

    @staticmethod
    def make(url):
        """Make one.

        Parameters
        ----------
        url : str
            Where.
        retries : int
            Gone.
        """

    @retry
    def flaky(self, x):
        """Args:
            y: A decorator may change the signature.
        """

    def quiet(self, a):
        """Args:
            b: Suppressed. staleproof: ignore[docstring-param-unknown]
        """


# staleproof: ignore[docstring-param-unknown]
def hidden(a):
    """Args:
        z: Suppressed by the comment above the def.
    """


def connect(host, port, tls=False, _pool=None):
    """Connect.

    Args:
        host: Host.
        port: Port.
    """


@overload
def parse(x: int) -> int: ...
@overload
def parse(x: str) -> str: ...
def parse(x):
    """Args:
        y: Overloaded: not judged.
    """


def tool(ctx: RunContext[Deps], topic: str, depth: int):  # noqa: C901
    """Args:
        topic: The topic.
        depth: How deep.
    """


def build(  # noqa: C901
    function,
    schema,
):
    """Args:
        function: The function.
        schema: The schema.
        strict: Gone.
    """
`;

const INDEX_TS = `/**
 * Pad a string.
 * @param text The text.
 * @param {number} width The width.
 */
export function pad(text: string, size: number): string {
  return text;
}

/**
 * @param [sep=','] Separator.
 * @param parts.first A property, not a parameter.
 * @param parts The parts.
 */
export const join = (parts: string[], sep = ','): string => parts.join(sep);

/** @param name Taken by the rest parameter. */
export function log(...args: unknown[]): void {}

/** @param opts Names a destructured parameter. */
export function configure({ a, b }: { a: number; b: number }): void {}

/**
 * @param a First.
 */
export function add(a: number, b: number): number {
  return a + b;
}

export class Box {
  /**
   * @param w The width.
   * @param depth Gone.
   */
  resize(w: number, h: number): void {}
}

/**
 * @param controller The controller, marked unused.
 * @param request The request.
 */
export function handle(_controller: unknown, request: string): void {}

/**
 * @param ulid The id, a property of the one object parameter.
 * @param collect Gone.
 */
export function capture(args: { ulid: string; model: string }): void {}

/** @param anything Taken by the bare parameter. */
export function ignore(_: unknown): void {}
`;

describe('docstring facts', () => {
  it('reads Google, NumPy and Sphinx parameter sections, with each name where it is written', () => {
    const g = docParams('Run.\n\n    Args:\n        a (int): One.\n            More about a.\n        b, *rest: Two.\n        **kw: Three.\n\n    Keyword Args:\n        t: Time.\n    Returns:\n        x: not a parameter.\n', 'python');
    expect(g.style).toBe('google');
    expect(g.keywordSection).toBe(true);
    expect(g.params.map((p) => `${p.stars}${p.name}@${p.line}:${p.column}/${p.section}`)).toEqual(['a@3:8/args', 'b@5:8/args', '*rest@5:11/args', '**kw@6:8/args', 't@9:8/keyword']);
    expect(g.header).toEqual({ line: 2, column: 4, text: 'Args' });

    const n = docParams('Do.\n\nParameters\n----------\nx : int\n    The x.\ny, z : float\n\nReturns\n-------\nint\n', 'python');
    expect(n.style).toBe('numpy');
    expect(n.params.map((p) => p.name)).toEqual(['x', 'y', 'z']);

    const s = docParams('Do.\n\n:param x: The x.\n:param dict[str, int] opts: Options.\n:type x: int\n:keyword timeout: Seconds.\n:raises ValueError: never a parameter.\n', 'python');
    expect(s.style).toBe('sphinx');
    expect(s.params.map((p) => `${p.name}/${p.section}@${p.line}:${p.column}`)).toEqual(['x/args@2:7', 'opts/args@3:22', 'timeout/keyword@5:9']);
  });

  it('reads JSDoc and TSDoc @param tags: types, optional names, defaults, properties', () => {
    const j = docParams('/**\n * @param {string} a The a.\n * @param [b] Optional.\n * @param {number} [c=1] - Default.\n * @param opts.d A property.\n * @param e - TSDoc.\n * @returns nothing\n */', 'ts');
    expect(j.style).toBe('jsdoc');
    expect(j.params.map((p) => `${p.name}${p.dotted ? ' (dotted)' : ''}@${p.line}:${p.column}`)).toEqual(['a@1:19', 'b@2:11', 'c@3:20', 'opts.d (dotted)@4:10', 'e@5:10']);
    expect(docParams('/** @param a The a. */', 'ts').params.map((p) => p.name)).toEqual(['a']);
    // A comment that describes the syntax (`@param x` in prose) documents nothing.
    expect(docParams('/** JSDoc/TSDoc: `@param x`, `@param {T} x`. */', 'ts').params).toEqual([]);
    expect(docParams('/**\n * Reads tags like `@param x` from a comment.\n */', 'ts').params).toEqual([]);
  });

  it('reads the parameters a stored signature declares', () => {
    expect(signatureParams('def f(self, a: int = 1, *args: str, b, c=(1, 2), **kw) -> X', 'python')).toEqual({ names: ['self', 'a', 'b', 'c'], varArgs: 'args', varKw: 'kw', destructured: false, types: { a: 'int' } });
    expect(signatureParams('async def g[T](x: T, /, *, y: dict[str, int] = {"a": 1})', 'python')).toMatchObject({ names: ['x', 'y'], destructured: false, types: { x: 'T', y: 'dict[str, int]' } });
    expect(signatureParams('def h(  # noqa: C901\n    ctx: RunContext[Deps],  # injected\n    topic: str,\n)', 'python')).toMatchObject({ names: ['ctx', 'topic'], types: { ctx: 'RunContext[Deps]' } });
    expect(signatureParams('function f<T extends Record<string, unknown>>(a: T, cb: (x: number) => void, sep = ", ")', 'ts')).toMatchObject({ names: ['a', 'cb', 'sep'], destructured: false });
    expect(signatureParams('async query(this: Db, @Inject() private readonly q: string, { a }: O, ...rest: X[])', 'ts')).toMatchObject({ names: ['q'], varArgs: 'rest', destructured: true });
    expect(signatureParams('x =>', 'ts')).toEqual({ names: ['x'], destructured: false });
    expect(signatureParams('function cut(a: string, b: Rec', 'ts')).toBeUndefined();
    expect(signatureParams('function f(a: string, // the a b: number)', 'ts')).toBeUndefined();
  });

  it('reads staleproof: ignore[rule] comments in code, for the same line or the next', () => {
    const s = codeSuppressions('x = 1  # staleproof: ignore[env-unused]\n// staleproof: ignore\n\nnext()\n    b: doc line staleproof: ignore[docstring-param-unknown, symbol-missing]\n');
    expect([...s.lines].map(([l, r]) => [l, [...r]])).toEqual([
      [1, ['env-unused']],
      [2, ['*']],
      [4, ['*']],
      [5, ['docstring-param-unknown', 'symbol-missing']],
    ]);
    expect(codeSuppressions('# staleproof: ignore-file\n').file).toBe(true);
  });

  it('suggests close names first', () => {
    expect(closeNames('parameters', ['params', 'timeout', 'cypher'])).toEqual(['params']);
    expect(closeNames('width', ['text', 'size'])).toEqual([]);
  });

  it('keeps the whole docstring and the JSDoc comment on the definitions, with their lines', async () => {
    const py = await extractPython('def f(a):\n    r"""Doc.\n\n    Args:\n        a: A.\n    """\n', { module: 'm', path: 'm.py' });
    expect(py.defs[1]).toMatchObject({ doc: 'Doc.', docLine: 2, docText: 'Doc.\n\n    Args:\n        a: A.\n    ' });
    const ts = await extractTs('/** File. */\nimport x from "y";\n\n/**\n * @param a A.\n */\nexport const f = (a: number) => a;\nclass C {\n  /** M. */\n  @dec()\n  m(b: string) {}\n}\n', { module: 'js-m', path: 'm.ts' });
    expect(ts.defs.filter((d) => d.docText).map((d) => [d.name, d.docLine, d.docText])).toEqual([
      ['f', 4, '/**\n * @param a A.\n */'],
      ['m', 9, '/** M. */'],
    ]);
  });
});

describe('docstring-param-unknown and docstring-param-undocumented', () => {
  let result: LintResult;
  let dirOf = '';

  beforeAll(async () => {
    const dir = await repoWith({
      'pkg/__init__.py': '',
      'pkg/client.py': CLIENT_PY,
      'fmt/package.json': JSON.stringify({ name: 'fmt-demo', main: 'src/index.ts' }),
      'fmt/src/index.ts': INDEX_TS,
    });
    dirOf = dir;
    result = await lintRepo({ dir, repo: 'acme/docstrings', rules: ['docstring-param-unknown', 'docstring-param-undocumented'] });
  });

  it('reports documented parameters the signature lacks, and parameters left out, on the docstring line', () => {
    expect(brief(result)).toEqual([
      'fmt/src/index.ts:4:20 docstring-param-unknown pad(width) | `pad` has no parameter `width` (parameters: text, size).',
      'fmt/src/index.ts:24:11 docstring-param-undocumented add(b) | `add` documents a but not `b`.',
      'fmt/src/index.ts:33:13 docstring-param-unknown Box.resize(depth) | `Box.resize` has no parameter `depth` (parameters: w, h).',
      'fmt/src/index.ts:46:11 docstring-param-unknown capture(collect) | `capture` has no parameter `collect` (parameters: args).',
      'pkg/client.py:6:9 docstring-param-unknown Client(prt) | `Client` has no parameter `prt` (parameters: host, port).',
      'pkg/client.py:17:13 docstring-param-unknown Client.query(parameters) | `Client.query` has no parameter `parameters` (parameters: cypher, params, timeout).',
      'pkg/client.py:25:20 docstring-param-unknown Client.ro_query(mode) | `Client.ro_query` has no parameter `mode` (parameters: cypher, read_only).',
      'pkg/client.py:41:13 docstring-param-unknown Client.profile(limit) | `Client.profile` has no parameter `limit` (parameters: cypher, **kwargs).',
      'pkg/client.py:60:9 docstring-param-unknown Client.make(retries) | `Client.make` has no parameter `retries` (parameters: url).',
      'pkg/client.py:87:9 docstring-param-undocumented connect(tls) | `connect` documents host, port but not `tls`.',
      'pkg/client.py:116:9 docstring-param-unknown build(strict) | `build` has no parameter `strict` (parameters: function, schema).',
    ]);
    expect(new Set(result.findings.map((f) => f.surface))).toEqual(new Set(['docstring']));
  });

  it('names the likely rename as a fix candidate, and does not also report it undocumented', async () => {
    const parsed = await parseRepo({ repo: 'acme/docstrings', dir: dirOf, sha: 'worktree' });
    const raw = await checkDocstrings(parsed, (p) => readFile(join(dirOf, p), 'utf8'));
    const cands = Object.fromEntries(raw.filter((x) => x.f.rule === 'docstring-param-unknown').map((x) => [x.f.subject, x.f.candidates ?? []]));
    expect(cands).toMatchObject({ 'Client.query(parameters)': ['params'], 'pad(width)': ['size'], 'Client(prt)': ['port'], 'Box.resize(depth)': ['h'] });
    expect(result.findings.some((f) => f.subject === 'Client.query(params)' || f.subject === 'pad(size)' || f.subject === 'Client(port)')).toBe(false);
  });

  it('locates each finding on the name as written', async () => {
    for (const f of result.findings.filter((x) => x.rule === 'docstring-param-unknown')) {
      const line = (await readFile(join(dirOf, f.path), 'utf8')).split('\n')[f.line - 1]!;
      expect(line.slice(f.column - 1, f.endColumn - 1)).toBe(f.subject.replace(/^.*\(|\)$/g, ''));
    }
  });

  it('skips **kwargs without a keyword section, *args and ...rest, destructuring, properties, decorators, overloads, unused-marked and injected parameters, and suppressed lines', () => {
    const subjects = result.findings.map((f) => f.subject);
    for (const s of ['handle(controller)', 'capture(ulid)', 'ignore(anything)', 'tool(ctx)', 'tool(topic)', 'Client.explain(verbose)', 'Client.profile(verbose)', 'Client.call(name)', 'Client.flaky(y)', 'Client.quiet(b)', 'hidden(z)', 'parse(y)', 'log(name)', 'configure(opts)', 'join(first)', 'join(parts.first)', 'connect(_pool)']) {
      expect(subjects).not.toContain(s);
    }
  });
});
