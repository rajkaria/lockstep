import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runInSandbox } from '../src/runner/sandbox.js';

const python = execFileSync('uv', ['python', 'find', '3.12'], { encoding: 'utf8' }).trim();
const SCRATCH = 6380; // the test FalkorDB started by global setup

describe('sandbox shim', () => {
  it('answers localhost:6379 with the scratch FalkorDB', async () => {
    const code = [
      'import socket',
      's = socket.create_connection(("localhost", 6379), timeout=5)',
      's.sendall(b"*1\\r\\n$4\\r\\nPING\\r\\n")',
      'print(s.recv(64).decode().strip())',
    ].join('\n');
    const r = await runInSandbox(python, code, { scratchPort: SCRATCH, timeoutMs: 20_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim()).toBe('+PONG');
  });

  it('refuses every other connection and DNS lookup', async () => {
    const code = [
      'import socket',
      'for target in [("1.1.1.1", 80), ("127.0.0.1", 22)]:',
      '    try:',
      '        socket.create_connection(target, timeout=5)',
      '        print("connected", target)',
      '    except OSError as e:',
      '        print("refused", target[1], "Staleproof sandbox" in str(e))',
      'try:',
      '    socket.getaddrinfo("example.com", 443)',
      'except OSError as e:',
      '    print("dns", "DNS is disabled" in str(e))',
    ].join('\n');
    const r = await runInSandbox(python, code, { scratchPort: SCRATCH, timeoutMs: 20_000 });
    expect(r.stdout.trim().split('\n')).toEqual(['refused 80 True', 'refused 22 True', 'dns True']);
  });

  it('enforces the timeout and inherits no secrets', async () => {
    process.env.STALEPROOF_TEST_SECRET = 'nope';
    const env = await runInSandbox(python, 'import os; print(os.environ.get("STALEPROOF_TEST_SECRET"))', { scratchPort: SCRATCH, timeoutMs: 20_000 });
    expect(env.stdout.trim()).toBe('None');
    const slow = await runInSandbox(python, 'import time; time.sleep(30)', { scratchPort: SCRATCH, timeoutMs: 1500 });
    expect(slow.timedOut).toBe(true);
  });
});
