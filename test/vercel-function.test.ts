import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vercel function', () => {
  it('receives every /api path through one rewrite', async () => {
    const config = JSON.parse(await readFile(join(import.meta.dirname, '..', 'vercel.json'), 'utf8')) as { rewrites: { source: string; destination: string }[]; functions: Record<string, unknown> };
    expect(config.rewrites).toContainEqual({ source: '/api/:path*', destination: '/api' });
    expect(Object.keys(config.functions)).toEqual(['api/index.js']);
  });

  it('puts the original path back when the platform passes the rewritten URL', async () => {
    // @ts-expect-error plain JavaScript module
    const { originalRequest } = (await import('../api/_original.js')) as { originalRequest: (r: Request) => Request };
    const rewritten = originalRequest(new Request('https://x.dev/api?path=checks/chk-1&limit=2'));
    expect(rewritten.url).toBe('https://x.dev/api/checks/chk-1?limit=2');
    const post = originalRequest(new Request('https://x.dev/api?path=badge/a/b.svg', { method: 'POST', body: '{}' }));
    expect(post.method).toBe('POST');
    expect(new URL(post.url).pathname).toBe('/api/badge/a/b.svg');
    const original = new Request('https://x.dev/api/checks/chk-1');
    expect(originalRequest(original)).toBe(original);
  });
});
