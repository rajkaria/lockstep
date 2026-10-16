import { describe, expect, it } from 'vitest';
import { arityOfSignature, extractPython } from '../src/indexer/python.js';
import { SymbolTable } from '../src/indexer/resolve.js';
import { checkArgs, trustsSignature } from '../src/indexer/signature.js';

const LIB: Record<string, string> = {
  'acme/__init__.py': `
from .client import Client as Client
from .graph import Graph
__version__ = "1.2.0"
`,
  'acme/client.py': `
from .graph import Graph

class Client:
    DEFAULT_PORT = 6379
    timeout: float

    def __init__(self, host: str = "localhost", port: int = 6379, *, ssl: bool = False):
        self.host = host
        self.pool = None

    def select_graph(self, name: str) -> Graph:
        return Graph(self, name)

    @classmethod
    def from_url(cls, url: str, **kwargs) -> "Client":
        return cls()

    @staticmethod
    def parse(url):
        return url

    @retry(3)
    def ping(self):
        return True

    @property
    def info(self):
        return {}
`,
  'acme/graph.py': `
class Graph:
    def __init__(self, client, name):
        self.client = client
        self.name = name

    def query(self, q: str, params=None, *, timeout: int | None = None):
        return []

    def explain(self, q, /, *args):
        return []

class Dynamic:
    def __getattr__(self, name):
        return name

class FromRedis(Redis):
    def own(self):
        return 1
`,
  'acme/lazy.py': `
def __getattr__(name):
    return name
`,
};

const MODULES: Record<string, string> = {
  'acme/__init__.py': 'acme',
  'acme/client.py': 'acme.client',
  'acme/graph.py': 'acme.graph',
  'acme/lazy.py': 'acme.lazy',
};

async function table(): Promise<SymbolTable> {
  const t = new SymbolTable();
  for (const [path, src] of Object.entries(LIB)) {
    const module = MODULES[path]!;
    t.add('acme/lib', await extractPython(src, { module, path, isPackage: path.endsWith('__init__.py') }));
  }
  return t;
}

async function check(code: string) {
  const t = await table();
  const mod = await extractPython(code, { module: '__docs__.page', path: 'docs/page.md' });
  const dispose = t.addEphemeral('acme/docs', mod);
  try {
    return t.checkModule('acme/docs', mod).map((m) => `${m.line} ${m.kind}: ${m.detail}`);
  } finally {
    dispose();
  }
}

describe('checkArgs', () => {
  const arity = { params: [{ name: 'self', kind: 'pos' as const, required: true }, { name: 'q', kind: 'pos' as const, required: true }, { name: 'timeout', kind: 'kw-only' as const, required: false }], varArgs: false, varKw: false };

  it('accepts a call that fits', () => {
    expect(checkArgs({ positional: 1, keywords: ['timeout'], starArgs: false, starKwargs: false }, arity, { dropFirst: true, callee: 'f' })).toEqual([]);
  });

  it('flags unknown keywords, extra positionals and missing arguments', () => {
    const r = checkArgs({ positional: 3, keywords: ['tmeout'], starArgs: false, starKwargs: false }, arity, { dropFirst: true, callee: 'f' });
    expect(r.map((m) => m.kind)).toEqual(['unknown-keyword', 'too-many-arguments']);
    const missing = checkArgs({ positional: 0, keywords: [], starArgs: false, starKwargs: false }, arity, { dropFirst: true, callee: 'f' });
    expect(missing).toEqual([{ kind: 'missing-argument', detail: '`f` requires `q`, which the example does not pass' }]);
  });

  it('gives up on counts when the call splats', () => {
    expect(checkArgs({ positional: 9, keywords: [], starArgs: true, starKwargs: true }, arity, { dropFirst: true, callee: 'f' })).toEqual([]);
  });

  it('trusts only signature-preserving decorators', () => {
    expect(trustsSignature(['staticmethod'])).toBe(true);
    expect(trustsSignature(['functools.lru_cache(maxsize=4)'])).toBe(true);
    expect(trustsSignature(['click.command()'])).toBe(false);
  });
});

describe('arityOfSignature', () => {
  it('reads kinds, defaults and splats from a stored signature', async () => {
    const a = await arityOfSignature('async def query(self, q, /, params=None, *args, timeout: int = 0, retries, **kw) -> Result');
    expect(a).toEqual({
      params: [
        { name: 'self', kind: 'pos-only', required: true },
        { name: 'q', kind: 'pos-only', required: true },
        { name: 'params', kind: 'pos', required: false },
        { name: 'timeout', kind: 'kw-only', required: false },
        { name: 'retries', kind: 'kw-only', required: true },
      ],
      varArgs: true,
      varKw: true,
    });
    expect(await arityOfSignature('class Graph(Base)')).toBeUndefined();
  });
});

describe('SymbolTable.checkModule', () => {
  it('passes an example that matches the code', async () => {
    expect(
      await check(`
import acme
from acme import Client, __version__
db = Client("localhost", 6379, ssl=True)
g = db.select_graph("social")
g.query("MATCH (n) RETURN n", timeout=5)
g.explain("MATCH (n) RETURN n", 1, 2)
Client.from_url("redis://x", decode=True)
Client.parse("x")
print(db.DEFAULT_PORT, db.timeout, db.host)
acme.Client(port=1)
`),
    ).toEqual([]);
  });

  it('flags keywords, counts, missing names and missing attributes', async () => {
    expect(
      await check(`
from acme import Client, Gone
from acme.graph import Graph, Vanished
import acme.nowhere
db = Client(prot=6379)
g = db.select_graph()
g.query("q", {}, 3)
g.ro_query("q")
db.select_graph("a").query(q="x")
Client.from_url()
acme.connect()
`),
    ).toEqual([
      '2 missing-import: `acme` has no `Gone`',
      '3 missing-import: `acme.graph` has no `Vanished`',
      '4 missing-import: `acme` has no `nowhere`',
      '5 unknown-keyword: `Client` has no parameter `prot`',
      '6 missing-argument: `Client.select_graph` requires `name`, which the example does not pass',
      '7 too-many-arguments: `Graph.query` takes at most 2 positional arguments; the example passes 3',
      '8 missing-attribute: `Graph` has no attribute `ro_query`',
      '10 missing-argument: `Client.from_url` requires `url`, which the example does not pass',
      '11 missing-attribute: `acme` has no `connect`',
    ]);
  });

  it('stays quiet where the code could accept the call dynamically', async () => {
    expect(
      await check(`
from acme.graph import Dynamic, FromRedis
from acme.lazy import anything
from acme.client import Client
Dynamic().whatever()
FromRedis().ping(1, 2, 3)
FromRedis(host="x")
Client().ping(1, 2)
print(Client().info)
args = []
Client(*args)
redis.Redis().nothing()
`),
    ).toEqual([]);
  });

  it('checks only lines from the given start (fragments on one page)', async () => {
    const t = await table();
    const mod = await extractPython('from acme import Gone\nfrom acme import Client\nClient(prot=1)\n', { module: '__docs__.p', path: 'p.md' });
    const dispose = t.addEphemeral('acme/docs', mod);
    try {
      expect(t.checkModule('acme/docs', mod, 3).map((m) => m.kind)).toEqual(['unknown-keyword']);
    } finally {
      dispose();
    }
  });
});
