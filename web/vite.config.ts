import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { PACKAGE, PRODUCT, REPO_URL, SITE_URL } from './src/docs/manifest';
import { contentType, llmsFiles } from './llms';

/** Publishes the docs as plain text (/llms.txt, /llms-full.txt, /docs/<slug>.md) in builds and in the dev server. */
function llmsPlugin(): Plugin {
  return {
    name: 'staleproof-llms',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        if (!/^(llms\.txt|llms-full\.txt|robots\.txt|sitemap\.xml|docs\/[\w-]+\.md)$/.test(path)) return next();
        const body = llmsFiles(`http://${req.headers.host ?? 'localhost'}`)[path];
        if (body === undefined) return next();
        res.setHeader('content-type', contentType(path));
        res.end(body);
      });
    },
    transformIndexHtml(html) {
      return html
        .replaceAll('{{PRODUCT}}', PRODUCT)
        .replaceAll('{{PACKAGE}}', PACKAGE)
        .replaceAll('{{SITE_URL}}', SITE_URL)
        .replaceAll('{{REPO_URL}}', REPO_URL);
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(llmsFiles())) this.emitFile({ type: 'asset', fileName, source });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), llmsPlugin()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
