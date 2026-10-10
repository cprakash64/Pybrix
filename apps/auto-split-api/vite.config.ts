import { defineConfig } from 'vite';

/**
 * THE PRODUCTION SERVICE BUILD: one Node ES module, `dist/main.js`, from the production entry only.
 * The mock provider, the fixtures and the test server are not reachable from `main.ts`, so none of
 * them can be in this output; `production-boundary.test.ts` greps the built file to prove it.
 */
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'main.js', format: 'es' } },
  },
  ssr: { noExternal: [/^@cadfixer\//] },
});
