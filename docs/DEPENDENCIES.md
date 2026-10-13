# Dependencies

Every dependency must justify its presence. This file records what we use, why,
and the licence risk.

**Licence policy.** Pybrix is intended to become a proprietary commercial
application. Runtime dependencies must therefore carry licences compatible with
that intent — permissive ones (MIT, Apache-2.0, BSD, ISC) need no further
analysis. **No GPL or AGPL code may be copied into the project, and no GPL/AGPL
runtime dependency may be added without explicit written approval from the
product owner.** Copyleft licences that are not outright GPL/AGPL (notably LGPL,
and LGPL with linking exceptions) are not automatically disqualifying, but they
carry obligations that must be evaluated for our specific distribution model
before adoption. See [Geometry kernel licensing](#geometry-kernel-licensing).

Versions below are the ranges declared in `package.json`, verified against the
npm registry on 2026-08-14. Licences were read from published package metadata.

## Auto Split (PYBRIX-08B-PROD-A1)

**No third-party package was added.** The four new workspaces are first-party and
private: `@cadfixer/auto-split-contract` (wire types, strict validators, PNG inspector, view
cameras), `@cadfixer/auto-split` (the worker-side engine: six software renders, component matching,
suggestions, component extraction), `@cadfixer/auto-split-api` (the same-origin service) and test
fixtures under the engine package. The service uses Node's own `http` and `fetch`; there is no
framework and no provider SDK, so the provider's wire format is read from its documented REST API
rather than from a client library.

The **provider** is an external service, not a dependency of the build: model `gpt-6.1-sol` through
the Responses API, `store=false`, reached only from the service and only with a key that exists only on
the server. Its terms and retention are the provider's. See ADR 0020 and `docs/PRIVACY_ARCHITECTURE.md`.

## Runtime dependencies

| Package     | Version  | Purpose                | Source                                                           | Licence | Why this one                                                                                           | Risks                                                                                                                                                                                                                                                                             |
| ----------- | -------- | ---------------------- | ---------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`     | ^19.2.8  | UI rendering           | [github.com/facebook/react](https://github.com/facebook/react)   | MIT     | Mandated stack. `useSyncExternalStore` gives us a framework-free state layer with a supported binding. | Large ecosystem surface; we use the core only.                                                                                                                                                                                                                                    |
| `react-dom` | ^19.2.8  | DOM renderer for React | same as above                                                    | MIT     | Required companion to `react`.                                                                         | None beyond React itself.                                                                                                                                                                                                                                                         |
| `three`     | ^0.185.1 | WebGL viewport         | [github.com/mrdoob/three.js](https://github.com/mrdoob/three.js) | MIT     | Mandated stack; the practical choice for browser 3D. Actively maintained.                              | **Ships no TypeScript types** — `@types/three` is required and versioned separately. Unstable minor-version API (`0.x`); upgrades need review. Dominates bundle size (see Known Issues in the README). Confined to `apps/web/src/viewport`; the mesh model does not depend on it. |

That is the entire runtime PACKAGE list. Two sets of third-party assets are
vendored into the source tree rather than installed, and are recorded here
because they ship to users:

| Asset                                  | Location                                 | Source                                                                                                             | Licence                            | Why vendored                                                                                                                                                      | Obligations                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Figtree, Space Grotesk, JetBrains Mono | `apps/web/src/styles/fonts/*.woff2`      | Latin-subset variable fonts as distributed by Google Fonts; copyright lines read from each file's own `name` table | SIL OFL 1.1                        | The UI-01 shell's type system. Self-hosted so the page makes no request to a font service and stays cross-origin isolated. Three files, 74 KiB in total.          | The licence and each font's copyright notice sit beside the files in `fonts/LICENSE`, and ship with every build in `third-party-notices.txt`. The fonts may not be sold on their own; bundling them in an application is permitted. Reserved Font Names do not apply — the files are unmodified. |
| Lucide icon path data (≈ 30 icons)     | `apps/web/src/components/shell/Icon.tsx` | [lucide.dev](https://lucide.dev) / [github.com/lucide-icons/lucide](https://github.com/lucide-icons/lucide)        | ISC (Feather-derived portions MIT) | The shell draws about thirty line icons. Copying their path strings avoids an icon package, its component runtime and a dependence on tree-shaking to stay small. | Both notices must accompany copies. They are kept verbatim in `components/shell/LICENSE-lucide` and ship with every build in `third-party-notices.txt`.                                                                                                                                          |

Both ship with every build as `apps/web/public/third-party-notices.txt`, a
static file Vite copies beside the application — never part of its script —
and `scripts/third-party-notices.test.ts` holds that file to the licences in
the source tree. The index is `THIRD_PARTY_NOTICES.md` at the repository root.

Notably absent:

- **No state management library.** The workspace store is ~90 lines over
  `useSyncExternalStore`. A dependency would not earn its place at this size.
- **No UI component library.** The shell is plain semantic HTML and CSS.
- **No router.** The application is a single workspace view.
- **No HTTP client.** By design — the browser application makes exactly one same-origin request (Auto Split's analysis, ADR 0020) from one file, and Repair, Convert and Manual Split make none.
- **Two geometry kernels, each confined to its own workers.** Geogram v1.10.0
  (Stage 3C-1B) runs the self-intersection diagnostic and the hole-fill
  narrowphase; Manifold (Stage 7A) runs the Boolean behind Split and Surface
  Texture, in a disposable worker per call. lib3mf, OpenVDB, CGAL and
  OpenCascade remain deliberately absent. See "Geogram, as shipped" and
  "Manifold, as shipped" below; anything else is evaluated separately, with
  licensing as a first-class criterion.
- **No third-party STL parser.** The STL codec in `packages/file-formats` is our
  own. Parsing is the trusted boundary for hostile input; we do not delegate it,
  and specifically do not use Three.js's `STLLoader`, which is a rendering
  convenience rather than a validating parser.

## Geogram, as shipped

**This section describes code that is distributed to users**, unlike the
research artifacts under `experiments/`.

|                |                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Version        | v1.10.0                                                                                                                  |
| Commit         | `c8529bb00838186938ab31d96008a59b6a892dee`                                                                               |
| Toolchain      | emsdk 4.0.16                                                                                                             |
| Where          | `packages/self-intersection-kernel/artifacts/self-intersection.wasm`                                                     |
| Reachable from | `apps/web/src/workers/self-intersection.worker.ts` and `apps/web/src/workers/hole-fill-narrowphase.ts`, and nothing else |
| Licence        | **BSD-3-Clause** (core)                                                                                                  |

**Why this is licence-clean.** Geogram's distribution bundles TetGen (AGPL-3.0)
and Triangle (non-free), neither of which may enter a proprietary product.
`GEOGRAM_WITH_TETGEN=OFF` and `GEOGRAM_WITH_TRIANGLE=OFF` exclude both at
configure time, and `packages/self-intersection-kernel/build.sh` runs the
build-input audit **and** scans the emitted artifact, refusing to produce one if
either check fails. The shipped `.wasm` contains zero `tetgenmesh`, `tetgenio`
or `triangulateio` symbols.

**Attribution obligation — discharged in PR-01.** BSD-3-Clause requires the
copyright notice and licence text to accompany binary distributions. Until PR-01
nothing shipped them: the licence lived only in the (unversioned) pinned source.
Geogram's `LICENSE` and the zlib notice from its bundled `zlib.h`, both taken
verbatim from commit `c8529bb`, are now tracked in
`packages/self-intersection-kernel/licenses/` and shipped in the build's
`third-party-notices.txt`, which the Help menu links to.
`scripts/third-party-notices.test.ts` holds the shipped copy to the tracked one.

zlib is also linked (Geogram satisfies `<zlib.h>` from its own bundled copy);
its notice ships with Geogram's.

**Stage 4B-1B1 added a second entry point to the SAME artifact, not a second
kernel.** `cf_hf_begin` / `cf_hf_classify` / `cf_hf_end` classify a
caller-supplied list of face pairs and attribute each finding to patch/source or
patch/patch, reusing Geogram's exact `triangles_intersections` and Pybrix's
own frozen classifier unchanged. Nothing new is linked, no build option changed,
and `si_core.h` and `si_bvh.h` stay byte-identical to the research copies. The
build was verified REPRODUCIBLE first: rebuilding the unchanged source produced
byte-identical output (`self-intersection.js` SHA-256
`5829ce696e614eb295d2af8da5abfa7e52e6499dafa4060aed76c52d3813936d`,
`self-intersection.wasm` SHA-256
`8f6b3fa78be55078780615ed2118d4446422030734d413d9e3b9ea4be582482f`), so the
artifact that ships now differs from the qualified one only by the code that was
deliberately added.

**PMP does not ship, and Stage 4B-1B1 is where that was decided rather than
assumed.** ADR 0018 qualified `pmp::fill_hole` and rejected it: it traps
uncatchably inside the module on a legal 512-vertex loop, loses append-only
provenance, refines a 128-vertex loop by +1,193 vertices, and times out at
2,000. Pybrix's own ear clipping is the production triangulator, and a
boundary test scans for PMP imports and artifacts in every shipped package.

## Manifold, as shipped

**This section describes code that is distributed to users.**

|                |                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------- |
| Upstream       | https://github.com/elalish/manifold, commit `11235e6b8ebea2dbed8aec4285685aafd3d95667`    |
| Where          | `apps/web/src/workers/third-party/manifold/manifold-candidate.{js,wasm}`, unmodified      |
| Toolchain      | emsdk 4.0.16 (`experiments/repair-kernels/manifold/build.sh`)                             |
| Reachable from | `apps/web/src/workers/manifold-boolean-backend.ts`, in the disposable Boolean worker only |
| Licence        | **Apache-2.0**. Upstream has no `NOTICE` file at that commit (checked in PR-01)           |
| Linked         | Manifold core and the Emscripten runtime only — no Clipper2, TBB or other library symbols |

Stage 7A copied the pinned research artifact into the worker source; see
`docs/design/STAGE_7_GEOMETRY_EDITING_FOUNDATION.md`. Apache-2.0 requires a copy
of the licence with any redistribution: the vendored `LICENSE` (byte-identical
to upstream's) ships in `third-party-notices.txt`.

## Emscripten runtime, as shipped

Both WebAssembly modules carry the Emscripten 4.0.16 JavaScript runtime and its
musl-based C library (MIT / NCSA and MIT), whose texts — taken verbatim from the
`4.0.16` tag — are tracked in `apps/web/src/workers/third-party/emscripten/` and
shipped in `third-party-notices.txt`. libc++, libc++abi and compiler-rt are
Apache-2.0 WITH LLVM-exception, which requires no notice for object code.

## Geometry kernel licensing

**Geogram is the only kernel that ships** (see above). No OTHER geometry kernel
is installed, and none may be added without an explicit decision. This section
records what the licences actually say, because an earlier draft of this
document flattened them into "GPL/AGPL, therefore unusable", which is not
accurate for either CGAL or OCCT.

**This is an engineering summary of upstream licence text, not legal advice.**
Anything adopted needs review by someone qualified, against our actual
distribution model.

### CGAL — licensing is per package

CGAL is not under a single licence. Upstream states that some parts are
available under the LGPL and other parts under the GPL, and the per-package
licence is listed in CGAL's Package Overview.

- The **kernel and support libraries** are LGPL, deliberately chosen as the less
  constraining licence so others can build on top.
- **Advanced algorithms and data structures** are typically GPL, to protect
  their commercial value.
- Using a **GPL-covered CGAL package** in proprietary distributed software
  requires GPL compliance — which for a proprietary product generally means
  obtaining a commercial licence instead. GeometryFactory sells commercial CGAL
  licences precisely for the case where the open-source terms do not work.
- Using only **LGPL-covered CGAL packages** is a materially different analysis
  from the GPL case and must be evaluated on its own terms.

Practical consequence: "can we use CGAL?" is not answerable in general. It is
answerable only for the specific packages an algorithm needs.

Source: <https://www.cgal.org/license.html> (checked 2026-08-14).

### OCCT — LGPL 2.1 with an additional exception

Open CASCADE Technology is distributed under **LGPL 2.1 plus an additional
exception** (`OCCT_LGPL_EXCEPTION.txt` in the distribution). The exception
covers, among other things, distributing object code incorporating material from
OCCT header files under terms of your choice given prominent notice, and
combining or linking a "work that uses the Library" and distributing that work
under terms of your choice — provided those terms permit modification for the
customer's own use and reverse engineering for debugging such modifications.

That is not the same as "unusable in a proprietary product". It does carry
obligations that must be evaluated for our distribution model, and the
reverse-engineering-for-debugging condition in particular deserves attention.
Open Cascade also offers commercial arrangements if the open-source obligations
turn out to be undesirable.

Note for this project specifically: LGPL's relinking/modification expectations
were written for native dynamic linking. How they apply to a **statically linked
WebAssembly bundle shipped to a browser** is a question that must be answered
before adoption, not after.

Sources: <https://github.com/Open-Cascade-SAS/OCCT>,
<https://occt3d.com/open-cascade-technology/index.html> (checked 2026-08-14).

### Others not yet evaluated

Manifold, Geogram, lib3mf, and OpenVDB have not been assessed. Each needs the
same treatment — current upstream licence text, read against our distribution
model — before it can be considered.

## Development dependencies

| Package                            | Version            | Purpose                    | Licence    | Why this one                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Risks                                                                                       |
| ---------------------------------- | ------------------ | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `typescript`                       | ~6.0.3             | Type system                | Apache-2.0 | **Pinned to the 6.x line deliberately.** TypeScript 7.0 is the Go-native port and does not yet expose a stable programmatic compiler API, so typescript-eslint cannot use it (`typescript-eslint` declares `typescript: >=4.8.4 <6.1.0`; TS 7 support is [open issue #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518)). Choosing TS 7 today means losing type-aware linting. See [ADR 0006](adr/0006-typescript-version-line.md). | We are one major version behind current. Revisit when typescript-eslint ships TS 7 support. |
| `vite`                             | ^8.2.1             | Dev server and bundler     | MIT        | Mandated stack. First-class module-worker and WASM support; `server.headers`/`preview.headers` let us reproduce cross-origin isolation locally.                                                                                                                                                                                                                                                                                                               | Fast major-version cadence.                                                                 |
| `@vitejs/plugin-react`             | ^6.0.5             | React fast refresh and JSX | MIT        | Official React plugin for Vite. Its Babel peers are optional and unused.                                                                                                                                                                                                                                                                                                                                                                                      | Tied to Vite majors.                                                                        |
| `vitest`                           | ^4.1.10            | Unit and component tests   | MIT        | Mandated stack. Shares Vite's transform pipeline, so tests and build agree. `projects` separates the DOM-free packages from the jsdom app.                                                                                                                                                                                                                                                                                                                    | None material.                                                                              |
| `@playwright/test`                 | ^1.62.1            | End-to-end tests           | Apache-2.0 | Mandated stack. The only way to verify real WebGL, real module workers, real buffer transfer, and the isolation headers.                                                                                                                                                                                                                                                                                                                                      | Downloads a browser binary; CI needs `playwright install`.                                  |
| `eslint`                           | ^10.8.1            | Linting                    | MIT        | Mandated stack.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Flat config only; legacy plugin shapes are rejected (see `eslint.config.js`).               |
| `typescript-eslint`                | ^8.67.0            | TypeScript lint rules      | MIT        | Type-aware rules catch real defects (floating promises, unsafe `any` flow) that syntax-only linting cannot.                                                                                                                                                                                                                                                                                                                                                   | Constrains our TypeScript version — see above.                                              |
| `eslint-plugin-react-hooks`        | ^7.1.1             | Hook correctness rules     | MIT        | Catches effect and dependency mistakes. Its flat config lives at `configs.flat[...]`.                                                                                                                                                                                                                                                                                                                                                                         | Version 7 adds stricter compiler-era rules.                                                 |
| `eslint-config-prettier`           | ^10.1.8            | Disables formatting rules  | MIT        | Prevents lint and formatter from fighting.                                                                                                                                                                                                                                                                                                                                                                                                                    | None.                                                                                       |
| `@eslint/js`                       | ^10.0.1            | Base JS rules              | MIT        | Baseline correctness rules.                                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                       |
| `globals`                          | ^17.11.0           | Environment global lists   | MIT        | Declares browser vs Node globals per file group.                                                                                                                                                                                                                                                                                                                                                                                                              | None.                                                                                       |
| `prettier`                         | ^3.9.6             | Formatting                 | MIT        | Mandated stack. Removes formatting from review.                                                                                                                                                                                                                                                                                                                                                                                                               | None.                                                                                       |
| `jsdom`                            | ^30.0.1            | DOM for component tests    | MIT        | Needed by the `web` Vitest project.                                                                                                                                                                                                                                                                                                                                                                                                                           | No WebGL and no `Worker`; both are stubbed and the gap is covered by Playwright.            |
| `@testing-library/react`           | ^16.3.2            | Component testing          | MIT        | Encourages testing behaviour through the accessibility tree rather than implementation.                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                       |
| `@testing-library/jest-dom`        | ^7.0.1             | DOM assertions             | MIT        | Readable assertions such as `toBeDisabled`.                                                                                                                                                                                                                                                                                                                                                                                                                   | None.                                                                                       |
| `@types/node`                      | ^26.2.0            | Node types for tooling     | MIT        | Types for config files and Playwright specs.                                                                                                                                                                                                                                                                                                                                                                                                                  | Scoped to the root tsconfig; not visible to app or package code.                            |
| `@types/react`, `@types/react-dom` | ^19.2.18 / ^19.2.4 | React types                | MIT        | React ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                         | None.                                                                                       |
| `@types/three`                     | ^0.185.4           | Three.js types             | MIT        | `three` ships no types.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Versioned separately from `three`; the two can drift.                                       |

## Verification performed

For each package above we confirmed the current published version, the official
repository, that it is actively maintained (all had releases within the past
year; most within weeks), and the declared licence. `npm audit` reports **0
vulnerabilities**.

No GPL or AGPL dependency is present in the tree, at runtime or in development.

## Adding a dependency

1. Establish that the need is real now, not speculative.
2. Check maintenance status and the official source.
3. Record the licence and confirm it permits proprietary commercial use.
4. For anything significant, write an ADR.
5. Add a row here.
6. For a **runtime** dependency, also confirm it does not break cross-origin
   isolation — anything loading a cross-origin resource without CORP will.

## Plane-cut triangulation

Open plane splitting uses the pure geometry Mapbox Earcut v3.0.2 implementation already bundled with the pinned Three.js dependency. Its exact source is vendored at `packages/geometry-runtime/src/third-party/earcut.js` to keep rendering code out of geometry packages. The adjacent ISC license is from https://github.com/mapbox/earcut/blob/v3.0.2/LICENSE. Source is unchanged; bounded contour admission, incidence, winding and area validation surround the triangulator. No network or rendering dependency is introduced.
