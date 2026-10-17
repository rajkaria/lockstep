import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { githubAppEnv, type GitHubAppEnv } from './env.js';
import { GitHubAppService, type GitHubAppDeps } from './service.js';
import { PayloadTooLargeError, readRawBody, verifySignature, webhookHeaders } from './webhook.js';

/**
 * The App's two routes on the Staleproof API:
 *
 * - `POST /api/github/webhook`: signature checked over the raw body, more than 25 MB
 *   refused, a delivery seen in the last 24 hours ignored, then `202` at once while the
 *   work goes on in the background (`waitUntil`).
 * - `GET /api/github/cron`: the daily job (fix PRs, audit issues, dirty indexes), for
 *   callers holding `CRON_SECRET` (Vercel Cron sends it as a bearer token).
 *
 * Both answer 404 when the App's environment variables are not set.
 */

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerGitHubAppRoutes(app: Hono, deps: GitHubAppDeps): void {
  let service: GitHubAppService | undefined;
  let envError: string | undefined;
  const get = (): GitHubAppService | undefined => {
    if (service) return service;
    let env: GitHubAppEnv | undefined;
    try {
      env = deps.env ?? githubAppEnv();
    } catch (err) {
      envError = (err as Error).message;
      return undefined;
    }
    if (env) service = new GitHubAppService(deps, env);
    return service;
  };
  const disabled = (c: { json: (body: unknown, status: 404) => Response }) =>
    c.json({ error: envError ? `the GitHub App is misconfigured on this server: ${envError}` : 'the GitHub App is not configured on this server' }, 404);
  const log = deps.log ?? ((msg: string) => console.error(`[github-app] ${msg}`));
  const waitUntil = deps.waitUntil ?? ((p: Promise<unknown>) => void p);

  app.post('/api/github/webhook', async (c) => {
    const svc = get();
    if (!svc) return disabled(c);
    const headers = webhookHeaders(c.req.raw);
    if (!headers) return c.json({ error: 'not a GitHub webhook delivery (X-GitHub-Event and X-GitHub-Delivery required)' }, 400);
    let body: Uint8Array;
    try {
      body = await readRawBody(c.req.raw);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return c.json({ error: err.message }, 413);
      throw err;
    }
    if (!verifySignature(svc.env.webhookSecret, body, headers.signature)) return c.json({ error: 'bad signature' }, 401);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return c.json({ error: 'the payload is not JSON' }, 400);
    }
    if (headers.event === 'ping') return c.json({ ok: true, event: 'ping' });
    if (await svc.registry.seenDelivery(headers.delivery)) return c.json({ duplicate: true, delivery: headers.delivery });
    const work = svc.handle(headers.event, payload).then(
      (r) => {
        log(`${headers.delivery} ${headers.event}${r.action ? `.${r.action}` : ''}: ${r.result}`);
        return r;
      },
      (err) => {
        log(`${headers.delivery} ${headers.event} failed: ${(err as Error).message}`);
        return undefined;
      },
    );
    waitUntil(work);
    return c.json({ accepted: true, event: headers.event, delivery: headers.delivery }, 202);
  });

  app.get('/api/github/cron', async (c) => {
    const svc = get();
    if (!svc) return disabled(c);
    if (!svc.env.cronSecret) return c.json({ error: 'the cron is off: set CRON_SECRET' }, 503);
    const auth = c.req.header('authorization') ?? '';
    if (!sameSecret(auth, `Bearer ${svc.env.cronSecret}`)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await svc.cron());
  });
}
