// Vercel Function: the Staleproof API (src/server/app.ts) behind /api/*. The web UI is served
// statically from web/dist. Needs FALKORDB_URL pointing at a FalkorDB that holds the org graph;
// without it the API answers 503 and the UI falls back to the bundled snapshot.
import { createApp, defaultModelFactory, GraphStore, loadConfig, setting } from '../dist/index.js';

let appPromise;

function app() {
  appPromise ??= (async () => {
    const config = loadConfig();
    const store = await GraphStore.connect(config.falkordbUrl);
    const preloaded = setting('PRELOADED')?.split(',').map((s) => s.trim()).filter(Boolean);
    return createApp({ store, config, model: defaultModelFactory(config), preloaded, webDir: '/nonexistent' });
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
