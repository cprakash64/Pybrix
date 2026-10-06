import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PRODUCTION BOUNDARY, asserted from source rather than from a build.
 *
 * Two things have to stay true and neither is visible in review:
 *
 *   1. NO GEOMETRY KERNEL REACHES PRODUCTION. Manifold, Geogram and PMP are
 *      research artifacts under `experiments/`. A single import from `apps/**`
 *      or `packages/**` would put a multi-megabyte `.wasm` in front of users,
 *      and the first anyone would notice is the download.
 *
 *   2. THE ENGINES STAY IN THE WORKER CHUNK. `apps/web/src/workers/**` is the
 *      only main-application code allowed to import the topology engine, the
 *      repair engine or the format codecs. Everywhere else in `apps/web/src`
 *      talks to `@cadfixer/geometry-runtime`, which restates the contract's
 *      constants rather than re-exporting them — see
 *      `packages/geometry-runtime/src/repair.ts`.
 *
 * CHECKED FROM SOURCE, not from `dist`, on purpose. A test that reads a build
 * output either has to run a build — making the unit suite depend on the
 * bundler — or silently pass when `dist` is absent, which is the worst of both.
 * The import graph is what actually decides the answer, and it is always there.
 */

const REPO_ROOT = join(import.meta.dirname, '..');

/** Packages whose code must never be reachable from the main-thread bundle. */
const WORKER_ONLY_PACKAGES: readonly string[] = [
  '@cadfixer/mesh-topology',
  '@cadfixer/mesh-repair',
  /*
   * STAGE 4B-1B1. The hole-fill engine carries the triangulator, the
   * broadphase, every validator and — through `mesh-topology` — the whole
   * topology engine. The application names a fill STATUS and a summary, both of
   * which `geometry-runtime` restates without a runtime edge; see
   * `packages/geometry-runtime/src/hole-fill.ts`.
   */
  '@cadfixer/mesh-hole-fill',
];

/**
 * Codec entry points, which are a narrower rule than the package they live in.
 *
 * `@cadfixer/file-formats` IS a legitimate main-thread dependency: filename
 * screening and the declared capability list are exactly the parts the UI needs,
 * and they carry no parser. What must never cross is the CODEC surface — reading
 * and writing geometry — because codecs register inside the worker by design and
 * a main-thread import would pull a parser into the application bundle to do
 * nothing.
 */
const WORKER_ONLY_IMPORTS: readonly string[] = [
  'readStl',
  'requireWriter',
  'requireReader',
  'registerBuiltInFormats',
  /*
   * STAGE 4A-2B1. Three more parsers now live behind the same boundary, and
   * each is a different way to pull whole-file work into the application
   * bundle: `readObj` is a character scan, `read3mf` inflates an archive and
   * scans XML, and `identifyFormat` reads the head of the bytes. The main
   * thread never does any of it — it hands the file to the worker and receives
   * scalars back.
   */
  'readObj',
  'read3mf',
  'identifyFormat',
  'readZipDirectory',
  'readZipEntry',
  'scanXml',
];

/** Kernels qualified by research and deliberately not shipped. */
const RESEARCH_KERNELS: readonly string[] = [
  'manifold-3d',
  'geogram',
  'pmp-library',
  'lib3mf',
  'openvdb',
  'cgal',
  'opencascade',
  'occt-import-js',
];

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  walk(directory);
  return found;
}

/** Files under `apps/web/src` that are NOT part of the worker entry point. */
function mainThreadFiles(): string[] {
  const root = join(REPO_ROOT, 'apps', 'web', 'src');
  const workerDirectory = `workers${sep}`;
  return sourceFilesUnder(root).filter((file) => {
    const rel = relative(root, file);
    if (rel.startsWith(workerDirectory)) return false;
    // Tests may name anything: they run under Node, never in the browser, and
    // excluding them keeps the rule about SHIPPED code rather than about which
    // modules a test is allowed to look at.
    return !/\.test\.(ts|tsx)$/.test(rel);
  });
}

describe('the geometry engines stay in the worker', () => {
  for (const packageName of WORKER_ONLY_PACKAGES) {
    it(`is not imported by main-thread code: ${packageName}`, () => {
      const offenders = mainThreadFiles()
        .filter((file) => readFileSync(file, 'utf8').includes(packageName))
        .map((file) => relative(REPO_ROOT, file));

      expect(
        offenders,
        `these main-thread files import ${packageName}, which would pull the engine into the ` +
          `application bundle. Go through @cadfixer/geometry-runtime instead.`,
      ).toEqual([]);
    });
  }

  it('keeps the format CODECS out of main-thread code', () => {
    const offenders: string[] = [];
    for (const file of mainThreadFiles()) {
      const contents = readFileSync(file, 'utf8');
      // Only imports count. The word appearing in a comment is not a dependency.
      const importBlocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        if (!block.includes('@cadfixer/file-formats')) continue;
        for (const symbol of WORKER_ONLY_IMPORTS) {
          if (new RegExp(`\\b${symbol}\\b`).test(block)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${symbol}`);
          }
        }
      }
    }

    expect(offenders, 'a format codec became reachable from the application bundle').toEqual([]);
  });

  it('keeps the TEST-ONLY fixture and context modules out of production code', () => {
    /*
     * `file-formats` ships three modules that exist only for tests: the STL
     * fixture builders, the hand-authored ZIP/3MF archives, and the read
     * context that supplies `TextDecoder` and `DecompressionStream`. The
     * archives are deliberately EXPORTED from the package so the worker and
     * application suites exercise the same corpus the reader package does —
     * which is exactly why this check has to exist: an export is reachable, and
     * a production file that reached for one would ship a corpus of hostile
     * archives inside the application bundle.
     */
    const TEST_ONLY = [
      '@cadfixer/file-formats/threemf-fixtures',
      'threemf/zip-fixtures',
      'stl/fixtures',
      'file-formats/src/test-context',
      './test-context',
      '../test-context',
    ];
    const offenders: string[] = [];

    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
      // Tests may import fixtures; so, obviously, may the fixture and
      // test-context modules themselves.
    ].filter(
      (file) =>
        !/\.(test|bench-suite)\.(ts|tsx)$/.test(file) &&
        !file.endsWith('fixtures.ts') &&
        !file.endsWith('test-context.ts'),
    );

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/(?:import|export)[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const specifier of TEST_ONLY) {
          if (block.includes(specifier))
            offenders.push(`${relative(REPO_ROOT, file)}: ${specifier}`);
        }
      }
    }

    expect(offenders, 'a test-only fixture module became reachable from production').toEqual([]);
  });

  it('keeps the WRITER ORACLES out of production code', () => {
    /*
     * `obj-oracle.ts`, `threemf-oracle.ts` and `stl-oracle.ts` are structural
     * checkers that share
     * no code with the production readers ON PURPOSE: parse-back validation runs
     * our reader over our writer, which proves the two agree and nothing more,
     * so the oracles exist to catch a shared misunderstanding. Production
     * importing one would make them a second parser — the exact thing they must
     * not become.
     */
    const ORACLES = ['obj-oracle', 'threemf-oracle', 'stl-oracle'];
    const offenders: string[] = [];
    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.(test|bench-suite)\.(ts|tsx)$/.test(file));

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/(?:import|export)[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const oracle of ORACLES) {
          if (block.includes(oracle)) offenders.push(`${relative(REPO_ROOT, file)}: ${oracle}`);
        }
      }
    }

    expect(offenders, 'a test oracle became reachable from production').toEqual([]);
  });

  it('keeps the document WRITERS out of the main-thread bundle', () => {
    /*
     * STAGE 4A-2B3 CHANGED WHAT THIS PROTECTS, and deliberately did not delete
     * it.
     *
     * Until B3 the rule was that NOTHING in the application could reach the
     * export engine, because the engine existed and the workflow did not. The
     * workflow now exists, so that rule is gone — `use-document-conversion.ts`
     * reaches `DocumentExportService` on purpose, which is the feature.
     *
     * What survives is the rule that actually matters for the shipped product:
     * the SERIALISERS stay behind the worker boundary. `writeObjDocument`,
     * `write3mfDocument`, `writeStlDocument`, `exportDocument` and the ZIP
     * writer are tens of kilobytes of code that only ever runs off-thread, and
     * a main-thread import of any of them would pull all of it into the initial
     * bundle — paid for by every user who opens the page and never exports
     * anything. It would also be main-thread geometry work waiting to happen.
     */
    /*
     * THE READERS ARE ON THIS LIST TOO, and for the same reason. Import runs in
     * the authoritative worker; a main-thread import of `readStl` or `read3mf`
     * would pull the XML scanner, the ZIP reader and the STL detector into the
     * initial bundle. It has happened once already: the conversion policy
     * reached into the STL writer for `84 + n * 50` and arrived carrying
     * `stl/detect.ts`'s ASCII keyword tables, which are built at module scope
     * and therefore survive tree-shaking. The numbers now live in leaf modules
     * (`export/stl-layout.ts`, `threemf/units.ts`) that import nothing.
     */
    const WORKER_ONLY = [
      'writeObjDocument',
      'write3mfDocument',
      'writeStlDocument',
      'exportDocument',
      'buildZipArchive',
      'writeBinaryStl',
      'writeAsciiStl',
      'readStl',
      'readObj',
      'read3mf',
      'detectStlEncoding',
      'readZipDirectory',
      'readZipEntry',
      'scanXml',
      'parseModelXml',
    ];

    const offenders = mainThreadFiles()
      .filter((file) => {
        const contents = readFileSync(file, 'utf8');
        const blocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
        return blocks.some(
          (block) =>
            block.includes('@cadfixer/file-formats') &&
            WORKER_ONLY.some((name) => new RegExp(`\\b${name}\\b`).test(block)),
        );
      })
      .map((file) => relative(REPO_ROOT, file));

    expect(offenders, 'a codec became reachable from the application bundle').toEqual([]);
  });

  it('keeps the size and unit constants in leaf modules with no imports', () => {
    /*
     * THE MECHANISM THAT MAKES THE RULE ABOVE KEEPABLE.
     *
     * The main thread genuinely needs two things from the format layer: how big
     * a binary STL of N triangles is, and which unit tokens 3MF allows. Both are
     * arithmetic and constants. They live in modules that import NOTHING, so a
     * main-thread import of either cannot drag a codec along with it — and a
     * future import added to one of them would fail here rather than silently
     * adding kilobytes to every page load.
     */
    for (const leaf of [
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'export', 'stl-layout.ts'),
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'units.ts'),
    ]) {
      const contents = readFileSync(leaf, 'utf8');
      const imports = contents.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? [];
      expect(imports, `${relative(REPO_ROOT, leaf)} must import nothing`).toEqual([]);
    }
  });

  it('constructs the export worker from exactly one place', () => {
    /*
     * ONE OWNER OF THE DISPOSABLE WORKER.
     *
     * `DocumentExportService` cancels by TERMINATING its worker, which is only
     * safe while it is the only thing that made one. A component that built its
     * own `export.worker.ts` would be a second lifecycle: two exports racing for
     * the same ceilings, and a Cancel that killed one of them.
     */
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );

    const constructors = files
      .filter((file) => /new Worker\([\s\S]*?export\.worker/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(constructors).toEqual([
      join('apps', 'web', 'src', 'runtime', 'document-export-service.ts'),
    ]);
  });

  it('keeps the 3MF expansion counters out of production code', () => {
    /*
     * `ThreeMfExpansionStats` exists so a test can prove that an over-large
     * expansion stops at the ceiling instead of running to completion. It is
     * instrumentation, and instrumentation that production passes is a debug
     * channel: it would mean the shipped reader writes counters nobody reads,
     * on a path taken by every import.
     */
    const offenders: string[] = [];
    const productionFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter(
      (file) =>
        !/\.(test|bench-suite)\.(ts|tsx)$/.test(file) &&
        !file.endsWith(join('threemf', 'threemf-reader.ts')),
    );

    for (const file of productionFiles) {
      const contents = readFileSync(file, 'utf8');
      // The type name is the exact marker: naming it is the only way to pass
      // one, and `stats:` alone matches unrelated fields elsewhere.
      if (/\bThreeMfExpansionStats\b/.test(contents)) offenders.push(relative(REPO_ROOT, file));
    }

    expect(offenders, 'expansion counters must stay test-only').toEqual([]);
  });

  it('keeps the end-to-end harness out of the application', () => {
    /*
     * THE HARNESS IS NOT A BACKDOOR, and this is what makes that checkable.
     *
     * `apps/web/e2e-harness/` builds a synthetic multi-part document so the
     * browser suite can test what no shipped codec can produce. It is a
     * separate Vite root with a separate entry, so the application build has no
     * path to it — but "no path" is a property of an import graph, and an
     * import graph is exactly the kind of thing that acquires an edge by
     * accident. One import from `apps/web/src` would put a synthetic-document
     * importer in front of every user.
     */
    const offenders = [...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src'))]
      .filter((file) => readFileSync(file, 'utf8').includes('e2e-harness'))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      'application source must not reference the end-to-end harness in any form',
    ).toEqual([]);
  });

  it('builds the application from exactly one entry, which is not the harness', () => {
    // The structural half of the same guarantee. A second `input` in the
    // application's Vite config would emit the harness into `dist/` for every
    // deployment, whatever the import graph said.
    const appConfig = readFileSync(join(REPO_ROOT, 'apps', 'web', 'vite.config.ts'), 'utf8');

    expect(appConfig).not.toContain('e2e-harness');
    expect(appConfig).not.toContain('rollupOptions');
    expect(appConfig).not.toContain('rolldownOptions');

    // And the harness config inverts the root, so it cannot emit into the
    // application's output directory either.
    const harnessConfig = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'vite.harness.config.ts'),
      'utf8',
    );
    expect(harnessConfig).toContain("root: 'e2e-harness'");
    expect(harnessConfig).toContain("outDir: '../dist-e2e-harness'");
  });

  it('never injects a worker in the production entry point', () => {
    /*
     * `GeometryClientOptions.createWorker` exists so the harness can drive a
     * worker whose importer builds a synthetic document. It chooses a SCRIPT and
     * cannot inject geometry — but the production ENTRY POINT must still not
     * pass one, or the application would be running something other than the
     * geometry worker.
     *
     * The same seam already existed for the diagnostic worker
     * (`SelfIntersectionService`) and, since Stage 4A-2B2, for the export worker
     * (`DocumentExportService`). All three are worker-factory DECLARATIONS, each
     * inside its own module, and none is a call site anywhere else. The list is
     * exact rather than a maximum so that a fourth one has to be argued for.
     */
    const entry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    expect(entry).not.toContain('createWorker');

    const injectors = mainThreadFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('createWorker'))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(injectors).toEqual(
      [
        join('apps', 'web', 'src', 'runtime', 'document-export-service.ts'),
        join('apps', 'web', 'src', 'runtime', 'geometry-client.ts'),
        join('apps', 'web', 'src', 'runtime', 'hole-fill-service.ts'),
        join('apps', 'web', 'src', 'runtime', 'self-intersection-service.ts'),
      ].sort(),
    );
  });

  it('exposes no document-injection global or query parameter in the application', () => {
    // The shapes a reviewer would look for first: a window global, a URL switch,
    // or a debug hook that reaches authoritative geometry.
    const BANNED = [
      '__CADFIXER',
      'cadfixerHarness',
      'window.cadfixer',
      'globalThis.cadfixer',
      "searchParams.get('document",
      "searchParams.get('fixture",
    ];
    const offenders: string[] = [];

    for (const file of [...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src'))].filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    )) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }

    expect(offenders, 'the application must expose no route to inject a document').toEqual([]);
  });

  it('keeps AUTHORITATIVE geometry types out of main-thread code', () => {
    /*
     * STAGE 4A-2A. The main thread holds a `DocumentHandle`, scalar part
     * descriptors and disposable render snapshots. It must never hold — or even
     * be able to name — the authoritative types, because a component that can
     * name a `CanonicalMesh` is one refactor away from storing one, and React
     * state holding a multi-hundred-megabyte document is exactly the ownership
     * inversion ADR 0008 exists to prevent.
     *
     * Names in COMMENTS are fine and deliberate: several files explain what they
     * are NOT holding. Only imports count.
     */
    const AUTHORITATIVE = ['CanonicalMesh', 'GeometryDocument', 'GeometryPart'];
    const offenders: string[] = [];

    for (const file of mainThreadFiles()) {
      const contents = readFileSync(file, 'utf8');
      const importBlocks = contents.match(/import[\s\S]*?from\s+['"][^'"]+['"]/g) ?? [];
      for (const block of importBlocks) {
        for (const symbol of AUTHORITATIVE) {
          if (new RegExp(`\\b${symbol}\\b`).test(block)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${symbol}`);
          }
        }
      }
    }

    expect(
      offenders,
      'the main thread must name handles and descriptors, never authoritative geometry',
    ).toEqual([]);
  });

  it('routes the repair contract through the runtime’s restatement', () => {
    // The positive half of the rule: the UI does name repair decisions, and it
    // gets them from the package that restates them without a runtime edge to
    // the engine.
    const presentation = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'state', 'repair-presentation.ts'),
      'utf8',
    );

    expect(presentation).toContain("from '@cadfixer/geometry-runtime'");
    expect(presentation).not.toContain('@cadfixer/mesh-repair');
  });
});

describe('the self-intersection kernel is confined to its own worker', () => {
  /*
   * WHAT CHANGED IN STAGE 3C-1B, and why this section had to be rewritten.
   *
   * Geogram now SHIPS. It is compiled into the WebAssembly kernel that backs the
   * read-only self-intersection diagnostic, and pretending otherwise would make
   * this file assert a fiction. What still holds — and what these tests now
   * check — is the boundary: the kernel is reachable ONLY from the disposable
   * diagnostic worker, so a user who never runs a check never downloads it and
   * the main-thread bundle never contains it.
   *
   * The kernel is NOT in RESEARCH_KERNELS. Those are the packages qualified and
   * deliberately not shipped; this one was qualified and deliberately IS.
   */
  const KERNEL_PACKAGE = '@cadfixer/self-intersection-kernel';
  const DIAGNOSTIC_WORKER = join('apps', 'web', 'src', 'workers', 'self-intersection.worker.ts');
  const HOLE_FILL_NARROWPHASE = join('apps', 'web', 'src', 'workers', 'hole-fill-narrowphase.ts');

  it('is imported by exactly the files named here, all of them worker code', () => {
    /*
     * THE LIST IS EXACT RATHER THAN A MAXIMUM, so a fourth importer has to be
     * argued for in review instead of appearing quietly.
     *
     * STAGE 4B-1B1 added two entries. `hole-fill-narrowphase.ts` wraps the
     * kernel as the fill engine's exact predicate and is imported only by the
     * disposable fill worker; its `.node.test.ts` runs the HP corpus against
     * that predicate and never ships. Both are under `apps/web/src/workers/`,
     * which the main-thread scan below excludes wholesale.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];
    const importers = files
      .filter((file) =>
        new RegExp(`from\\s+['"]${KERNEL_PACKAGE}`).test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers, 'the WASM kernel must be reachable from worker code only').toEqual(
      [
        DIAGNOSTIC_WORKER,
        HOLE_FILL_NARROWPHASE,
        join('apps', 'web', 'src', 'workers', 'node-tests', 'hole-fill-kernel.test.ts'),
        /*
         * STAGE 4B-1B1-R1. The rebuilt artifact is compared, fixture by
         * fixture, against the pre-B1B1 one extracted from git — so this test
         * instantiates the CURRENT kernel beside the historical one. It never
         * ships.
         */
        join('apps', 'web', 'src', 'workers', 'node-tests', 'kernel-differential.test.ts'),
        join('apps', 'web', 'src', 'workers', 'node-tests', 'wasm-build-differential.test.ts'),
        /*
         * REPAIR-CORE-02. The local-region fill pipeline against the shipped
         * kernel, beside the whole-part engine with the same kernel. Never ships.
         */
        join('apps', 'web', 'src', 'workers', 'node-tests', 'local-fill-kernel.test.ts'),
      ].sort(),
    );
  });

  it('is never imported by main-thread code', () => {
    const offenders = mainThreadFiles()
      .filter((file) => readFileSync(file, 'utf8').includes(KERNEL_PACKAGE))
      .map((file) => relative(REPO_ROOT, file));

    expect(
      offenders,
      'importing the kernel from the main thread would pull ~1.2 MB of WebAssembly into the ' +
        'application bundle for every user, including those who never run the check',
    ).toEqual([]);
  });

  it('keeps the diagnostic CONTRACT free of the kernel', () => {
    // The contract package carries policy, caps and taxonomy so the application
    // can reason about the diagnostic without loading a geometry kernel to do it.
    const contract = sourceFilesUnder(join(REPO_ROOT, 'packages', 'mesh-self-intersection'));
    for (const file of contract) {
      expect(
        readFileSync(file, 'utf8').includes(KERNEL_PACKAGE),
        `${relative(REPO_ROOT, file)} must not reach for the kernel`,
      ).toBe(false);
    }
  });
});

describe('no UNSHIPPED geometry kernel reaches production', () => {
  it('is not imported anywhere in the application or its packages', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      /*
       * AN IMPORT OF THE EXPERIMENTS TREE, in any form a bundler would follow.
       *
       * TESTS ARE EXEMPT, and deliberately so. Stage 4A-2B1's differential
       * suite runs the same bytes through the production parsers and through
       * the qualified research readers and compares the results — which is the
       * whole point: a parser that is its own oracle proves only that it is
       * self-consistent. A `.test.ts` never ships, so importing a reference
       * implementation into one puts nothing in front of a user.
       *
       * The ban stays absolute for everything else, including test HELPERS that
       * are not themselves tests, because those can be imported by anything.
       */
      const isTest = /\.test\.(ts|tsx)$/.test(file);
      if (!isTest && /from\s+['"][^'"]*experiments\//.test(contents)) {
        offenders.push(`${relative(REPO_ROOT, file)} (imports from experiments/)`);
      }
      for (const kernel of RESEARCH_KERNELS) {
        if (new RegExp(`from\\s+['"]${kernel}`).test(contents)) {
          offenders.push(`${relative(REPO_ROOT, file)} (imports ${kernel})`);
        }
      }
    }

    expect(offenders, 'a geometry kernel became reachable from production code').toEqual([]);
  });

  it('lets ONLY tests reach the research tree, and names the ones that do', () => {
    /*
     * The exemption above is narrow, and this is what keeps it narrow: the list
     * of files allowed to import a research reference is written down, so
     * adding another is a deliberate act that shows up in review rather than a
     * quiet widening of the rule.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ];

    const importers = files
      .filter((file) => /from\s+['"][^'"]*experiments\//.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers).toEqual(
      [
        join('packages', 'file-formats', 'src', 'format-differential.test.ts'),
        /*
         * STAGE 4B-1B1-R1. The Stage 3C kernel differential runs the FROZEN
         * research corpus — the 24 hand-authored adversarial fixtures and the
         * three regenerated shells — through the old and new artifacts. Reusing
         * the frozen corpus is the point: a differential over a corpus invented
         * for the occasion would prove the rebuild agrees with itself on cases
         * chosen after the fact.
         */
        join('apps', 'web', 'src', 'workers', 'node-tests', 'kernel-differential.test.ts'),
        join('apps', 'web', 'src', 'workers', 'node-tests', 'wasm-build-differential.test.ts'),
      ].sort(),
    );
  });

  it('is not declared as a dependency of any shipped package', () => {
    const manifests = [
      join(REPO_ROOT, 'package.json'),
      join(REPO_ROOT, 'apps', 'web', 'package.json'),
      ...readdirSync(join(REPO_ROOT, 'packages')).map((name) =>
        join(REPO_ROOT, 'packages', name, 'package.json'),
      ),
    ];

    for (const manifest of manifests) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const declared = parsed as { dependencies?: Record<string, string> };
      const names = Object.keys(declared.dependencies ?? {});

      for (const kernel of RESEARCH_KERNELS) {
        expect(names, `${relative(REPO_ROOT, manifest)} declares ${kernel}`).not.toContain(kernel);
      }
    }
  });
});

describe('no network API reaches production', () => {
  /**
   * The lint config bans these repo-wide, and this is the second, independent
   * check — a rule can be disabled in a config file, and the whole privacy
   * argument rests on this one property. See docs/PRIVACY_ARCHITECTURE.md.
   */
  const BANNED = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon'];

  it('appears nowhere in shipped application or package source', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const api of BANNED) {
        if (contents.includes(api)) offenders.push(`${relative(REPO_ROOT, file)}: ${api}`);
      }
    }

    expect(offenders, 'a network API reached shipped code').toEqual([]);
  });
});

describe('the hole-fill engine stays where Stage 4B-1B1 put it', () => {
  /*
   * WHAT THIS SECTION PROTECTS, and why each rule is separate.
   *
   * The engine is production, the workflow is not. Stage 4B-1B1 ships an engine
   * behind the worker boundary with NO user-facing control; Stage 4B-1B2 will
   * add selection, preview and Apply. Until it does, an accidental import from
   * a component would put a half-finished feature in front of users, and an
   * accidental import from `experiments/` would put research code in the
   * bundle.
   */
  const HOLE_FILL_ENGINE = '@cadfixer/mesh-hole-fill';

  it('is imported only by worker code and by the runtime restatement', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const importers = files
      .filter((file) =>
        new RegExp(`from\\s+['"]${HOLE_FILL_ENGINE}`).test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    expect(importers).toEqual(
      [
        join('apps', 'web', 'src', 'workers', 'hole-fill.worker.ts'),
        join('apps', 'web', 'src', 'workers', 'hole-fill-narrowphase.ts'),
        join('packages', 'geometry-runtime', 'src', 'hole-fill.ts'),
        /*
         * REPAIR-CORE-02, and ONLY through `/admission` — asserted below. The
         * authoritative geometry worker plans and assembles automatic fills;
         * the engine entry, the BVH and the narrowphase stay in the disposable
         * worker.
         */
        join('apps', 'web', 'src', 'workers', 'boundary-fill.ts'),
        /*
         * REPAIR-CORE-06A, with the same restriction: the authoritative side of the local pinch
         * repair imports ONLY `/admission` (asserted below) — fan topology and the work-limit
         * constants. The search, the exact gate and the residual phase run in the disposable
         * kernel worker (`hole-fill.worker.ts`, already listed). The geometry-runtime file is the
         * wire restatement, which holds type-level mirrors of the engine's enumerations.
         */
        join('apps', 'web', 'src', 'workers', 'local-repair-stage.ts'),
        join('packages', 'geometry-runtime', 'src', 'local-repair.ts'),
        /*
         * THE HARNESS, and it is named rather than excluded so its access is
         * visible in review. It imports the TEST-ONLY fixture corpus in order to
         * build documents the shipped importers cannot — a 512-vertex rim, and
         * the HP23 configuration whose patch pierces a wall — and it is not an
         * input to the application build, which the checks above assert.
         */
        join('apps', 'web', 'e2e-harness', 'fixtures.ts'),
      ].sort(),
    );
  });

  it('reaches the geometry worker only through the bounded admission subpath (REPAIR-CORE-02)', () => {
    for (const name of ['boundary-fill.ts', 'local-repair-stage.ts']) {
      const worker = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'workers', name), 'utf8');
      const specifiers = [
        ...worker.matchAll(/from\s+['"](@cadfixer\/mesh-hole-fill[^'"]*)['"]/g),
      ].map((match) => match[1]);
      expect(specifiers, name).toEqual(['@cadfixer/mesh-hole-fill/admission']);
    }

    // Everything the subpath reaches, transitively, inside the package.
    const packageSource = join(REPO_ROOT, 'packages', 'mesh-hole-fill', 'src');
    const reached = new Set<string>();
    const visit = (file: string): void => {
      if (reached.has(file)) return;
      reached.add(file);
      const contents = readFileSync(join(packageSource, file), 'utf8');
      for (const match of contents.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
        visit(`${match[1] ?? ''}.ts`);
      }
    };
    visit('admission-entry.ts');
    for (const forbidden of [
      'engine.ts',
      'bvh.ts',
      'local-intersection.ts',
      'validate.ts',
      'index.ts',
    ]) {
      expect(reached.has(forbidden), `the admission subpath must not reach ${forbidden}`).toBe(
        false,
      );
    }
  });

  it('ships NO narrowphase of its own', () => {
    /*
     * The engine takes its exact predicate as a parameter. A local
     * implementation inside the package would be a second, weaker predicate
     * shipped beside the qualified one — and `fixtures.ts` deliberately holds a
     * separating-axis checker for tests, which must never become reachable from
     * production.
     */
    const production = sourceFilesUnder(join(REPO_ROOT, 'packages', 'mesh-hole-fill')).filter(
      (file) => !file.endsWith('.test.ts') && !file.endsWith('fixtures.ts'),
    );
    for (const file of production) {
      const contents = readFileSync(file, 'utf8');
      expect(
        contents.includes('trianglesIntersect'),
        `${relative(REPO_ROOT, file)} must not carry a triangle intersection predicate`,
      ).toBe(false);
      expect(contents.includes('referenceNarrowphase')).toBe(false);
    }
  });

  /*
   * STAGE 4B-1B2 REPLACED THE "NO CONTROL" ASSERTION.
   *
   * Stage 4B-1B1 asserted that no Fill control existed anywhere, because the
   * engine shipped without a workflow and "we will wire it up later" had to be
   * kept from becoming "it is already wired up". That stage is closed and the
   * workflow now exists, so the old assertion describes behaviour that has
   * legitimately changed. It is REPLACED rather than deleted: the checks below
   * assert precisely what the workflow may and may not offer, which is a
   * stronger statement than the absence it replaces.
   */
  it('offers exactly ONE fill control, and it is not a batch one', () => {
    /*
     * FILL-ALL IS STILL FORBIDDEN, and always will be without an explicit
     * decision: it would close every opening in a model, including the
     * intentional ones, from a single click. So is any wording that promises to
     * fill more than the one opening the user selected.
     */
    const BANNED = ['Fill All', 'fill all', 'Fill Holes', 'fill every', 'Close All'];
    const componentFiles = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src', 'components')),
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src', 'state')),
    ];

    const offenders: string[] = [];
    for (const file of componentFiles) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'batch filling is out of scope and must stay out').toEqual([]);
  });

  it('commits a hole-fill candidate from exactly ONE place', () => {
    /*
     * THE STAGE 4B-1B2 COUNTERPART of the registration check below. `Apply` is
     * the only path by which proposed geometry becomes the user's model, and it
     * goes through `HoleFillCandidateStore.prepareCommit` — which applies every
     * identity, lifecycle and staleness guard — followed by
     * `residentDocuments.replace`. A second commit path would be a second set of
     * rules, and the two would eventually disagree.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const callers = files
      .filter((file) => readFileSync(file, 'utf8').includes('holeFillCandidates.prepareCommit('))
      .map((file) => relative(REPO_ROOT, file));

    expect(callers).toEqual([
      join('apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
    ]);

    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    // And the guard runs BEFORE the swap. An ordering inversion would let a
    // stale or consumed candidate replace a part and only then be refused.
    const guard = handlers.indexOf('holeFillCandidates.prepareCommit(');
    const swap = handlers.indexOf('residentDocuments.replace(');
    expect(guard).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(guard);
  });

  it('builds every fallible answer BEFORE the authoritative swap', () => {
    /*
     * THE TRANSACTION ORDERING, asserted structurally — Stage 4B-1B2-R2.
     *
     * `residentDocuments.replace` is the atomic step: before it the user has the
     * old document, after it the new one. Everything that CAN FAIL has to happen
     * before it, because a failure afterwards would be reported to the caller as
     * an ordinary error while the document had already changed — telling a user
     * their fill failed when it succeeded, which the interface then acts on.
     *
     * `buildRenderSnapshot` allocates megabytes for a large part, `describeParts`
     * allocates a descriptor per part, and `reportProgress` posts on a channel
     * that can be gone. All three now precede the swap. What follows it is a
     * string concatenation, two bounded map writes and an object literal.
     *
     * Source order is asserted here and the BEHAVIOUR is exercised in
     * `hole-fill-atomicity.test.ts`, which injects a failing snapshot builder
     * through a construction seam. Neither alone is enough: order does not prove
     * the handler copes with a failure, and a passing failure test would not
     * notice a future statement quietly added below the swap.
     */
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    const commitBody = commit.slice(commit.indexOf('createHoleFillCommitHandler'));
    const snapshot = commitBody.indexOf('work.buildRenderSnapshot(');
    const describe_ = commitBody.indexOf('work.describeParts(');
    const progress = commitBody.indexOf('context.reportProgress(');
    const swap = commitBody.indexOf('residentDocuments.replace(');
    const consume = commitBody.indexOf('holeFillCandidates.markCommitted(');
    const record = commitBody.indexOf('repairHistory.record(');
    for (const [name, at] of [
      ['buildRenderSnapshot', snapshot],
      ['describeParts', describe_],
      ['reportProgress', progress],
      ['replace', swap],
      ['markCommitted', consume],
      ['record', record],
    ] as const) {
      expect(at, `${name} is missing from holefill/commit`).toBeGreaterThan(-1);
    }
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(progress).toBeLessThan(swap);
    expect(consume).toBeGreaterThan(swap);
    expect(record).toBeGreaterThan(consume);

    /*
     * AND NOTHING ALLOCATING SURVIVES BELOW THE SWAP. Named rather than
     * inferred: these are the calls that would reintroduce the defect, and a
     * substring scan of the committed region is what catches one being added
     * back without anybody thinking about the ordering.
     */
    /*
     * BOUNDED AT THE END OF THE HANDLER, not at the end of the file. The
     * successor-document helper is defined below the factory and legitimately
     * calls `assertGeometryDocument`; scanning past the handler would flag it
     * for running "after the swap" when it runs before, from inside the
     * preparation.
     */
    const commitEnd = commitBody.indexOf('export const holeFillCommitHandler =');
    expect(commitEnd).toBeGreaterThan(swap);
    const committedRegion = commitBody.slice(swap, commitEnd);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'documentByteLength',
      'assertMeshStructure',
      'assertGeometryDocument',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in holefill/commit`,
      ).toBe(false);
    }
  });

  it('CRT13: repair/commit builds every fallible answer BEFORE the authoritative swap', () => {
    /*
     * THE SAME PROTECTION HOLE FILLING GOT IN STAGE 4B-1B2-R2, extended to
     * conservative repair in Stage 4B-1C. `buildRenderSnapshot` allocates and
     * can fail; running it after `replace` meant a failure was reported to the
     * caller as an ordinary error while the document had already changed.
     */
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    const body = commit.slice(commit.indexOf('createRepairCommitHandler'));
    const snapshot = body.indexOf('work.buildRenderSnapshot(');
    const describe_ = body.indexOf('work.describeParts(');
    const progress = body.indexOf('context.reportProgress(');
    const swap = body.indexOf('residentDocuments.replace(');
    const consume = body.indexOf('repairCandidates.markCommitted(');
    const record = body.indexOf('repairHistory.record(');
    for (const [name, at] of [
      ['buildRenderSnapshot', snapshot],
      ['describeParts', describe_],
      ['reportProgress', progress],
      ['replace', swap],
      ['markCommitted', consume],
      ['record', record],
    ] as const) {
      expect(at, `${name} is missing from repair/commit`).toBeGreaterThan(-1);
    }
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(progress).toBeLessThan(swap);
    expect(consume).toBeGreaterThan(swap);
    expect(record).toBeGreaterThan(consume);

    const end = body.indexOf('export const repairCommitHandler =');
    expect(end).toBeGreaterThan(swap);
    const committedRegion = body.slice(swap, end);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'documentByteLength',
      'assertMeshStructure',
      'assertGeometryDocument',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in repair/commit`,
      ).toBe(false);
    }
  });

  it('reconstructs undo from a RETAINED MESH, never from a patch', () => {
    /*
     * STAGE 4B-1C. Repair's undo rebuilt the pre-repair mesh from a patch of
     * removed triangles, which returned an indexed OBJ or 3MF as triangle soup
     * and turned one shared mesh into two byte-equal ones. The patch is gone —
     * along with the module that defined it — so there is ONE reconstruction and
     * the two kinds of change cannot drift apart.
     */
    /*
     * SHIPPED SOURCE ONLY. Tests may still NAME the removed functions — the
     * repair suite explains what they did and why they went, which is the record
     * of the defect and is worth keeping readable.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
      ...sourceFilesUnder(join(REPO_ROOT, 'scripts')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of ['restoreFromInverse', 'buildInversePatch', 'RepairInversePatch']) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'undo reconstruction from a patch must stay removed').toEqual([]);

    // And the module that defined them is gone, not merely unreferenced.
    expect(existsSync(join(REPO_ROOT, 'packages', 'mesh-repair', 'src', 'inverse.ts'))).toBe(false);
  });

  it('builds every fallible answer BEFORE the authoritative swap, in undo too', () => {
    const undo = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    const undoBody = undo.slice(undo.indexOf('createRepairUndoHandler'));
    const snapshot = undoBody.indexOf('work.buildRenderSnapshot(');
    const describe_ = undoBody.indexOf('work.describeParts(');
    const swap = undoBody.indexOf('residentDocuments.replace(');
    const mark = undoBody.indexOf('repairHistory.markUndone(');
    const release = undoBody.indexOf('holeFillCandidates.releaseDocument(');
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(swap);
    expect(describe_).toBeLessThan(swap);
    expect(mark).toBeGreaterThan(swap);
    expect(release).toBeGreaterThan(mark);

    const undoEnd = undoBody.indexOf('export const repairUndoHandler =');
    expect(undoEnd).toBeGreaterThan(swap);
    const committedRegion = undoBody.slice(swap, undoEnd);
    for (const banned of [
      'buildRenderSnapshot',
      'describeParts',
      'reportProgress',
      'computeBounds',
      'restoreFromInverse',
      'assertMeshStructure',
    ]) {
      expect(
        committedRegion.includes(banned),
        `${banned} runs after the authoritative swap in repair/undo`,
      ).toBe(false);
    }
  });

  it('registers the production handlers, and only those', () => {
    /*
     * THE SEAM IS A CONSTRUCTION SEAM, NOT A FAULT SWITCH — Stage 4B-1B2-R2.
     *
     * `createHoleFillCommitHandler` and `createRepairUndoHandler` take their
     * fallible work as a parameter so a test can make it fail. That is only safe
     * while the APPLICATION builds exactly one of each, from the production
     * defaults — otherwise the parameter becomes a way to divert real work,
     * which is the bypass hook the scan above forbids.
     */
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );
    const callers = files
      .filter((file) =>
        /createHoleFillCommitHandler\(|createRepairUndoHandler\(|createRepairCommitHandler\(/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(REPO_ROOT, file))
      .sort();
    expect(callers).toEqual(
      [
        join('apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
        join('apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      ].sort(),
    );

    // And each builds its exported handler from the production defaults.
    const commit = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    expect(commit).toContain('createHoleFillCommitHandler(PRODUCTION_COMMIT_WORK)');
    const undo = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'repair-handlers.ts'),
      'utf8',
    );
    expect(undo).toContain('createRepairUndoHandler(PRODUCTION_UNDO_WORK)');
    expect(undo).toContain('createRepairCommitHandler(PRODUCTION_COMMIT_WORK)');
  });

  it('keeps the undo inverse OUT of the wire protocol', () => {
    /*
     * STAGE 4B-1B2-R1. `UndoableInverse` now carries a `CanonicalMesh` — the
     * exact mesh a part held before a fill — so that undo can restore the
     * document's sharing and not merely its bytes. That mesh is authoritative
     * geometry and must never reach the page (ADR 0008).
     *
     * It cannot today, because no payload or result names the type. This asserts
     * that, so the day someone reaches for the inverse to describe an undo over
     * the wire, they are told rather than shipping a mesh to React.
     */
    const protocol = readFileSync(
      join(REPO_ROOT, 'packages', 'geometry-runtime', 'src', 'protocol.ts'),
      'utf8',
    );
    expect(protocol).not.toContain('UndoableInverse');
    expect(protocol).not.toContain('previousMesh');
    // `UndoableChangeKind` — a string union — IS on the wire, and that is fine:
    // it is what lets a result say which kind of change was reversed.
    expect(protocol).toContain('UndoableChangeKind');
  });

  it('never re-runs the engine while applying a candidate', () => {
    /*
     * THE CORE PRODUCT-SAFETY GUARANTEE OF STAGE 4B-1B2: what the user previewed
     * is what Apply commits. That holds because the commit path reads the mesh
     * the candidate store already holds and does nothing else — no
     * triangulation, no planarity test, no broadphase, no narrowphase, no
     * boundary-loop extraction of the candidate.
     *
     * Asserted structurally rather than by measurement, because a timing test
     * would pass on a fast machine with the re-run present.
     */
    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-workflow-handlers.ts'),
      'utf8',
    );
    const commit = handlers.slice(handlers.indexOf('holeFillCommitHandler'));
    for (const banned of [
      'runHoleFill',
      'earClip',
      'assessPlanarity',
      'FaceBvh',
      'narrowphase',
      'sendForFill',
    ]) {
      expect(commit.includes(banned), `holefill/commit must not reach ${banned}`).toBe(false);
    }

    // And the engine is not even importable from the commit module.
    expect(handlers).not.toContain("from '@cadfixer/mesh-hole-fill'");
  });

  it('registers a hole-fill candidate from exactly ONE place', () => {
    /*
     * STAGE 4B-1B1-R1. `HoleFillCandidateStore.create` is the only way geometry
     * becomes a candidate, and the byte-preservation gate sits immediately
     * before the single call site. A second caller would be a second way in —
     * one that had not compared the candidate against the resident source — so
     * the number of call sites is asserted rather than assumed.
     */
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const callers = files
      .filter((file) =>
        /holeFillCandidates\.create\(|CandidateStore\(\)\.create\(/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => relative(REPO_ROOT, file));

    expect(callers).toEqual([join('apps', 'web', 'src', 'workers', 'hole-fill-handlers.ts')]);

    // And that one call site is guarded: the gate has to be in the same file,
    // above it.
    const handlers = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-handlers.ts'),
      'utf8',
    );
    const gate = handlers.indexOf('sourcePositionsPreserved');
    const registration = handlers.indexOf('holeFillCandidates.create(');
    expect(gate).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(gate);
  });

  it('exposes no corruption or bypass hook in shipped code', () => {
    /*
     * The mutation injection that proves the gate works lives entirely in
     * `hole-fill-handlers.test.ts`, which substitutes a corrupted reply at the
     * channel boundary. Nothing in production can produce one.
     */
    const BANNED = ['corruptCandidate', 'skipPreservationCheck', 'bypassPreservation'];
    const offenders: string[] = [];
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const banned of BANNED) {
        if (contents.includes(banned)) offenders.push(`${relative(REPO_ROOT, file)}: ${banned}`);
      }
    }
    expect(offenders, 'the corruption path must remain test-only').toEqual([]);
  });

  it('wraps the application in an error boundary, outside the providers', () => {
    /*
     * STAGE 5A. React unmounts the whole tree when a component throws during
     * render, so without a boundary one unexpected interface bug replaced the
     * entire application with a blank page — no message, no reload affordance,
     * and a model still sitting in a worker the user could no longer reach.
     *
     * ASSERTED AS AN ORDERING, not merely as an import. The boundary has to be
     * OUTSIDE the providers: a throw inside a provider's own render would
     * otherwise be outside anything that could catch it, which is exactly the
     * case being defended against.
     */
    const entry = readFileSync(join(REPO_ROOT, 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    const boundary = entry.indexOf('<ErrorBoundary>');
    const workspace = entry.indexOf('<WorkspaceProvider');
    const app = entry.indexOf('<App />');

    expect(boundary, 'the application must be wrapped in ErrorBoundary').toBeGreaterThan(-1);
    expect(workspace).toBeGreaterThan(boundary);
    expect(app).toBeGreaterThan(workspace);
  });

  it('sends nothing off-origin when the interface fails', () => {
    /*
     * A crash reporter would be the first thing in this application to transmit
     * anything, and the privacy architecture has no exception for one. The
     * boundary's only sink is the console.
     */
    const boundary = readFileSync(
      join(REPO_ROOT, 'apps', 'web', 'src', 'components', 'ErrorBoundary.tsx'),
      'utf8',
    );
    for (const banned of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'new Image(']) {
      expect(boundary, `the error boundary must not reach for ${banned}`).not.toContain(banned);
    }
  });

  it('constructs the fill worker from exactly one place', () => {
    const files = sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );
    const constructors = files
      .filter((file) => /new Worker\([\s\S]*?hole-fill\.worker/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));

    expect(constructors).toEqual([join('apps', 'web', 'src', 'runtime', 'hole-fill-service.ts')]);
  });
});

describe('PMP reaches nothing', () => {
  /**
   * EXPLICIT, AND SEPARATE FROM THE GENERAL KERNEL SCAN.
   *
   * ADR 0018 qualified `pmp::fill_hole` and REJECTED it: it traps uncatchably
   * on a legal 512-vertex loop, loses append-only provenance, refines a
   * 128-vertex loop by +1,193 vertices, and times out at 2,000. It remains
   * research evidence and must never become a runtime dependency, a vendored
   * artifact, or an import — the whole reason CAD Fixer's own triangulator is
   * the MVP.
   */
  const MARKERS = ['pmp-library', 'pmp/', 'pmp::', 'fill_hole', 'SurfaceHoleFilling'];

  it('appears in no shipped source file', () => {
    const files = [
      ...sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')),
      ...sourceFilesUnder(join(REPO_ROOT, 'packages')),
    ].filter((file) => !/\.test\.(ts|tsx)$/.test(file));

    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const marker of MARKERS) {
        // A comment EXPLAINING why PMP was rejected is not a dependency, so
        // only import and require forms count.
        const pattern = new RegExp(
          `(from|require)\\s*\\(?\\s*['"][^'"]*${marker.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}`,
        );
        if (pattern.test(contents)) offenders.push(`${relative(REPO_ROOT, file)}: ${marker}`);
      }
    }
    expect(offenders, 'PMP is research evidence and must not ship').toEqual([]);
  });

  it('leaves no PMP artifact in any shipped package', () => {
    const packageDirectories = readdirSync(join(REPO_ROOT, 'packages'));
    for (const name of packageDirectories) {
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory)) {
          if (entry === 'node_modules') continue;
          const full = join(directory, entry);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          expect(/pmp/i.test(entry), `${relative(REPO_ROOT, full)} looks like a PMP artifact`).toBe(
            false,
          );
        }
      };
      walk(join(REPO_ROOT, 'packages', name));
    }
  });
});

describe('ZIP-B1-T10: the inflation path keeps exactly one destination', () => {
  /*
   * STRUCTURAL, AND DELIBERATELY SO.
   *
   * `zip-inflation.test.ts` proves the OUTPUT is correct, including under a
   * decompressor that reuses its chunk buffer — which a concatenating
   * implementation could not survive. What no behavioural test can prove is
   * that no SECOND full-size buffer exists, because accumulate-then-concatenate
   * produces byte-identical results. This is the assertion that fails if
   * someone reintroduces that shape while keeping every other test green.
   *
   * IT LIVES HERE, not beside the behavioural tests, because reading a source
   * file needs `node:fs` and `@cadfixer/file-formats` compiles with `lib:
   * ES2023` and no Node types — deliberately, so a codec cannot quietly acquire
   * a platform dependency. This suite is tooling-scoped and already asserts
   * boundary properties from source.
   */
  const source = readFileSync(
    join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'zip.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('export async function readZipEntry'));

  it('retains no array of inflated chunks', () => {
    expect(body).not.toMatch(/chunks\s*:\s*Uint8Array\[\]/);
    expect(body).not.toMatch(/\.push\(chunk\)/);
  });

  it('allocates exactly one output buffer', () => {
    /*
     * A FORWARD GUARD, and honestly less than the two above.
     *
     * The pre-B1 implementation also contained exactly one `new Uint8Array(` —
     * its second full-size buffer was the chunk ARRAY, which the assertions
     * above are what actually catch. This one bounds the future: it fails if a
     * later change reaches for a second destination, for example to grow past a
     * declared size instead of refusing.
     */
    expect(body.match(/new Uint8Array\(/g) ?? []).toHaveLength(1);
  });

  it('proves the declared size is within the entry cap before allocating', () => {
    // The allocation takes its size from attacker-controlled metadata, so the
    // ceiling has to be applied in THIS function rather than inherited from
    // whatever limits the directory happened to be read under.
    const allocation = body.indexOf('new Uint8Array(');
    const check = body.indexOf('declared > limits.maxEntryBytes');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(allocation);
  });
});

describe('B2: model/import is dispatched as an interruptible operation', () => {
  /*
   * THE CHEAP GUARD BEHIND AN EXPENSIVE PROOF.
   *
   * MF-P24 proves in a real browser that a cancel requested AFTER inflation is
   * honoured, and MF-P25 proves the page is cross-origin isolated so the shared
   * control word actually exists. Both live in the TIMING project, which is a
   * separate command and runs in neither `npm run verify` nor `npm run
   * test:e2e` — so a change that dropped `interruptible: true` would go green
   * through both and only fail whenever someone next ran the timing suite by
   * hand.
   *
   * What it guards is not a style preference. Without the flag no
   * `SharedArrayBuffer` is allocated, the worker's token is backed only by a
   * `cancel` MESSAGE, and every poll across the whole post-inflate synchronous
   * span — decode, XML safety scan, element scan, materialisation, expansion —
   * reads a flag that cannot change. Measured before the fix: a cancel at the
   * parsing phase was ignored entirely and the document was committed anyway,
   * 4,545 ms later, for a 250 MiB-class fixture.
   */
  const source = readFileSync(
    join(REPO_ROOT, 'apps', 'web', 'src', 'runtime', 'geometry-client.ts'),
    'utf8',
  );

  it('requests a shared cancellation signal for model/import', () => {
    const at = source.indexOf("'model/import'");
    expect(at, 'model/import must be dispatched from geometry-client').toBeGreaterThan(-1);
    // The dispatch call ends at the first `);` after the operation name.
    const call = source.slice(at, source.indexOf('  }', at));
    expect(call).toContain('interruptible: true');
  });

  it('still transfers the file buffer rather than copying it', () => {
    // Guarded together because they live on the same options object, and an
    // edit that added one by replacing the other would otherwise be invisible.
    const at = source.indexOf("'model/import'");
    const call = source.slice(at, source.indexOf('  }', at));
    expect(call).toContain('transfer: [bytes]');
  });
});

/** Every shipped `.ts` or `.tsx` under `apps/web/src` and `packages`, tests aside. */
function shippedSources(): string[] {
  const roots = [join(REPO_ROOT, 'apps', 'web', 'src'), join(REPO_ROOT, 'packages')];
  return roots
    .filter((root) => existsSync(root))
    .flatMap((root) => sourceFilesUnder(root))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file));
}

describe('R3: the import resource gate has one call site, above the snapshot', () => {
  /*
   * WHY SOURCE ORDER IS THE PROPERTY.
   *
   * `checkImportGeometry` bounds the render snapshot. A gate that ran AFTER
   * `buildDocumentRenderSnapshot` would still refuse the commit, still return a
   * typed error, and still pass every unit test — having already allocated the
   * hundreds of megabytes it exists to prevent. Nothing about the returned value
   * distinguishes the two orderings, so the ordering is asserted directly.
   *
   * And ONE call site, because a second producer of documents is a second place
   * the gate can be forgotten — the same reason `commitImportedDocument` was
   * extracted in Stage 4A-2B1.
   */
  const source = readFileSync(
    join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'stl-handlers.ts'),
    'utf8',
  );

  it('runs the gate before the render snapshot is built', () => {
    const gate = source.indexOf('checkImportGeometry(cost)');
    const snapshot = source.indexOf('buildDocumentRenderSnapshot(document)');
    const commit = source.indexOf('residentDocuments.commit(document)');

    expect(gate, 'the import gate must be called').toBeGreaterThan(-1);
    expect(snapshot, 'the render snapshot must be built').toBeGreaterThan(-1);
    expect(gate).toBeLessThan(snapshot);
    expect(snapshot).toBeLessThan(commit);
  });

  it('calls the gate exactly once, from commitImportedDocument', () => {
    expect(source.match(/checkImportGeometry\(/g) ?? []).toHaveLength(1);
    const commitAt = source.indexOf('export function commitImportedDocument');
    expect(source.indexOf('checkImportGeometry(cost)')).toBeGreaterThan(commitAt);
  });

  it('keeps the retired estimator out of production', () => {
    /*
     * NAMED SO THEY CANNOT RETURN QUIETLY. `estimateImportPeak` ran after the
     * peak it named, charged summed triangles so shared placements were billed
     * once per placement, and received the CANDIDATE's triangle count as the
     * OUTGOING document's render bytes. `checkResident` and `maxRenderBytes`
     * were never called from production at all.
     */
    const RETIRED = [
      'estimateImportPeak',
      'checkImportPeak',
      'maxImportPeakBytes',
      'checkResident',
      'maxRenderBytes',
      'residentBytesFor',
      'renderBytesFor',
    ];
    for (const file of shippedSources()) {
      const text = readFileSync(file, 'utf8');
      for (const symbol of RETIRED) {
        // Prose may discuss them; an identifier followed by `(` or `:` is a use.
        expect(
          new RegExp(`\\b${symbol}\\s*[(:]`).test(text),
          `${relative(REPO_ROOT, file)} still uses ${symbol}`,
        ).toBe(false);
      }
    }
  });
});

describe('R3: the automatic boundary listing is size-gated before it walks', () => {
  /*
   * THE ONLY AUTOMATIC POST-IMPORT OPERATION THAT HAD NO PREFLIGHT. Its cost
   * scales with boundary COMPONENTS, of which a mesh of loose triangles has one
   * per FACE, so it is not bounded by anything a geometry gate can see: two
   * 100 MiB binary STL files with identical triangle counts measured 1,055 MiB
   * and 2,650 MiB of Chromium renderer footprint.
   *
   * The guard has to precede `extractBoundaryLoops` for the same reason the
   * import gate has to precede the snapshot — refusing afterwards is not
   * refusing.
   */
  const source = readFileSync(
    join(REPO_ROOT, 'apps', 'web', 'src', 'workers', 'hole-fill-handlers.ts'),
    'utf8',
  );

  it('checks the part size before extracting boundary loops', () => {
    const guard = source.indexOf('partFaceCount > HOLE_FILL_MAX_PART_FACES');
    const walk = source.indexOf('extractBoundaryLoops(part.mesh');

    expect(guard, 'the listing must be size-gated').toBeGreaterThan(-1);
    expect(walk).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(walk);
  });

  it('reports a skipped walk as `inventoried: false`, never as a zero count alone', () => {
    // `loopCount: 0` with no other signal would tell a user their model has no
    // open boundaries on the strength of a check that never ran.
    expect(source).toContain('inventoried: false');
    expect(source).toContain('inventoried: true');
  });
});

describe('A2: reachable cross-part loading keeps its ownership rules', () => {
  /*
   * THE RULES THAT ARE INVISIBLE WHEN BROKEN.
   *
   * A multi-part import that resolved an object id against the wrong part's
   * table, gave each model part its own inflation allowance, or walked several
   * parts concurrently would still produce a document — the wrong one, or one
   * that cost several times what it should. None of those shows up as an error,
   * so each is pinned at the source.
   */
  const reader = readFileSync(
    join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'threemf-reader.ts'),
    'utf8',
  );

  it('has exactly one place that resolves a package path', () => {
    // A second resolver is a second answer to "may CAD Fixer open this entry",
    // and the first traversal rule to be forgotten would be in the copy.
    expect(reader.match(/resolvePackageModelPath\(/g) ?? []).toHaveLength(1);
  });

  it('constructs exactly one package graph, holding the archive budget', () => {
    expect(reader.match(/new PackageModelGraph</g) ?? []).toHaveLength(1);
    const at = reader.indexOf('new PackageModelGraph<');
    const construction = reader.slice(at, reader.indexOf('});', at));
    // THE ARCHIVE'S BUDGET, not a fresh one. A per-part budget is a per-part
    // FULL allowance — twenty parts, twenty times the ceiling.
    expect(construction).toContain('budget,');
    expect(construction).not.toContain('createInflationBudget');
  });

  it('never awaits model-part loads concurrently', () => {
    /*
     * ORDERING AND LIFETIME BOTH DEPEND ON THIS. `Promise.all` over components
     * would make the document's part order the order loads happened to settle,
     * and would inflate, decode and parse several model parts at once — which is
     * the transient accumulation Stage 6D-R1's one-part-in-flight contract rests
     * on not happening.
     */
    // Matched as a CALL, so the comment above the walk explaining why this is
    // forbidden does not trip its own rule.
    expect(reader).not.toMatch(/Promise\s*\.\s*all(Settled)?\s*\(/);
  });

  it('keys the cycle path on the object identity, never on a bare id', () => {
    // Two model parts may each legally declare `id="1"`. A bare-id path set
    // calls `A.model:1 -> B.model:1` a cycle and refuses an ordinary package.
    expect(reader).toContain('objectKeyToString({ part: target.key, objectId })');
  });

  it('enforces the package totals from the limits it was given', () => {
    /*
     * Stage 6D-R1 recorded that these counters reset per parsed model, so a
     * package of two parts each just inside the ceiling produced twice it. They
     * are read from `limits` so the package-wide property is provable at four
     * triangles instead of twenty million.
     */
    const walkAt = reader.indexOf('async function expandPackageBuild');
    const walk = reader.slice(walkAt);
    expect(walk).toContain('limits.maxTotalTriangles');
    expect(walk).toContain('limits.maxTotalVertices');
    /*
     * THE WALK READS ITS CEILINGS FROM `limits`. Reaching for
     * `DEFAULT_DOCUMENT_LIMITS` here would re-hardcode them and make the
     * package-wide property unprovable without a twenty-million-triangle
     * fixture. The DEFAULTS still come from the document — asserted in the 3MF
     * suite — which is where that equality belongs.
     */
    expect(walk).not.toContain('DEFAULT_DOCUMENT_LIMITS.maxTotal');
  });

  it('keeps the retired whole-extension refusal out of the vocabulary', () => {
    // `THREEMF_MULTI_MODEL_PART_UNSUPPORTED` said the extension was unsupported.
    // That sentence stopped being true in A2, and a code with no producer would
    // invite its return.
    const errors = readFileSync(
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'import-errors.ts'),
      'utf8',
    );
    expect(errors).not.toMatch(/ThreeMfMultiModelPart:/);
  });

  it('tells no user that the production extension is unsupported', () => {
    /*
     * THE ONE SENTENCE A2 HAD TO RETIRE. A refusal naming the whole extension
     * would send someone to re-export a file that now imports. Specific
     * constructs may still be named — the non-root path refusal does — so this
     * looks for the CLAIM, not for the words.
     */
    for (const file of shippedSources()) {
      const text = readFileSync(file, 'utf8');
      for (const [quote] of text.matchAll(/'[^'\n]{40,}'/g)) {
        const sentence = quote.toLowerCase();
        if (!sentence.includes('production extension')) continue;
        expect(
          sentence.includes('does not support that extension') ||
            sentence.includes('does not support the 3mf production'),
          `${relative(REPO_ROOT, file)} still calls the production extension unsupported`,
        ).toBe(false);
      }
    }
  });
});

describe('A3: production semantics resolve by namespace, and the root by the package', () => {
  const reader = readFileSync(
    join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'threemf-reader.ts'),
    'utf8',
  );

  it('matches no literal namespace prefix in its semantic logic', () => {
    /*
     * THE PREFIX IS THE AUTHOR'S TO CHOOSE. `p`, `prod` and `production` are
     * all the same attribute, and a package binding the namespace to anything
     * else is equally ordinary — so a literal `p:path` or `pa:alternatives`
     * comparison would read some files and silently miss others.
     *
     * Matched as a STRING LITERAL so the prose above may keep naming them.
     */
    for (const [literal] of reader.matchAll(/'[^'\n]*'/g)) {
      expect(literal, 'production semantics must not match a literal prefix').not.toMatch(
        /\b(p|pa|prod|production):[a-zA-Z]/,
      );
    }
  });

  it('keeps the two production namespaces distinct', () => {
    // One is implemented and one is not. Treating a URI as equivalent because
    // it contains the word "production" is how a version's semantics get
    // silently assumed.
    expect(reader).toContain("production/2015/06'");
    expect(reader).toContain("production/alternatives/2021/04'");
    // Never a substring test on the URI.
    expect(reader).not.toMatch(/\.includes\(\s*'production'/);
    expect(reader).not.toMatch(
      /startsWith\(\s*'http:\/\/schemas\.microsoft\.com\/3dmanufacturing\/production/,
    );
  });

  it('resolves the root model part through the package, not by taking the first entry', () => {
    /*
     * THE DEFECT A3 FIXED, AND IT WAS SILENT. The reader used to return the
     * first `.model` the ZIP DIRECTORY listed whenever the conventional path
     * was absent. In a production-extension package that can be a CHILD, and
     * since A2 the reader walks the root's build — so it would expand a part
     * the specification says to ignore, or refuse a package that builds fine.
     */
    expect(reader).toContain('MODEL_RELATIONSHIP_TYPE');
    expect(reader).toContain('resolveRootModelEntry');
    expect(reader).not.toContain('function findModelEntry');
    // One resolver, one call site.
    expect(reader.match(/resolveRootModelEntry\(/g) ?? []).toHaveLength(2);
  });

  it('never resolves a relationship target through a weaker path rule', () => {
    // A `.rels` Target goes through the SAME shape validation a production
    // `path` does. A second, looser route would be the first place traversal
    // came back.
    //
    // STAGE 6D-A4: the root relationship no longer demands the `.model` suffix
    // — the relationship TYPE is what says the part is a model, and the 3MF
    // Consortium's positive cases name roots `3dmodel`, `3dmodel.moodel` and
    // `3dmodel.part`. So the `.rels` route calls `canonicalisePackagePartName`,
    // and this asserts the production-path grammar is that SAME function plus
    // the suffix, rather than a parallel implementation that could drift.
    const at = reader.indexOf('function modelTargetFromRels');
    const body = reader.slice(at, reader.indexOf('\n}', at));
    expect(body).toContain('canonicalisePackagePartName(');
    expect(body).not.toMatch(/startsWith\('\.\.'|split\('\/'\)/);

    const paths = readFileSync(
      join(REPO_ROOT, 'packages/file-formats/src/threemf/package-path.ts'),
      'utf8',
    );
    const start = paths.indexOf('export function canonicalisePackagePath(');
    const pathBody = paths.slice(start, paths.indexOf('\n}', start));
    expect(pathBody).toContain('canonicalisePackagePartName(raw, limits)');
    // Every shape rule lives in exactly one function.
    expect(paths.match(/PackagePathRefusal\.ParentSegment/g) ?? []).toHaveLength(1);
  });
});

describe('A4: the inflation loop pulls the decompressor directly', () => {
  it('keeps every async-generator layer out of the ZIP reader', () => {
    /*
     * Stage 6D-A4 wrapped the decompressor in an `async function*` to turn its
     * failures into a typed refusal. The extra hop per chunk let inflated chunks
     * queue beside the preallocated entry buffer: a 2 x 1.2 M-triangle
     * production package peaked at 1,600 MiB in Chromium against 1,221-1,242 MiB
     * for a direct `next()` loop. Comments are stripped, because the reason is
     * written down there and must stay.
     */
    const zip = readFileSync(
      join(REPO_ROOT, 'packages', 'file-formats', 'src', 'threemf', 'zip.ts'),
      'utf8',
    );
    const code = zip
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/async\s+function\s*\*/);
    expect(code).not.toMatch(/async\s+\*\s*\w+\s*\(/);
    // The conversion is still there, around `next()` alone.
    expect(code).toMatch(/await chunks\.next\(\)/);
  });
});

describe('6E-A2: streamed 3MF ingestion is productionised and OFF by default', () => {
  const read = (...path: string[]): string => readFileSync(join(REPO_ROOT, ...path), 'utf8');
  const appSources = (): string[] =>
    sourceFilesUnder(join(REPO_ROOT, 'apps', 'web', 'src')).filter(
      (file) => !/\.test\.(ts|tsx)$/.test(file),
    );

  it('the package index exports no qualification hook and no streaming internal', () => {
    const index = read('packages', 'file-formats', 'src', 'index.ts');
    for (const symbol of [
      'read3mfForQualification',
      'ThreeMfStreamingQualification',
      'openTwoPassEntry',
      'scanXmlByteStream',
      'XmlStreamScanner',
      'XmlSecurityStream',
      'createStreamScanStats',
      'StreamScanStats',
      'xml-stream',
      'xml-security',
      'test-context',
    ]) {
      expect(index, symbol).not.toContain(symbol);
    }
  });

  it('the application never names a streaming mode, a 3MF reader factory or a wider limit', () => {
    for (const file of appSources()) {
      const text = readFileSync(file, 'utf8');
      const where = relative(REPO_ROOT, file);
      for (const symbol of [
        'ThreeMfIngestion',
        'createThreeMfReader',
        'read3mfForQualification',
        'harness/ingestion',
        'zipLimits',
        'maxEntryBytes',
        "'streaming'",
      ]) {
        expect(text.includes(symbol), `${where} names ${symbol}`).toBe(false);
      }
      expect(/\bingestion\s*:/.test(text), `${where} passes an ingestion option`).toBe(false);
    }
  });

  it('the shipped worker registers the ONE import handler built from the production config', () => {
    const worker = read('apps', 'web', 'src', 'workers', 'geometry.worker.ts');
    expect(worker).toContain("host.register('model/import', modelImportHandler);");
    expect(worker).not.toContain('createModelImportHandler');

    const handlers = read('apps', 'web', 'src', 'workers', 'stl-handlers.ts');
    expect(handlers).toContain(
      'export const PRODUCTION_IMPORT_CONFIG: ModelImportConfig = Object.freeze({});',
    );
    expect(handlers).toContain(
      "export const modelImportHandler: OperationHandler<'model/import'> =\n  createModelImportHandler(PRODUCTION_IMPORT_CONFIG);",
    );
    const builders = appSources().filter((file) =>
      readFileSync(file, 'utf8').includes('createModelImportHandler('),
    );
    // The definition and the one production call, both in the import module.
    expect(builders.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('apps', 'web', 'src', 'workers', 'stl-handlers.ts'),
    ]);
    expect(handlers.match(/createModelImportHandler\(/g)).toHaveLength(2);
  });

  it('the registry reads 3MF routed per entry, under the production limits', () => {
    /*
     * STAGE 6E-A3 CHANGED THIS LINE, AND IT IS STILL ONE LINE. The product's
     * only choice about ingestion is the registry's reader; A2 asserted it was
     * built with no options at all, A3 asserts it is built with `auto` and
     * nothing else. `zipLimits` still does not appear, so the 256 MiB per-entry
     * ceiling is untouched by routing.
     */
    const codec = read('packages', 'file-formats', 'src', 'threemf', 'codec.ts');
    expect(codec).toContain(
      'export const threeMfReader: DocumentReader = createThreeMfReader({\n  ingestion: ThreeMfIngestion.Auto,\n});',
    );
    expect(codec).not.toContain('zipLimits');
    expect(codec).not.toContain('maxEntryBytes');

    // The MODE is read once from the options; the PATH is chosen per entry.
    const reader = read('packages', 'file-formats', 'src', 'threemf', 'threemf-reader.ts');
    expect(reader).toContain('const mode = options.ingestion ?? ThreeMfIngestion.Buffered;');
    expect(reader).toContain(
      'const route: ThreeMfIngestionRoute = routeModelEntryIngestion(entry.uncompressedSize, mode);',
    );
    // ONE CALL SITE, counted in CODE — the prose above it names the function too.
    const readerCode = reader
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(readerCode.match(/routeModelEntryIngestion\(/g)).toHaveLength(1);
  });

  it('6E-A3: the route is decided from the declaration alone, by one leaf module', () => {
    /*
     * The routing input must be a deterministic function of the archive's own
     * metadata. A module that could reach for available memory, a heap
     * estimate, a clock, the file name or the producer would make the same file
     * import two different ways on two machines — and make a refusal stop being
     * reproducible. The module imports nothing at all, which is the strongest
     * available statement of that.
     */
    const route = read('packages', 'file-formats', 'src', 'threemf', 'ingestion-route.ts');
    expect(route).not.toMatch(/^\s*import\s/m);
    for (const forbidden of [
      'performance',
      'Date.',
      'navigator',
      'deviceMemory',
      'memory',
      'random',
      'compressedSize',
      'name',
    ]) {
      const code = route
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(code.includes(forbidden), `ingestion-route.ts reads ${forbidden}`).toBe(false);
    }
    // ONE threshold literal, and the decision reads it rather than restating it.
    expect(route.match(/1024 \* 1024/g)).toHaveLength(1);
    expect(route).toContain('declaredUncompressedBytes >= THREEMF_STREAMING_THRESHOLD_BYTES');
  });

  it('pass 2 cannot begin before pass 1 has decided: the order is in the source', () => {
    const stream = read('packages', 'file-formats', 'src', 'threemf', 'xml-stream.ts');
    const body = stream.slice(stream.indexOf('export async function scanXmlByteStream('));
    const verdict = body.indexOf('const unsafe = security.finish();');
    const refused = body.indexOf('if (unsafe !== undefined) refuseUnsafeXml(unsafe);');
    const handlers = body.indexOf('createHandlers()');
    const secondPass = body.indexOf('source.semantic()');
    expect(verdict).toBeGreaterThan(body.indexOf('source.security()'));
    expect(refused).toBeGreaterThan(verdict);
    expect(handlers).toBeGreaterThan(refused);
    expect(secondPass).toBeGreaterThan(handlers);
    expect(body.match(/createHandlers\(\)/g)).toHaveLength(1);
  });

  it('only the first pass is charged, and only the two-pass entry can open a streamed read', () => {
    const zip = read('packages', 'file-formats', 'src', 'threemf', 'zip.ts');
    expect(zip).not.toMatch(/export function streamZipEntry/);
    // The definition, the charged security pass and the uncharged element pass.
    expect(zip.match(/streamZipEntry\(/g)).toHaveLength(3);
    expect(zip).toContain(
      'return streamZipEntry(this.bytes, this.entry, this.options, true, () => {',
    );
    expect(zip).toContain(
      'return streamZipEntry(this.bytes, this.entry, this.options, false, undefined);',
    );
    expect(zip).toContain("if (this.state !== 'cleared') {");
  });

  it('no regular expression runs over a document: the security rules are a state machine', () => {
    const security = read('packages', 'file-formats', 'src', 'threemf', 'xml-security.ts');
    const code = security.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/RegExp\(|\.test\(|\.exec\(|\.match\(|\.search\(|\.replace\(/);
    const scan = read('packages', 'file-formats', 'src', 'threemf', 'xml-scan.ts');
    const describe = scan.slice(
      scan.indexOf('export function describeUnsafeXml('),
      scan.indexOf('function refuseUnsafe('),
    );
    expect(describe).toContain('new XmlSecurityStream()');
    expect(describe).not.toMatch(/\.test\(/);
    // R1: the kept name is detached, and the engine's match state is released
    // after every part and whenever a read ends — including by refusal.
    const reader = read('packages', 'file-formats', 'src', 'threemf', 'threemf-reader.ts');
    expect(reader).toMatch(/name:\s*attrs\.name === undefined\s*\? undefined\s*: detachedCopy\(/);
    expect(reader.match(/forgetRegExpMatch\(\);/g)).toHaveLength(2);
    const guarded = reader.slice(reader.indexOf('async function readThreeMfPackage('));
    expect(
      guarded.slice(0, guarded.indexOf('async function readThreeMfPackageUnguarded(')),
    ).toMatch(/try \{[\s\S]*\} finally \{[\s\S]*forgetRegExpMatch\(\);/);
    expect(scan).toContain("EMPTY_MATCH.exec('');");
  });

  it('there is ONE decompressor construction in the application, and it is sliced', () => {
    const constructing = appSources().filter((file) =>
      readFileSync(file, 'utf8').includes('new DecompressionStream('),
    );
    expect(constructing.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('apps', 'web', 'src', 'workers', 'platform-inflate.ts'),
    ]);
    const inflater = read('apps', 'web', 'src', 'workers', 'platform-inflate.ts');
    expect(inflater).toContain('createSlicedInflater(openDecompressor)');
  });
});
