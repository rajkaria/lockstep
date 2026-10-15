import { describe, expect, it } from 'vitest';
import { buildSymbolTable, parseRepo } from '../src/indexer/index.js';
import { moduleNames } from '../src/indexer/repo.js';
import { FIXTURE_REPOS } from './helpers.js';

async function fixtureTable() {
  const parsed = await Promise.all(FIXTURE_REPOS.map((c) => parseRepo(c)));
  return { parsed, table: buildSymbolTable(parsed) };
}

function edges(calls: { from: string; to: string; resolved: string }[]) {
  return calls.map((c) => `${c.from.split(':')[1]} -> ${c.to} [${c.resolved}]`);
}

describe('moduleNames', () => {
  it('finds package roots, including src layouts and loose modules', () => {
    const names = moduleNames([
      'falkordb/__init__.py',
      'falkordb/asyncio/__init__.py',
      'falkordb/asyncio/graph.py',
      'graphrag_sdk/src/graphrag_sdk/__init__.py',
      'graphrag_sdk/src/graphrag_sdk/core/__init__.py',
      'graphrag_sdk/src/graphrag_sdk/core/connection.py',
      'tools/run-me.py',
    ]);
    expect(Object.fromEntries([...names].map(([k, v]) => [k, v.module]))).toEqual({
      'falkordb/__init__.py': 'falkordb',
      'falkordb/asyncio/__init__.py': 'falkordb.asyncio',
      'falkordb/asyncio/graph.py': 'falkordb.asyncio.graph',
      'graphrag_sdk/src/graphrag_sdk/__init__.py': 'graphrag_sdk',
      'graphrag_sdk/src/graphrag_sdk/core/__init__.py': 'graphrag_sdk.core',
      'graphrag_sdk/src/graphrag_sdk/core/connection.py': 'graphrag_sdk.core.connection',
      'tools/run-me.py': 'tools.run_me',
    });
    expect(names.get('falkordb/asyncio/__init__.py')!.isPackage).toBe(true);
  });
});

describe('SymbolTable', () => {
  it('skips tests and treats example scripts as examples, not library code', async () => {
    const { parsed } = await fixtureTable();
    const sdk = parsed.find((p) => p.checkout.repo === 'acme/mini-sdk')!;
    expect(sdk.files.map((f) => `${f.path}:${f.kind}`)).toEqual([
      'minisdk/examples/quickstart.py:python-example',
      'minisdk/src/minisdk/__init__.py:python',
      'minisdk/src/minisdk/connection.py:python',
      'minisdk/src/minisdk/rag.py:python',
    ]);
  });

  it('resolves dotted names through package re-exports', async () => {
    const { table } = await fixtureTable();
    const v = table.resolveDotted('miniclient.asyncio.AsyncClient');
    expect(v?.t === 'sym' && v.sym.id).toBe('acme/mini-client:miniclient.asyncio.client.AsyncClient');
    const g = table.resolveDotted('miniclient.Graph.query');
    expect(g?.t === 'sym' && g.sym.id).toBe('acme/mini-client:miniclient.graph.Graph.query');
  });

  it('follows attribute types and return annotations across repositories', async () => {
    const { parsed, table } = await fixtureTable();
    const sdk = parsed.find((p) => p.checkout.repo === 'acme/mini-sdk')!;
    const calls = edges(sdk.modules.flatMap((m) => table.resolveModule('acme/mini-sdk', m)));
    expect(calls).toEqual(
      expect.arrayContaining([
        'minisdk.connection.Connection.__init__ -> acme/mini-client:miniclient.asyncio.client.AsyncClient [exact]',
        'minisdk.connection.Connection.__init__ -> acme/mini-client:miniclient.asyncio.client.AsyncClient.__init__ [exact]',
        'minisdk.connection.Connection.__init__ -> acme/mini-client:miniclient.asyncio.client.AsyncClient.select_graph [exact]',
        'minisdk.connection.Connection.run -> acme/mini-client:miniclient.asyncio.client.AsyncGraph.query [exact]',
        'minisdk.rag.Rag.__init__ -> acme/mini-sdk:minisdk.connection.Connection [exact]',
        'minisdk.rag.Rag.ask -> acme/mini-sdk:minisdk.connection.Connection.run [exact]',
        'minisdk.rag.Rag.ingest -> acme/mini-sdk:minisdk.connection.Connection.run [exact]',
      ]),
    );
    expect(calls.every((c) => c.endsWith('[exact]'))).toBe(true);
  });

  it('resolves self-calls through base classes', async () => {
    const { parsed, table } = await fixtureTable();
    const client = parsed.find((p) => p.checkout.repo === 'acme/mini-client')!;
    const calls = edges(client.modules.flatMap((m) => table.resolveModule('acme/mini-client', m)));
    expect(calls).toEqual(
      expect.arrayContaining([
        'miniclient.graph.Graph.ro_query -> acme/mini-client:miniclient.graph.Graph.query [exact]',
        'miniclient.graph.Graph.query -> acme/mini-client:miniclient.graph.Graph._send [exact]',
        'miniclient.asyncio.client.AsyncGraph.query -> acme/mini-client:miniclient.graph.Graph._send [exact]',
        'miniclient.client.Client.select_graph -> acme/mini-client:miniclient.graph.Graph [exact]',
        'miniclient.asyncio.client.AsyncClient.select_graph -> acme/mini-client:miniclient.asyncio.client.AsyncGraph [exact]',
      ]),
    );
  });

  it('falls back to by-name only inside imported repositories, never for generic names', async () => {
    const { table } = await fixtureTable();
    const { extractPython } = await import('../src/indexer/python.js');
    const mod = await extractPython('from miniclient import Client\nx = make()\nx.ro_query("a")\nx.get("k")\n', {
      module: '__doc__.t',
      path: 't.md',
    });
    const calls = mod.calls.flatMap((c) => table.resolveCall('acme/mini-docs', mod, c).map((r) => `${c.text} -> ${r.to} [${r.resolved}]`));
    expect(calls).toEqual(['x.ro_query -> acme/mini-client:miniclient.graph.Graph.ro_query [by-name]']);
  });
});

describe('SymbolTable precision', () => {
  it('prefers an in-org binding over an Any annotation, and never by-names calls on external objects', async () => {
    const { extractPython } = await import('../src/indexer/python.js');
    const { SymbolTable } = await import('../src/indexer/resolve.js');
    const { parsed, table: base } = await fixtureTable();
    const table = new SymbolTable();
    for (const p of parsed) for (const m of p.modules) table.add(p.checkout.repo, m);
    void base;
    const src = [
      'from typing import Any',
      'from redis.asyncio import BlockingConnectionPool',
      'from miniclient import Client',
      'class Conn:',
      '    def __init__(self):',
      '        self._graph: Any | None = None',
      '        self._pool: Any | None = None',
      '    def connect(self):',
      '        self._pool = self._pool or BlockingConnectionPool()',
      '        self._graph = Client().select_graph("g")',
      '    def go(self):',
      '        self._pool.ro_query()',
      '        return self._graph.ro_query("x")',
    ].join('\n');
    const mod = await extractPython(src, { module: 'app.conn', path: 'app/conn.py' });
    table.add('acme/app', mod);
    const calls = table.resolveModule('acme/app', mod).map((c) => `${c.from.split(':')[1]} -> ${c.to.split(':')[1]} [${c.resolved}]`);
    expect(calls).toContain('app.conn.Conn.go -> miniclient.graph.Graph.ro_query [exact]');
    expect(calls.filter((c) => c.includes('[by-name]'))).toEqual([]);
  });
});
