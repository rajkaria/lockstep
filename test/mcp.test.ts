import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import type { OrgGraph } from '../src/graph/client.js';
import { indexOrg } from '../src/indexer/index.js';
import { recordPullRequest } from '../src/pr/ingest.js';
import { fakePr, FIXTURE_REPOS, testGraph } from './helpers.js';

const PR = fakePr({ number: 21, url: 'https://github.com/acme/mini-client/pull/21' });

describe('MCP server (stdio, FalkorDB)', () => {
  let graph: OrgGraph;
  let done: () => Promise<void>;
  let client: Client;

  beforeAll(async () => {
    ({ graph, done } = await testGraph('mcp'));
    await indexOrg(graph, FIXTURE_REPOS);
    await recordPullRequest(graph, PR, {
      before: 'b', after: 'a', files: [], docsTouched: [],
      symbols: [{ repo: 'acme/mini-client', qualname: 'miniclient.graph.Graph.ro_query', name: 'ro_query', kind: 'method', change: 'renamed', renamedTo: 'miniclient.graph.Graph.read_query', before: 'def ro_query(self, q: str)', after: 'def read_query(self, q: str)', path: 'miniclient/graph.py', lineno: 13, endLineno: 15 }],
    });
    const root = join(import.meta.dirname, '..');
    const transport = new StdioClientTransport({
      command: join(root, 'node_modules', '.bin', 'tsx'),
      args: [join(root, 'src', 'cli.ts'), 'mcp'],
      env: { ...(process.env as Record<string, string>), FALKORDB_URL: inject('falkordbUrl'), LOCKSTEP_ORG: graph.name },
      stderr: 'pipe',
    });
    client = new Client({ name: 'lockstep-test', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await done();
  });

  it('lists every tool with a JSON schema and its Cypher in the description', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'impact', 'clearance', 'read_section', 'run_example', 'decisions_for', 'rank_sections', 'propose_edit', 'record_verdict', 'write_decision', 'docs_patch',
    ]);
    const impact = tools.find((t) => t.name === 'impact')!;
    expect(impact.description).toContain('Cypher (impact):');
    expect(impact.description).toContain('[:CALLS*0..3]');
    expect(impact.inputSchema).toMatchObject({ type: 'object', required: ['pr_url'] });
  });

  it('answers impact and clearance over MCP with the Cypher it ran', async () => {
    const r = await client.callTool({ name: 'impact', arguments: { pr_url: PR.url } });
    const texts = (r.content as { type: string; text: string }[]).map((c) => c.text);
    expect(texts[0]).toMatch(/^1 changed symbols reach 1 doc sections \(1 breaking/);
    expect(JSON.parse(texts[1]!).sections[0].section).toBe('acme/mini-docs:docs/getting-started.mdx#read-only-queries');
    expect(texts[2]).toContain('Cypher run on FalkorDB:');
    const c = await client.callTool({ name: 'clearance', arguments: { pr_url: PR.url } });
    expect((c.content as { text: string }[])[0]!.text).toBe('Every changed symbol reaches at least one doc; nothing is cleared.');
  });

  it('rejects invalid input with an error result, not a crash', async () => {
    const r = await client.callTool({ name: 'impact', arguments: {} });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^invalid input: pr_url/);
  });
});
