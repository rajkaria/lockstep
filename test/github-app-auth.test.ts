import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { githubAppEnv, githubAppHealth, normalizePrivateKey } from '../src/app/env.js';
import { GitHubApiError, GitHubAppClient, TOKEN_MARGIN_MS } from '../src/app/github-app.js';
import { assertPublicGraph, isPrivateGraph, PrivateGraphError, privateGraphName, publicGraphs } from '../src/app/guard.js';
import { appJwt, jwtClaims } from '../src/app/jwt.js';
import { MAX_WEBHOOK_BYTES, PayloadTooLargeError, readRawBody, signBody, verifySignature, webhookHeaders } from '../src/app/webhook.js';
import { FakeGitHub, testKeys } from './fixtures/github-app/fake-github.js';

describe('App JWT (RS256, node:crypto)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

  it('verifies against the public half of a key generated here', () => {
    const now = 1_760_000_000;
    const token = appJwt('12345', pem, now);
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    const { header, payload } = jwtClaims(token);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    // A minute back for clock drift, under GitHub's 10-minute cap.
    expect(payload).toEqual({ iat: now - 60, exp: now + 540, iss: '12345' });
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(600);
  });

  it('fails verification when the payload is tampered with or another key signed it', () => {
    const token = appJwt('12345', pem);
    const [h, , s] = token.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ iat: 0, exp: 9e9, iss: '666' })).toString('base64url');
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${forged}`), publicKey, Buffer.from(s, 'base64url'))).toBe(false);
    const other = testKeys();
    const [h2, p2, s2] = appJwt('12345', other.privateKey).split('.') as [string, string, string];
    expect(verify('RSA-SHA256', Buffer.from(`${h2}.${p2}`), publicKey, Buffer.from(s2, 'base64url'))).toBe(false);
  });

  it('accepts PKCS#8 keys and refuses non-RSA keys', () => {
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(appJwt('1', pkcs8).split('.')).toHaveLength(3);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => appJwt('1', ec)).toThrow(/RSA/);
  });
});

describe('App settings from the environment', () => {
  const { privateKey } = testKeys();

  it('is off unless id, key and webhook secret are all set', () => {
    expect(githubAppEnv({})).toBeUndefined();
    expect(githubAppEnv({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey })).toBeUndefined();
    expect(githubAppEnv({ GITHUB_APP_ID: '1', GITHUB_APP_WEBHOOK_SECRET: 's' })).toBeUndefined();
    const env = githubAppEnv({ GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: 's', GITHUB_APP_SLUG: 'staleproof', CRON_SECRET: 'c' });
    expect(env).toMatchObject({ appId: '42', webhookSecret: 's', slug: 'staleproof', cronSecret: 'c' });
    expect(() => githubAppEnv({ GITHUB_APP_ID: 'abc', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: 's' })).toThrow(/numeric/);
  });

  it('reads the key as a PEM, a one-line PEM with \\n, or base64', () => {
    const oneLine = privateKey.trim().replace(/\n/g, '\\n');
    const b64 = Buffer.from(privateKey).toString('base64');
    expect(normalizePrivateKey(privateKey)).toBe(`${privateKey.trim()}\n`);
    expect(normalizePrivateKey(oneLine)).toBe(`${privateKey.trim()}\n`);
    expect(normalizePrivateKey(`"${oneLine}"`)).toBe(`${privateKey.trim()}\n`);
    expect(normalizePrivateKey(b64)).toBe(`${privateKey.trim()}\n`);
    expect(() => normalizePrivateKey('not a key')).toThrow(/neither/);
    // The normalized key signs.
    expect(appJwt('1', normalizePrivateKey(b64)).split('.')).toHaveLength(3);
  });

  it('tells /api/health whether the App is on and where to install it, never the secrets', () => {
    expect(githubAppHealth({})).toEqual({ enabled: false });
    const base = { GITHUB_APP_ID: '42', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_WEBHOOK_SECRET: 'whsec' };
    expect(githubAppHealth(base)).toEqual({ enabled: true });
    const h = githubAppHealth({ ...base, GITHUB_APP_SLUG: 'staleproof' });
    expect(h).toEqual({ enabled: true, appSlug: 'staleproof', installUrl: 'https://github.com/apps/staleproof/installations/new' });
    expect(JSON.stringify(h)).not.toContain('whsec');
    expect(githubAppHealth({ ...base, GITHUB_APP_ID: 'x' })).toEqual({ enabled: false });
    // From the App's settings object too (what createApp passes when they are injected).
    expect(githubAppHealth(githubAppEnv({ ...base, GITHUB_APP_SLUG: 'sp' })!)).toEqual({ enabled: true, appSlug: 'sp', installUrl: 'https://github.com/apps/sp/installations/new' });
  });
});

describe('webhook signatures and limits', () => {
  const secret = "It's a Secret to Everybody";

  it('matches the documented example signature', () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    expect(signBody(secret, 'Hello, World!')).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17');
  });

  it('accepts the right signature and refuses wrong, missing, malformed or other-secret ones', () => {
    const body = new TextEncoder().encode('{"action":"opened"}');
    const sig = signBody(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
    expect(verifySignature(secret, body, sig.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, '')).toBe(false);
    expect(verifySignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifySignature(secret, body, sig.slice(0, -1))).toBe(false);
    expect(verifySignature(secret, new TextEncoder().encode('{"action":"closed"}'), sig)).toBe(false);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature('', body, sig)).toBe(false);
  });

  it('reads the raw body and refuses more than the limit, declared or streamed', async () => {
    const ok = await readRawBody(new Request('http://x/', { method: 'POST', body: 'abc' }));
    expect(new TextDecoder().decode(ok)).toBe('abc');
    await expect(readRawBody(new Request('http://x/', { method: 'POST', body: 'x', headers: { 'content-length': String(MAX_WEBHOOK_BYTES + 1) } }))).rejects.toBeInstanceOf(PayloadTooLargeError);
    // No declared length: counted while streaming.
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(10));
        c.close();
      },
    });
    await expect(readRawBody(new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 25)).rejects.toThrow(/over the 25-byte limit/);
  });

  it('needs the event and delivery headers', () => {
    expect(webhookHeaders(new Request('http://x/', { headers: { 'x-github-event': 'push' } }))).toBeUndefined();
    expect(webhookHeaders(new Request('http://x/', { headers: { 'x-github-event': 'push', 'x-github-delivery': 'a b' } }))).toBeUndefined();
    expect(webhookHeaders(new Request('http://x/', { headers: { 'x-github-event': 'push', 'x-github-delivery': 'abc-123', 'x-hub-signature-256': 'sha256=00' } }))).toEqual({
      event: 'push',
      delivery: 'abc-123',
      signature: 'sha256=00',
    });
  });
});

describe('private graph guard', () => {
  it('names one graph per installation and recognises it', () => {
    expect(privateGraphName(123)).toBe('ghp-123');
    expect(privateGraphName('9')).toBe('ghp-9');
    expect(() => privateGraphName(0)).toThrow();
    expect(() => privateGraphName('1; DROP')).toThrow();
    expect(() => privateGraphName(-4)).toThrow();
    for (const name of ['ghp-1', 'GHP-77', ' ghp-5']) expect(isPrivateGraph(name)).toBe(true);
    // Hosted workspaces are `gh-<owner>`: even an owner called "p-1" never looks private.
    for (const name of ['gh-acme', 'gh-p-1', 'falkordb', 'staleproof-hosted', 'staleproof-app', '', undefined, null]) expect(isPrivateGraph(name)).toBe(false);
  });

  it('refuses private graphs to public endpoints without confirming they exist', () => {
    expect(assertPublicGraph('gh-acme')).toBe('gh-acme');
    expect(() => assertPublicGraph('ghp-42')).toThrow(PrivateGraphError);
    expect(() => assertPublicGraph('ghp-42')).toThrow('no such repository on this server');
    expect(new PrivateGraphError('x').status).toBe(404);
  });

  it('filters lists of graphs, names or workspaces', () => {
    expect(publicGraphs(['falkordb', 'ghp-1', 'gh-acme'])).toEqual(['falkordb', 'gh-acme']);
    expect(publicGraphs([{ name: 'ghp-2' }, { name: 'gh-x' }])).toEqual([{ name: 'gh-x' }]);
    expect(publicGraphs([{ graph: 'gh-x', curated: false }, { graph: 'ghp-3', curated: false }])).toEqual([{ graph: 'gh-x', curated: false }]);
  });
});

describe('installation tokens', () => {
  const keys = testKeys();

  it('come from a JWT GitHub verifies, are cached until a minute before expiry, then renewed', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const gh = new FakeGitHub('77', keys.publicKey);
    gh.now = () => now;
    gh.tokenTtlMs = 10 * 60_000;
    const client = new GitHubAppClient({ appId: '77', privateKey: keys.privateKey, fetchImpl: gh.fetch, now: () => now });
    const [a, b] = await Promise.all([client.installationToken(5), client.installationToken(5)]);
    expect(a).toBe(b);
    expect(gh.find('POST', /access_tokens/)).toHaveLength(1);
    now += 10 * 60_000 - TOKEN_MARGIN_MS - 1000;
    expect(await client.installationToken(5)).toBe(a);
    now += 2000;
    const c = await client.installationToken(5);
    expect(c).not.toBe(a);
    expect(gh.find('POST', /access_tokens/)).toHaveLength(2);
    // Another installation has its own token.
    expect(await client.installationToken(6)).toMatch(/^ghs_test_6_/);
  });

  it('refuses a JWT from the wrong key, and keeps tokens out of error messages', async () => {
    const gh = new FakeGitHub('77', keys.publicKey);
    const wrong = new GitHubAppClient({ appId: '77', privateKey: testKeys().privateKey, fetchImpl: gh.fetch });
    await expect(wrong.installationToken(5)).rejects.toThrow(/401/);
    const client = new GitHubAppClient({ appId: '77', privateKey: keys.privateKey, fetchImpl: gh.fetch });
    const inst = client.installation(5);
    const token = await inst.token();
    const err = await inst.post('/repos/acme/x/check-runs', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(422);
    expect((err as Error).message).not.toContain(token);
  });

  it('retries once with a new token when GitHub refuses the cached one', async () => {
    const gh = new FakeGitHub('77', keys.publicKey);
    const client = new GitHubAppClient({ appId: '77', privateKey: keys.privateKey, fetchImpl: gh.fetch });
    const inst = client.installation(5);
    await inst.token();
    gh.failures.push({ method: 'GET', path: /\/issues\/1\/comments/, status: 401 });
    expect(await inst.get('/repos/acme/x/issues/1/comments')).toEqual([]);
    expect(gh.find('POST', /access_tokens/)).toHaveLength(2);
  });

  it('finds the installation of a repository as the App', async () => {
    const gh = new FakeGitHub('77', keys.publicKey);
    gh.repoInstallation.set('acme/app', 9);
    const client = new GitHubAppClient({ appId: '77', privateKey: keys.privateKey, fetchImpl: gh.fetch });
    expect(await client.installationIdFor('acme/app')).toBe(9);
    expect(await client.installationIdFor('acme/none')).toBeUndefined();
  });
});
