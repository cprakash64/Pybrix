import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration.
 *
 * Beyond the usual correctness rules, this file mechanically enforces two
 * project invariants that would otherwise rely on reviewer memory:
 *
 * 1. NETWORK SILENCE — the browser's network APIs are banned outright. CAD
 *    Fixer must not transmit anything, and the cheapest way to keep that true
 *    is to make an accidental `fetch` fail CI. Lifting this requires an ADR.
 * 2. LAYER SEPARATION — geometry packages may not import UI libraries, and no
 *    package may reach into the application.
 */

const networkGlobals = [
  {
    name: 'fetch',
    message: 'CAD Fixer does not make network requests. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'XMLHttpRequest',
    message: 'CAD Fixer does not make network requests. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'WebSocket',
    message: 'CAD Fixer does not open network connections. See docs/PRIVACY_ARCHITECTURE.md.',
  },
  {
    name: 'EventSource',
    message: 'CAD Fixer does not open network connections. See docs/PRIVACY_ARCHITECTURE.md.',
  },
];

const noBeacon = {
  selector: "MemberExpression[object.name='navigator'][property.name='sendBeacon']",
  message: 'Beacons exfiltrate data silently and are banned. See docs/PRIVACY_ARCHITECTURE.md.',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // Stage 5C release artifacts: a COPY of the production bundle, emitted by
      // scripts/build-release-artifact.mjs. The same minified bytes are already
      // excluded as '**/dist/**'; linting the copy would report thousands of
      // errors against generated output nobody authored. The PACKAGER itself,
      // under scripts/, is linted.
      'artifacts/release/**',
      // The end-to-end harness's own build output. Its SOURCE, under
      // apps/web/e2e-harness/, IS linted; only the emitted bundle is not.
      '**/dist-e2e-harness/**',
      '**/node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      // Stage 3A-2 bakeoff: third-party sources and the Emscripten SDK are
      // fetched, not authored here. Our own scripts and bindings under
      // experiments/ ARE linted; only the fetched trees are excluded.
      'experiments/repair-kernels/.toolchain/**',
      'experiments/repair-kernels/*/upstream/**',
      'experiments/repair-kernels/*/build/**',
      // The native Geogram reference build tree. CMake emits stub files named
      // `compiler_depend.ts` which are Makefile fragments, not TypeScript, and
      // the parser chokes on them.
      'experiments/repair-kernels/*/build-native/**',
      // Stage 3C-1A: the Emscripten glue emitted beside the self-intersection
      // WASM artifact is machine-generated, single-line and not authored here.
      // The harness, corpus and bindings in that directory ARE linted.
      'experiments/self-intersection/artifacts/**',
      // Stage 3C-1B: the PRODUCTION kernel's Emscripten glue. Machine-generated,
      // single-line, and not authored here. The binding that produces it and the
      // worker that consumes it ARE linted.
      'packages/self-intersection-kernel/artifacts/**',
      // Stage 7A: pinned upstream Emscripten output. The authored wrapper is linted.
      'apps/web/src/workers/third-party/manifold/manifold-candidate.js',
      'experiments/browser-harness/.cases/**',
      'experiments/repair-kernels/*/artifacts/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-globals': ['error', ...networkGlobals],
      'no-restricted-syntax': ['error', noBeacon],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Empty catch blocks and bare rethrows hide failures; the project rule is
      // that errors are surfaced as typed AppErrors.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // Geometry and format packages are platform- and framework-free.
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message: 'Geometry and format packages must not depend on the UI framework.',
            },
            {
              group: ['three', 'three/*'],
              message: 'Three.js is a rendering concern. The canonical mesh must not depend on it.',
            },
            {
              group: ['@cadfixer/web', '../../apps/*', '../../../apps/*'],
              message: 'Packages must not import from the application.',
            },
          ],
        },
      ],
    },
  },

  // React application code.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    // `configs.flat.*` is the flat-config form; `configs['recommended-latest']`
    // is still the legacy eslintrc shape and is rejected by ESLint 10.
    ...reactHooks.configs.flat['recommended-latest'],
  },

  // Node-hosted tooling and end-to-end specs.
  {
    files: [
      '*.config.ts',
      'e2e/**/*.ts',
      'e2e-browser/**/*.ts',
      'e2e-auto-split/**/*.ts',
      'playwright.*.config.ts',
      'experiments/**/*.spec.ts',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  /*
   * THE AUTO SPLIT SERVICE (Stage 08B-PROD-A1, ADR 0020).
   *
   * The ONE place outside the browser's own same-origin asset loading where this repository makes a
   * network request: the same-origin analysis service calls the model provider with `fetch`, from
   * `openai-provider.ts` ONLY, and its tests call their own local server. Nothing else under `apps/web` or
   * `packages/**` is exempt, and `scripts/production-boundary.test.ts` asserts that no other file in
   * the service names a network API. The service never receives a model file.
   */
  {
    files: [
      // The browser's one same-origin request (ADR 0020): a relative path, a request type with no
      // geometry field, and a boundary test that holds both.
      'apps/web/src/runtime/auto-split-transport.ts',
      'apps/auto-split-api/src/openai-provider.ts',
      'apps/auto-split-api/src/*.test.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': 'off',
    },
  },

  // Plain JS and .mjs live outside any tsconfig, so type-aware rules cannot run
  // against them. `.mjs` is included because the Stage 3A-2 experiment scripts
  // must be runnable by a bare `node` with no build step.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Node-hosted scripts that must run as plain JavaScript.
  //
  // `scripts/check-node-version.js` cannot be TypeScript: it guards the project
  // against unsupported runtimes and therefore has to execute before any build
  // or loader exists. `explicit-function-return-type` is turned off for these
  // files only because JavaScript has no return-type syntax to satisfy it —
  // the types are declared in the accompanying `.d.ts`, which IS checked.
  //
  // `scripts/release-server.mjs` is `.mjs` for the same reason: it is the
  // reference implementation of the production serving contract, so it has to be
  // runnable with plain `node` and no build step.
  {
    files: ['scripts/**/*.js', 'scripts/**/*.mjs', 'experiments/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-restricted-globals': 'off',
    },
  },

  /*
   * STAGE 6D-B3'S CHROMIUM MEMORY QUALIFICATION HARNESS.
   *
   * A Node script that DRIVES a browser, so it legitimately contains code for
   * two runtimes in one file: the harness itself runs under `node`, and the
   * bodies passed to `page.evaluate` are serialised and run inside the page,
   * where `document` and `MutationObserver` are exactly the right globals to
   * use. The e2e specs have the same shape and do not trip this only because
   * `no-undef` is off for TypeScript.
   *
   * Declared here rather than silenced at the call sites: a file that spans two
   * runtimes should say so once, in the config, instead of carrying five
   * disable comments that would also hide a genuine typo.
   */
  {
    files: ['scripts/chromium-memory.qualify.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-restricted-globals': 'off',
    },
  },

  /*
   * STAGE 6E-A1'S STREAMING QUALIFICATION HARNESS: a Node driver whose
   * `page.evaluate` bodies run in the page, and a worker entry Vite bundles
   * into a temporary directory. Same two-runtime reasoning as the B3 harness
   * above — but `no-restricted-globals` STAYS ON: neither file needs a network
   * API, and the local server the driver starts is Node's `http`, not a fetch.
   */
  {
    files: ['scripts/streaming-import.qualify.mjs'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['scripts/streaming-import.worker.mjs'],
    languageOptions: {
      globals: { ...globals.worker },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // The Stage 3A-3B experimental browser harness.
  //
  // These files run IN A BROWSER — a page and a module Worker — so they need
  // browser and worker globals, not Node's. They are plain JavaScript on
  // purpose: they are served to the browser as raw bytes, because putting them
  // (or the Emscripten glue they load) through a bundler is exactly the defect
  // that fabricated 321 "crashes" in Stage 3A-2. Return-type syntax does not
  // exist in JavaScript, and the Playwright-facing surface is typed in
  // `e2e-browser/harness.d.ts`, which IS checked.
  //
  // NOTE: `no-restricted-globals` stays ON. The repo-wide network-API ban
  // applies here too, and the harness deliberately contains no network call —
  // the candidate glue performs its own same-origin `.wasm` fetch.
  {
    files: ['experiments/browser-harness/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // The Stage 3C-1A self-intersection browser harness.
  //
  // Same reasoning as the Stage 3A-3B harness above: a page plus two module
  // Workers, served as raw bytes rather than bundled, so they need browser and
  // worker globals. `no-restricted-globals` stays ON — the network ban applies
  // to research code too, and the only fetch anywhere near this harness is the
  // Emscripten glue loading its own same-origin `.wasm`.
  // The Stage 4A-1 format research harness. Same reasoning as the harnesses
  // above: a page and its modules, served as raw bytes rather than bundled, so
  // they need browser globals. `no-restricted-globals` stays ON — the network
  // ban applies to research code, and this harness proves zero off-origin
  // requests rather than making any.
  {
    files: ['experiments/format-io/harness/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  {
    files: ['experiments/self-intersection/harness/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  prettier,
);
