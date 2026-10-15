import { describe, expect, it } from 'vitest';
import { exprText, extractPython } from '../src/indexer/python.js';

const SRC = `
"""Module doc."""
import os
import a.b.c
import numpy as np
from .graph import Graph
from ..core import thing as other
from pkg.sub import *

TIMEOUT: int = 5

@dataclass
class Client(Base, metaclass=Meta):
    """Talks to the server."""

    def __init__(this, host: str = "localhost", port: int = 6379):
        this.host = host
        this._graph = this.select_graph("x")

    @property
    def name(self) -> str:
        return self.host

    def select_graph(self, name: str) -> Graph:
        return Graph(self, name)

    @staticmethod
    def helper(x):
        return np.array(x)

    async def run(self, q):
        async with Session(self.host) as s:
            return await s.execute(q).fetch()

def top(conn: "Client") -> None:
    def inner():
        return conn.select_graph("y").query("RETURN 1")
    inner()
`;

describe('extractPython', () => {
  it('extracts module, classes, methods, nested functions with qualnames', async () => {
    const m = await extractPython(SRC, { module: 'pkg.client', path: 'pkg/client.py' });
    const byQ = Object.fromEntries(m.defs.map((d) => [d.qualname, d]));
    expect(Object.keys(byQ)).toEqual([
      'pkg.client',
      'pkg.client.Client',
      'pkg.client.Client.__init__',
      'pkg.client.Client.name',
      'pkg.client.Client.select_graph',
      'pkg.client.Client.helper',
      'pkg.client.Client.run',
      'pkg.client.top',
      'pkg.client.top.inner',
    ]);
    expect(byQ['pkg.client']!.doc).toBe('Module doc.');
    expect(byQ['pkg.client.Client']!.kind).toBe('class');
    expect(byQ['pkg.client.Client']!.bases).toEqual(['Base']);
    expect(byQ['pkg.client.Client']!.decorators).toEqual(['dataclass']);
    expect(byQ['pkg.client.Client']!.doc).toBe('Talks to the server.');
    expect(byQ['pkg.client.Client.select_graph']!.kind).toBe('method');
    expect(byQ['pkg.client.Client.select_graph']!.signature).toBe('def select_graph(self, name: str) -> Graph');
    expect(byQ['pkg.client.Client.select_graph']!.returns).toBe('Graph');
    expect(byQ['pkg.client.Client.name']!.decorators).toEqual(['property']);
    expect(byQ['pkg.client.Client.run']!.isAsync).toBe(true);
    expect(byQ['pkg.client.Client.run']!.signature).toBe('async def run(self, q)');
    expect(byQ['pkg.client.top']!.kind).toBe('function');
    expect(byQ['pkg.client.top.inner']!.parent).toBe('pkg.client.top');
    expect(byQ['pkg.client.Client.__init__']!.params.map((p) => p.name)).toEqual(['this', 'host', 'port']);
  });

  it('resolves import aliases, including relative imports and wildcards', async () => {
    const m = await extractPython(SRC, { module: 'pkg.client', path: 'pkg/client.py' });
    const imports = Object.fromEntries(m.imports.map((i) => [i.alias, i.target]));
    expect(imports).toMatchObject({
      os: 'os',
      a: 'a',
      'a.b.c': 'a.b.c',
      np: 'numpy',
      Graph: 'pkg.graph.Graph',
      other: 'core.thing',
      '*': 'pkg.sub',
    });
  });

  it('treats __init__.py relative imports as relative to the package itself', async () => {
    const m = await extractPython('from .falkordb import FalkorDB as FalkorDB\n', {
      module: 'falkordb.asyncio',
      path: 'falkordb/asyncio/__init__.py',
      isPackage: true,
    });
    expect(m.imports).toEqual([{ alias: 'FalkorDB', target: 'falkordb.asyncio.falkordb.FalkorDB', lineno: 1 }]);
  });

  it('records calls with canonical self, bindings for self attributes, params and with-aliases', async () => {
    const m = await extractPython(SRC, { module: 'pkg.client', path: 'pkg/client.py' });
    const calls = m.calls.map((c) => `${c.scope.replace('pkg.client.', '')}: ${exprText(c.fn)}`);
    expect(calls).toContain('Client.__init__: self.select_graph');
    expect(calls).toContain('Client.select_graph: Graph');
    expect(calls).toContain('Client.helper: np.array');
    expect(calls).toContain('Client.run: s.execute().fetch');
    expect(calls).toContain('top.inner: conn.select_graph().query');
    expect(calls).toContain('top: inner');
    const b = m.bindings.map((x) => `${x.scope.replace('pkg.client.', '')}|${x.at.replace('pkg.client.', '')}|${x.target}`);
    expect(b).toContain('Client|Client.__init__|self.host');
    expect(b).toContain('Client|Client.__init__|self._graph');
    expect(b).toContain('Client.run|Client.run|s');
    expect(b).toContain('top|top|conn');
    expect(b).toContain('pkg.client|pkg.client|TIMEOUT');
    const conn = m.bindings.find((x) => x.target === 'conn')!;
    expect(conn.annotation).toBe('"Client"');
  });

  it('collects identifiers and survives syntax errors (docs fragments)', async () => {
    const m = await extractPython('db = FalkorDB(\ng.query("x")\nresult = g.ro_query(', { module: '__doc__.x', path: 'x.md' });
    expect(m.idents).toEqual(expect.arrayContaining(['FalkorDB', 'g', 'query']));
  });
});
