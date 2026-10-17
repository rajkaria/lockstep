import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts', hook: 'src/hooks/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: true,
  sourcemap: false,
  dts: false,
});
