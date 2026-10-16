import { describe, expect, it } from 'vitest';
import { errorLine, extractTraceback, isFragmentFailure, prepareExample, skipReason } from '../src/runner/prepare.js';
import type { RunRecord } from '../src/runner/index.js';
import { verdictOf } from '../src/tools/run-example.js';

describe('skipReason', () => {
  it('skips what cannot be run honestly, and nothing else', () => {
    expect(skipReason('redis-cli PING', 'bash')).toBe('not Python (bash)');
    expect(skipReason('llm=LiteLLM(model="openai/gpt-4o")', 'python')).toMatch(/^needs an LLM provider/);
    expect(skipReason('os.environ["OPENAI_API_KEY"]', 'python')).toMatch(/^needs an LLM provider/);
    expect(skipReason('await rag.ingest("my_document.pdf")', 'python')).toBe('reads a local file the docs do not provide (my_document.pdf)');
    expect(skipReason('db = FalkorDB(host="<your-host>")', 'python')).toMatch(/placeholders/);
    expect(skipReason('from falkordb import FalkorDB\ndb = FalkorDB()\n', 'python')).toBeUndefined();
  });
});

describe('prepareExample', () => {
  const setup = { id: 'p:0', lang: 'python', code: 'from x import C\ng = C()' };
  it('stitches a fragment onto the runnable examples above it', () => {
    const p = prepareExample({ id: 'p:2', lang: 'python', code: 'g.run()' }, [setup, { id: 'p:1', lang: 'bash', code: 'pip install x' }]);
    expect(p.stitched).toEqual(['p:0']);
    expect(p.code).toContain('# --- stitched from p:0\nfrom x import C');
    expect(p.code.endsWith('# --- p:2\ng.run()')).toBe(true);
  });
  it('runs self-contained examples as written and turns REPL transcripts into code', () => {
    expect(prepareExample(setup, []).stitched).toEqual([]);
    expect(prepareExample({ id: 'p:3', lang: 'python', code: '>>> import x\n>>> x.f()\n42' }, []).code).toBe('import x\nx.f()');
  });
});

describe('tracebacks', () => {
  const stderr = 'noise\nTraceback (most recent call last):\n  File "example.py", line 3, in <module>\nAttributeError: \'Graph\' object has no attribute \'ro_query\'\n';
  it('extracts the last traceback and its error line', () => {
    expect(errorLine(extractTraceback(stderr))).toBe("AttributeError: 'Graph' object has no attribute 'ro_query'");
  });
  it('tells a fragment (NameError on a name nothing defines) from a real failure', () => {
    expect(isFragmentFailure('g.query("x")', "Traceback...\nNameError: name 'g' is not defined")).toBe(true);
    expect(isFragmentFailure('g = make()\ng.query("x")', "Traceback...\nNameError: name 'g' is not defined")).toBe(false);
  });
});

describe('verdictOf', () => {
  const run = (side: RunRecord['side'], status: RunRecord['status'], error?: string) =>
    ({ side, status, error }) as RunRecord;
  it('derives the differential verdict', () => {
    expect(verdictOf([run('before', 'pass'), run('after', 'fail', 'E')])).toBe('breaks');
    expect(verdictOf([run('before', 'fail', 'E'), run('after', 'pass')])).toBe('fixes');
    expect(verdictOf([run('before', 'pass'), run('after', 'pass')])).toBe('passes');
    expect(verdictOf([run('before', 'fail', 'E'), run('after', 'fail', 'E')])).toBe('already-broken');
    expect(verdictOf([run('before', 'fail', 'E'), run('after', 'timeout')])).toBe('changed-failure');
    expect(verdictOf([run('before', 'skipped')])).toBe('skipped');
    expect(verdictOf([run('current', 'fail', 'E')])).toBe('fails');
  });
});

describe('installEnv', () => {
  it('passes what uv and pip need and none of the server secrets', async () => {
    const { installEnv } = await import('../src/runner/sandbox.js');
    const env = installEnv({
      PATH: '/usr/bin', HOME: '/home/x', LANG: 'C.UTF-8', UV_CACHE_DIR: '/c', PIP_INDEX_URL: 'https://pypi.org/simple', HTTPS_PROXY: 'http://p:3128', SSL_CERT_FILE: '/etc/ssl/cert.pem',
      FALKORDB_URL: 'falkor://user:secret@host:6379', ANTHROPIC_API_KEY: 'sk-x', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', GITHUB_TOKEN: 'ghp_x', LOCKSTEP_MODEL: 'm', VIRTUAL_ENV: '/v', AWS_SECRET_ACCESS_KEY: 'a', NODE_OPTIONS: '--x',
    });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'HTTPS_PROXY', 'LANG', 'PATH', 'PIP_INDEX_URL', 'SSL_CERT_FILE', 'UV_CACHE_DIR']);
  });
});

describe('installFailure', () => {
  it('names the pin when the resolver finds no solution', async () => {
    const { installFailure } = await import('../src/runner/sandbox.js');
    // uv's output for GraphRAG-SDK@35e67a0 with falkordb-py at falkordb-py#276 (recorded on the graph).
    const stderr = [
      '× No solution found when resolving dependencies:',
      '  ╰─▶ Because only graphrag-sdk==1.4.0 is available and graphrag-sdk==1.4.0',
      '      depends on falkordb[hiredis]>=1.8.0,<2, we can conclude that all',
      '      versions of graphrag-sdk depend on falkordb[hiredis]>=1.8.0,<2.',
    ].join('\n');
    const msg = installFailure(['FalkorDB/GraphRAG-SDK@35e67a0', 'FalkorDB/falkordb-py@e307df3'], stderr);
    expect(msg.split('\n')[0]).toBe(
      "dependency conflict: graphrag-sdk==1.4.0 requires falkordb[hiredis]>=1.8.0,<2, which the other checkouts don't satisfy " +
        '(installing FalkorDB/GraphRAG-SDK@35e67a0, FalkorDB/falkordb-py@e307df3)',
    );
    expect(msg).toContain('No solution found');
    expect(installFailure(['a@1'], 'boom').split('\n')[0]).toBe('installing a@1 failed:');
  });
});

describe('scratch guard', () => {
  it('never treats the org graph server as scratch', async () => {
    const { scratchIsOrgServer } = await import('../src/runner/scratch.js');
    const { loadConfig } = await import('../src/config.js');
    expect(scratchIsOrgServer(loadConfig({ FALKORDB_URL: 'falkor://localhost:6390' }))).toBe(true);
    expect(scratchIsOrgServer(loadConfig({ FALKORDB_URL: 'falkor://user:pw@127.0.0.1:6379', LOCKSTEP_SCRATCH_PORT: '6379' }))).toBe(true);
    expect(scratchIsOrgServer(loadConfig({}))).toBe(false);
  });

  it('reads a scratch URL without credentials and refuses one with them', async () => {
    const { loadConfig } = await import('../src/config.js');
    expect(loadConfig({ LOCKSTEP_SCRATCH_URL: 'redis://scratch.internal:6400' }).scratch).toEqual({ host: 'scratch.internal', port: 6400, managed: false });
    expect(() => loadConfig({ LOCKSTEP_SCRATCH_URL: 'redis://user:pw@scratch.internal:6400' })).toThrow(/must not carry credentials/);
  });

  it('removes UDF libraries between runs (FLUSHALL keeps them)', async () => {
    const { ensureScratchDb, flushScratchDb } = await import('../src/runner/scratch.js');
    const { loadConfig } = await import('../src/config.js');
    const { FalkorDB } = await import('falkordb');
    // Its own server: flushing the shared test server would wipe other tests' graphs.
    const base = loadConfig({ LOCKSTEP_SCRATCH_PORT: '6392' });
    const config = { ...base, scratch: { ...base.scratch, managed: true } };
    await ensureScratchDb(config);
    const db = await FalkorDB.connect({ socket: { host: config.scratch.host, port: config.scratch.port } });
    try {
      const conn = (await db.connection) as unknown as { sendCommand(args: string[]): Promise<unknown> };
      await conn.sendCommand(['GRAPH.UDF', 'LOAD', 'REPLACE', 'StringUtils', "function f(s) { return s; }; falkor.register('f', f);"]);
      expect(await conn.sendCommand(['GRAPH.UDF', 'LIST'])).toHaveLength(1);
      await flushScratchDb(config);
      // The docs' UDF example loads 'StringUtils'; a leftover library fails the next run with "already registered".
      expect(await conn.sendCommand(['GRAPH.UDF', 'LIST'])).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
