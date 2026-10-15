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

describe('scratch guard', () => {
  it('never treats the org graph server as scratch', async () => {
    const { scratchIsOrgServer } = await import('../src/runner/scratch.js');
    const { loadConfig } = await import('../src/config.js');
    expect(scratchIsOrgServer(loadConfig({ FALKORDB_URL: 'falkor://localhost:6390' }))).toBe(true);
    expect(scratchIsOrgServer(loadConfig({ FALKORDB_URL: 'falkor://user:pw@127.0.0.1:6379', LOCKSTEP_SCRATCH_PORT: '6379' }))).toBe(true);
    expect(scratchIsOrgServer(loadConfig({}))).toBe(false);
  });
});
