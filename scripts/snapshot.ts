/**
 * Writes web/public/snapshot.json: what the API returns right now for the demo's
 * pages (stats, preloaded PRs, recent checks with their full traces, the query
 * catalogue). A static deployment with no FalkorDB behind it shows this, labelled
 * with the time it was taken.   npm run snapshot
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, setting } from '../src/config.js';
import { GraphStore } from '../src/graph/client.js';
import { createApp, DEFAULT_PRELOADED } from '../src/server/app.js';

const root = join(import.meta.dirname, '..');
const config = loadConfig();
const store = await GraphStore.connect(config.falkordbUrl);
try {
  const preloaded = setting('PRELOADED')?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_PRELOADED;
  const app = createApp({ store, config, preloaded, webDir: '/nonexistent' });
  const get = async (path: string) => {
    const res = await app.request(path);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json() as Promise<any>;
  };
  const health = await get('/api/health');
  const stats = await get('/api/stats');
  const prs = await get('/api/prs');
  const checks = await get('/api/checks?limit=20');
  // Traces: the latest check of every preloaded PR, plus every agent check listed.
  const wanted = new Set<string>();
  for (const p of prs.prs) if (p.latestCheck) wanted.add(p.latestCheck.id);
  for (const c of checks.checks) if (!String(c.model).startsWith('graph')) wanted.add(c.id);
  const traces: Record<string, unknown> = {};
  for (const id of wanted) traces[id] = (await get(`/api/checks/${encodeURIComponent(id)}`)).events;
  checks.checks = checks.checks.filter((c: { id: string }) => wanted.has(c.id));
  const model = await get('/api/model');
  const snapshot = { takenAt: new Date().toISOString(), health: { ...health, busy: false }, stats, prs, checks, traces, model };
  const out = join(root, 'web', 'public', 'snapshot.json');
  await writeFile(out, JSON.stringify(snapshot));
  console.log(`wrote ${out} (${Object.keys(traces).length} traces, ${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB)`);
} finally {
  await store.close();
}
