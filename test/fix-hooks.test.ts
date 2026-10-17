import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHook } from '../src/hooks/index.js';
import { FIXTURES, gitIn } from './helpers.js';

// The hooks attach verified fixes (src/hooks/index.ts); test/hooks.test.ts expects the same ` Fix: …` suffix.

const HOOKS = join(FIXTURES, 'hooks');
const input = async (name: string, root: string) => (await readFile(join(HOOKS, 'inputs', `${name}.json`), 'utf8')).replaceAll('{{root}}', root);
const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.STALEPROOF_HOOK;
  return e;
};

describe('hooks name the verified fix', () => {
  it('stop: a renamed parameter gets its fix in the reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'staleproof-hooks-fix-'));
    await cp(join(HOOKS, 'repo'), root, { recursive: true });
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-q', '-m', 'init');
    await runHook('session-start', await input('claude-session-start', root), { env: env(), graph: false, timeoutMs: 60_000 });
    const p = join(root, 'demo', 'client.py');
    await writeFile(p, (await readFile(p, 'utf8')).replace('def connect(host, timeout=10):', 'def connect(host, deadline=10):'));
    await runHook('post-edit', await input('claude-post-edit-signature', root), { env: env(), graph: false, timeoutMs: 60_000 });
    const out = JSON.parse((await runHook('stop', await input('claude-stop', root), { env: env(), graph: false, timeoutMs: 60_000 })).stdout) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(
      '- README.md:8:8 `connect` has no parameter `timeout`. [example-unknown-keyword] Fix: Rename to `deadline=` (renamed in the signature of `demo.client.connect`)',
    );
  });
});
