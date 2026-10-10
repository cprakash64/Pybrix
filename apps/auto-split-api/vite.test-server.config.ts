import { defineConfig } from 'vite';

/** THE TEST SERVER BUILD: `dist-test/test-server.js`. Never shipped, never deployed. */
export default defineConfig({
  build: {
    ssr: 'src/test-server.ts',
    target: 'node22',
    outDir: 'dist-test',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'test-server.js', format: 'es' } },
  },
  ssr: { noExternal: [/^@cadfixer\//] },
});
