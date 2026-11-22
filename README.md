# Pybrix

Repair, convert, split, and texture 3D-print models — locally in your browser.

Pybrix (formerly CAD Fixer) is a local-first, browser-based tool for repairing
and preparing 3D printing meshes. The repository, its packages and its
deployment paths keep the `cad-fixer` / `@cadfixer` names; they are identifiers,
not the product's name.

**Your models never leave your machine.** Files are read, processed, and
exported entirely in the browser using Web Workers, WebAssembly, and your own
CPU and GPU. There is no server-side geometry processing, no upload endpoint,
and no analytics.

## Technical Preview

**Try it: <https://pybrix.com>**

This repository carries the **Pybrix v0.8.0 Technical Preview**: editable
connectors, physically sized connectors, corrected exports and the qualified
split core. Auto Split (Beta) is not included in v0.8.0 while its engine
undergoes separate requalification. See the
[v0.8.0 release notes](docs/release/V0_8_0_TECHNICAL_PREVIEW_RELEASE.md).

- Qualified on **Chromium-based desktop browsers** (Chrome, Edge). The critical
  flow also runs in Playwright's WebKit build; Safari, Firefox and real mobile
  devices are **not** release-qualified. See
  [BROWSER_SUPPORT.md](docs/release/BROWSER_SUPPORT.md).
- All geometry is processed in your browser. Nothing is uploaded.
- Deliberately bounded: see
  [What is and is not implemented](#what-is-and-is-not-implemented).

Feedback is how this preview improves — there is no telemetry, so nothing is
observed unless you report it. See
[how to send feedback](docs/beta/TECHNICAL_PREVIEW_FEEDBACK.md), or open a
[Beta feedback issue](https://github.com/cprakash64/CAD-Fixer/issues/new/choose).
Please do not attach models you are not authorised to share.

> **Current status: v0.8.0 Technical Preview.**
> You can open an **STL, OBJ or 3MF** file, inspect it in a real 3D viewport,
> read a full topology report about it, highlight its defects in 3D, **run a
> combined conservative repair and eligible simple flat opening fills with a
> before/after preview, apply it, undo it**, run a read-only self-intersection
> check, and **split a part with one flat cut**. Eligible closed solids can use
> physically sized round pin connectors; open surfaces are plain-cut only.
> Connectors can be edited after a split, and connector dimensions are specified
> in millimetres after the model's unit meaning is explicitly asserted. You can
> also **add a Dots, Lines or Diamond texture to one flat region**, and convert
> or export to any of the three formats — entirely on your own machine.
>
> **"Conservative" is the operative word and it is not marketing.** The Repair
> workflow removes exact duplicate triangles, removes safely-removable degenerate
> triangles, and makes neighbouring triangles agree on their winding. It does
> **not** weld nearby vertices, reconstruct non-planar openings, resolve non-manifold
> topology, or decide which side of a surface is outside — and it refuses, with a
> stated reason, anything it cannot decide from the stored coordinates alone.
> Self-intersections have a bounded read-only diagnostic; wall thickness is not
> measured, so Pybrix does not establish that a model will print.
>
> **Hollow is not implemented**, and Split and Texture do exactly the bounded
> things described above and nothing more. See
> [What is and is not implemented](#what-is-and-is-not-implemented). Nothing in
> this repository fakes a working feature.

## Planned workflows

| Workflow | Purpose                                            | Status                                      |
| -------- | -------------------------------------------------- | ------------------------------------------- |
| Repair   | Repair and prepare meshes for printing             | **Conservative subset implemented** (below) |
| Convert  | Translate between STL, OBJ, and 3MF                | **Implemented** (below)                     |
| Split    | Cut oversized models into parts and add connectors | **Implemented**: one flat cut per split     |
| Texture  | Apply surface displacement patterns                | **Implemented**: flat regions, 3 patterns   |
| Hollow   | Hollow solid models and place drainage holes       | Not implemented                             |

### What "conservative repair" covers

| Operation                              | Implemented | Note                                                                 |
| -------------------------------------- | ----------- | -------------------------------------------------------------------- |
| Remove exact duplicate triangles       | Yes         | Same rotational order only. Reversed duplicates are never removed.   |
| Remove repeated-position triangles     | Yes         | Refused when removal would open the surface or create a defect.      |
| Remove exact zero-area triangles       | Yes         | Exactly collinear corners. No "nearly flat" judgement, no tolerance. |
| Unify relative face winding            | Yes         | RELATIVE to neighbours. Pybrix never decides which side is outside.  |
| Weld nearby vertices                   | No          | Would need a tolerance. See the policy document.                     |
| Close openings in a surface            | Partly      | Eligible simple flat openings in Repair model. See below.            |
| Resolve non-manifold edges or vertices | No          | Reported, and they can block winding unification. Never rewritten.   |
| Detect or resolve self-intersections   | Diagnostic  | Bounded read-only check; no automatic correction.                    |
| Determine printability                 | No          | Wall thickness is not measured.                                      |

### What "automatic filling" covers

Repair model can fill multiple independently safe, simple flat openings even
on large meshes. Fill simple openings is enabled by default. Planning and
preview each verify patches before they can be applied. Conservative changes
and fills share one atomic Apply and Undo; original coordinate identity and
source triangles are preserved according to the qualified repair policy.

Branched boundaries, non-planar rims and patches that would intersect or
double-cover existing geometry are refused. Interacting openings may require
another pass. Non-manifold vertex repair is not implemented. Existing resource
limits remain safety boundaries; filling does not establish printability.
The selected-opening tool remains available within its own bounded policy.
See the [v0.6.0 notes](docs/release/V0_6_0_TECHNICAL_PREVIEW_RELEASE.md).

Target formats: **STL, OBJ, 3MF**.

### What each format can carry

Pybrix reads and writes all three. What survives a conversion depends on the
target, and the app tells you which of these apply to **your** model before it
writes anything.

|                               | STL                                    | OBJ                                 | 3MF                                 |
| ----------------------------- | -------------------------------------- | ----------------------------------- | ----------------------------------- |
| Triangle geometry             | yes                                    | yes                                 | yes                                 |
| Physical unit                 | not stored by the format               | not stored                          | stored, one of six                  |
| Separate parts                | merged into one mesh                   | kept                                | kept                                |
| Part placements               | applied to the coordinates             | applied to the coordinates          | kept as placements                  |
| Repeated shapes               | written out in full                    | written out in full                 | stored once, placed many times      |
| Part names                    | dropped                                | kept                                | kept                                |
| Face groups                   | dropped                                | kept                                | dropped                             |
| Materials, textures, colours  | never written by Pybrix, in any format |                                     |                                     |
| Names with unusual characters | n/a — names dropped                    | adjusted, and the app says so first | adjusted, and the app says so first |

Coordinates are never rescaled in any direction. Exporting a model that states
inches as OBJ writes the same numbers and drops the label — the app says exactly
that before you press the button, rather than claiming the scale was "preserved".

## Getting started

Requires **Node.js 22.12 or later**.

```bash
npm install
```

```bash
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default). The dev server
sends cross-origin isolation headers, matching what production must send.

## Commands

| Command                 | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `npm install`           | Install dependencies from the lockfile              |
| `npm run dev`           | Start the development server                        |
| `npm run build`         | Production build into `apps/web/dist/`              |
| `npm run preview`       | Serve the production build on http://localhost:4173 |
| `npm run lint`          | ESLint across the repository                        |
| `npm run format:check`  | Verify formatting (`npm run format` to fix)         |
| `npm run typecheck`     | TypeScript across every project                     |
| `npm test`              | Vitest unit and component tests                     |
| `npm run test:e2e`      | Playwright end-to-end tests                         |
| `npm run verify`        | format:check + lint + typecheck + test + build      |
| `npm run release:check` | verify, then all three browser suites, in order     |

End-to-end tests need a browser binary once:

```bash
npx playwright install chromium
```

`npm run test:e2e` builds the app and serves it itself — no server needs to be
running first.

## What is and is not implemented

### Implemented

- **STL import**, binary and ASCII, parsed in a Web Worker. The encoding is
  detected structurally, never from the file extension or a leading `solid` —
  binary STL files routinely contain `solid` in their header, and getting that
  wrong is the classic STL bug.
- **A hand-written STL parser** that treats every file as hostile: declared
  facet counts are checked against the real buffer length, every allocation is
  preflighted against a typed budget, and non-finite coordinates are rejected
  rather than silently replaced. Three.js's `STLLoader` is deliberately not used
  as the parsing boundary.
- **Import progress and working cancellation**, including on multi-million-
  triangle files.
- **A real 3D viewport**: your model, with orbit/pan/zoom, fit-view, lighting,
  high-DPI handling, and correct GPU resource disposal when a model is replaced.
- **Model statistics** — triangle and vertex counts, file size, encoding,
  bounding box and radius, and unit status.
- **Topology diagnostics**, run automatically after import, in the worker:
  recovered vertices and edges, connected components, boundary edges and their
  loop/chain/branched structure, non-manifold edges, non-manifold vertices
  (including bow-tie points that edge-only checks miss), winding conflicts,
  duplicate and degenerate faces, Euler characteristic, surface area, and
  algebraic signed volume. Connectivity is recovered from **exact stored
  coordinates** — no tolerance welding, and the mesh is never modified. See
  [ADR 0009](docs/adr/0009-exact-topology-recovery.md).
- **A Mesh Health panel** reporting all of the above with per-component detail,
  and **viewport overlays** highlighting boundary edges, non-manifold edges,
  winding conflicts, and degenerate triangles.
- **Analysis progress and cancellation**, with a report that can never be
  attached to a model it does not describe.
- **Conservative repair** — the first production repair capability. Four exactly-
  decidable operations (above), each shown with its own decision: applicable, not
  needed, refused as unsafe, or blocked by the model's topology, always with a
  reason. Every operation is listed even when there is nothing for it to do, so
  you can see what was checked.
- **A validated before/after preview.** Pressing Preview builds a _candidate_ in
  the worker and re-analyses it; the candidate is accepted only if the requested
  defects improved and nothing else regressed. Your model is not touched. The
  viewport switches between Before and After without moving the camera, and says
  **"Preview — not applied"** whenever the proposal is on screen.
- **Change overlays**, highlighting the sampled removed duplicates, removed
  degenerates and reversed triangles in 3D, with direction markers for reversed
  triangles derived from corner order rather than from the file's stored normals.
- **A change summary** giving the exact before/after topology, and labelling a
  movement as _expected_ only when the validator predicted it. Removing a
  duplicate can legitimately reveal boundary edges the duplicate was hiding; that
  is reported as an expected consequence, not as new damage.
- **Transactional apply**, which swaps one reference in the worker after
  re-checking every guard — revision currency, candidate state, validation
  acceptance, plan identity, single use. A double-click cannot commit twice.
- **Undo of the most recent repair**, restoring the exact mesh the part held
  before it, retained in the worker. See
  [ADR 0011](docs/adr/0011-repair-undo-revisions.md).
- **STL, OBJ and 3MF import.** The format is decided from the BYTES, never from
  the extension: a `.stl` holding an OBJ is refused as a mismatch rather than
  guessed at. OBJ refuses a polygon instead of fanning it; 3MF supports build
  items, component instances, all six units, Zip64 packages, and the 3MF
  Production Extension's references to other model parts — the multi-part
  packages Bambu Studio, OrcaSlicer and PrusaSlicer write. Any other required
  3MF extension is refused by name. No `mtllib` is ever opened and no texture,
  material or external reference is ever resolved. Archive and XML resources
  are bounded during inflation, not after. The exact support statement is
  [SUPPORT_MATRIX.md](docs/release/SUPPORT_MATRIX.md); see also
  [ADR 0015](docs/adr/0015-production-obj-and-3mf-import.md).
- **Format conversion to STL, OBJ or 3MF**, in the Convert workspace, which
  writes the WHOLE document. Before anything is written it reports
  what the chosen format will keep and what it cannot — derived from your actual
  model, so a one-part file is not warned about merged parts and a file with no
  names is not warned about dropped names.
- **Validated output.** Every exported file is read back with the same parser a
  re-import uses and compared against what it was written from. If the two
  disagree the export is refused rather than saved. There is no way to skip it.
- **An export-time unit choice for 3MF.** 3MF has to state what its numbers
  mean; a model from an STL or an OBJ does not know, and Pybrix will not
  guess. You pick one of the six units, nothing is preselected, and the choice
  LABELS the numbers — it never resizes anything and never touches the model.
- **Automatic filling of one selected flat opening.** The Open boundaries panel
  lists every rim where the active part's surface stops, says which ones CAD
  Fixer will attempt and explains the rest, highlights the one you choose, and
  builds a candidate surface you can look at before deciding. Applying it is a
  separate, explicit act; undoing it restores the part exactly. Planar rims only,
  one at a time, up to 512 rim points on a part of up to 250,000 triangles — and
  the generated surface is checked against the part with exact arithmetic and
  discarded if it would pass through it.
- **Single-part STL export**, binary and ASCII, for pulling one part out of a
  multi-part document. Named apart from the whole-document conversion, because
  they are different operations.
- All of it local: files are written from bytes already in memory and handed to
  the browser's own download, with no network involvement and no gating.
- Filename screening at the UI boundary — extension and declared size. **This is
  a usability filter, not a security control, and it reads no file contents.**
- The canonical mesh contract (`packages/mesh-core`) and structural mesh
  validation.
- A typed worker protocol with request correlation, progress reporting,
  cooperative cancellation, structured errors, and buffer transfer
  (`packages/geometry-runtime`), plus a working geometry worker.
- A runtime self-test that transfers a buffer to the worker and back and
  verifies it against a checksum computed before the transfer. This is a
  diagnostic, not a geometry feature.
- A typed application error foundation.
- Strict TypeScript, type-aware linting, formatting, unit tests, end-to-end
  tests, and CI.

### Not implemented

- **No unit CONVERSION.** The 3MF unit chooser states what existing numbers
  mean; nothing anywhere rescales geometry. Inches to millimetres, "normalise
  for printer" and automatic size correction do not exist.
- **No materials, textures or colours, in or out.** An `mtllib` is recorded as
  text and never opened; a 3MF texture is reported as unimported and never
  fetched. Nothing writes a material definition, so a material a model refers to
  by name is reported as lost rather than written as a reference pointing at
  something that is not in the file. Exported files carry no normals and no
  texture coordinates.
- **No reconstruction of an imported 3MF's component nesting.** Every placement
  is imported in the right position, but the hierarchy above it is not retained
  and cannot be rebuilt on export. The conversion report says so when it applies.
- **No conversion is lossless in general.** Each report says what THIS document
  loses to THIS format; STL keeps no parts, placements, names or units, and OBJ
  keeps no units and bakes placements into coordinates.
- **No batch or automatic filling.** Openings are closed one at a time, only
  when you select one and apply it. There is no fill-all and nothing is closed
  on import, on analysis or on repair.
- **No filling of a rim that is not flat.** A rim that curves out of its own
  plane needs a shaped surface, which this version does not build. It is refused
  with a reason rather than approximated.
- **No hollowing or drainage holes, no curved or image-based textures, and no
  cut other than one flat plane per split.** Split and Texture are the only
  operations that run Boolean geometry, and each accepts only a closed,
  manifold part. Import deliberately does not weld vertices, drop degenerate
  triangles, deduplicate facets, reorient winding, or rescale anything — see
  [ADR 0007](docs/adr/0007-stl-preservation-policy.md). Parsing is not repair,
  and repair only happens when you ask for it and confirm the preview.
- **Two geometry kernels, each confined to its own worker.** Geogram (BSD-3)
  runs the self-intersection check and validates hole fills; Manifold
  (Apache-2.0) runs Split and Texture. Both are WebAssembly and their licences
  ship in the build's `third-party-notices.txt`. No lib3mf, OpenVDB, CGAL, or
  OpenCascade — these need licence and WASM-portability evaluation first. The
  licence question is per-kernel (and for CGAL, per package); see
  [Geometry kernel licensing](docs/DEPENDENCIES.md#geometry-kernel-licensing).
- **No self-intersection correction.** A read-only check can report where a
  part passes through itself; nothing resolves it, and a model with zero
  topological defects can still intersect itself — the interface says so on
  every report rather than in a footnote.
- **No 3MF extensions beyond the Production Extension's model-part references.**
  Production alternatives, Secure Content, slices, beam lattices, booleans,
  displacement and required materials are refused by name rather than partly
  read.
- **No streaming import.** A 3MF whose single model entry expands beyond
  256 MiB is refused with a message naming its size and the limit.
- **No wall-thickness analysis**, and therefore **no printability verdict**. The
  report's printability status is never "printable"; the most it says is "not
  yet determined". Filling an opening does not change this: the most Pybrix
  says afterwards is that the selected opening was filled and validated.
- **No tolerance welding.** Two corners one float apart are two vertices, and
  the edge between them is reported as a boundary. That is what the file says.
  There is no epsilon, weld distance or proximity threshold anywhere in the
  conservative repair API, because Stage 3A established that no single global
  tolerance can be correct — the value that heals one model's crack destroys
  another's intentional gap. A future assisted stage will offer welding
  explicitly, with a stated tolerance you choose and a preview.
- **No general mesh repair.** Conservative repair fixes four exactly-decidable
  things and refuses everything else with a reason. Diagnostics identify many
  defects that nothing in Pybrix can currently fix.
- **No automatic repair.** Nothing is changed without a preview you looked at and
  an Apply you pressed.
- **No units for STL.** STL files carry no unit, so Pybrix reports
  "Unspecified by STL" rather than assuming millimetres.
- **No accounts, authentication, payments, pricing, or download gating.** Usage
  is completely open.
- **No analytics or telemetry of any kind.**
- **No persistence.** Nothing is saved between sessions.

## Architecture at a glance

```
apps/web/                   React shell, Three.js viewport, worker transport
packages/shared/            typed errors, units, ids, cancellation
packages/mesh-core/         canonical mesh + structural validation
packages/file-formats/      format descriptors, screening, codec seams
packages/geometry-runtime/  worker protocol, coordinator, worker host
```

Two rules shape the layout:

1. **The UI layer does not own geometry algorithms.** React components render
   state and dispatch intents; they never parse or transform meshes.
2. **Heavy geometry work never runs on the UI thread.**

Both are enforced by tooling: `packages/**` cannot import React or Three.js
(ESLint), and the geometry packages are tested under Node with no DOM at all, so
a browser dependency breaks the test run.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, boundaries, module
  responsibilities
- [docs/PRIVACY_ARCHITECTURE.md](docs/PRIVACY_ARCHITECTURE.md) — network policy
  and how it is enforced
- [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) — every dependency, its purpose
  and licence
- [docs/DEPLOYMENT_REQUIREMENTS.md](docs/DEPLOYMENT_REQUIREMENTS.md) — required
  hosting headers
- [docs/adr/](docs/adr/) — architecture decision records
- [CLAUDE.md](CLAUDE.md) — working rules for this repository

## Known issues

- **Sessions are not saved.** Models live in memory; a reload or a closed tab
  starts empty. While a model has applied changes that have not been exported,
  the browser asks before leaving the page; export to keep your work.
- Importing a very large model (≈500,000 triangles) pauses the page for 1–2 s
  while its render buffers are uploaded to the GPU, after the import progress
  finishes. The import itself runs in a worker.
- The main JavaScript bundle is ~1.07 MB raw (~285 kB gzipped), dominated by
  Three.js and React. Acceptable for a professional tool; worth code-splitting if first
  load becomes a concern. The repair ENGINE is not in it — it lives in the
  ~83 kB worker chunk, and the repair contract's constants are restated in
  `geometry-runtime` rather than re-exported precisely so that stays true.
- Only ONE step of undo is retained, for the most recent repair. Redo is not
  implemented — see [ADR 0011](docs/adr/0011-repair-undo-revisions.md).
- Cancelling a repair discards the result rather than interrupting the pass
  already running: the worker finishes the current deterministic pass, then
  observes the cancel and registers no candidate. Nothing is committed and no
  memory is retained, but on a very large model the cancel is not instant. This
  is the same contract topology analysis has had since Stage 2.
- Component tests run in jsdom, which has no WebGL and no `Worker`; both are
  stubbed. Real rendering and worker behaviour are covered by the Playwright
  suite instead.
- The Float32 vs Float64 choice for vertex positions is deliberately unresolved
  pending benchmarks — see
  [ADR 0004](docs/adr/0004-canonical-mesh-model.md).

## Licence

Not yet determined. This project is intended to become a proprietary commercial
application, and dependency licences are vetted on that basis.
