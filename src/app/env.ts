/**
 * The GitHub App's settings. The App is on only when its id, private key and webhook
 * secret are all set; without them its routes answer 404 and nothing else changes.
 *
 * - `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`: from registration
 *   (`npx tsx scripts/github-app-register.ts` writes them to `.env.app`).
 * - `GITHUB_APP_SLUG`: shows the install button on `#/install` (via `/api/health`).
 * - `CRON_SECRET`: protects the daily `GET /api/github/cron` (Vercel sends it as a bearer token).
 */

export interface GitHubAppEnv {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
  webhookSecret: string;
  slug?: string;
  cronSecret?: string;
}

/**
 * A private key as people paste it: a PEM, a PEM with literal `\n` (one-line env
 * values), or the PEM base64-encoded (what the registration script writes).
 */
export function normalizePrivateKey(raw: string): string {
  const s = raw.trim().replace(/^["']|["']$/g, '');
  if (s.includes('-----BEGIN')) return `${s.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim()}\n`;
  const decoded = Buffer.from(s, 'base64').toString('utf8');
  if (decoded.includes('-----BEGIN')) return `${decoded.replace(/\r\n/g, '\n').trim()}\n`;
  throw new Error('GITHUB_APP_PRIVATE_KEY is neither a PEM private key nor a base64-encoded one');
}

export function githubAppEnv(env: NodeJS.ProcessEnv = process.env): GitHubAppEnv | undefined {
  const appId = env.GITHUB_APP_ID?.trim();
  const key = env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!appId || !key?.trim() || !webhookSecret) return undefined;
  if (!/^\d+$/.test(appId)) throw new Error('GITHUB_APP_ID must be the numeric App id');
  const slug = env.GITHUB_APP_SLUG?.trim() || undefined;
  if (slug && !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('GITHUB_APP_SLUG must be the App slug from its URL (github.com/apps/<slug>)');
  return { appId, privateKey: normalizePrivateKey(key), webhookSecret, ...(slug ? { slug } : {}), ...(env.CRON_SECRET ? { cronSecret: env.CRON_SECRET } : {}) };
}

/** What `/api/health` says about the App: whether it is on and where to install it (from its settings, or the environment). */
export function githubAppHealth(source: NodeJS.ProcessEnv | GitHubAppEnv = process.env): { enabled: boolean; appSlug?: string; installUrl?: string } {
  let app: GitHubAppEnv | undefined;
  try {
    app = 'appId' in source && 'webhookSecret' in source ? (source as GitHubAppEnv) : githubAppEnv(source as NodeJS.ProcessEnv);
  } catch {
    app = undefined;
  }
  if (!app) return { enabled: false };
  return app.slug ? { enabled: true, appSlug: app.slug, installUrl: installUrl(app.slug) } : { enabled: true };
}

export function installUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}
