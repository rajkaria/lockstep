import { Socket } from 'node:net';
import type { PredictedBreak } from './report.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether something listens on host:port, answered within `ms`. */
function listening(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const s = new Socket();
    const finish = (ok: boolean) => {
      s.destroy();
      done(ok);
    };
    s.setTimeout(ms, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    s.connect(port, host.replace(/^\[|\]$/g, ''));
  });
}

/**
 * Examples in other docs (another repository's too) that a static check predicts the
 * working tree breaks, from a graph that is already running on this machine and already
 * has the repository. Never starts a database, never indexes, never talks to a remote
 * one: a hook sends nothing off the machine. Nothing found or no graph: an empty list.
 */
export async function predictedFromLocalGraph(root: string, opts: { timeoutMs?: number } = {}): Promise<PredictedBreak[]> {
  // Loaded only here: the config module brings the model client, which the edit hook never needs.
  const { loadConfig, orgSlug, setting } = await import('../config.js');
  let config: ReturnType<typeof loadConfig>;
  let url: URL;
  try {
    // An invalid setting elsewhere (STALEPROOF_EFFORT) must not cost the lint findings.
    config = loadConfig();
    url = new URL(config.falkordbUrl.replace(/^falkors?:/, 'redis:'));
  } catch {
    return [];
  }
  if (!LOOPBACK.has(url.hostname)) return [];
  if (!(await listening(url.hostname, Number(url.port || 6379), opts.timeoutMs ?? 300))) return [];
  const [{ GraphStore }, { analyzeChanges, localChanges }] = await Promise.all([import('../graph/client.js'), import('../pr/local.js')]);
  let store: Awaited<ReturnType<typeof GraphStore.connect>> | undefined;
  try {
    const local = await localChanges(root, { base: 'HEAD' });
    if (!local.diff.symbols.length) return [];
    const org = orgSlug(setting('ORG') ?? local.repo.split('/')[0]!);
    store = await GraphStore.connect(config.falkordbUrl);
    const r = await analyzeChanges(store.org(org), config.home, local.repo, local.diff, { url: '', title: 'working tree' });
    return r.data.impact.predicted.map((p) => ({ example: p.repo === local.repo ? p.path : `${p.repo}:${p.path}`, line: p.line, detail: p.detail }));
  } catch {
    // Not indexed, or the graph is busy: the lint findings stand on their own.
    return [];
  } finally {
    await store?.close().catch(() => {});
  }
}
