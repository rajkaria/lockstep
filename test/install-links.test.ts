import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpLinks, newWorkflowUrl, repoFromInput, workflowYaml } from '../web/src/install-links.js';
import { parseRoute } from '../web/src/route.js';

describe('install page links', () => {
  it('reads a repository from what people paste', () => {
    expect(repoFromInput('encode/httpx')).toBe('encode/httpx');
    expect(repoFromInput('https://github.com/encode/httpx')).toBe('encode/httpx');
    expect(repoFromInput('github.com/encode/httpx.git')).toBe('encode/httpx');
    expect(repoFromInput('https://github.com/encode/httpx/pull/3571')).toBe('encode/httpx');
    expect(repoFromInput('  pallets/click/  ')).toBe('pallets/click');
    expect(repoFromInput('httpx')).toBeUndefined();
    expect(repoFromInput('')).toBeUndefined();
  });

  it('writes the same zero-config workflow as examples/, and adds only the options chosen', async () => {
    const plain = workflowYaml({ withRepos: [], agent: false, failOnBreaks: false });
    const example = await readFile(join(import.meta.dirname, '..', 'examples', 'staleproof.yml'), 'utf8');
    const body = (y: string) => y.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(body(plain)).toEqual(body(example));
    expect(plain).not.toContain('with:');

    const all = workflowYaml({ withRepos: ['acme/docs', 'acme/sdk'], agent: true, failOnBreaks: true });
    expect(all).toContain('      - uses: rajkaria/staleproof@v1\n        with:\n          also-index: acme/docs acme/sdk\n');
    expect(all).toContain('          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}\n');
    expect(all).toContain('          fail-on: breaks\n');
    // Every input the page can write is one the action declares.
    const action = await readFile(join(import.meta.dirname, '..', 'action.yml'), 'utf8');
    for (const input of ['also-index', 'anthropic-api-key', 'fail-on']) expect(action).toContain(`\n  ${input}:`);
  });

  it("opens GitHub's new-file page with the workflow filled in", () => {
    const yaml = workflowYaml({ withRepos: [], agent: false, failOnBreaks: false });
    const url = new URL(newWorkflowUrl('encode/httpx', 'master', yaml));
    expect(url.origin + url.pathname).toBe('https://github.com/encode/httpx/new/master');
    expect(url.searchParams.get('filename')).toBe('.github/workflows/staleproof.yml');
    expect(url.searchParams.get('value')).toBe(yaml);
  });

  it('builds the MCP install links for the server the page came from', () => {
    const links = mcpLinks('https://staleproof.dev/api/mcp');
    const cursor = new URL(links.cursor);
    expect(cursor.protocol).toBe('cursor:');
    expect(cursor.searchParams.get('name')).toBe('staleproof');
    expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({ url: 'https://staleproof.dev/api/mcp' });
    expect(JSON.parse(decodeURIComponent(links.vscode.replace('vscode:mcp/install?', '')))).toEqual({ name: 'staleproof', type: 'http', url: 'https://staleproof.dev/api/mcp' });
    expect(links.claudeCode).toBe('claude mcp add --transport http staleproof https://staleproof.dev/api/mcp');
    expect(JSON.parse(links.json)).toEqual({ mcpServers: { staleproof: { url: 'https://staleproof.dev/api/mcp' } } });
  });
});

describe('routes', () => {
  it('parses the install page and check deep links', () => {
    expect(parseRoute('#/install')).toEqual({ page: 'install', repo: undefined });
    expect(parseRoute('#/install?repo=encode%2Fhttpx')).toEqual({ page: 'install', repo: 'encode/httpx' });
    expect(parseRoute(`#/try?pr=${encodeURIComponent('https://github.com/a/b/pull/1')}`)).toEqual({ page: 'home', section: 'try', pr: 'https://github.com/a/b/pull/1' });
    expect(parseRoute('#/try')).toEqual({ page: 'home', section: 'try' });
    expect(parseRoute('#/check/chk-1')).toEqual({ page: 'check', id: 'chk-1' });
    expect(parseRoute('#/docs/mcp/hosted')).toEqual({ page: 'docs', slug: 'mcp', anchor: 'hosted' });
    expect(parseRoute('#/nowhere')).toEqual({ page: 'home' });
  });
});
