// Vercel Function: the Staleproof API (src/server/app.ts) behind /api/*, including MCP at /api/mcp.
// The web UI is served statically from web/dist. Needs FALKORDB_URL pointing at a FalkorDB that
// holds the org graph; without it the API answers 503 and the UI falls back to the bundled snapshot.
// Hosted mode (default here; STALEPROOF_HOSTED=off disables it): any public repository is indexed
// on demand into its own workspace graph.
import { createApp, defaultModelFactory, GraphStore, loadConfig, setting, Workspaces } from '../dist/index.js';

let appPromise;

function app() {
  appPromise ??= (async () => {
    const config = loadConfig();
    const store = await GraphStore.connect(config.falkordbUrl);
    const preloaded = setting('PRELOADED')?.split(',').map((s) => s.trim()).filter(Boolean);
    const workspaces = setting('HOSTED') === 'off' ? undefined : new Workspaces(store, config, store.org(config.org));
    const agentChecksPerDay = Number(setting('AGENT_CHECKS_PER_DAY') ?? 50);
    return createApp({ store, config, model: defaultModelFactory(config), preloaded, webDir: '/nonexistent', workspaces, agentChecksPerDay });
  })().catch((err) => {
    appPromise = undefined;
    throw err;
  });
  return appPromise;
}

async function handle(request) {
  try {
    return await (await app()).fetch(request);
  } catch (err) {
    return Response.json(
      { error: `the Staleproof API is not connected to FalkorDB (${err.message}); set FALKORDB_URL`, offline: true },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
