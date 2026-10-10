import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Unit and component test configuration.
 *
 * Two projects, because the layers have genuinely different needs: the geometry
 * and format packages are platform-free and run under Node with no DOM at all —
 * which is itself a check that they have not quietly grown a browser
 * dependency — while the application is tested in jsdom.
 *
 * End-to-end tests live in `e2e/` and are run by Playwright, not Vitest.
 */
export default defineConfig({
  test: {
    // Test globals are not injected; every helper is imported explicitly.
    globals: false,
    projects: [
      {
        test: {
          name: 'packages',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        // The same-origin Auto Split analysis service: Node, no DOM.
        test: {
          name: 'service',
          environment: 'node',
          include: ['apps/auto-split-api/src/**/*.test.ts'],
        },
      },
      {
        // Repository tooling: the Node version guard and anything else that has
        // to run before a build exists.
        test: {
          name: 'tooling',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          // `*.node.test.ts` runs in the project below instead; see there for
          // why the WebAssembly kernel cannot be instantiated under jsdom.
          exclude: ['apps/web/src/workers/node-tests/**'],
          setupFiles: ['./apps/web/vitest.setup.ts'],
        },
      },
      {
        /*
         * WORKER TESTS THAT INSTANTIATE THE WEBASSEMBLY KERNEL.
         *
         * They cannot run under jsdom, and the reason is a property of the
         * kernel rather than a preference: `GEO::initialize()` executes an
         * `EM_ASM` snippet during Geogram's start-up that reads a global jsdom
         * does not provide, so the call throws — and because it throws before
         * the module's own initialisation flag is set, the NEXT call runs
         * `GEO::initialize()` again and trips Geogram's duplicate
         * attribute-registration assertion. Under Node and inside a real
         * browser worker — which is where this code actually runs — it works.
         *
         * So these tests run under Node, against the same artifact the browser
         * downloads, loaded with `wasmBinary` because the Emscripten glue is
         * built for `web,worker` and fetches its `.wasm` relative to
         * `import.meta.url`.
         */
        test: {
          name: 'worker-kernel',
          environment: 'node',
          include: ['apps/web/src/workers/node-tests/**/*.test.ts'],
          /*
           * THE EMSCRIPTEN GLUE IS LOADED BY NODE, NOT BY VITEST'S TRANSFORM.
           *
           * Geogram's start-up runs an `EM_ASM` snippet that begins
           * `typeof module !== "undefined" && this.module !== module` — its way
           * of detecting a CommonJS host so it can mount NODEFS. Vitest's module
           * runner puts a `module` binding in scope, so the guard passes and the
           * snippet then dereferences `this`, which is `undefined` in a strict
           * ES module. The call throws, `GEO::initialize()` never sets its own
           * initialised flag, and the NEXT call re-initialises Geogram and trips
           * its duplicate attribute-registration assertion.
           *
           * Externalising the artifact makes Node import it natively, where
           * `module` is genuinely undefined and the snippet correctly does
           * nothing — which is also what happens in the browser worker that
           * actually runs it.
           */
          server: { deps: { external: [/self-intersection\.js$/] } },
        },
      },
    ],
  },
});
