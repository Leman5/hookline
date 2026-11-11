import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022', assetsInlineLimit: 0, sourcemap: false },
  worker: { format: 'es' },
  test: { environment: 'node', testTimeout: 60000 },
} as never);
