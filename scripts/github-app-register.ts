/**
 * Register the Staleproof GitHub App from `github-app.json` with GitHub's manifest flow,
 * on your own machine:
 *
 *   npx tsx scripts/github-app-register.ts [--org <org>] [--name <name>] [--port 3978] [--no-open] [--force]
 *
 * 1. Serves a page on localhost that posts the manifest to GitHub (your browser opens it).
 * 2. You click "Create GitHub App"; GitHub sends the browser back to localhost with a code.
 * 3. The code is exchanged for the App's id, private key and webhook secret, written to the
 *    git-ignored `.env.app` (mode 600), and the exact `vercel env add` commands are printed.
 *
 * Nothing secret is printed. GitHub gives an hour to finish the three steps.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appJwt } from '../src/app/jwt.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_FILE = join(ROOT, 'github-app.json');
export const DEFAULT_PORT = 3978;
/** What the server reads (src/app/env.ts), in the order the commands are printed. */
export const VERCEL_VARS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_SLUG', 'CRON_SECRET'] as const;

export interface RegisterOptions {
  /** Register under this organisation instead of your personal account. */
  org?: string;
  /** Another App name (names are unique on GitHub: "Staleproof" may be taken by then). */
  name?: string;
  port: number;
  open: boolean;
  /** Where the credentials go (default `.env.app` in the repository). */
  out: string;
  /** Overwrite an existing credentials file. */
  force: boolean;
}

export function parseArgs(argv: string[]): RegisterOptions {
  const opts: RegisterOptions = { port: DEFAULT_PORT, open: true, out: join(ROOT, '.env.app'), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--org') opts.org = value();
    else if (a === '--name') opts.name = value();
    else if (a === '--port') {
      opts.port = Number(value());
      if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be a port number');
    } else if (a === '--out') opts.out = resolve(value());
    else if (a === '--no-open') opts.open = false;
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') throw new Error('usage: npx tsx scripts/github-app-register.ts [--org <org>] [--name <name>] [--port 3978] [--out .env.app] [--no-open] [--force]');
    else throw new Error(`unknown option ${a}`);
  }
  if (opts.org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opts.org)) throw new Error(`--org must be a GitHub organisation login, not "${opts.org}"`);
  return opts;
}

/** The manifest GitHub receives: the checked-in one, sent back to this machine when registered. */
export function buildManifest(base: Record<string, unknown>, opts: { redirectUrl: string; name?: string }): Record<string, unknown> {
  return { ...base, ...(opts.name ? { name: opts.name } : {}), redirect_url: opts.redirectUrl };
}

/** Where the manifest is posted: your account's or an organisation's new-App page. */
export function registrationUrl(state: string, org?: string): string {
  const base = org ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new` : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The local page that posts the manifest to GitHub (the manifest flow needs a form POST from the browser). */
export function startPage(manifest: Record<string, unknown>, action: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register the Staleproof GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5">
<h1>Register the Staleproof GitHub App</h1>
<p>This sends <code>github-app.json</code> to GitHub. Check the name and permissions there, then click <strong>Create GitHub App</strong>; GitHub brings you back here.</p>
<form id="register" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('register').submit();</script>
</body></html>`;
}

export interface Conversion {
  id: number;
  slug: string;
  name?: string;
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  owner?: { login: string } | null;
}

/** Exchange the code GitHub sent back for the App's credentials (`POST /app-manifests/{code}/conversions`). */
export async function convert(code: string, fetchImpl: typeof fetch = fetch): Promise<Conversion> {
  if (!/^[\w-]{1,200}$/.test(code)) throw new Error('GitHub sent back an unexpected code');
  const res = await fetchImpl(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'staleproof-register', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub refused the code (${res.status}): it is valid for an hour and only once. Run the script again.`);
  const c = (await res.json()) as Conversion;
  if (!c.id || !c.pem || !c.slug) throw new Error('GitHub answered without the App id, slug or private key');
  return c;
}

/**
 * GitHub may register an App without a webhook secret: give it one (`PATCH /app/hook/config`,
 * as the App) so every delivery is signed.
 */
export async function ensureWebhookSecret(c: Conversion, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (c.webhook_secret) return c.webhook_secret;
  const secret = randomBytes(32).toString('hex');
  const res = await fetchImpl('https://api.github.com/app/hook/config', {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'staleproof-register',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${appJwt(String(c.id), c.pem)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ secret, content_type: 'json' }),
  });
  if (!res.ok) throw new Error(`could not set the webhook secret (${res.status}); set one in the App's settings and put it in GITHUB_APP_WEBHOOK_SECRET`);
  return secret;
}

/** The credentials file: one `KEY=value` per line, the private key base64-encoded on one line. */
export function envFile(c: Conversion, opts: { webhookSecret: string; cronSecret: string; at?: Date }): string {
  return [
    `# Staleproof GitHub App "${c.name ?? c.slug}" (${c.html_url}), registered ${(opts.at ?? new Date()).toISOString()} by scripts/github-app-register.ts.`,
    '# Secret: never commit or paste it (.gitignore covers .env.*). The private key is the PEM, base64-encoded on one line.',
    `GITHUB_APP_ID=${c.id}`,
    `GITHUB_APP_SLUG=${c.slug}`,
    `GITHUB_APP_WEBHOOK_SECRET=${opts.webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY=${Buffer.from(c.pem).toString('base64')}`,
    `GITHUB_APP_CLIENT_ID=${c.client_id}`,
    `GITHUB_APP_CLIENT_SECRET=${c.client_secret}`,
    `CRON_SECRET=${opts.cronSecret}`,
    '',
  ].join('\n');
}

/** The commands that copy the credentials into Vercel production without printing them. */
export function vercelCommands(file = '.env.app'): string[] {
  return [
    ...VERCEL_VARS.map((v) => `grep '^${v}=' ${file} | cut -d= -f2- | tr -d '\\n' | vercel env add ${v} production`),
    `git commit --allow-empty -m "Turn on the GitHub App" && git push origin main`,
  ];
}

export interface RegisterDeps {
  fetchImpl?: typeof fetch;
  /** Opens the browser (default: `open`, `xdg-open` or `start`). */
  openUrl?: (url: string) => void;
  log?: (line: string) => void;
  /** Called when the local server listens (tests learn its port). */
  onListening?: (url: string) => void;
  /** Give up after this long (default one hour, GitHub's limit for the flow). */
  timeoutMs?: number;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** Run the manifest flow: serve the start page, wait for GitHub's redirect, write the credentials. */
export async function register(opts: RegisterOptions, deps: RegisterDeps = {}): Promise<{ conversion: Conversion; file: string }> {
  const log = deps.log ?? ((l: string) => console.log(l));
  if (existsSync(opts.out) && !opts.force) throw new Error(`${opts.out} exists: an App is already registered. Pass --force to register another and overwrite it.`);
  const base = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')) as Record<string, unknown>;
  const state = randomBytes(16).toString('hex');
  const fetchImpl = deps.fetchImpl ?? fetch;

  return new Promise((resolvePromise, reject) => {
    let port = opts.port;
    let finished = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const page = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      };
      if (url.pathname === '/') {
        const manifest = buildManifest(base, { redirectUrl: `http://localhost:${port}/callback`, name: opts.name });
        return page(200, startPage(manifest, registrationUrl(state, opts.org)));
      }
      if (url.pathname !== '/callback') return page(404, 'Not found');
      if (url.searchParams.get('state') !== state) return page(400, '<p>This answer is not for this registration (the state does not match). Start again.</p>');
      const code = url.searchParams.get('code') ?? '';
      if (finished) return page(409, '<p>Already registered. You can close this tab.</p>');
      finished = true;
      (async () => {
        const conversion = await convert(code, fetchImpl);
        const webhookSecret = await ensureWebhookSecret(conversion, fetchImpl);
        await writeFile(opts.out, envFile(conversion, { webhookSecret, cronSecret: randomBytes(32).toString('hex') }), { mode: 0o600 });
        return conversion;
      })().then(
        (conversion) => {
          page(200, `<p>Registered <strong>${escapeHtml(conversion.name ?? conversion.slug)}</strong>: <a href="${escapeHtml(conversion.html_url)}">${escapeHtml(conversion.html_url)}</a>. The credentials are in <code>.env.app</code>; the terminal has the next steps. You can close this tab.</p>`);
          clearTimeout(timer);
          server.close();
          resolvePromise({ conversion, file: opts.out });
        },
        (err: Error) => {
          page(500, `<p>${escapeHtml(err.message)}</p>`);
          clearTimeout(timer);
          server.close();
          reject(err);
        },
      );
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('no answer from GitHub within the hour the manifest flow allows; run the script again'));
    }, deps.timeoutMs ?? 3600_000);
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(opts.port, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      const local = `http://localhost:${port}/`;
      deps.onListening?.(local);
      log(`Opening ${local} to register the App${opts.org ? ` under ${opts.org}` : ''} (manifest: github-app.json).`);
      if (opts.open) (deps.openUrl ?? openBrowser)(local);
      else log('Open that address in your browser.');
    });
  });
}

/** What to do once the credentials are on disk. */
export function nextSteps(c: Conversion, file: string): string[] {
  const rel = file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
  return [
    `Registered ${c.name ?? c.slug} (id ${c.id}): ${c.html_url}`,
    `Credentials written to ${rel} (mode 600; git-ignored). Nothing secret was printed.`,
    '',
    'Add them to Vercel production (from the repository root, logged in with `vercel login`):',
    '',
    ...vercelCommands(rel).map((l) => `  ${l}`),
    '',
    `Then install it on a repository: https://github.com/apps/${c.slug}/installations/new`,
  ];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { conversion, file } = await register(opts);
  for (const line of nextSteps(conversion, file)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: Error) => {
    console.error(`github-app-register: ${err.message}`);
    process.exit(1);
  });
}
