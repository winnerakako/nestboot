import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Intentional: esbuild (Vite's default TS transform) cannot emit decorator
// metadata, which Nest's DI and DBOS's registration both read at runtime.
// swc is the only transform that does, so every spec goes through it.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'nodenext' } })],
  resolve: {
    alias: {
      '@platform': `${root}src/platform`,
      '@contracts': `${root}src/contracts`,
      '@features': `${root}src/features`,
      '@test': `${root}test`,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['test/setup/each-file.ts'],
    // One Postgres container for the run; each test file clones a template
    // database inside it, so files stay parallel without paying per-file setup.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
