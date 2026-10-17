import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubAppEnv } from '../src/app/env.js';
import { appJwt } from '../src/app/jwt.js';
import {
  buildManifest,
  DEFAULT_PORT,
  envFile,
  MANIFEST_FILE,
  nextSteps,
  parseArgs,
  register,
  registrationUrl,
  startPage,
  vercelCommands,
  VERCEL_VARS,
  type Conversion,
} from '../scripts/github-app-register.js';
import { testKeys } from './fixtures/github-app/fake-github.js';

/** The manifest fields GitHub documents (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
const MANIFEST_KEYS = new Set([
  'name',
  'url',
  'hook_attributes',
  'redirect_url',
  'callback_urls',
  'setup_url',
  'description',
  'public',
  'default_events',
  'default_permissions',
  'request_oauth_on_install',
  'setup_on_update',
]);

describe('github-app.json', () => {
  it('is a manifest GitHub accepts: documented fields, the webhook, the permissions and events the App needs', async () => {
    const m = JSON.parse(await readFile(MANIFEST_FILE, 'utf8'));
    for (const k of Object.keys(m)) expect(MANIFEST_KEYS.has(k), k).toBe(true);
    expect(m.name).toBe('Staleproof');
    expect(m.url).toBe('https://staleproof.dev');
    expect(m.hook_attributes).toEqual({ url: 'https://staleproof.dev/api/github/webhook', active: true });
    expect(m.default_permissions).toEqual({ checks: 'write', contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' });
    // installation and installation_repositories reach every App by default and cannot be subscribed to.
    expect(m.default_events).toEqual(['pull_request', 'push', 'check_run', 'check_suite']);
    expect(m.public).toBe(true);
  });
});

describe('registration script: pure parts', () => {
  it('parses its options', () => {
    expect(parseArgs([])).toMatchObject({ port: DEFAULT_PORT, open: true, force: false });
    expect(parseArgs(['--org', 'acme', '--name', 'Staleproof Acme', '--port', '0', '--no-open', '--force'])).toMatchObject({ org: 'acme', name: 'Staleproof Acme', port: 0, open: false, force: true });
    expect(() => parseArgs(['--org'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--org', 'a b'])).toThrow(/organisation login/);
    expect(() => parseArgs(['--port', '99999'])).toThrow(/port/);
    expect(() => parseArgs(['--what'])).toThrow(/unknown option/);
  });

  it('sends the manifest back to this machine, under your account or an organisation', () => {
    const base = { name: 'Staleproof', url: 'https://staleproof.dev' };
    const m = buildManifest(base, { redirectUrl: 'http://localhost:3978/callback' });
    expect(m).toEqual({ name: 'Staleproof', url: 'https://staleproof.dev', redirect_url: 'http://localhost:3978/callback' });
    expect(base).not.toHaveProperty('redirect_url');
    expect(buildManifest(base, { redirectUrl: 'x', name: 'Other' }).name).toBe('Other');
    expect(registrationUrl('s1')).toBe('https://github.com/settings/apps/new?state=s1');
    expect(registrationUrl('s1', 'acme')).toBe('https://github.com/organizations/acme/settings/apps/new?state=s1');
  });

  it('posts the manifest from an auto-submitting form, escaped', () => {
    const html = startPage({ name: 'A "quoted" <b>name</b>' }, 'https://github.com/settings/apps/new?state=x&y');
    expect(html).toContain('<form id="register" method="post" action="https://github.com/settings/apps/new?state=x&amp;y">');
    expect(html).toContain('name="manifest" value="{&quot;name&quot;:&quot;A \\&quot;quoted\\&quot; &lt;b&gt;name&lt;/b&gt;&quot;}"');
    expect(html).not.toContain('<b>name</b>');
    expect(html).toContain(".submit()");
  });

  const keys = testKeys();
  const conversion: Conversion = {
    id: 123456,
    slug: 'staleproof',
    name: 'Staleproof',
    html_url: 'https://github.com/apps/staleproof',
    client_id: 'Iv1.abc',
    client_secret: 'client-secret-value',
    webhook_secret: 'whsec-value',
    pem: keys.privateKey,
  };

  it('writes credentials the server reads back (the key base64 on one line)', () => {
    const text = envFile(conversion, { webhookSecret: 'whsec-value', cronSecret: 'cron-value', at: new Date('2026-10-17T00:00:00Z') });
    const env = Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(Object.keys(env)).toEqual(['GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'CRON_SECRET']);
    expect(env.GITHUB_APP_PRIVATE_KEY).not.toContain('\n');
    const app = githubAppEnv(env as NodeJS.ProcessEnv)!;
    expect(app).toMatchObject({ appId: '123456', slug: 'staleproof', webhookSecret: 'whsec-value', cronSecret: 'cron-value' });
    // The key that comes back signs a JWT the original key's public half verifies.
    const [h, p, s] = appJwt(app.appId, app.privateKey).split('.') as [string, string, string];
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), keys.publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('prints vercel commands for every variable the server needs, and no secret', () => {
    const cmds = vercelCommands('.env.app');
    for (const v of VERCEL_VARS) expect(cmds.some((c) => c.includes(`'^${v}='`) && c.endsWith(`vercel env add ${v} production`))).toBe(true);
    expect(cmds.at(-1)).toMatch(/git push origin main/);
    const steps = nextSteps(conversion, '/somewhere/.env.app').join('\n');
    for (const secret of ['whsec-value', 'client-secret-value', 'BEGIN RSA', Buffer.from(keys.privateKey).toString('base64').slice(0, 40)]) expect(steps).not.toContain(secret);
    expect(steps).toContain('https://github.com/apps/staleproof/installations/new');
  });
});

describe('registration script: the manifest flow on localhost', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'staleproof-register-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the form, refuses a foreign state, converts the code, sets a missing webhook secret, writes .env.app (600)', async () => {
    const keys = testKeys();
    const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization') ?? undefined;
      calls.push({ url, method: init?.method ?? 'GET', ...(auth ? { auth } : {}), ...(init?.body ? { body: String(init.body) } : {}) });
      if (url === 'https://api.github.com/app-manifests/code-123/conversions') {
        return Response.json({ id: 99, slug: 'staleproof-test', name: 'Staleproof Test', html_url: 'https://github.com/apps/staleproof-test', client_id: 'Iv1', client_secret: 'cs', webhook_secret: null, pem: keys.privateKey }, { status: 201 });
      }
      if (url === 'https://api.github.com/app/hook/config') return Response.json({ content_type: 'json' });
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const out = join(dir, '.env.app');
    let local = '';
    const opened: string[] = [];
    const done = register(
      { port: 0, open: true, out, force: false },
      { fetchImpl, openUrl: (u) => opened.push(u), log: () => undefined, onListening: (u) => (local = u) },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(opened).toEqual([local]);
    const page = await (await fetch(local)).text();
    const action = /action="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, '&');
    const state = new URL(action).searchParams.get('state')!;
    expect(action.startsWith('https://github.com/settings/apps/new?state=')).toBe(true);
    const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    expect(manifest.redirect_url).toBe(`${local}callback`);
    expect(manifest.hook_attributes.url).toBe('https://staleproof.dev/api/github/webhook');

    expect((await fetch(`${local}callback?code=code-123&state=wrong`)).status).toBe(400);
    expect(calls).toHaveLength(0);
    const ok = await fetch(`${local}callback?code=code-123&state=${state}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Registered <strong>Staleproof Test</strong>');
    const { conversion, file } = await done;
    expect(conversion.id).toBe(99);
    expect(file).toBe(out);
    expect((await stat(out)).mode & 0o777).toBe(0o600);

    // GitHub gave no webhook secret: one was set through the App's own JWT.
    const hook = calls.find((c) => c.url.endsWith('/app/hook/config'))!;
    expect(hook.method).toBe('PATCH');
    const [h, p, s] = hook.auth!.replace('Bearer ', '').split('.') as [string, string, string];
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(keys.privateKey), Buffer.from(s, 'base64url'))).toBe(true);
    const secret = JSON.parse(hook.body!).secret as string;
    const env = githubAppEnv(Object.fromEntries((await readFile(out, 'utf8')).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])))!;
    expect(env).toMatchObject({ appId: '99', slug: 'staleproof-test', webhookSecret: secret });
    expect(env.cronSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('will not overwrite registered credentials without --force', async () => {
    const out = join(dir, 'existing.env');
    await writeFile(out, 'GITHUB_APP_ID=1\n');
    await expect(register({ port: 0, open: false, out, force: false }, { log: () => undefined })).rejects.toThrow(/--force/);
  });
});
