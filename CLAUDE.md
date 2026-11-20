# Pybrix — Project Rules

Read this before changing anything. These rules exist to prevent architectural
drift across sessions.

## What this is

**Product display name: Pybrix** (formerly CAD Fixer; BRAND-01). Legacy
repository, package (`@cadfixer/*`), environment-variable (`CADFIXER_*`), CSS
class, test id, worker, protocol and deployment identifiers (`/var/www/cad-fixer`,
the nginx files, the GitHub repository) KEEP their CAD Fixer naming until a
separately qualified infrastructure migration. Invariants below that were written
before BRAND-01 say "CAD Fixer"; they mean this product. See "Brand invariants".

**Pybrix is production software, not a prototype.** It is a local-first,
browser-based tool for repairing and preparing 3D printing meshes, intended to
become a commercial product. Code quality, correctness, and privacy guarantees
matter more than moving fast.

Five workflows are planned: **Repair, Convert, Split, Texture, Hollow**. Target
formats: **STL, OBJ, 3MF**.

**REPAIR-UX-01 and REPAIR-CORE-02 (branches `repair-ux-01`, `repair-core-02`,
the v0.6.0 candidate) redesigned the Repair workspace and added automatic,
per-loop filling of simple flat openings to Repair model at large part sizes.**

**Current stage: Stage 7B qualified — a PRODUCTION SPLIT + CONNECTORS MVP on
the qualified Stage 7A editing foundation, plus the PRODUCTION USER-FACING PLANAR
HOLE-FILL WORKFLOW on top of the qualified engine, the user-facing format
conversion workflow, the validated export engine, production STL/OBJ/3MF import,
the multi-part geometry document foundation and conservative deterministic
repair.** The engine, the transaction and the user workflow are all
production. Implemented: structural STL encoding detection, hand-written binary
and ASCII STL parsers with resource budgets, worker-based parsing with progress
and working cancellation, a real Three.js viewport with camera controls, model
statistics, binary/ASCII STL export that round-trips through our own parser,
worker-resident authoritative geometry addressed by handle+revision, read-only
topology diagnostics with a Mesh Health panel and viewport overlays, and the
**conservative repair workflow**: an automatic plan with a per-operation
decision and reason, a validated candidate, a before/after preview that shares
one camera, bounded change overlays, transactional apply, and one step of undo.

Stage 4A-2A migrated the authoritative unit from **one mesh** to **one
`GeometryDocument` holding one or more parts**, with one monotonic document
revision, stable `PartId`s, per-part placements, document-level units, and
geometry structurally shared between parts. STL still describes one thing, so an
STL import produces a one-part document and the single-part workflow is
unchanged. See `docs/adr/0014-multi-part-geometry-document-foundation.md`.

Stage 4A-2B1 added production IMPORT for OBJ and 3MF. All three formats go
through one path: `identifyFormat` decides from the BYTES, `requireReader`
returns that format's reader, every reader produces a `GeometryDocument`, and
`commitImportedDocument` is the one transaction that installs it. See
`docs/adr/0015-production-obj-and-3mf-import.md`.

Stage 6D-A2 made 3MF read the REACHABLE subset of the PRODUCTION EXTENSION: a
root build item or component may carry a `p:path` naming another `.model` part
of the package, and the object it names is resolved in THAT part. See the Stage
6D-A2 section of
`docs/design/STAGE_6D_3MF_PRODUCTION_AND_LARGE_ENTRY_ARCHITECTURE.md`.

Stage 6D-A4 qualified STL, OBJ and 3MF interoperability for the release
candidate against 2,130 real and reference files — the 3MF
Consortium's conformance suites among them — and corrected what that found: see
the Interoperability invariants below and the Stage 6D-A4 section of the design
document. The support statement is `docs/release/SUPPORT_MATRIX.md`.

NOT implemented, and not to be implemented unless a task explicitly asks:
tolerance welding, NON-PLANAR hole filling, batch or "fill all" hole filling,
booleans, remeshing, UNIT CONVERSION of any kind, OBJ polygons, MTL resolution,
3MF production ALTERNATIVES or model-resolution switching, 3MF Secure Content,
encrypted model parts, a `p:path` on a reference outside the root model part,
3MF textures or materials, exported normals
or texture coordinates, exported 3MF group or property resources, reconstruction
of an imported 3MF's component hierarchy, texturing,
hollowing, drainage holes, wall-thickness analysis, inter-part overlap
detection, redo, multi-step undo, transform editing, a persistent "set model
units" document edit, and any repair that is not one of the four conservative
operations.

Stage 4A-2B2 added a validated OBJ and 3MF export ENGINE: `exportDocument`
serialises a document snapshot, reads the bytes back with the PRODUCTION reader,
and returns an artifact only if the two agree. See
`docs/adr/0016-validated-document-export.md`.

Stage 4A-2B3 made all three formats writable and put a workflow in front of the
engine: a whole-document STL writer, a deterministic conversion compatibility
report, and an export-local unit assertion for 3MF. See
`docs/adr/0017-format-conversion-workflow.md`.

Stage 4B-1B1 added a validated planar hole-fill ENGINE and NO workflow.
`packages/mesh-hole-fill` fills ONE selected boundary loop, proven simple,
manifold and planar, with in-house deterministic ear clipping that adds no
vertex; the candidate is validated independently, including a PATCH-ATTRIBUTED
intersection check against the qualified Geogram narrowphase.

Stage 4B-1B2 put a WORKFLOW in front of that engine and changed the engine not
at all: an inventory of open boundaries, selection of ONE by identity, a patch
preview read from the stored candidate, an explicit Apply and an Undo. See
`docs/adr/0018-hole-filling-qualification.md`, its production addendum, its
Stage 4B-1B1-R1 closure addendum and its Stage 4B-1B2 workflow addendum.

**Stage 08B-PROD-A1 (a LOCAL PRODUCT CANDIDATE, not deployed) added Auto Split (Beta): ASSISTED
part detection inside the Split workspace.** An AI provider, reached only through one same-origin
service, says roughly where a head, an arm, a wheel, a cab or a body is in six rendered views; Pybrix
turns that into EDITABLE SUGGESTIONS checked against the real geometry; the user previews, edits and
applies through the existing split transaction. **It never changes a model by itself.** See
`docs/adr/0020-auto-split-same-origin-service.md` and the Auto Split invariants below.

**AUTO-SPLIT-LARGE-MESH-02 (local, not deployed) raised the supported part size for Auto Split AND the
exact split to ONE shared ceiling of 2,000,000 triangles**, aligned the Manifold input budget to it,
made the long local passes cancellable and told a larger part so as a neutral status before anything
runs. See the large-mesh split invariants below and `docs/design/AUTO_SPLIT_LARGE_MESH.md`.

**Topology diagnoses; it never repairs.** Connectivity is recovered from exact
stored coordinates with no tolerance, and analysis leaves the canonical buffers
byte-identical. See `docs/adr/0009-exact-topology-recovery.md`.

**Parsing is not repair.** Import preserves exactly what the file contains — no
welding, no dropping degenerate or duplicate triangles, no reorientation, no
rescaling, no invented units. See `docs/adr/0007-stl-preservation-policy.md`.

## Git attribution policy

**Never add Claude, Anthropic, an AI model, or an AI tool as a Git author,
committer, co-author, `Co-Authored-By` trailer, `Generated-By` trailer, or
equivalent attribution.** All Git commits in this repository must use only the
user's configured Git identity unless the user explicitly requests otherwise.

Claude Code IS expected to create the commits itself — the prohibition is on
attribution METADATA, not on who does the work. This is a statement about who
the repository's contributors are, and it is the user's to make.

This says nothing about prose. Documentation, ADRs and commit bodies may discuss
Claude Code, `CLAUDE.md` or Anthropic wherever that is the accurate thing to
write; the rule is about commit trailers and identity fields only.

## Non-negotiable rules

1. **Production software, not a prototype.** No throwaway code, no "we'll fix it
   later" shortcuts in committed work.
2. **Raw user geometry stays local by default.** Never add code that transmits a
   user's model, or anything derived from it, anywhere.
3. **No backend geometry processing.** No server-side geometry, no file upload
   endpoint. The application is a static site. **One disclosed exception (ADR 0020):** Auto Split's
   optional same-origin service receives six rendered PNGs and three bounded numbers — never a model,
   a vertex, a face or a file name — and the release bundle contains none of it.
4. **Never do expensive geometry work on the UI thread.** Parsing, validation,
   repair, booleans, subdivision, displacement, hollowing, and export run in
   workers. If it touches a whole mesh, it belongs off-thread.
5. **Do not invent third-party APIs.** If you are not certain a function,
   option, or export exists, verify it.
6. **Verify unfamiliar or current APIs against primary documentation** — official
   docs, the package's own type definitions, or the registry — before relying on
   them. Package APIs and versions change.
7. **Prefer explicit types.** Especially at module boundaries and in exported
   signatures.
8. **Avoid `any`.** If it is genuinely unavoidable, document why in a comment at
   the site. A narrow, explained `as` assertion is preferable to `any`.
9. **Never suppress a TypeScript, compiler, or linter failure to make CI pass.**
   No `@ts-ignore`, no `eslint-disable`, no weakening `tsconfig` strictness. Fix
   the cause. If a rule is genuinely wrong for the codebase, change it
   deliberately in the config with a comment explaining why.
10. **Never silently catch errors.** No empty `catch`. Every caught error is
    either handled meaningfully, converted with `toAppError`, or rethrown.
11. **Geometry results require post-operation validation.** Returning a mesh is
    not success. Pass output through `assertMeshStructure` before accepting it —
    including output from a WASM kernel that reports success.
12. **Do not silently modify user geometry.** An operation that may materially
    change a model must state what it will change, expose warnings, support
    cancellation where feasible, preserve an undoable previous state, and
    validate its result.
13. **Add a test for every bug fix**, reproducing the bug.
14. **Do not weaken a test to make it pass.** If a test fails because behaviour
    legitimately changed, update it to assert the _new_ behaviour precisely —
    never by loosening an assertion or deleting a case.
15. **Keep dependencies minimal.** Every runtime dependency needs a reason to
    exist now, not a speculative one.
16. **Check licences before adding a significant dependency**, and record it in
    `docs/DEPENDENCIES.md`.
17. **No GPL/AGPL runtime code without explicit approval.** This product is
    intended to be proprietary. Copyleft that is not GPL/AGPL (LGPL, LGPL with a
    linking exception) is not automatically disqualifying but carries obligations
    that must be evaluated first. Geometry kernel licensing is per-kernel and,
    for CGAL, **per package** — read
    `docs/DEPENDENCIES.md#geometry-kernel-licensing` rather than assuming.
18. **Preserve the UI/geometry separation.** React components do not own
    geometry algorithms. `packages/**` must not import React or Three.js, and
    must never import from `apps/**`.
19. **Run the relevant checks before declaring work complete** (see below). Do
    not report that checks passed unless you actually ran them.
20. **Report assumptions and unresolved risks** rather than hiding them.

## Repository layout

```
apps/web/                   React application shell
  src/components/           presentation only
  src/state/                framework-free workspace store
  src/runtime/              the ONLY place a Worker is constructed
  src/viewport/             Three.js scene lifecycle
  src/workers/              worker entry point (own tsconfig: WebWorker lib)
packages/shared/            typed errors, units, ids, cancellation
packages/mesh-core/         canonical mesh + multi-part document + validation
packages/file-formats/      format descriptors, screening, budgets, identification,
                            STL codec, OBJ + 3MF readers, bounded ZIP and XML,
                            validated STL + OBJ + 3MF document writers, and the
                            conversion compatibility policy (src/export/)
packages/mesh-topology/     read-only topology analysis (no mutation, no welding)
packages/mesh-repair/       conservative deterministic repair (kernel-free)
packages/mesh-hole-fill/    planar hole-fill engine: ordered-loop eligibility,
                            relative planarity, deterministic ear clipping, a
                            bounded patch-query broadphase, and independent
                            validation (kernel-free; narrowphase injected)
packages/geometry-runtime/  worker protocol, coordinator, worker host
docs/                       architecture, dependencies, privacy, deployment
docs/adr/                   architecture decision records
e2e/                        Playwright specs
```

Dependency direction is one-way:
`shared ← mesh-core ← file-formats`, `shared ← mesh-core ← mesh-topology`,
`shared ← mesh-core ← mesh-topology ← geometry-runtime`,
`shared ← mesh-core ← mesh-topology ← mesh-hole-fill`, all ← `apps/web`.
`geometry-runtime` gained a `mesh-core` dependency in Stage 1 because geometry
operations speak `CanonicalMesh`, and a **type-only** `mesh-topology` dependency
in Stage 2 because `model/analyze` returns a topology report and an untyped
result at that boundary would let the worker and its consumer drift apart. It
must NOT depend on `file-formats`, so codecs stay behind the worker's operation
handlers.

## Commands

```bash
npm install          # install from the lockfile
npm run dev          # dev server (cross-origin isolated)
npm run build        # production build
npm run preview      # serve the production build on :4173
npm run lint         # ESLint
npm run format:check # Prettier check
npm run typecheck    # TypeScript, all projects
npm test             # Vitest unit and component tests
npm run test:e2e     # Playwright end-to-end (needs `npx playwright install chromium`)
npm run test:e2e:timing # Timing/responsiveness proofs, SERIAL (see below)
npm run test:e2e:harness # Multi-part document proofs in Chromium, SERIAL (see below)
npm run test:e2e:auto-split # Auto Split against the real service + a deterministic provider, SERIAL
npm run test:e2e:auto-split-large # the 2,000,000-triangle chain, refusal, many-shell and Cancel probes (minutes; on demand)
npm run bench:auto-split-large # local Auto Split passes by size, before/after the reference implementations (NOT in CI)
npm run bench:auto-split-large-split # the exact split at the ceiling with the real Manifold WASM (NOT in CI)
npm run verify       # format:check + lint + typecheck + test + build
npm run release:check # verify + test:e2e + test:e2e:harness + test:e2e:timing, in order
npm run bench:stl      # STL parser benchmark (NOT in CI)
npm run bench:topology # small topology benchmark (NOT in CI)
npm run bench:pipeline # whole-pipeline benchmark, 1/10/50/100 MiB (NOT in CI)
npm run bench:document # document-wrapper cost + part-count scaling (NOT in CI)
npm run bench:formats  # OBJ + 3MF import at 1/10/50 MiB (NOT in CI)
npm run bench:export   # OBJ + 3MF export, sizes and placement counts (NOT in CI)
npm run bench:repair-browser # repair workflow timings in a real browser (NOT in CI)
npm run bench:hole-fill # hole-fill phase timings and broadphase reduction (NOT in CI)
npm run bench:boundary-listing # automatic boundary-walk cost by shape (NOT in CI)
npm run qualify:threemf-corpus # real producer 3MF files; CADFIXER_CORPUS=<dir>, ships no data
npm run qualify:interop-corpus # STL + OBJ + 3MF through every import gate, optional export
                               # (CADFIXER_CORPUS, CADFIXER_CORPUS_REPORT, CADFIXER_EXPORT=1)
npm run qualify:import-phases  # Chromium footprint, ATTRIBUTED BY PHASE (NOT in CI)
npm run qualify:streaming-import # buffered vs streamed 3MF read, worker-side, in Chromium (NOT in CI)
npm run qualify:streaming-corpus # buffered vs streamed over a real 3MF corpus; CADFIXER_CORPUS=<dir>
npm run check:node     # runtime version guard; also runs before test/build/verify
```

Before declaring work complete, run `npm run verify`. Run `npm run test:e2e` as
well when you have touched the shell, the worker, or the build.

**`npm run test:e2e:timing` is a SEPARATE command, and it is not optional.**
Timing and responsiveness proofs — cancellation ratios, main-thread gaps — live
in `playwright.timing.config.ts` and run single-worker. They are excluded from
`test:e2e` because a ratio between two measurements is only meaningful when both
see the same machine load: under four parallel workers the Stage 3B cancellation
ratio was measured anywhere from 0.640 to 1.17, and a ratio above 1.0 cannot be
a statement about cancellation at all. Run it whenever you touch cancellation,
the worker lifecycle, or anything that could move work onto the main thread.

**`npm run test:e2e:harness` is a THIRD suite, and it serves a different page.**
The shipped application can only import STL, so it can only ever hold one part —
which is why DF07, DF08, DF10 and multi-part responsiveness had no browser
evidence when Stage 4A-2A first landed. `playwright.harness.config.ts` serves
the end-to-end harness build instead: the same application, store, worker
handlers and viewport, with a synthetic multi-part document put in front of
them. Run it whenever you touch the document model, the viewport, part
selection, or anything a multi-part document reaches. Since Stage 4A-2B2 it is
also the ONLY caller of the document export engine, so run it whenever you touch
a writer, the export worker or the export controller.

THE HARNESS MUST NEVER SHIP, and five boundary tests enforce that: no import
edge from `apps/web/src`, one application build input, no `createWorker` in the
production entry, no injection global or query parameter, and no harness
identifier in the built output. If a change would be easiest to make by adding a
route into authoritative geometry from the application, that change is wrong —
see `docs/adr/0014-multi-part-geometry-document-foundation.md#r1`.

These proofs are also sensitive to WHOLE-MACHINE load, which no test
configuration can remove. On a busy host the same suite has taken 42 minutes
with spurious timeouts and seconds when quiet. A timing failure on a loaded
machine is not evidence of a regression — re-run it on a quiet one before
believing it.

## Document invariants (Stage 4A-2A)

- **ONE MONOTONIC REVISION PER DOCUMENT, never one per part.** It lives in
  `ResidentDocumentStore`, not as a field on `GeometryDocument` — a field would
  be a second authority that could disagree. A change to ANY part consumes the
  document's revision, so a result for part A is invalidated by an edit to part
  B. That over-invalidation is deliberate and was qualified: an over-invalidated
  result is recomputed, an under-invalidated one is applied to geometry it was
  not built from.
- **THE PART IS PART OF THE IDENTITY.** Two parts of one document carry
  IDENTICAL handles, so a handle comparison cannot say which mesh a result
  describes. Every guard that compares handles must compare `partId` too — the
  topology cache, the report echo, the repair candidate, `expectedPart` at
  commit, the undo record, the self-intersection report, and every workspace
  slice.
- **`expectedPart` is STATED by the caller, never read off the candidate.**
  Reading it off the candidate compares the candidate with itself and the guard
  becomes vacuous.
- **ONE UNIT AUTHORITY: `GeometryDocument.unit`.** A mesh has no unit field.
  `undefined` means unknown and is NEVER defaulted to millimetres.
- **ONE TRANSFORM AUTHORITY: `GeometryPart.transform`.** A mesh has no transform
  field, so a shared mesh cannot be placed two contradictory ways. Twelve Float64
  values, row-major 3×4. Never baked into Float32 positions.
- **Geometry is SHARED, not copied.** Two parts may hold the same
  `CanonicalMesh` object. `withPartMesh` carries untouched parts across by
  reference, `documentByteLength` counts each mesh once, the render snapshot
  builds buffers per DISTINCT mesh, and `SharedPartGeometry` reference-counts the
  GPU geometry so disposal cannot free a buffer another part is drawing from.
- **`activePartId` is workspace state, not geometry identity.** Changing it must
  NOT change the document revision. Switching parts clears the per-part
  diagnostic slices rather than carrying them across.
- **Automatic work follows the ACTIVE part only.** A hundred-part document must
  not launch a hundred topology passes or a hundred WASM kernels on import.
- **Every part-targeted request carries its `partId` explicitly.** The
  authoritative worker never infers a target from UI selection state.
- **Self-intersection is INTRA-PART.** Two independently valid parts that overlap
  in world space are not self-intersecting, and nothing checks whether they do.
  Never flatten a document for the diagnostic.
- **STL export writes ONE part and says what it left out.** STL holds one
  object. The panel states this before the click. Never flatten silently. It
  writes that part AS PLACED — see the export placement invariants (Stage C03-D).
- **`assertGeometryDocument` is the second gate**, mirroring
  `assertMeshStructure`. Structural validity is NOT mesh health: a part with
  degenerate triangles is a valid document describing a defective model.
- **Selecting a part is NOT a model change.** `setActivePart` moves the overlay
  and preview frame; `setModel` rebuilds the scene. Routing selection through
  `setModel` disposed and re-uploaded every part's GPU geometry on a click — four
  uploads for a two-part document where two were correct, two thousand for a
  thousand placements. The harness suite asserts zero geometry work on a switch.
- **Local bounds belong to the MESH, not the part.** Compute them once per
  DISTINCT mesh and apply the placement to the box afterwards. Computing per part
  walked one shared buffer a thousand times — 356 ms at 1,000 placements.

## Import invariants (Stage 4A-2B1)

- **THE BYTES DECIDE THE FORMAT, never the extension.** `identifyFormat` sniffs
  at most 4 KiB plus the file length. The name is used only to disambiguate an
  ambiguous sniff and to REPORT a mismatch: a `.stl` holding an OBJ is refused
  as `ContentExtensionMismatch`, not parsed as either.
- **ONE COMMIT PATH.** Every reader returns a `GeometryDocument` and every
  import goes through `commitImportedDocument`. A format-specific commit is a
  second transaction that can disagree with the first.
- **`assertMeshStructure` runs per DISTINCT mesh, not per part.** A thousand
  placements of one object share one `CanonicalMesh`; validating per part
  validates the same buffer a thousand times.
- **OBJ REFUSES A POLYGON, it never fans one.** A naive fan of the research
  corpus's concave pentagon produced a triangle of the opposite orientation,
  covering area outside the polygon the file described. `o` becomes a part; `g`
  is recorded as group membership and does NOT create one.
- **`mtllib` IS NEVER OPENED**, and no 3MF texture, material, schema or
  relationship is ever resolved. They are recorded as unsupported features and
  reported by name. Following a path chosen by an untrusted file is a read the
  user did not ask for.
- **ZIP budgets are enforced DURING inflation, chunk by chunk, and ACROSS
  ENTRIES.** The directory's declared uncompressed size is a claim by the
  attacker; checking it and then inflating anyway proves nothing. `inflateRaw`
  yields chunks for exactly this reason — a `Promise<Uint8Array>` would mean the
  allocation had already happened. One `InflationBudget` is created per import
  and passed to every entry, and each chunk is checked against the PROSPECTIVE
  total BEFORE it is retained; stored entries are charged too. The budget is a
  REQUIRED field on `ZipReadOptions`, because an optional one is not enforced
  the first time someone adds a second `readZipEntry` call.
- **THE READER'S PART CEILING IS THE DOCUMENT'S.** `DEFAULT_3MF_LIMITS.maxParts`
  reads `DEFAULT_DOCUMENT_LIMITS.maxParts`, and `DEFAULT_OBJ_LIMITS.maxFaces` /
  `maxNameLength` read the document's ceilings too. A reader limit above the
  document's means a file is fully expanded and then refused — all of the work
  and none of the protection. Tests assert they stay equal.
- **The expansion budget is checked BEFORE the part is appended**, so the walk
  stops rather than building the part that crosses and unwinding. Triangle and
  vertex totals are carried through the walk for the same reason: a document
  counts them PER PART, so repeated placements of one shared mesh multiply them.
  `maxTotalGeometryBytes` is deliberately left to the document gate — it is
  charged per DISTINCT mesh, so no expansion can reach it early.
- **Names are truncated to the DOCUMENT'S cap, not to a larger one.** Truncating
  at 1,024 while the gate refuses above 512 is not truncating: it made a model
  with a 600-character object name unimportable for a display string.
- **XML IS FAIL-CLOSED BEFORE IT IS PARSED.** `describeUnsafeXml` refuses any
  DOCTYPE, ENTITY, SYSTEM or PUBLIC identifier before a single element is read,
  and the scanner is ours — never `DOMParser`. The refusal must not depend on a
  parser being configured correctly.
- **A 3MF without `unit` means MILLIMETRE.** The specification defaults the
  attribute, so an absent one is a stated unit, not an unknown one
  (`THREE_MF_DEFAULT_UNIT`). This is not "inventing a unit": the value comes
  from the format's definition. STL is the opposite case — no unit field exists,
  so an STL states nothing and the interface says `Unspecified by STL`.
  Coordinates are never rescaled either way.
- **The platform primitives are INJECTED, not imported.** `file-formats`
  compiles with `lib: ES2023` and no DOM or Node types, so `TextDecoder` and
  `DecompressionStream` arrive as `decodeText` and `inflateRaw` on
  `FormatReadContext`. A codec that reached for them directly would stop being
  runnable under plain Node, and the differential suite against the research
  readers would stop being possible.
- **Every refusal carries an `ImportRefusal` code** in `AppError.details.reason`.
  Tests assert the CODE, never the sentence, so wording can change without
  weakening what a test proves.
- **Names and parser text from a file are UNTRUSTED.** Object names, group
  names, material references and file names render as text. No
  `dangerouslySetInnerHTML`, and no error message may carry archive, XML or OBJ
  content into markup.

## Import resource invariants (Stage 6D-R3)

- **THE GATE MEASURES WHAT THE DOCUMENT WILL HOLD; IT PREDICTS NOTHING.**
  `measureImportGeometry` sums, ONCE PER DISTINCT MESH, the canonical buffers the
  reader produced and the render snapshot `buildDrawableTriangles` is about to
  allocate — 72 bytes a triangle, because the draw is NON-INDEXED and sharing
  corners makes a mesh cheaper to store and not one byte cheaper to draw.
  `checkImportGeometry` compares that against `MAX_IMPORT_GEOMETRY_BYTES`
  (768 MiB) in `commitImportedDocument`, immediately before the snapshot is
  built. One call site, all three formats.
- **`estimateImportPeak`, `checkImportPeak`, `maxImportPeakBytes`,
  `checkResident`, `maxRenderBytes`, `residentBytesFor` and `renderBytesFor` ARE
  DELETED AND MAY NOT COME BACK.** The estimator ran AFTER the transient peak it
  named, charged SUMMED triangles so a thousand placements of one mesh were
  billed a thousand times, and passed the CANDIDATE's triangle count as the
  outgoing document's render bytes. Measured error spanned two orders of
  magnitude and CHANGED SIGN with content shape.
- **THE CONSTANT LIVES IN `mesh-core/import-cost.ts`, BESIDE THE ALLOCATION IT
  BOUNDS**, with the Chromium measurements that produced it written above it. A
  `9 * 4 * 2` restated in the budget module would be a second answer to "how big
  is a render snapshot", and the first time the snapshot gained a buffer the gate
  would quietly stop bounding it.
- **THE CURRENT DOCUMENT IS NOT A TERM, AND THAT IS MEASURED.** A large
  replacement does not stack: the outgoing buffers are released as the successor
  commits. There is no parameter through which resident state could enter, and a
  test asserts the same candidate reaches the same verdict twice.
- **THE STL PRE-GATE IS DERIVED, NEVER A SECOND NUMBER.**
  `DEFAULT_IMPORT_BUDGET.maxUnsharedImportTriangles` reads
  `MAX_UNSHARED_IMPORT_TRIANGLES`, which is
  `MAX_IMPORT_GEOMETRY_BYTES / 120`. STL never welds, so the cost is fixed by the
  declared count — four bytes at offset 80 — and the refusal lands before the
  first array. 6,710,886 triangles, a 320.00 MiB binary file exactly. A ceiling
  of its own here would mean a file fully parsed and THEN refused: all of the
  work and none of the protection. OBJ and 3MF cannot be pre-gated, because their
  triangle count is a fact about contents rather than length.
- **A RESOURCE REFUSAL NAMES THE METRIC, THE VALUE AND THE LIMIT.** "This would
  use more memory than CAD Fixer allows for one session" named none of the three
  and presented an estimate as memory. That sentence is gone from the import gate
  and from `requestAnalysisWorkspace`, which now says how many triangles the part
  has and how much working memory that needs.
- **THE GATE DOES NOT BOUND THE PARSE TRANSIENT and does not pretend to.** The
  inflated 3MF entry, the decoded XML string and the readers' scratch arrays are
  bounded by the per-entry and package inflation budgets, which Stage 6D-B3
  measured and this stage did not reopen.

## Multi-model-part invariants (Stage 6D-A2)

- **THE ROOT'S BUILD IS THE ONLY BUILD.** A referenced part's build section is
  parsed into its record and NEVER walked: the specification requires consumers
  to ignore it, and a child's build describes how that part looks ON ITS OWN, so
  walking one would invent placements the package never asked for. Its build is
  not validated either — refusing a package over entries no consumer reads would
  reject files every conformant reader accepts.
- **REACHABILITY DECIDES WHAT IS OPENED.** A `.model` entry nothing references
  is never inflated, never parsed and never charged. There is no `loadAll`. A
  test puts a MALFORMED spare part in an otherwise valid package: if reachability
  were not the rule the package would be refused rather than imported.
- **THE IDENTITY IS `(ModelPartKey, objectId)`, NEVER A BARE ID.** Object ids are
  unique within a model part, not within a package, so `id="1"` in two parts is
  ordinary 3MF. A bare-id lookup produces a document of the right SHAPE with the
  wrong geometry in it, and a bare-id cycle path refuses an ordinary package as a
  loop. Both directions are tested with marker meshes.
- **NO FALLBACK, IN EITHER DIRECTION.** A cross-part reference is NEVER retried
  against the referring part's table, and a same-part reference never reaches the
  package resolver. The test for the first has the root declare an object with
  the same id the cross-part reference asks for, so a fallback would find it and
  import the wrong geometry as a success.
- **`THREEMF_MISSING_MODEL_PART_OBJECT` IS NOT `THREEMF_MISSING_OBJECT_REFERENCE`.**
  One is a package whose parts disagree; the other is a broken object graph
  inside one file. They send a user to different places, so they are not one
  code.
- **A `p:path` OUTSIDE THE ROOT PART IS REFUSED, not followed and not ignored.**
  The extension permits a path-bearing reference only in the root. Following it
  would import geometry the specification says no consumer should reach;
  ignoring it would silently drop a placement the file asked for.
- **EVERY PACKAGE TOTAL IS THE PACKAGE'S.** Triangles, vertices, parts, component
  depth and the inflation budget are each ONE quantity across every reachable
  model part, and none resets at a part boundary. Stage 6D-R1 recorded the
  counters resetting per parsed model as the defect A2 had to fix: two parts each
  just inside the ceiling would have passed while producing twice it.
  `ThreeMfLimits.maxTotalTriangles` / `maxTotalVertices` exist so the
  package-wide property is provable at four triangles instead of twenty million;
  a test keeps them equal to the document's.
- **ONE MODEL PART IS OPEN AT A TIME.** `open -> inflate -> decode -> parse ->
materialise -> RELEASE -> next`. The entry buffer and the decoded XML are
  locals of the part loader, and `materialiseMeshes` CLEARS the parser's Float64
  scratch once the canonical buffers exist — with one part that only inflated the
  peak, with a package it would accumulate, because every loaded part stays
  reachable until the import ends.
- **THE WALK IS STRICTLY SEQUENTIAL**, and a boundary test forbids `Promise.all`.
  Ordering: the document's part order must be the file's traversal order, not the
  order loads settled. Lifetime: concurrent branches would open several model
  parts at once.
- **REACHABLE PARTS MUST AGREE ABOUT THE UNIT**, and a disagreement is
  UNSUPPORTED rather than malformed — nothing in such a package is
  self-contradictory, and honouring it would mean rescaling, which CAD Fixer
  never does. An absent `unit` compares as MILLIMETRE, because the specification
  defaults the attribute. Unreachable parts are never compared.
- **`requiredextensions="p"` NO LONGER REFUSES, AND NOTHING ELSE CHANGED.** Every
  other extension is still refused on declaration, by the root AND by any
  referenced part. `THREEMF_MULTI_MODEL_PART_UNSUPPORTED` was REMOVED: it named
  the sentence "CAD Fixer does not support that extension yet", which stopped
  being true, and a code with no producer would invite the sentence back.
- **NO PRODUCTION METADATA IS INTERPRETED EXCEPT `path`.** `p:UUID` is ignored
  because it cannot affect geometry, transform, placement, unit or which
  representation is selected. Broadening that list needs its own reasoning.

## Production Extension semantics (Stage 6D-A3)

- **THE ROOT MODEL PART IS THE ONE THE PACKAGE NAMES.** 3MF core identifies it by
  the OPC relationship `.../2013/01/3dmodel` in the root `.rels`, and the
  production extension adds that non-root model files MUST NOT appear there — so
  the relationship is unambiguous. `resolveRootModelEntry` tries the
  relationship, then the conventional `3D/3dmodel.model`, then a SINGLE `.model`
  entry, and **refuses** (`THREEMF_AMBIGUOUS_ROOT_MODEL_PART`) rather than
  guessing between several. The old `findModelEntry` took the first `.model` the
  ZIP DIRECTORY listed, which after Stage 6D-A2 could be a CHILD part — and the
  reader walks the ROOT's build, so it would have answered from the wrong part
  silently. A `.rels` Target goes through `canonicalisePackagePath`, so
  relationships are never a weaker route into the archive.
- **ZIP64 IS READ, AND IT IS NOT A LARGE-ARCHIVE FEATURE.** A writer may emit the
  Zip64 structures at any size, and Bambu Studio and OrcaSlicer do — their
  140 KiB and 256 KiB calibration packages carry the `0xFFFFFFFF` sentinel in
  every size and offset. CAD Fixer refused all of them as corrupt. The Zip64
  record and the tag-1 extra field are consulted ONLY when a fixed field is its
  sentinel, each field resolved on its own. **EVERY CEILING IS APPLIED TO THE
  RESOLVED VALUE**: checking the sentinel refuses an ordinary entry as four
  gibibytes, and skipping the check leaves a real one unbounded. A sentinel with
  no extra field is MALFORMED, never a fallback. 64-bit values are read as two
  halves and refused above 2^53.
- **MEANING COMES FROM THE NAMESPACE URI, NEVER FROM THE PREFIX.** `p`, `prod`,
  `x` and `production` are all the same attribute. A boundary test asserts no
  string literal in the reader matches a literal prefix, and that the two
  production URIs — `production/2015/06` and
  `production/alternatives/2021/04` — are compared exactly rather than by
  substring. "Contains the word production" is not a version policy.
- **THE ALTERNATIVES EXTENSION IS REFUSED, AND THE TENSION IS WRITTEN DOWN.**
  `THREEMF_MODEL_RESOLUTION_UNSUPPORTED`. It selects between `fullres`, `lowres`
  and `obfuscated` representations, so ignoring it could hand a user an obscured
  model as their part. Core says a consumer MUST ignore namespaces it does not
  support, so this is a NARROW, namespace-scoped exception — not an
  "unknown namespace is an error" policy. A declared-but-unused extension still
  imports, and an unknown element from one is still ignored.
- **`requiredextensions` HOLDS PREFIXES**, resolved through the map. Production is
  accepted because it is implemented; every other extension is still refused, in
  the root AND in any referenced part.
- **WHAT IS DELIBERATELY NOT VALIDATED, each for a stated reason:**
  `[Content_Types].xml` (packaging metadata; a non-model entry fails to parse
  anyway), a referenced part's own `.rels` (the `path` names the target
  directly), a referenced part's `<build>` (normatively ignorable, so validating
  it is a false refusal), `p:UUID` in any form (a producer requirement with no
  mandated consumer validation), and a package that uses `p:path` without
  declaring the extension required (a producer-side MUST that changes no
  interpretation).
- **A TRANSFORM TOKEN IS CHECKED LEXICALLY BEFORE IT IS COERCED.** `Number` reads
  `0x10` as sixteen and `Infinity` as infinity, and neither is an `xs:double` —
  the same reasoning that made `pid` a lexical check. An ABSENT or EMPTY
  transform is identity; a PRESENT but unusable one is malformed.
- **UNITS ARE THE SIX CORE TOKENS, CASE-SENSITIVELY.** `Millimeter` is not one of
  them and is refused rather than normalised: the format enumerates lower-case
  values, so accepting a variant would be inventing a spelling.

## Interoperability invariants (Stage 6D-A4)

- **THE ROOT RELATIONSHIP NAMES THE ROOT, WHATEVER IT IS CALLED.** The OPC
  relationship's TYPE is what makes a part the 3D model; the 3MF Consortium's
  positive conformance cases name roots `/3D/3dmodel`, `/3D/3dmodel.moodel` and
  `/3D/3dmodel.part`, and CAD Fixer refused them as "not a 3MF file". The `.rels`
  target goes through `canonicalisePackagePartName` — every shape rule, no
  `.model` suffix — and the relationship is read BEFORE asking whether any
  `.model` entry exists. A production `path` keeps the suffix rule:
  `canonicalisePackagePath` is `canonicalisePackagePartName` plus the suffix,
  never a parallel implementation, and a boundary test holds that.
- **A CORE MEANING NEEDS A CORE ELEMENT.** `isCoreElement`: a PREFIXED element
  whose prefix does not resolve to the core namespace is ignored — `d:vertex`
  inside a displacement mesh is not a vertex. An UNPREFIXED element keeps its
  meaning, because lib3mf's v0.9.3 fixtures put core elements in the
  pre-release `2013/01` default namespace and have always imported. Tightening
  the default namespace needs its own evidence.
- **A DECOMPRESSOR FAILURE IS A DAMAGED FILE, NOT AN INTERNAL ERROR.**
  `readZipEntry` converts only what the platform inflater's `next()` throws;
  AppErrors — cancellation, budget refusals — pass through, and the stream is
  still released on early exit. The untyped `TypeError` it replaced reached the
  user as the file name followed by an empty message. **The loop pulls `next()`
  DIRECTLY, never through an `async function*` layer**: the first version of
  this fix did, and a 2 x 1.2 M-triangle production package peaked at 1,600 MiB
  in Chromium against 1,221–1,242 MiB without it — chunks queued beside the
  preallocated entry buffer. A boundary test keeps async generators out of
  `zip.ts`. Any change to this loop is re-measured with
  `npm run qualify:import-phases -- 3mf-package:2:1200000` against the previous
  build, interleaved, several runs each: A3 alone spans 1,285–1,730 MiB on the
  8 GiB host.
- **THE ZIP DIRECTORY IS BOUNDED BEFORE IT IS FOLLOWED.** A Zip64 locator that
  leads to no valid record is corruption, never a fallback to sentinel values
  (which reported "65,535 entries"). The record must sit before its locator.
  Split archives — any disk number other than the first, entries-on-disk not
  equal to the total — are refused. An entry whose data or offset lies outside
  the archive is refused at the directory. A deflated entry declaring output
  from ZERO compressed bytes is an unbounded ratio and is refused before its
  allocation. A stored entry whose two sizes differ is corrupt. The EOCD is the
  signature whose comment ends the file, so a signature inside a comment cannot
  shadow the real one.
- **OBJ TOKENS ARE CHECKED LEXICALLY BEFORE THEY ARE COERCED**, as 3MF transform
  tokens are. A face corner is `v`, `v/`, `v/vt`, `v//vn` or `v/vt/vn` with
  integer components (`OBJ_CORNER`); `Number` would have read `0x2` as two.
  **So are coordinates, in both formats (PR-01)**: an OBJ number is decimal
  (`OBJ_DECIMAL`), a 3MF coordinate an `xs:double` and a triangle index an
  `xs:nonNegativeInteger`, after XML Schema's whitespace collapse. `Number`
  alone had imported `v 0x10 0 0` as sixteen.
- **AN ASCII STL LINE ENDS AT LF OR CR.** A classic-Mac file's `solid` line used
  to run to the end of the file.
- **EVERY OBJ GROUP BOUNDARY SURVIVES EXPORT.** OBJ has run-START records and no
  run-END record, so the writer emits one wherever the reader needs one — an
  empty-named group (a plain STL `solid`), the face after a group (a hole-fill
  patch), a part's first face — and `expectedObjRoundTrip` states the one thing
  OBJ cannot say: once a run has started, faces in no group come back in an
  EMPTY-named group. Before this, OBJ export of every ASCII STL with an unnamed
  solid, and of every hole-filled grouped mesh, was refused on parse-back.
- **CONFORMANCE NEGATIVES ARE FOR PRINTERS.** Many of the 3MF Consortium's
  negative cases are geometrically defective meshes a printer must reject and a
  repair tool exists to open — negative volume, inward normals, fewer than four
  triangles, non-manifold edges. CAD Fixer imports those exactly, and Mesh
  Health diagnoses them. The rest it accepts are OPC, content-type, metadata and
  UUID checks A3 deliberately does not enforce. Neither is a licence to accept
  a negative case that changes GEOMETRY; each accepted negative is classified in
  the Stage 6D-A4 design section, and a new one must be too.

## Auto Split invariants (Stage 08B-PROD-A1, ADR 0020)

- **AUTO SPLIT NEVER MUTATES A MODEL.** The four `autosplit/*` worker operations read a part or build a
  split CANDIDATE; none commits. Apply is the existing `split/commit`, Undo the existing `repair/undo`,
  so one Apply is one document transaction and one Undo restores the exact previous mesh OBJECTS. A
  boundary test asserts the handler module reaches no `replace`, `commit` or history call. Never add a
  path that applies a suggestion without a preview the user asked for.
- **A PROVIDER ANSWER IS DATA.** It arrives as `unknown`, is validated in the service, again in the
  browser and again in the worker, and can only become suggestions. It cannot name a part, a revision, a
  handle or an operation, and a test injects an instruction-shaped field to prove it.
- **THE REQUEST HAS NO FIELD FOR GEOMETRY.** `AnalyzeRequest` is six clean 512 × 512 RGB PNGs, a mode, a
  protocol version and three bounded numbers. The service refuses unknown keys and a deny-list of
  mesh-looking keys (`RAW_GEOMETRY_REJECTED`), and the PNG inspector refuses any chunk but
  `IHDR`/`IDAT`/`IEND`. Never widen the request without changing the contract, the validator, the
  disclosure, the privacy document and the ADR together.
- **THE KEY LIVES IN ONE PLACE.** `OPENAI_API_KEY` is read by the service at start-up and nowhere else:
  not a `VITE_*` variable, not in a bundle, not in a log, an error, a response or a test (tests use an
  obviously fake one). The browser supplies no prompt, model or URL; the protocol version is pinned in
  server code and the vehicle protocol's three hashes are asserted.
- **THE LOCAL SOURCE GATE IS MANUAL SPLIT'S, AND IT IS NOT WEAKENED.** A part that is not a closed solid
  shows its suggestions with Preview and Edit disabled and "Part found, but this model needs Repair
  before it can be split." Repair is offered only when every reason is one Repair addresses (winding,
  degenerate or duplicate triangles).
- **A SUGGESTION BELONGS TO A REVISION.** The session reads a result back only for the
  (document, revision, part) it was made for: a new revision stales it (still listed, never
  executable), another document clears it and the cache, and a run in flight for anything else is
  cancelled. A late answer is dropped by generation, never applied.
- **A PLANE SUGGESTION IS LOADED INTO MANUAL SPLIT'S CONTROLS**, by `planeSettingsFor`, which is
  round-trip tested against `splitPlaneFor`. There is no second plane editor. When the controls cannot
  express a plane exactly the nearest is loaded and the interface says so.
- **THE MOCK PROVIDER AND THE TEST MODELS NEVER SHIP.** They exist in `packages/auto-split/src/fixtures`
  and `apps/auto-split-api/src/test-server.ts` (own build, `dist-test`, git-ignored). The production
  entry is `allowMock: false`; boundary tests assert nothing that ships imports either.
- **CONSENT IS IN MEMORY ONLY.** Nothing is written to storage; the disclosure is asked again after a
  reload. Nothing is requested on import, on opening the tab or on choosing a model type.
- **THE COPY LIVES IN `state/auto-split-presentation.ts`**, all of it, with exhaustive switches. The only
  claim it may make is "AI-assisted part detection with editable split suggestions": no accuracy figure,
  no number that reads as confidence, no "perfect", "every part" or "one-click", no research vocabulary,
  no retention promise. A test bans each.
- **THE DEFAULT TAB IS MANUAL SPLIT**, so the qualified 08A workflow opens exactly as it did. Auto Split
  is the second tab, badged Beta, and the Inspector is never opened by it.

## Large-mesh split invariants (AUTO-SPLIT-LARGE-MESH-02)

- **ONE TRIANGLE CEILING FOR EVERY SPLIT PATH: `MAX_SUPPORTED_SPLIT_TRIANGLES` (2,000,000), in
  `mesh-core/src/split-limits.ts`.** Auto Split's worker handlers, the page's pre-check and the Boolean
  adapter's per-input gate all read it, so Auto Split never accepts a part the exact split would refuse
  for size alone. 1,999,999 and 2,000,000 are allowed, 2,000,001 is refused, and tests hold all three.
  Never restate the number. Raising it needs the ladder in
  `docs/design/AUTO_SPLIT_LARGE_MESH.md` re-measured, not an argument.
- **THE MANIFOLD INPUT BUDGET IS DERIVED, NEVER A FLAT CONSTANT.** `MAX_BOOLEAN_INPUT_BYTES` is
  `(MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES) * 84`, where 84 is
  `BOOLEAN_KERNEL_BYTES_PER_TRIANGLE` (nine Float64 coordinates and three Uint32 indices) and
  `booleanKernelInputBytes` is the one estimator the backend uses. The tool term is not slack: a plane
  split intersects the part with a 12-triangle half-space, so `2,000,000 * 84` alone would refuse the part
  the ceiling admits. It replaced a flat 128 MiB that refused at 1,597,830 triangles, below the Boolean
  ceiling it sat under.
- **EVERY INDEPENDENT GUARD STAYS.** The Boolean adapter's triangle ceiling, the topology-workspace
  limit, the canonical-byte limit, the output-triangle limit and the edit-peak limit each fire on their
  own. Raising one budget aligned it with the others; it removed none.
- **A SIZE VERDICT IS A STATUS, NOT A FAILURE.** A part above the ceiling is told so BEFORE Find parts,
  from `PartDescriptor.triangleCount`, as `role="status"` with the size, the limit, "your model is
  unchanged and nothing was sent", and NO retry. The worker's check (`AUTO_SPLIT_TOO_DETAILED`) is the
  authority and the page's is courtesy; its refusal maps to the same status, never to the alert.
  `2,000,001` is written out in full against `2,000,000`, so a sentence never says a number exceeds a
  limit it prints equal to.
- **A RESOURCE REFUSAL OF A CUT NEVER SAYS "USE MANUAL SPLIT".** Manual Split meets the same exact-split
  limits, so pointing at it is a promise the product cannot keep. A split declined for resources is a
  neutral status (`ResourceRefusalCard`); "adjust the cut or use Manual Split" remains for a cut that is
  merely unsound. All of it is copy in `state/split-size-presentation.ts`.
- **EVERY LONG LOCAL PASS TAKES A `Checkpoint`, AND A CHECKPOINT NEVER CHANGES A RESULT.** The renders,
  the labelling, the plane search and the extraction call it every `CHECKPOINT_STRIDE` units; the worker
  passes `context.throwIfCancelled`, which reads the SHARED cancellation word and so sees a Cancel from
  inside synchronous work. The three Auto Split dispatches are `interruptible`. Where a pass cannot be
  interrupted (a page without cross-origin isolation) Cancel is WITHDRAWN, not left to lie.
- **THE CAB/BED SEARCH SCREENS, THEN CONFIRMS EXACTLY.** A face's side of a plane is the sign of
  `t - offset`, so it is exact in any order; only the ORDER of the area sums differs between a one-pass
  screen and the per-candidate scorer. Screening ranks 625 candidates a seed in one pass per tilt; only
  those within `SCREEN_KEEP_WINDOW` of the best are scored by the original ascending-face-order `purity`,
  and the original selection loop runs over them. The selected plane and its score are bit-identical to
  the frozen reference (`fixtures/reference-cab-bed.ts`), and the argument is written beside the
  constants. Never widen the screen's tolerance or narrow the window without redoing it.
- **THE FROZEN REFERENCES ARE ORACLES.** `fixtures/reference-*.ts` hold the code that stood at 5272c59
  verbatim. They live under `fixtures/`, which the production boundary scan forbids production code to
  import, and they are never "improved": an oracle edited to match the thing it checks proves nothing.
- **BOOKKEEPING IS TYPED, GEOMETRY IS NOT TOUCHED.** Component extraction and the kernel's exact-coordinate
  indexing replaced a JavaScript `Map` per vertex with int32 tables: 593 MB of heap became 1 MB, and 2.1 s
  per operand became a fraction of that, with the same numbering and the same coordinates (`-0` kept).
  Welding was considered and rejected: it adds topology semantics the ceiling does not need.

## Camera framing invariants (v0.7.1)

- **A DOCUMENT IS FRAMED ONCE, BY IDENTITY.** `ViewportPanel` keeps the document id the camera was last
  fitted to (`framedDocumentRef`); `setModel(..., { preserveView })` is true only for the SAME document
  inside the Split workspace (a preview or an applied split of what is on screen). A different document is
  fitted exactly once, from its own bounds. The decision was once `preserveView: splitWorkspaceRef.current`
  alone, which kept model A's framing for model B whenever Split was open (owner acceptance, v0.7.0).
- **NOTHING ELSE REFITS.** Not a re-render, a preview, Exploded / Assembled, a part selection, Show part,
  a connector control or the inspector. No timer, no polling, no triangle-count heuristic. The viewport
  publishes `data-document-fit-count`, `data-camera-distance` and `data-camera-fit-ratio` so
  `e2e/camera-replacement.spec.ts` reads what the camera did; the ratio is exactly `1 / FIT_PADDING` when
  fitted.
- **`commitImport` RESETS THE PREVIOUS DOCUMENT'S PRESENTATION**: the applied-split layout (`assembly`)
  and `previewExploded`. Model A's view state must not reach model B.
- **THE WORKSPACE PACKAGE LINKS ARE RELATIVE.** `node_modules/@cadfixer/*` links resolve into whichever
  tree owns that `node_modules`. A git worktree that borrows another tree's `node_modules` builds the
  OTHER tree's packages, silently ignoring its own edits: give the worktree its own `@cadfixer` links.

## Auto Split state invariants (v0.7.1)

- **RECOGNIZED, GROUNDED AND SPLITTABLE ARE THREE FACTS.** Recognized: the service named a part. Grounded:
  its outline reached faces of the model (`Suggestion.grounding`: GROUNDED / NOT_GROUNDED with face and
  view counts). Splittable: a cut or a component set was proposed. The list heading counts parts
  RECOGNIZED, never splits.
- **"NO SAFE SPLIT FOUND" IS A FINDING ABOUT A PROPOSED CUT.** A part nothing was proposed for reads
  "No cut suggested", one inside a single shell "Built into the body", one that could not be isolated
  "Couldn't isolate this part reliably". A skipped analysis, a spent allowance, an ungrounded part, a
  rejected service answer and a stale result may never produce the phrase. Copy lives in
  `state/auto-split-presentation.ts`; a test bans the phrase on every row that was not examined.
- **GROUNDING IS KEPT, NOT RECOMPUTED, AND IS BOUNDED.** The per-face view mask the engine builds for
  every part is retained bit-packed in the worker (`GroundedRegion`: one bit a face, at most 24 parts —
  497 KB on the 1,988,877-triangle truck) beside the preparation it came from and released with it. The
  page receives only scalars and, on request, face indices (`autosplit/part-faces`).
- **SHOW PART IS DISPLAY ONLY.** It needs no candidate, loads nothing into Manual Split, creates no
  revision, history entry, transaction or analysis charge, and never reframes the camera. It marks the
  surface the service outlined as seen from six views — approximate, and the interface says so. The
  request is made only for the result's own (document, revision, part); a replaced document clears every
  recognized part, its highlight and its Show part state. `shownPartId` is separate from `shownId` and
  `selectedId`.
- **THE NATIVE ALLOWANCE IS PER SELECTION.** Each Preview request gets the bound the policy states (one
  attempt of one finalist on 250,000+ triangles); outcomes are remembered per part (`winners`, `refused`),
  so a repeat does no new work and a refused part reports a completed analysis again. A limit inside a
  request is a typed `SEMANTIC_NATIVE_BUDGET_EXHAUSTED` that is never worded as a finding. The previous
  session-wide counting refused every part after the first on a large model without examining it. No
  ceiling was raised.
- **THE OWNER'S TRUCK IS A GATED REGRESSION FIXTURE.** `large-truck-grounding.test.ts` runs only with
  `CADFIXER_TRUCK_STL` set and ships no model; its hierarchy is a deterministic fixture authored from the
  engine-rendered views, not a provider answer. No real provider call is ever made by a test.

## Streaming 3MF ingestion invariants (Stage 6E-A1 prototype, 6E-A2 production)

- **BUFFERED IS `read3mf`'s DEFAULT; THE PRODUCT ROUTES — Stage 6E-A3
  SUPERSEDES THIS PARAGRAPH'S FIRST SENTENCE.**
  `ThreeMfReadOptions.ingestion` is `'buffered' | 'streaming' | 'auto'`,
  defaulting to buffered, and the registry's `threeMfReader` is
  `createThreeMfReader({ ingestion: ThreeMfIngestion.Auto })` — see the
  automatic-routing invariants below. The shipped worker still registers
  `modelImportHandler`, built from `PRODUCTION_IMPORT_CONFIG`
  (`Object.freeze({})`), and nothing under `apps/web/src` names an ingestion
  mode, `createThreeMfReader`, `zipLimits` or `maxEntryBytes`. `maxEntryBytes`
  is still 256 MiB. Boundary tests hold all of it. A larger ceiling is 6E-A4's
  decision.
- **THE SEAM IS A CONSTRUCTION SEAM, NOT A SWITCH.** `createModelImportHandler`
  takes an optional 3MF reader. Only the end-to-end harness passes one, chosen
  through a harness-only `harness/ingestion` message the shipped worker has no
  listener for. No flag, query parameter, setting or storage key reaches it.
- **QUALIFICATION HOOKS ARE NOT PRODUCT OPTIONS.** Stream statistics, byte and
  pass callbacks, yield cadence and narrower stream limits exist only on
  `read3mfForQualification`, which the package index does not export.
- **EQUALITY WITH THE BUFFERED READER IS THE CONTRACT, QUIRKS INCLUDED.** A tag
  ends at the first `>`; `<?>` and `<!-->` are complete; text is never
  delivered. Both modes feed ONE `createModelXmlParser` through ONE `applyTag`.
  Never fix a quirk in only one of them. The single intended difference is
  `XML_TAG_TOO_LONG` (16 attribute widths = 1 MiB), which only the streamed
  path can raise.
- **TWO PASSES, AND THE FIRST DECIDES — STRUCTURALLY.** `openTwoPassEntry`
  charges the package budget in `security()` only and refuses to open
  `semantic()` until `security()` reached its verified end; `scanXmlByteStream`
  creates the element handlers only after the security verdict. A part refused
  for a DOCTYPE, ENTITY or external identifier never instantiates a parser.
- **ONE SECURITY IMPLEMENTATION, AND IT RUNS NO REGULAR EXPRESSION.**
  `XmlSecurityStream` (`xml-security.ts`) is the rule set for both modes:
  `describeUnsafeXml` pushes the whole text through it. The v0.2.0 regular
  expressions live in `xml-stream.test.ts` as the oracle it is held to.
- **NO DECODED MODEL PART OUTLIVES THE IMPORT (finding R1).** V8 keeps a
  substring's parent alive, and two routes used to keep the WHOLE decoded part
  reachable after an import — up to 256 MiB, twice that with one character above
  U+00FF: the regular-expression last-match state, and a kept object name of 13+
  characters. They are closed where they open: `detachedCopy` on the stored name,
  and `forgetRegExpMatch` after every buffered part and in a `finally` around
  every read. `scripts/xml-retention.test.ts` measures the heap for both modes,
  both routes and a refusal, and fails if either half is removed. **Do not copy
  every tag instead**: that closed the same routes and raised a two-part
  package's peak by ~350 MiB in Chromium, by shifting when the worker collected
  the previous part's garbage.
- **ONE INFLATER, FED IN SLICES.** `createSlicedInflater`
  (`INFLATE_INPUT_SLICE_BYTES`, 64 KiB) is the only raw-deflate shape; the
  workers build theirs in `apps/web/src/workers/platform-inflate.ts`, the one
  `new DecompressionStream` in the application. One write of the whole payload
  made Chromium inflate the entire entry into its queue. It is an explicit
  iterator, not an `async function*`, and releases both sides on every exit.
- **NO CRC IS VERIFIED, in either mode, as in v0.2.0.** Corruption surfaces as a
  decode error ("damaged") or a size mismatch, identically in both modes.
- **Namespaces resolve from `<model>` only**, in both modes. 3MF Core defines an
  XML namespace as one declared on the `<model>` element; the Stage 6E design
  document records the evidence and the residual risk.

## 3MF size-policy invariants (Stage 6E-A4)

- **ONE SOURCE OF TRUTH: `threemf/size-limits.ts`**, a leaf module that imports
  NOTHING. `MAX_THREEMF_MODEL_ENTRY_BYTES` (320 MiB) and
  `MAX_THREEMF_PACKAGE_BYTES` (512 MiB) are read by `DEFAULT_ZIP_LIMITS`, by the
  3MF WRITER and by every refusal message. Nothing restates either number.
- **THE ENTRY CEILING IS 320 MiB, AND THE WORST CASE IS INDEXED, NOT SOUP.**
  Stage 6D-B3 rejected 384 MiB after measuring 2,679–3,071 MiB for a 376 MiB
  entry on the BUFFERED path. Streaming halved that — but A4 first proposed
  384 MiB from a ladder built out of UNSHARED SOUP at ~185 bytes a triangle,
  which **understated the worst case by ~650 MiB**. 3MF shares vertices: an
  indexed grid carries a triangle every ~70 bytes, and so do the 3MF
  Consortium's own large positive cases. Remeasured on that shape the peak steps
  from 1,641 MiB whole-browser at a 302 MiB entry to 2,056 at 321 MiB and
  2,506 at 364 MiB. **Any future ceiling argument must use maximally dense
  INDEXED content**; a soup ladder will say the ceiling can be higher than it
  can. The 6D-B3 section of `docs/release/RESOURCE_POLICY.md` is superseded, not
  deleted — it is correct about the reader it measured.
- **WHAT BOUNDS THE PEAK NOW IS GEOMETRY, NOT THE ENTRY.** A 480 MiB text-heavy
  entry around four triangles peaks at 452–461 MiB, varying ±3 MiB across runs.
  The ceiling is a proxy for triangles and a loose one: at 320 MiB the densest
  admissible file carries about 4.8 million of them.
- **THE MARGIN OVER BETA-002 IS 23 MiB AND IS DELIBERATE.** The tester class is
  ~297 MiB; the next credible step up crosses the cliff. Widening it would mean
  admitting the 2.0–2.5 GiB region. Do not widen it without remeasuring on
  indexed content.
- **A MULTI-PART PACKAGE IS CHEAPER THAN ONE LARGE ENTRY WITH THE SAME
  GEOMETRY**, because one model part is open at a time: 2 × 252 MiB carrying
  2,833,988 triangles peaks at 1,433–1,535 MiB whole-browser against
  1,925–2,214 for a single 492 MiB entry carrying fewer. That is why the
  PER-ENTRY ceiling is the one that moved and **the 512 MiB package total did
  not** — and why a package still cannot hold two maximum-sized parts.
- **THE ENTRY CEILING MAY NEVER EXCEED THE PACKAGE CEILING**, and must leave at
  least 64 MiB of room beside it, or a maximum-sized part could not have a
  sibling. Asserted in `size-limits.test.ts`.
- **THE WRITER MAY NEVER PRODUCE A MODEL ENTRY THE READER WOULD REFUSE.** The
  3MF writer bounds its model XML by
  `min(maxSerialisedBytes, MAX_THREEMF_MODEL_ENTRY_BYTES)`. Before A4 it used
  `maxSerialisedBytes` (512 MiB) while the reader refused above 256 MiB, and the
  gap was REACHABLE: a ~1.5 M triangle document — an ordinary multi-part package
  — was serialised in full, compressed to 22.7 MiB, and then refused at
  parse-back as `ZIP_ENTRY_TOO_LARGE`, surfacing as an INTERNAL error after all
  the work. A resource refusal from the writer is a decision; one from the
  validator is CAD Fixer saying it wrote a file it cannot read.
- **EXPORT VALIDATION ROUTES LIKE AN IMPORT — Stage 6E-A4 REVERSES 6E-A3.** A3
  pinned parse-back to `buffered` so a routing defect could not validate an
  invalid file. At a 320 MiB ceiling that would cost more than importing does.
  The replacement safety is the 2,474-file three-way differential plus
  `ingestion-routing.test.ts`; the artifact is still FULLY parsed and FULLY
  validated, and nothing is trusted because we wrote it. The export worker
  supplies `createTextDecoder` for this, and so does `testExportReadContext`.
- **A REFUSAL MAY NOT READ AS A CONTRADICTION.** `formatBytes` rounds to whole
  units above ten, so a 402,704,688-byte entry refused against a
  402,653,184-byte ceiling printed "expands to 320 MiB; ... limit is 320 MiB".
  `formatBytesAgainst` adds two decimals ONLY when the plain rendering would
  collide, and renders an exact tie as a tie. Every size refusal that compares a
  value with its ceiling uses it.
- **FIXTURES THAT MEAN "OVER THE CEILING" DERIVE FROM THE CEILING.**
  `threeMfOverEntryCeiling()` declared a flat 300 MiB and silently became a file
  the product ACCEPTS when the ceiling moved. It now reads
  `MAX_THREEMF_MODEL_ENTRY_BYTES + 1`, and sizes its incompressible payload from
  that too so the RATIO never fires first and the fixture keeps testing the
  ceiling.
- **BETA-002 IS A SUPPORTED RESOURCE CLASS ON `main` AND IS NOT RELEASED.** The
  live v0.2.0 build still refuses above 256 MiB. The support matrix says so at
  the top; do not let it read as though the deployed site changed.

## Automatic ingestion routing invariants (Stage 6E-A3)

- **THE ROUTE IS DECIDED PER MODEL ENTRY, FROM ITS DECLARED UNCOMPRESSED SIZE,
  BEFORE A BYTE IS DECOMPRESSED.** `routeModelEntryIngestion` in
  `threemf/ingestion-route.ts` — a leaf module that imports NOTHING — streams an
  entry declaring `THREEMF_STREAMING_THRESHOLD_BYTES` (128 MiB) or more and
  buffers anything below it. One literal, one decision, asked once in
  `loadModelPart`. A package may legitimately buffer its root and stream a
  child; a package-wide choice would make small parts pay two passes or make a
  large one hold a quarter of a gibibyte.
- **NOTHING BUT THE DECLARATION MAY ENTER IT.** Not available memory, a heap
  estimate, elapsed time, host load, the file name, the producer, the
  compression ratio alone, or whether the part holds characters above U+00FF. A
  boundary test forbids all of them, so the same file routes the same way on
  every machine and a refusal stays reproducible. There is NO Unicode rule and
  none is needed — the shapes that suffer most on the buffered path are the
  shapes that grow.
- **THE DECLARATION IS A HINT, NEVER AN INTEGRITY CLAIM.** The per-entry
  ceiling, the package ceiling, the 200:1 ratio, the package inflation budget,
  the overrun check against the declaration and the shortfall check at the end
  of the stream are enforced by `zip.ts` on BOTH paths. An upward lie is bounded
  by the RATIO, which is checked against the declaration at the directory before
  any route is chosen; a downward lie is caught by the overrun check, which
  bounds the buffered allocation by the lie. No mode is the one that catches a
  lie, which is why no mode can be the one that misses it.
- **THE THRESHOLD IS DERIVED FROM MEASUREMENT AND THE ERRORS ARE NOT
  SYMMETRIC.** Streaming too early costs at most ~101 MiB and is bounded,
  because the streamed peak hardly moves with size; buffering too late costs
  292 MiB at 142 MiB dense, 642 MiB at 128 MiB text-heavy, and grows without
  limit. 128 MiB sits ~10 MiB below the sharp buffered step at ~140 MiB, so no
  supported input depends on buffered behaviour near it. Moving it needs the
  full ladder in `docs/design/STAGE_6E_STREAMING_3MF_IMPORT.md` re-run, not an
  argument.
- **ROUTING IS NOT A CEILING AND CHANGES NO ELIGIBILITY.** `maxEntryBytes` is
  still 256 MiB, the package total still 512 MiB. Crossing the threshold
  refuses nothing and admits nothing. **BETA-002 IS STILL UNSUPPORTED**: A3
  raised no limit, and A4 decides the new maximum.
- **THE PRODUCT'S ONE CHOICE IS ONE LINE IN `codec.ts`**:
  `createThreeMfReader({ ingestion: ThreeMfIngestion.Auto })`. Nothing under
  `apps/web/src` names a mode, a reader factory or a ZIP limit.
- **`read3mf`'s OWN DEFAULT STAYS BUFFERED, AND BOTH FORCED MODES SURVIVE.**
  v0.2.0's path is the ORACLE every differential holds the other two to; a
  default of `auto` would make those suites compare routing with itself. The
  harness bridge's `buffered` no longer aliases the production config — `auto`
  does — for exactly the same reason. Never delete a forced mode.
- **A MODE THAT MAY STREAM NEEDS A TEXT DECODER AND REFUSES UP FRONT.** `auto`
  raises the wiring fault when it is asked for, never at whichever file happens
  to be first past the threshold. A silent fallback to buffered would undo the
  routing on exactly the entries that need it, and say nothing.
- **ROUTING IS INVISIBLE TO THE USER.** No message, no warning, no setting, no
  choice, no progress change. The ONE observable difference is
  `XML_TAG_TOO_LONG`, which only the streamed scanner can raise and which
  routing therefore makes size-dependent; it needs more than sixteen
  maximum-length attributes on one element and no producer file has come close.
- **`onRoute` IS QUALIFICATION-ONLY AND IS NOT TELEMETRY.** It exists because a
  mixed-mode package is otherwise unprovable from outside — both paths produce
  the same document, which is the point. Reached only through
  `read3mfForQualification`, which the package index does not export.
- **EXPORT VALIDATION READS BUFFERED ON PURPOSE, AND SAYS SO.**
  `exportDocument` states `ingestion: Buffered` rather than inheriting a
  default. Making the validator depend on the routing decision would let a
  routing defect pass an invalid file; making it independent means it cannot.

## Export invariants (Stage 4A-2B2)

- **VALIDATION IS MANDATORY AND HAS NO SWITCH.** Every successful OBJ or 3MF
  export has been read back by the PRODUCTION reader, under production limits,
  and compared with what it was written from. A serialiser returning bytes is not
  proof of a valid artifact. Never add "skip validation for faster export".
- **THE PAGE NEVER HOLDS GEOMETRY; IT DOES HOLD THE ARTIFACT.** The snapshot
  travels worker to worker over a `MessageChannel`; the finished FILE comes back
  to the page, because that is what the user asked to save and it cannot be
  edited back into the model.
- **THE SNAPSHOT IS A COPY, ONE PER DISTINCT MESH.** Transferring the
  authoritative arrays would detach them and let a terminated export worker take
  the user's model with it. A thousand placements copy one mesh, not a thousand.
- **CANCELLATION IS TERMINATION.** `CompressionStream` polls no flag of ours, so
  a cooperative token alone would be a lie for part of the work. The export
  worker is disposable and Cancel kills it. One export at a time.
- **A STALE ARTIFACT IS DISCARDED, NEVER DOWNLOADED.** The snapshot carries the
  revision it was built from, and the controller re-checks it against the handle
  the caller asked for. Bytes from a revision the user has moved off describe
  geometry they are no longer looking at.
- **OUTPUT CEILINGS ARE DERIVED AND ENFORCED INCREMENTALLY.**
  `maxSerialisedBytes` (512 MiB) is the reader's own intake ceiling — an export
  our reader would refuse could never be validated. `maxOutputBytes` (256 MiB) is
  half of it, because the artifact, the snapshot and the parsed-back document are
  live at once. Both are checked BEFORE a chunk is retained.
- **OBJ BAKES TRANSFORMS; 3MF PRESERVES THEM.** Baking is Float64
  `applyPartTransform`, then `Math.fround`, then nine significant digits — the
  same single narrowing the reader performs. Never `toFixed(6)`: it fails 50.7%
  of Float32 values. Negative zero is written explicitly, and `isIdentity` uses
  `Object.is` for the same reason.
- **A 3MF NEEDS A UNIT AND CAD FIXER WILL NOT INVENT ONE.** Unknown unit is
  `BLOCKED_UNIT_REQUIRED`, never `millimeter`. The reader's millimetre default is
  the SPECIFICATION saying what an absent attribute means; an STL-derived
  document has asserted nothing. Coordinates are never rescaled to hide a lost
  unit either.
- **3MF GROUPS OBJECTS BY (MESH, NAME)** — the metadata the `<object>` element
  actually carries. Parts that agree share one object; parts that disagree get
  their own, and the split is recorded. A differing MATERIAL REFERENCE does not
  split anything, because none is written. The imported component hierarchy is
  NOT reconstructed.
- **ARCHIVE PATHS ARE A FIXED LIST THE WRITER DECIDES.** No entry path is derived
  from a document name, a part name or a material reference. Untrusted strings
  are XML DATA: escaped with all five predefined entities, control characters
  dropped because XML cannot carry them.
- **THE WRITER'S OUTPUT MUST SATISFY THE READER'S SECURITY CONTRACT.** No
  DOCTYPE, no entities, no external identifiers, no remote references — a file
  our own reader would refuse is a file the user cannot open.
- **OBSERVATIONS ARE MACHINE-READABLE FACTS, NOT SENTENCES.** `ExportObservation`
  records what a writer did; Stage 4A-2B3 decides the wording. Two copies of that
  copy would drift.
- **INDEPENDENT ORACLES SIT BESIDE PARSE-BACK.** Our reader agreeing with our
  writer proves only that they agree. `obj-oracle.ts` and `threemf-oracle.ts` are
  test-only structural checkers that share no code with production, and a
  boundary test keeps them out of it.

## Export placement invariants (Stage C03-D)

- **A FILE HOLDS THE PART WHERE THE DOCUMENT PUTS IT, in every format.** The
  active-part STL export (`model/export`) used to write `part.mesh` and ignore
  `part.transform`: a part that was translated, rotated, scaled or mirrored came
  out somewhere other than where the document has it, and a connector-bearing
  split piece at ×2 came out half its physical size. It now writes
  `placeMesh(part.mesh, part.transform)`, with no copy at all for an identity
  placement. Whole-document STL and OBJ bake while streaming; 3MF writes
  placements as build-item transforms. Never write local coordinates for a
  placed part and say nothing.
- **ONE PLACEMENT ARITHMETIC AND ONE ORIENTATION QUESTION.** `applyPartTransform`
  applies a placement (Float64, narrowed once to Float32). `placementReversesOrientation`
  (the sign of `placementLinearDeterminant`, the same triple product
  `classifyPlacement` reads for `mirrored`) answers whether a placement turns a
  mesh inside out. No exporter re-derives either. It is independent of
  `classifyPlacement`'s support policy: a non-uniform placement that also
  mirrors reverses orientation too, and an exporter that bakes it must turn the
  triangles whether or not a connector could have been cut into that part.
- **A MIRROR REVERSES THE WINDING, EVERYWHERE IT IS BAKED.** Positions go where
  the placement puts them; keeping the stored corner order writes a closed solid
  inside out (negative volume, normals into the material). `placeMesh`, the
  whole-document STL writer, the OBJ writer, its stream validator and the two
  expected round-trips all exchange the second and third corner of every triangle
  of a part whose placement mirrors. Before C03-D2 the whole-document STL and OBJ
  exports of a mirrored part were inside out.
- **A 3MF BUILD ITEM NEVER REFLECTS.** A negative-determinant item transform is
  one of the defects the 3MF Consortium's conformance suite files as a negative
  case, so a mirrored part is written as its mesh mirrored in x (corners turned)
  and the placement composed with that mirror (`mirroredObjectPlacement`: the
  first basis row negated, zeros kept +0). World positions are exactly what they
  were: both steps are negations. `planThreeMfObjects` keys on (mesh, name,
  mirrored): mirrored placements of one mesh share ONE mirrored object, plain
  ones keep the plain object, and the page's `threeMfObjectCount` mirrors that
  rule. A part whose placement mirrors does not come back as the same
  (mesh, transform) pair on re-import; it comes back as the same PHYSICAL object.
- **BAKING NEVER RESCALES AND NEVER LABELS.** STL and OBJ state no unit: the
  coordinates written are the document's, placement applied, with no unit
  invented and none lost to a different number. A known unit survives only where
  the format can state it (3MF). The active-part STL says "placement was applied"
  (`STL_EXPORT_PLACEMENT_APPLIED`, with `mirrored`) only when there is one.
- **THE ORACLE THAT MATTERS IS BYTES MEASURED BY CODE THAT SHARES NOTHING.**
  The C03-D export oracle parses the written STL, OBJ and 3MF with its own
  parsers and applies placements with its own arithmetic. A test that exports
  through our writer and reads back with our reader proves only that they agree.

## Editable connector model invariants (Stage EC-1 model, EC-2 rebuild engine, EC-3 transactions, EC-4 page projection, ADR 0033)

EC-1 is the MODEL, its lifecycle and its accounting. EC-2 is the engine that rebuilds a joint's connectors from what it retained.
EC-3 records a joint at split commit and makes an edit a transaction (`joint/list`, `joint/propose`, `joint/commit`,
`joint/discard`). EC-4 makes the page a projection of the worker's joints. There is still no CONTROL that edits one: the page has typed
client methods for the edit operations and nothing calls them yet.

- **A JOINT IS SESSION STATE IN THE WORKER'S DOCUMENT.** `GeometryDocument.joints` holds records for the two parts of one cut, the
  pre-connector pieces they were built from, the physical frame they were sized in and the engine's interface authority. No reader
  produces it and no writer reads it; `exportSnapshotOf` builds a fresh part list and cannot carry one. The page holds
  `JointDescriptor`s — ids, a status, a reason and counts — and never a mesh. A boundary test names every module allowed to build
  a joint list and every one that may never mention one.
- **VALIDITY IS DERIVED FROM THE PARTS, NEVER STORED.** `jointAttachment` is the one function that says whether a joint is usable:
  both parts present, no document unit that contradicts the frame's (a unit-less model does not: the unit asserted at split time is the
  frame's, and the document never gains one), both placements element-wise equal to the ones it was built under, and both meshes
  the exact OBJECTS it built. Identity, not content: a byte-equal copy is a change. The reasons come in a fixed order (part removed,
  unit, placement, geometry) so one document has one answer. A stored flag would be carried onto a changed part, because
  `withPartMesh`, `withPartTransform` and the split candidate all spread the previous document.
- **RETIREMENT IS AT THE ONE INSTALL PATH.** `ResidentDocumentStore.replace` (and `commit`) retire every joint that is no longer
  attached, replacing the record with a bounded descriptor and releasing the meshes it held. The same document object is installed
  when nothing retires, and the part array is shared in every case. A retired joint is never edited, rebuilt, re-attached or
  guessed. A boundary test asserts the two writes to the resident map and the single call site.
- **UNDO NEEDS NO RULE OF ITS OWN.** `repair/undo` installs the previous document OBJECT, so a joint attached before a change is
  attached again after undoing it.
- **A PART IS IN AT MOST ONE ATTACHED JOINT**, because an edit rebuilds both of a joint's pieces. The document gate refuses two.
- **INTENT IS STORED IN MILLIMETRES WITH ITS FRAME.** A pin carries `diameterMm`, `depthMm`, `clearanceMm`; a local length is
  derived through the frame and never stored as intent. A site is always explicit: the exact `local` point the pin was cut at plus its `(u, v)` in the interface frame, and an
  explicit site is validated, never trusted. `mmPerCoordinate` is stored as built and not re-derived by the model.
- **RETAINED BYTES ARE COUNTED ONCE PER DISTINCT MESH AND NEVER WITH A PART.** `jointRetainedBytes` charges bases, stale built
  meshes and the authority's own bytes; `documentByteLength` includes it, so every resident total sees it. The ceiling
  `MAX_JOINT_RETAINED_BYTES` is `MAX_SUPPORTED_SPLIT_TRIANGLES × 52` — derived, not a number of its own — and is a POLICY bound:
  above it a producer keeps the connectors as plain geometry and says so, and never refuses a split on account of editability.
  `npm run bench:joint-retention` measured accounting equal to the Node typed-array bytes and release on retirement to the byte;
  it is NOT a browser footprint, and the first stage that actually retains bases must measure that.
- **A REBUILD STARTS FROM THE RETAINED CUT, NEVER FROM THE BUILT PIECES.** `rebuildJointConnectors` hands the two pre-connector pieces,
  their provenance, the generated interface and the cut's tolerance (`PinCut`) and a connector spec to `constructPinConnectors`, the
  ONE pin stage: footprint containment, receiving material, material support, then the Booleans. It was the body of
  `splitWithConnectors` and is called by both, so there is no edit-only validator, relaxation or refusal; a boundary test holds that a
  rebuild names no validator or primitive itself. Because every rebuild starts from the same cut, an edit never builds on an edit, and
  editing a joint back to an earlier spec returns the same bytes. Differential, on the real kernel: a joint rebuilt from its own cut
  is byte-identical to the split that made it, manual and automatic, one to three pins, male side A and B, four units and a scaled
  placement, with an equal manifest. Booleans are never inverted.
- **A SITE IS THE POINT IT NAMES.** `local` is the exact point cut; `u`/`v` are that point read through `interfaceCoordinates` and
  nothing else. A rebuild recomputes them and refuses a pair that disagrees (`INVALID_PLAN`). `siteOnInterface(cut, u, v)` makes a site
  from a requested `(u, v)` and may differ from the request by a rounding error; that is the price of cutting an exact point.
- **TWO PINS HAVE ONE SPACING RULE.** `minimumPinSpacing` / `pinsTooClose` are used by the resolver that chooses sites AND by the
  rebuild that is handed them. Explicit sites would otherwise have been a way to build overlapping pins a split would never place.
- **A REBUILD PROVES ITS FRAME RATHER THAN ASSUMING IT.** The size is resolved through the same resolver with the unit and the current
  placement, and must equal the frame the joint was built under to the bit, or it is `INVALID_PLAN`. An attached joint guarantees
  that; the rebuild checks it anyway. The engine's cut lives in `JointInterfaceAuthority.detail`, opaque to the model, minted only by
  `jointAuthorityOf` and read back only through a guard that refuses anything else. `provenanceSHA` names the per-face provenance and
  not the geometry; identity of the pieces is by object.
- **PIN IDS ARE NOT PLAN PAIR IDS.** The plan numbers pairs `pin-1…` by position, so after a pin is removed a refusal's `pairId` is a
  position and the transaction stage must translate it. One size per joint is checked by the rebuild; the model already carries sizes
  per pin.
- **THE ENGINE REBUILDS; IT INSTALLS NOTHING.** It returns two candidate meshes, the manifest and the successor joint record. Checking
  that the joint is attached, the transaction, the history record and the page are the next stage's.
- **THE PAGE KEEPS NO RECORD OF A CONNECTOR (EC-4).** What the page knows is what `joint/list` said about the revision it holds
  (`WorkspaceState.joints`, read through `currentJoints`, which reads a slice for another revision, another document or no model as
  nothing). `useJointSync` asks once for every revision the model comes to hold and is mounted once, in the controllers provider; an
  answer for a revision the model has left is refused by the store. A list that could not be read is `UNAVAILABLE` and the inspector
  says so; it is never read as "no connectors". This replaced a list inside the assembly layout that was built from the size a split
  asked for and carried across later cuts by a sign test at `1e-8` that silently dropped what it could not place. The pair field, the pair
  migration and the local pick arithmetic are gone, and a boundary test keeps them gone. The assembly layout's INTERFACES (explode
  offsets, labels, the interface footprints a later cut is tested against) are page presentation and are unchanged; they hold no connector.
- **THE WORKER PUTS A PIN IN THE SCENE FOR THE PAGE.** A joint descriptor carries each pin's centre in the scene's coordinates, the axis the
  pin points along and `mmPerSceneUnit`, so a scene length is millimetres divided by it, the placement scale cancelling out. The page
  therefore holds no placement inverse, interface or mesh to place a marker or answer a pick. The guard radius of a connector is
  `hypot(depth × 1.0001, socket radius)` in the scene; the engine's floor of eight split tolerances is dropped, so it errs outward.
- **A CUT IS GUARDED BY THE WORKER'S CONNECTORS ALONE.** `preservesAssemblyInterfaces` takes the connectors the worker lists, so a plane
  near an attached pin is refused whether or not a layout was kept. A later cut of a piece in an attached joint retires the joint in
  the worker, exactly, and the connector stops being listed.
- **A REPAIR OR A FILL SAYS WHAT IT DOES TO RECORDED CONNECTORS BEFORE APPLY**, in the sentence that already says what Apply does
  (`disclosureFor`), and the action region still draws one line. All the wording is in `connector-edit-presentation.ts`, exhaustive,
  and a test holds it to no claim about use (no fits, holds, strong, secure, printable) and no promise of an edit, because no control
  exists to make one.
- **A SPLIT RECORDS A JOINT AND IS NEVER REFUSED FOR IT.** `recordJointFromSplit` assembles it from the split's own result at
  `SplitCandidateStore.resolve`: the clip's pieces become the bases, the returned pieces the built meshes, the plan's pins the sites. A
  plain cut records a joint with no connectors, so connectors can be added later. Why one was not recorded travels in
  `SplitCandidateSummary.editableConnector` (`UNIT_UNKNOWN`, `UNSUPPORTED_TRANSFORM`, `RETENTION_CEILING` with the metric, the value
  and the limit, `NOT_A_CLOSED_PLANE_CUT`, `LEGACY_CONNECTOR`, `FRAME_DISAGREES`), and the pieces are then exactly what they always were.
  The ceiling is judged on the document AS IT WILL BE INSTALLED, so a joint the cut itself retires is not counted against the new one.
- **THE UNIT A JOINT WAS SIZED IN IS THE FRAME'S.** A document that states a unit must agree with it; one that states none (an STL) does
  not contradict it, and the document never gains one. A plain cut on a unit-less model has no assertion to record and records nothing.
- **AN EDIT IS A CANDIDATE, THEN ONE MUTATION.** `JointEditStore.begin` resolves the joint the caller named, proves it attached and
  proves its connectors are what the caller saw (`JOINT_UNKNOWN`, `JOINT_RETIRED` with the reason, `JOINT_SPEC_STALE`), and takes the
  document's ONE edit ticket, so an edit, a split and every other candidate exclude one another by construction. `resolve` validates
  the rebuilt pieces (structure, ceilings, degenerate faces against what the BASES already carried) and the document gate.
  `joint/commit` is the only mutation. The caller states the document and revision, the joint and the spec digest; the store compares
  each with its own reading. A refused commit consumes nothing; the candidate is consumed only after the swap.
- **THE SPEC DIGEST IS DERIVED, NEVER STORED** (`jointSpecDigest`), so it cannot disagree with the spec it names. The page states the
  digest of the descriptor it is looking at.
- **AN EDIT KEEPS EVERY PART ID, NAME AND PLACEMENT**, unlike a split. It commits in ONE step like a hole fill and not in the split's two
  phases: a split must be ADOPTED (new part ids, a new assembly, a new view) and can fail part way, an edit has nothing to adopt but a
  revision. The worker dying between the swap and the reply is the boundary Policy A already covers.
- **PIN NAMES ONLY GROW.** `nextPinOrdinal` is a field of the joint; a removed pin's name is never given to another.
- **RETIRE BEFORE REPORTING.** Every handler that builds its reply from a successor document before the swap builds it from the
  document AS IT WILL BE INSTALLED (`retireDetachedJoints` at the revision it will be installed as), so a reported `residentBytes` never
  counts geometry about to be released. Installation retires again and finds nothing left to do. A boundary test names the modules.
- **A CHANGE THAT RETIRES A JOINT KEEPS THE DOCUMENT IT CAME FROM.** A mesh-only inverse restores the part and leaves a descriptor where
  the joint was, so a repair, a fill or a generic edit that retires one records `previousDocument` (`retiredByInstall`), and Undo
  installs that object. Without this, "undo of a repair re-attaches the connectors" was false for every change but a split. What it
  retains is the joint's bases for as long as that one undo record lives.

## 3MF property-reference invariants (Stage 4A-2B3-R1)

- **NO `pid` IS EVER EMITTED, FOR ANY TARGET, FROM ANY DOCUMENT.** 3MF core
  types `object@pid` as an `ST_ResourceID` naming a property-group resource that
  must EXIST. CAD Fixer writes no property resources, so a `pid` it wrote would
  be dangling by construction — and for a `materialRef` that did not originate
  as a number it was not even a lexical id: `pid="steel-brushed"` was real
  output. Never emit `pindex` either.
- **NEVER FABRICATE A PROPERTY RESOURCE TO MAKE A REFERENCE RESOLVE.** A
  `materialRef` is an opaque import-level string, not a material definition; a
  `<basematerials>` invented for it would state a colour and a name the user
  never gave. Dropping it and SAYING SO is the honest MVP answer. Building a real
  material system is a separate, explicit decision.
- **A PART MATERIAL REFERENCE IS A LOSS IN ALL THREE TARGETS**, and the report
  says so before the export. Nothing may report it as preserved.
- **THE READER DISTINGUISHES UNSUPPORTED FROM DANGLING.** `pid` naming a
  `<basematerials>` CAD Fixer does not interpret is a VALID file: geometry
  imports and the loss is reported. `pid` naming nothing is
  `THREEMF_DANGLING_PROPERTY_REFERENCE`; a `pid` that is not a positive integer
  is `THREEMF_MALFORMED_RESOURCE_ID`. Validate LEXICALLY — `Number` accepts
  `7`, `0x7`, `1e3` and `+7`, none of which is a resource id.
- **REFERENCES RESOLVE AFTER THE SCAN, not inline.** A resource may legitimately
  be declared after the reference to it, and refusing on element order would
  reject valid files.
- **THE INDEPENDENT ORACLE VALIDATES THE ID SPACE**, and a mutated fixture proves
  it rejects. This defect passed ZIP, CRC and XML checks and passed parse-back,
  because writer and reader shared the blind spot — the oracle is the only layer
  that could have caught it, and it was not looking. When a defect gets through,
  ask which oracle should have seen it.
- **PARSE-BACK ASSERTS THE REFERENCE'S ABSENCE.** It used to assert its presence,
  which is how a malformed file passed validation.

## Name-sanitization invariants (Stage 4A-2B3-R1)

- **A NAME THAT CANNOT BE WRITTEN EXACTLY IS DISCLOSED BEFORE THE EXPORT**, as a
  COUNT. `NAME_CHARACTERS` carries a number and nothing else: a fact holding a
  name would put untrusted text one render away from markup and create a second
  place display copy lived. The profile holds no names either.
- **THE PREDICATES ARE THE WRITERS' OWN** — `objNameChangesOnWrite` and
  `xmlTextChangesOnWrite`, from leaf modules that import nothing. Not a mirror:
  the disclosure cannot disagree with the file.
- **STL IS EXCLUDED.** It drops every name and already says so; a warning that
  some would have been adjusted describes a change to something not written.
- **DO NOT WARN ABOUT PERFECTLY REPRESENTABLE UNICODE.** Accents, CJK, emoji and
  RTL scripts survive both writers intact. Warning about them is the noise that
  teaches people to stop reading the panel.

## Conversion workflow invariants (Stage 4A-2B3)

- **THE REPORT DESCRIBES THE DOCUMENT, NEVER THE TARGET'S NAME.** "OBJ loses
  units" is a fact about OBJ; whether THIS conversion loses one depends on
  whether this document has one. Never warn about a feature the current document
  does not contain — a panel that warns about everything is a panel nobody
  reads.
- **`analyseConversion` IS PURE AND IS THE ONLY JUDGE.** Scalars in, facts out.
  Everything the workflow shows, enables and disables comes from it; nothing
  recomputes any part of it independently. Policy correctness is established in
  `compatibility.test.ts`, not end to end.
- **THE REPORT IS DERIVED ON EVERY RENDER, NEVER STORED.** That is the whole
  staleness answer: there is no saved report, so none can authorise an export
  at a revision it was not built from. Never add a `report` field to the store.
- **VERDICT PRECEDENCE IS FROZEN**: `BLOCKED > UNSUPPORTED_INPUT_FEATURE >
LOSSY_STRUCTURE > LOSSY_METADATA > LOSSLESS_FOR_SUPPORTED_FEATURES`. A
  SOURCE-IMPORT WARNING NEVER TOUCHES THE VERDICT — a texture that was never
  imported is not something this conversion is doing.
- **`UNSUPPORTED_INPUT_FEATURE` IS FOR PER-VERTEX ATTRIBUTES THE DOCUMENT
  ACTUALLY CARRIES.** Do not put import warnings there.
- **SOURCE IMPORT WARNINGS LIVE ON `ModelSource` FOR THE LIFE OF THE MODEL.**
  They are file metadata, not geometry identity: no handle or revision compares
  them, a repair does not change them, and the next import replaces them
  wholesale. Shown in their own section, and they do not move when the target
  changes.
- **NO UNIT DEFAULT, ANYWHERE.** `document.unit === undefined` + 3MF is
  `BLOCKED`. Six radio choices and NONE starts checked; nothing is remembered
  from a previous model. (The Stage 4A-2B3 `<select>` needed an empty value and
  a disabled placeholder, because a select with no explicit value reports its
  first option — CAD Fixer asserting microns for the user.)
- **A UNIT ASSERTION IS EXPORT-LOCAL AND NEVER RESCALES.** It rides on the
  disposable snapshot; the authoritative document keeps `unit: undefined` and
  its revision does not move. `exportSnapshotOf` applies it ONLY when the
  document states none, and the AUTHORITATIVE WORKER decides that — not the
  page, which holds a mirror. The 3MF writer stays fail-closed regardless.
- **EXPORTING IS A READ.** No revision, no undo entry, no change to geometry,
  transforms, part order, sharing or unit — for every target.
- **WHOLE DOCUMENT MEANS WHOLE DOCUMENT.** Every target in this workflow writes
  every part. `activePartId` must not reach it. The active-part STL export is a
  DIFFERENT operation (`model/export`) and both are labelled with which they
  are; never let two controls both read "Export STL".
- **STL FLATTENS INTO THE OUTPUT BUFFER AND NOWHERE ELSE.** There is no
  flattened `CanonicalMesh`, authoritative or otherwise, and exporting twice
  from one snapshot must produce identical bytes.
- **STL FACET NORMALS COME FROM THE TRANSFORMED TRIANGLE.** A reflection
  reverses orientation, so a copied normal points into the solid. A degenerate
  triangle gets a ZERO normal — never an invented direction, never `NaN`.
- **THE STL PREFLIGHT IS EXACT**: `84 + n * 50`, checked before the single
  allocation, ceiling `min(floor((maxOutputBytes - 84) / 50), 2^32 - 1)`. OBJ
  keeps a genuine LOWER bound; 3MF gets no preflight, because its size depends
  on compression and a made-up bound would lie in one direction or the other.
- **CONVERSION COPY LIVES IN `apps/web/src/state/conversion-presentation.ts`,
  all of it.** The switch is exhaustive with no `default` on purpose. Banned by
  test: `scale preserved`, `units converted`, `lossless conversion`, `nothing is
lost`, `printable`, `watertight`, and the rest. **"The numbers are unchanged"
  and "the scale is preserved" are not the same statement** — the approved
  sentence says both halves.
- **SEVERITY IS PROPORTIONATE.** Only a blocker gets the strongest register.
  Every section states its meaning in words, so nothing depends on colour.
- **THE SERIALISERS STAY OFF THE MAIN THREAD.** No main-thread file may import a
  writer or reader by name, and the two constants the page needs live in leaf
  modules that import nothing — `export/stl-layout.ts` and `threemf/units.ts`.
  This was got wrong once: the policy imported `84 + n * 50` from the STL writer
  and arrived carrying `stl/detect.ts`'s module-scope keyword tables. Two
  boundary tests hold the line.
- **THE EXPORT WORKER IS BUILT ONLY WHEN AN EXPORT STARTS.** Entering the
  Convert workspace, choosing a target and picking a unit must construct
  nothing.
- **`ExportRefusal.UnsupportedTarget` LIVES AT `resolveExportTarget`**, which is
  where an untrusted target STRING arrives. It was removed from `exportDocument`
  because every `MeshFormatId` is now writable and the guard had become
  type-dead. The lookup uses `hasOwnProperty`, so `constructor` and `__proto__`
  are not formats.

## Convert action and export-refusal invariants (Convert P1, REPAIR-RC-03)

- **THE STICKY FOOTER HOLDS ONLY BOUNDED CONTENT.** Progress, a ONE-LINE
  outcome (`describeExportFailureHeadline`), the button, and one hint line.
  The sentence from `describeExportFailure` — or the size-refusal explanation —
  lives behind ⓘ in `OutcomeDetails`, in the SCROLLING content above the
  footer. The reported defect: the refusal paragraph lived inside the footer,
  and a sticky element taller than its scrollport is pinned by its TOP, so on
  a squeezed window the button slid under the Activity log with only its top
  edge visible (reproduced at 1440×380 on v0.5.0 and the unfixed tree). Never
  put a paragraph in a sticky action footer.
- **`.tool-panel__body` HAS A FLOOR (140 px) AND THE ACTIVITY LOG YIELDS FIRST**
  (`flex: 0 1 auto; min-height: 0`). The floor must stay at least the tallest
  compact footer (131 px measured, refused state) and no taller than the space
  a 300 px window leaves, or the status bar covers the button instead. It is
  shared by every workspace; Repair's action was re-measured with it.
  `e2e/convert-workspace.spec.ts` "I:" fails against v0.5.0 at 300 px.
- **OPENING ⓘ SCROLLS THE PANEL'S OWN SCROLLER**, set directly. Never
  `scrollIntoView`: it also scrolls clipped ancestors and moves the shell.
- **A SIZE REFUSAL IS REMEMBERED AND DISABLES EXACTLY THAT EXPORT.**
  `ResourceLimit` comes only from `EXPORT_SERIALISED_TOO_LARGE` and
  `EXPORT_OUTPUT_TOO_LARGE`, ceilings on bytes fixed by (revision, target,
  unit key). `useDocumentConversion` states the attempt; the store records it
  in `conversion.refused` (same lifecycle and keys as `measured`) and never
  judges which statuses qualify. Another format, another unit or a new
  revision is offered again. Cancellation, staleness and internal failures are
  NOT remembered — retrying them can succeed.
- **3MF HAS NO SIZE PREFLIGHT, AND THAT IS MEASURED, NOT OMITTED.** The
  smallest possible model XML for the 1,988,877-triangle motivating STL
  (5,966,631 soup vertices) is ~260 MiB, under the 320 MiB entry ceiling; only
  formatting the real coordinates shows it exceeds it. The refusal lands in
  ~2–4 s at "Writing 2%", identically on v0.5.0, and is then remembered. A
  count-based estimate would lie in one direction or the other.
- **THE EXPORT PEAK IS THE ARTIFACT'S, AND IT PREDATES REPAIR-CORE-02.** OBJ
  export of that model (267,988,767 bytes, just under `maxOutputBytes`) peaks
  the renderer at ~2 GiB on v0.5.0 (2,048 MiB) and now (1,964 MiB).

## Convert workspace invariants (UI-03)

- **THE CONVERT WORKSPACE IS THE ONE CONVERSION SURFACE.** The Stage 4A-2B3
  dialog is gone. The top bar's Export, the inspector's Export / Convert, the
  workspace nav and its compact switcher all call `useOpenConvertWorkspace`
  (the switchers through `useEnterWorkspace`); never add a second
  surface that can run a document export.
- **ONE FORMAT PER EXPORT.** `DocumentExportService` runs one export at a time,
  so the output grid is a single-choice radio group and the selected card IS
  the focused one. No multi-select, no queue, no batch, no "Convert N files" —
  CAD Fixer holds one document.
- **A CARD IS A WRITER.** Only `EXPORT_FORMATS` are selectable. ASCII STL is
  shown disabled with where it does exist (the active-part export); PLY, AMF,
  GLB and FBX have no card at all.
- **NO CONTROL THAT DOES NOT CHANGE THE FILE.** The only option is the 3MF unit
  assertion, which labels and never rescales. There is no axis conversion, unit
  conversion, merge switch, colour/material/texture toggle, thumbnail or 3MF
  metadata, because no writer does any of it.
- **SIZES ARE EXACT, MEASURED OR UNKNOWN.** Binary STL is exact from
  `stlContainerByteLength`. OBJ and 3MF show a number only after a real export
  of THAT revision, target and effective unit (`MeasuredExport`, cleared with
  the model). Never a ratio, never a lower bound presented as an estimate.
- **THE WORKSPACE STAYS MOUNTED WHILE HIDDEN**, like the Repair panels: its hook
  cancels the export it started on unmount.

## Split & Connect workspace invariants (UI-04)

- **ONE CUT STATE.** `useSplitWorkflow` (one instance, `SplitControlsProvider`)
  owns the plane settings; `splitPlaneFor` is the only settings → plane
  function. The slider, the number field, the HUD, the inspector, the worker
  request and the drawn plane all read it. The viewport arrow REPORTS a
  distance along the normal (`onEditPlaneDrag`) and moves nothing itself; the
  viewport's former `moveEditPlaneAlongNormal` / `rotateEditPlane` were deleted
  because they held a second copy of the plane.
- **ONLY WHAT STAGE 7B BUILDS.** One flat plane per split (XY / XZ / YZ plus one
  bounded tilt), automatic placement only, None / round pins (1–4) —
  the dovetail is NOT offered since v0.7.0, because it cannot be assembled
  (`OfferedConnectorKind` excludes it; the engine type still names it) —
  connectors only for a millimetre document. No cut list, custom
  plane, align-to-face, three-point plane, extra connector types, manual
  placement, pattern or margin control, bed fit or orientation.
- **CLEARANCE IS STATED EXACTLY.** Pin: radial, socket Ø = pin Ø + 2 × clearance.
  `socketDiameter` mirrors the engine and a test holds them together.
  `dovetailSlot` was removed from the interface with the dovetail card.
- **THE EXPLODED VIEW IS PRESENTATION ONLY, DURING PREVIEW TOO (v0.7.0).**
  `assemblyForSplitPreview` builds the preview's offsets with the SAME
  `assemblyAfterSplit` that builds the applied view, so the two cannot drift. The
  Assembled / Exploded flag is `previewExploded` in the store, separate from
  `splitPreview`, so toggling rebuilds no scene. Offsets are drawn translations
  of each part's matrix: never a part transform, never geometry, never read by
  Apply or export. A boundary test keeps `assembly-presentation` out of
  `runtime/`, `workers/` and `packages/`.
- **THE CHECKS LINE STATES WHAT WAS DONE.** `describeSplitChecks`: a surface cut
  (`volumeInterpretable === false`) never reads "closed; capped". The placement
  note says the connector is checked against the cut face and that the wall
  behind it is NOT measured.
- **CROSS-SECTION FACTS COME FROM THE ENGINE AFTER A PREVIEW.** Area, outline
  (loop) count and a bounded outline are measured from Piece A's cap in
  `identifyCutSurface`; nothing is estimated during a drag. `loopCount` counts
  OUTLINES, not pieces. Piece volumes shown are `pieceAFinalVolume` /
  `pieceBFinalVolume` (after connectors); `pieceAVolume` / `pieceBVolume` are the
  pre-connector volumes the conservation check uses.
- **WORK IS SESSION-SCOPED.** Phase, preview and errors are tagged with the part
  (while the workspace is shown); the effect cleanup releases the worker
  candidate. No effect resets React state. Cancel resets the settings;
  switching workspace keeps them.

## Workspace foundations invariants (PYBRIX-08A)

- **THE INSPECTOR STARTS COLLAPSED, AND NOTHING BUT THE USER OPENS IT.**
  `inspectorCollapsed` initialises to `true` in `ShellLayoutProvider`, is session
  state only, and is never persisted. A new document id re-collapses it. A load, a
  selection, a Repair and a workspace change never open it. Its facts stay in the
  DOM while collapsed, so tests assert them with `toHaveText`, not `toBeVisible`.
- **A UNIT INTERPRETATION IS A READING OF COORDINATES, NEVER AN EDIT.** It lives in
  `WorkspaceState.unitInterpretation` as `{ documentId, unit }`: no coordinate is
  rewritten, no revision is consumed, and `GeometryDocument.unit` is untouched. It
  is keyed by `documentId` because that is stable across revisions, so Repair,
  Split, Texture and the Undo of any of them cannot discard it, and a new import
  cannot inherit it. Do not turn it into a document edit: that consumes a revision
  and re-analyses a two-million-triangle model to change a label.
- **A UNIT THE FILE STATES ALWAYS WINS.** `setUnitInterpretation` refuses a
  document whose source states a unit. Nothing is inferred from bounding-box
  size, and the prompt preselects nothing.
- **PHYSICAL PARAMETERS ARE MILLIMETRES IN THE INTERFACE AND COORDINATE UNITS IN
  THE REQUEST.** `millimetresToCoordinates` is applied where the request is built
  (`connectorRequest`, `textureRequest`) and nowhere else. A value the engine
  would refuse in the model's units is refused with a message, never clamped.
- **ONE READER: `useUnitInterpretation`.** Split, Texture, the Model panel and
  Convert read it; Convert's `unitAssertion` is seeded from it and writes back to
  it. A hook boundary is deliberate (the React Compiler rejects a plain function
  call on `model` inside these hooks).
- **SPLIT REFUSALS ARE TYPED.** `SplitSourceReason` travels in
  `AppError.details.reasons`. The sentence names Repair only when every reason is
  winding or degenerate/duplicate triangles. It never promises Repair for an
  opening or a non-manifold edge.
- **THE PLANE WITH NO ROLL AND NO SWAP IS THE QUALIFIED PLANE, BYTE FOR BYTE.**
  A zero roll is skipped, not applied as an identity rotation.
- **PIECE VISIBILITY HIDES, IT NEVER RE-UPLOADS.** `setHiddenParts` toggles a
  mesh's `visible`; it is not routed through `setModel`.

## Surface Texture workspace invariants (UI-05)

- **ONE SELECTION, IN THE STORE.** `WorkspaceState.textureSelection` is the
  canonical copy: worker-grown triangle ids plus the seed, area, part area and
  planarity. The viewport draws the ids; panel, HUD and inspector read the
  summary. It is valid only when its `source` IS the loaded handle and its part
  is active — an Apply, Undo, repair or new file retires it, so stale face ids
  never reach a request. Picks reach `useTextureWorkflow().pick` directly; the
  old `cadfixer:texture-surface-pick` window event is gone (the harness uses
  `cadfixerHarness.selectTextureSurface`, which calls the same worker op).
- **ONLY WHAT STAGE 7C DOES.** One flat connected region per click (2° normal
  bound, 100,000-triangle ceiling); Dots / Lines / Diamond; Raised or Engraved;
  flat projection in the face's own plane; millimetre documents only. No brush,
  lasso, angle, grow/shrink/invert/select-all, bottom exclusion, image source,
  curved or surface-following mapping, falloff or subdivision.
- **THE FAST PREVIEW IS THE ENGINE'S LAYOUT, NOT A SHADER.** `texture/layout`
  runs `buildSurfaceTextureLayout` alone (same admission limits as Apply) and
  returns element count, the primitive-triangle estimate and exact footprint
  outlines. Debounced; no geometry is built. Generate preview runs the Boolean;
  only Apply commits.
- **NO REDUNDANT FRAMES.** Texture overlays use the scheduled frame, and a clear
  of something not drawn draws nothing (the UI-04 dense-model lesson).

## Shared UI invariants (UI-06)

- **THE SHELL IS `overflow: clip`, NEVER `hidden`.** Below 1200 px the inspector
  drawer waits off-canvas; a `hidden` shell is a scroll container that any
  scroll-into-view shifted 140 px sideways with no way back.
- **INSPECTOR ORDER IS Selection → Model → Export → Runtime** in every
  workspace, context first. Export is hidden (never unmounted) with no model.
  Nothing scrolls the inspector programmatically.
- **ONE PRIMARY ACTION PER STEP.** A control that navigates to a step is
  secondary. `.action` and `.secondary-action` are one control; `.format-card`
  is the one card family (Convert, Split, Texture). `e2e/ui-consistency.spec.ts`
  holds these as computed-style invariants — no pixel baselines.
- **POP-UPS ARE DISCLOSURES**: `aria-expanded`, `aria-controls` only while
  open, no `aria-haspopup`.
- **ONE "… preview — not applied" PILL PER GENERATED PREVIEW**, naming the
  operation; HUDs never repeat it. HUDs live in the band between the toolbar
  and the view cube (`--hud-inset-*`).
- **NO FLOOR OR GRID UNDER A MODEL**: the viewport is Y-up, print files are
  conventionally Z-up, and no print orientation or unit is asserted.
- **Below 600 px every target is at least 40 px**, primary actions included.

## Release invariants (PR-01)

- **EVERYTHING THE BUILD DISTRIBUTES HAS ITS LICENCE IN IT.**
  `apps/web/public/third-party-notices.txt` carries the fonts, icons, React,
  React DOM, scheduler, three.js, Geogram + zlib, Manifold, the Emscripten
  runtime and musl — each held VERBATIM to a tracked source by
  `scripts/third-party-notices.test.ts`, which also fails when a bundled npm
  package changes version. A new runtime dependency, kernel or asset is not
  done until it is there. The Help menu links the file.
- **THE SECURITY HEADERS ARE STATED ONCE**, in `apps/web/security-headers.ts`.
  `vite preview` sends them, so every end-to-end run executes under the
  production CSP; the nginx snippet sends them, held to the module by a test.
  The CSP needs `'wasm-unsafe-eval'` (kernel compilation) and `connect-src
'self'` (each Emscripten loader fetches its own `.wasm`); `'none'` broke
  Split, Texture and the self-intersection check. Never add `'unsafe-eval'`,
  `'unsafe-inline'` or a remote origin.
- **LEAVING WITH UNEXPORTED WORK ASKS FIRST, AND ONLY THEN.**
  `hasUnexportedChanges` is DERIVED — the model's revision is neither the one
  it was imported at (`importedHandle`) nor one a whole-document export was
  written from — and `UnsavedChangesGuard` attaches `beforeunload` only while it
  holds. Never store a "dirty" flag beside it.
- **A FAILURE MESSAGE NAMES A REMEDY, NOT A LIBRARY.** WebGL-unavailable says
  what still works and what to do; context loss says to export applied work
  BEFORE reloading, because a reload discards it.

## Repair workspace invariants (REPAIR-UX-01)

- **THREE QUESTIONS BY DEFAULT, NOTHING ELSE.** What is wrong (the Health line
  and Detected issues), what Pybrix can repair (each row's fixability line and
  Repair options), what to click (the sticky footer). Explanations go behind an
  ⓘ; the full report — topology table, component table, surface metrics,
  overlays, exclusions, filling limits — lives in the collapsed **Advanced
  diagnostics**. Never put a paragraph back on the default surface; move
  information behind a disclosure rather than deleting it.
- **ONE PRIMARY ACTION, ONE PLACE, EVERY STATE.** `deriveRepairAction` in
  `state/repair-workspace-presentation.ts` is the state machine and the footer
  renders it: Analyze model → Repair model → Apply repairs, with Cancel /
  Cancel preview beside it. When nothing safe can run the button is STILL
  THERE, disabled, with the reason beside it — never hidden. A stale report
  outranks any stored plan.
- **REPAIR MODEL IS `previewRepair`, NOT A COMMIT, AND NOT "FIX ALL".** It runs
  every SELECTED operation the current plan found APPLICABLE and shows a
  validated preview. Apply is `repair/commit`; Undo is `repair/undo`. No
  transaction, guard or validator changed. The supporting line counts issue
  TYPES truthfully, and open boundaries are never counted as something it
  repairs.
- **FIXABILITY IS READ FROM THE PLAN'S DECISIONS, NEVER FROM A COUNT.**
  `deriveIssueStatus` is exhaustive over `RepairIssueId`. Components are
  "Review recommended", never repaired. Non-manifold geometry and
  self-intersections are "Not automatically repairable".
- **ⓘ IS A DISCLOSURE, NOT A POPOVER** (`components/shell/info.tsx`): a button
  with `aria-expanded`/`aria-controls`, click or tap, Escape closes and returns
  focus to the button, the panel is in flow beneath what it explains and stays
  mounted `hidden`. Nothing floats, so nothing can leave the viewport.
- **ONE OWNER PER HOOK THAT STARTS WORK.** `SelfIntersectionSection` is the only
  caller of `useSelfIntersection` and now lives inside the self-intersection
  issue row; `SelfIntersectionDetails` reads the store only. The analysis
  lifecycle (progress, Cancel, failure) is in the footer, not in Mesh Health.
- **"FILE STRUCTURE VALID", NEVER "STRUCTURALLY VALID" OR "VALID".** It says the
  file parsed; its ⓘ says that is not mesh health.
- **SPLITTING A NON-MANIFOLD VERTEX WITHOUT MOVING IT IS NOT A REPAIR** under
  ADR 0009: two records at one coordinate are one topological vertex, so the
  validator would reject it on every input.
  `mesh-topology/src/vertex-split-audit.test.ts` holds the evidence; making it
  meaningful is an identity-policy decision (REPAIR-CORE-03 / TOPOLOGY-IDENTITY,
  not yet scheduled). The 250,000-face ceiling still bounds the PER-OPENING
  workflow; Repair model's automatic filling is the loop-local design REPAIR-CORE-02
  qualified — see the section below.

## Automatic boundary filling invariants (REPAIR-CORE-02)

- **ADMISSION IS BY THE LOOP, NEVER BY THE PART.** Repair model fills an opening
  only when it independently qualifies — simple closed cycle, ≤ 512 points,
  relatively planar, ear-clipped without a new point, no zero-area triangle,
  no existing edge reused, rim edges once and diagonals twice opposite ways —
  and is independent of every other admitted opening (boxes that touch are
  deferred, never batched). Part size is bounded only by the repair preflight.
  NEVER raise `HOLE_FILL_MAX_PART_FACES` to get large-part fills: that is the
  per-opening engine's ceiling and the old whole-part path is why it exists.
- **THE SCAN IS `extractBoundaryLoops` IN FIVE BYTES AN EDGE.** `scanBoundaries`
  must stay loop-for-loop identical to `extractBoundaryLoops` — same refusals,
  same order, same cycles — and the differential suite holds it. No tolerance,
  ADR 0009's exact identity, `-0` normalised. Everything after the edge table is
  proportional to the boundary, and the boundary is capped (100,000 edges)
  BEFORE it is allocated.
- **THE LOCAL REGION IS COMPLETE BY CONSTRUCTION.** Every face whose box meets a
  loop's box, inclusive. Never a radius, never a "nearby" heuristic. A loop whose
  region exceeds the budget is excluded, never checked partially.
- **THE EXACT CHECK STAYS IN THE DISPOSABLE WORKER.** The geometry worker imports
  ONLY `@cadfixer/mesh-hole-fill/admission`; the engine entry, the BVH, the
  local classifier and the kernel never reach it (boundary test + bundle).
  Cancel terminates the verifier and cancels the repair operation. The verifier
  is opened for a plan that admitted openings — which happens automatically
  after analysis, for the ACTIVE part only — and for each preview, and closed
  when that operation settles. Never for a part with nothing admitted.
- **FAIL CLOSED.** No verifier port → nothing filled. An incomplete or budget-
  stopped check → `NOT_VERIFIABLE`. A re-analysis that misses ANY predicted count
  (`judgeFilledCandidate`) → nothing filled. Filling never rescues a rejected
  conservative candidate.
- **ONE CANDIDATE, ONE TRANSACTION.** Conservative operations then fills, one
  candidate, the existing `repair/commit` and `repair/undo`. No second commit
  path, no partial apply.
- **A FILL-ONLY PREVIEW SENDS THE PATCH, NOT THE PART.** Never ship a full render
  snapshot for a change that only appends faces.
- **THE UI READS THE WORKER'S FILL PLAN.** "N fillable" is
  `fillableOpeningCount(plan)`; the preview's "N filled" and "M left open" are
  the candidate's outcome. Never derive either from a count, and never say more
  openings were repaired than the outcome states.
- **AN ADMITTED OPENING IS NOT A FILLABLE ONE — REPAIR-RC-03.** Admission is
  topology and planarity; only the exact check says a patch does not pass
  through the part. On the model that motivated REPAIR-CORE-02 admission passed
  six openings and the check refused four (every invalid pair an exact coplanar
  overlap with an opposite-facing face), yet the panel said "6 openings can be
  filled" — and after Apply, "4 openings can be filled", with a second Repair
  model that filled nothing. So the plan is VERIFIED before it is shown: when
  admission passes any opening, `planConservativeRepair` opens the disposable
  verifier for that plan alone and the worker re-plans with it, caching the
  verified plan per revision. `BoundaryFillPlan.verified` records it, and
  `fillableOpeningCount` returns ZERO for an unverified plan — which is what a
  dead verifier leaves, shown as "Openings could not be checked", never as
  fillable. The candidate re-runs the same check (`checkAdmitted`, ONE
  implementation for both), so no fill ever depends on a cached verdict. No
  verifier is opened for a part with no admitted opening.
- **HEADLESS FRAME GAPS AT MILLIONS OF TRIANGLES MEASURE SWIFTSHADER.** Headless
  Chromium rasterises WebGL on the CPU: one redraw of a 2M-triangle part takes
  1.3–1.7 s with no page script at all. Main-thread responsiveness for large
  parts is measured with `qualify:boundary-fill -- <size> --hardware-gl`
  (34 ms at 2M), and a CPU profile decides before any "the page is blocked"
  claim. Memory numbers from headless runs remain valid.
- **GEOGRAM'S "Argument is multiply defined" CONSOLE LINES ARE PRE-EXISTING AND
  BENIGN — REPAIR-RC-03, and they are technical debt, not noise to silence
  elsewhere.** `binding.cpp`'s `ensure_init` imports the `"standard"` argument
  group, which already declares `sys`, then imports `"sys"` by name; Geogram's
  import guard is by NAME, so the `sys` group and its ten arguments are
  declared twice, and `declare_arg_group` / `declare_arg` log and RETURN
  without changing anything (Geogram `c8529bb`, `command_line.cpp`). The log
  precedes `set_quiet(true)`. Byte-identical kernel to v0.5.0 (WASM SHA-256
  `507ea5e7…`), identical 11 lines at `log` level, once per kernel instance —
  and there are more instances now, because plan-time verification opens a
  disposable verifier. Removing the redundant `import_arg_group("sys")` means
  rebuilding the qualified kernel; do it in a kernel stage, with the integrity
  tests, not as a drive-by.
- **NON-MANIFOLD VERTICES ARE NOT REPAIRED** and ADR 0009 is not amended; see
  `docs/design/REPAIR_CORE_02.md` §11.

## Hole-fill invariants (Stage 4B-1B1 engine, 4B-1B2 workflow)

- **THE ENGINE IS UNCHANGED BY THE WORKFLOW.** Stage 4B-1B2 added selection,
  previews, Apply and Undo and did not relax, extend or re-tune a single ceiling,
  refusal or validator. `holefill/send-for-fill` still produces CANDIDATES ONLY.
- **"FILL ALL" IS STILL FORBIDDEN**, and a boundary test asserts the strings
  `Fill All`, `Fill Holes`, `fill every` and `Close All` appear nowhere in
  `components/` or `state/`. REPAIR-CORE-02 made the one deliberate exception
  the stage brief asked for: Repair model fills openings that EACH qualify
  independently, bounded per repair, behind a user option — never every opening,
  and never with that wording.
- **ONE SELECTED LOOP PER OPERATION, NAMED BY AN IDENTITY THE WORKER PRODUCED.**
  `holefill/list-loops` is the only source of a `boundaryLoopId`. Never an
  index, never a position in a UI list, never a boundary the caller describes.
- **THE LOOP ID IS STRUCTURALLY UNIQUE, NOT PROBABILISTICALLY.**
  `bl-<minVertex>-<count>-<hash64>`: boundary components are vertex-disjoint, so
  no two components of one part can share a smallest welded vertex id. The
  research 32-bit coordinate hash was audited and rejected — at 20,165 loops it
  collides ~4.6% of the time, and a collision means filling the wrong hole. **The
  identity is computed from the WALK, never from the verdict**: hashing only
  eligible loops made one boundary hash two ways depending on whether the caller
  passed a vertex ceiling.
- **NO TOLERANCE ANYWHERE, EXCEPT ONE ALGORITHM-ELIGIBILITY RATIO.**
  `RELATIVE_PLANARITY = 1e-4` is max deviation over the loop's OWN largest
  extent — dimensionless, so it means the same thing at any scale and for a
  unitless STL. It is NOT a welding distance, a merge tolerance or a proximity
  test, and nothing in the package welds, merges, snaps or moves a coordinate.
- **A ZERO NEWELL NORMAL IS DEGENERATE, NOT PLANAR.** A collinear loop has no
  plane; calling it perfectly planar would send a zero-area loop into a
  triangulator with nothing to triangulate.
- **EAR CLIPPING, NEVER A FAN.** A fan covers area outside every concave polygon
  — the same defect the OBJ reader refuses to commit. Zero added vertices, zero
  moved vertices, exactly `n - 2` triangles, deterministic ear choice from the
  lowest remaining index. The regression guard is a COMB, not an L: the L
  happens to be star-shaped from its origin corner, so a fan covers it correctly
  and the guard proved nothing.
- **PROVENANCE IS FROZEN AND APPEND-ONLY.** Faces `[0, sourceFaceCount)` are the
  user's; the rest is the patch. Candidate positions are the source's bytes and
  the candidate's index prefix is the source's index bytes, compared as BYTES —
  a numeric comparison would call `NaN` unequal to itself and `-0` equal to `+0`.
- **THE PRESERVATION GATE THAT COUNTS IS THE AUTHORITATIVE ONE.** Inside the
  fill worker the candidate SHARES the source's position buffer, so the engine's
  own comparison proves the two variables alias — not that nothing was
  rewritten. The load-bearing check runs in the authoritative worker, comparing
  the returned candidate against its OWN resident part immediately before
  registration; those two crossed a thread boundary and are genuinely
  independent. A mismatch is `INTERNAL_FAILURE`, never a refusal and never a
  success. Do not move it, and do not add a second registration path — there is
  exactly one, and a boundary test asserts it.
- **NEW NON-MANIFOLD TOPOLOGY IS DETECTED BY IDENTITY, NEVER BY KIND OR COUNT.**
  A source with defect X and a candidate with `{X, Y}` have identical defect
  KINDS, so the kind comparison this replaced accepted a manufactured
  non-manifold edge. Defects are collected as welded edge pairs and welded vertex
  ids and compared as sets; the rule is `candidateDefects ⊆ sourceDefects`, so
  removing one is never a regression and introducing one always is.
  `newNonManifoldDefectCount` must be zero. **The narrowphase cannot see this**:
  a patch landing on an edge a closed shell already owns is a legitimate shared
  edge to every intersection test and a new non-manifold edge to topology.
- **TRIANGULATION SUCCESS IS NEVER ENGINE SUCCESS.** Structural validity,
  topology postconditions, patch winding against the source's own directed
  edges, patch connectivity, Euler as corroboration, and patch-attributed
  intersection all run afterwards, on the final canonical Float32
  representation.
- **EULER IS CORROBORATION AND MAY NEVER OVERRIDE A FAILED VALIDATOR.** HP23 has
  exactly the right χ and drives its patch through an internal wall.
- **SELF-INTERSECTION IS PATCH-ATTRIBUTED, NEVER AGGREGATE.** Only
  (patch × source) and (patch × patch) pairs are generated, so a pre-existing
  crossing cannot be blamed on the fill and an unchanged total is never read as
  proof. A pair the narrowphase could not classify FAILS the candidate.
- **THE NARROWPHASE IS THE QUALIFIED GEOGRAM KERNEL, NOT THE RESEARCH SAT
  CHECKER.** The research checker is a SECOND OPINION in tests only; it is
  strictly weaker — no exact predicates, and it skips any pair sharing a welded
  vertex, so it cannot see an overlap beyond a legitimately shared edge.
  `si_core.h` and `si_bvh.h` stay byte-identical to the research copies; Stage
  4B-1B1 added `cf_hf_*` to `binding.cpp` and changed `cf_si_run` not at all.
- **THE BROADPHASE IS A PORT OF `si_bvh.h`, AND THE REASON IS WRITTEN DOWN.**
  The C++ tree is unreachable from TypeScript and exposes only an all-pairs
  query, so it cannot answer "which source faces might this patch triangle hit".
  The port keeps median split, leaf size 8, INCLUSIVE overlap and the face-index
  tie-break, and is validated against a brute-force oracle — a broadphase that
  misses a pair turns a defect into a clean bill of health.
- **CANDIDATE PAIRS STREAM; THEY ARE NEVER ACCUMULATED.** A reused 8,192-pair
  buffer, plus ceilings on node visits, AABB tests, candidates and narrowphase
  pairs. The research `O(patchFaces × sourceFaces)` list exhausted a 1.7 GB heap
  and is forbidden.
- **CANCELLATION IS TERMINATION.** The fill is one synchronous pass containing
  long exact C++ calls that poll no JavaScript flag, so a cooperative token
  would be a lie. Cancel kills the disposable worker AND cancels the
  authoritative operation, which is otherwise awaiting a channel the dead worker
  will never answer.
- **A CANDIDATE FROM A REVISION THE USER HAS LEFT IS DISCARDED**, not registered:
  the authoritative worker re-checks the revision when the reply arrives and
  reports `STALE_REVISION`.
- **THE CEILINGS ARE 512 BOUNDARY VERTICES AND 250,000 FACES, BOTH MEASURED.**
  `npm run bench:hole-fill` is the evidence, and the patch ceiling is DERIVED
  (`n - 2`) rather than a second number that could disagree with the first.
- **HOLE FILLING IS INTRA-PART.** Part-local coordinates, `PartTransform`
  untouched and never baked in, no unit assumption, and inter-part collision not
  checked at all — exactly as self-intersection is not.
- **`Filled` IS NOT `Repaired`.** A validated candidate means ONE named opening
  was closed and validated against the part it came from. Not watertight, not
  printable, not free of other openings, not free of pre-existing crossings. The
  strongest sentence allowed after Apply is `Selected opening filled and
validated`, and the qualifier naming what was NOT examined travels with it.

## Hole-fill workflow invariants (Stage 4B-1B2)

- **LISTING IS TOPOLOGICAL; PLANARITY IS THE ENGINE'S.** `holefill/list-loops`
  says whether a component is one ordered, closed, simple, manifold cycle, and
  nothing more — the planarity policy lives in `mesh-hole-fill`, whose ENGINE
  must stay out of the geometry worker (since REPAIR-CORE-02 only the bounded
  `/admission` subpath may enter it, for Repair model's automatic filling). So a simple rim that curves out of its plane is
  listed as ATTEMPTABLE and refused when the engine looks at it, and the row
  reads `CAD Fixer can attempt this opening`, NEVER `can be filled`. A promise
  the listing cannot keep is broken once per curved rim. Asserted by test.
- **THE DISPLAY INDEX IS A LABEL; THE `BoundaryLoopId` IS THE IDENTITY.**
  "Opening 3" is a position in the deterministic order `extractBoundaryLoops`
  produces. The index is never sent, compared or resolved, so a renumbering can
  produce a wrong label and can never produce a wrong operation.
- **THE PREVIEW IS READ FROM THE STORED CANDIDATE, NEVER RECOMPUTED.**
  `holefill/patch-preview` reads faces `[sourceFaceCount, candidateFaceCount)`
  out of the mesh the store holds — the same object Apply installs. A boundary
  test asserts the commit path reaches no engine symbol: no `runHoleFill`, no
  `earClip`, no `assessPlanarity`, no `FaceBvh`, no narrowphase, and no import of
  `@cadfixer/mesh-hole-fill`. ONLY the patch faces travel.
- **APPLY AND UNDO ARE OBSERVABLY ATOMIC** — Stage 4B-1B2-R2. EVERY fallible
  piece of the answer — the render snapshot, the part descriptors, the totals,
  the progress report — is built BEFORE `residentDocuments.replace`. What follows
  the swap is a string concatenation, two bounded map writes and an object
  literal, and a boundary test names the calls that may not reappear below it.
  The reason is not tidiness: `buildRenderSnapshot` allocates megabytes and can
  fail, and when it ran after the swap its failure was reported to the caller as
  an ordinary error while the document had already changed. **"The worker's
  internal state was consistent" is not the guarantee that matters** — the
  guarantee is what the caller may OBSERVE, because the interface acts on it.
  Preparing early introduces no stale race: `replace` re-checks the revision and
  is the only arbiter, so an answer built against a document the user has moved
  off is discarded rather than installed.
- **THE FALLIBLE WORK IS INJECTED, AND IT IS A CONSTRUCTION SEAM.**
  `createHoleFillCommitHandler` and `createRepairUndoHandler` take it as a
  parameter so a test can make a large allocation fail on demand; source order
  proves an ordering, not that the handler copes when a step actually fails. The
  application builds exactly one handler of each, from `PRODUCTION_COMMIT_WORK`
  and `PRODUCTION_UNDO_WORK`, and a boundary test asserts that. It is NOT a fault
  switch: nothing in the product can select another.
- **THE ONE REMAINING BOUNDARY IS THE WORKER DYING**, between the commit and the
  reply. No synchronous rollback exists for that and none is pretended: Policy A
  applies, the page CLEARS the model and says the session was lost, rather than
  keeping a revision it can no longer verify.
- **`holefill/commit` IS THE ONLY MUTATION, AND EVERY GUARD IS WORKER-SIDE.**
  Four identifiers, no geometry. `prepareCommit` checks existence, lifecycle,
  document, part, opening and revision — the caller's belief AND the store's own
  reading, independently. `expectedPart` and `expectedLoopId` are STATED by the
  caller, never read off the candidate. One call site, asserted by test, with the
  guard above the swap.
- **A REFUSED COMMIT CONSUMES NOTHING.** The candidate stays `Resolved` and
  retryable; `markCommitted` runs only after `residentDocuments.replace`
  succeeded. Consuming on a transient race would destroy a validated fill.
- **A COMMITTED CANDIDATE IS DEAD, AND `Committed` IS NOT `Discarded`.** Applying
  twice would append the same patch to a mesh that already carries it. The two
  terminal states are distinct so the refusal can say what actually happened.
- **SHARED GEOMETRY IS ISOLATED BY THE SWAP.** Filling part A gives A the
  candidate and leaves a sibling holding the ORIGINAL mesh OBJECT — reference
  identity, not value equality, because a copy passes a byte comparison and still
  means the document silently stopped sharing. Proven at contract level and in a
  real browser through the worker-side digest.
- **ONE UNDO HISTORY, ONE RECONSTRUCTION — THERE ISN'T ONE.** A fill and a
  conservative repair are both recorded in `RepairHistoryStore` and reversed by
  `repair/undo`; still exactly one undoable change per document, and either kind
  supersedes the other. Since Stage 4B-1C `UndoableInverse` is ONE shape holding
  `previousMesh`, so undo is an assignment, not a rebuild. `UndoableChangeKind`
  survives only so the interface can name what was reversed — it selects no code
  path.
- **UNDO RESTORES THE DOCUMENT, NOT MERELY ITS BYTES** — Stage 4B-1B2-R1 for
  fills, Stage 4B-1C for conservative repairs. The record RETAINS THE EXACT
  `CanonicalMesh` the part held and undo puts that OBJECT back, so a document
  whose parts shared one mesh shares it again and an indexed mesh comes back
  indexed. Reference identity, not byte equality: a rebuilt equal mesh passed
  every byte assertion and still left the document holding two meshes where it
  had one, permanently, along with two GPU geometries and two 3MF object
  resources — and for a genuinely indexed OBJ or 3MF it did not even pass the
  byte assertion, returning four shared corners as twelve. The retention is O(1)
  — meshes are immutable, nothing is copied — and costs nothing extra whenever a
  sibling still references the mesh. `retainedBytes` reports the upper bound, and
  the reference is released the moment the record is undone, superseded, evicted
  or its document released.
- **`packages/mesh-repair/src/inverse.ts` IS DELETED AND MAY NOT COME BACK.**
  `buildInversePatch`, `restoreFromInverse` and `RepairInversePatch` were the
  patch reconstruction, and a boundary test asserts both the file's absence and
  the symbols'. Two undo implementations capable of diverging is how one of them
  stops being tested — which is exactly how the soup defect survived every STL
  test in the suite.
- **APPLY PRESERVES THE SOURCE'S INDEXING** — Stage 4B-1D, and this SUPERSEDES
  the Stage 4B-1C note that said a repaired indexed mesh was soup until undone.
  `rebuildCandidate` keeps the surviving faces' original index triplets, in
  source face order, over the source's own vertices.
- **THE PAGE'S RENDER SNAPSHOT FOLLOWS THE DOCUMENT'S SHARING.**
  `SharedPartGeometry` keys on position-array IDENTITY, so restoring canonical
  sharing is not enough on its own: `withPartRender` reuses a sibling's EXISTING
  buffers whenever the successor's `meshResourceIndex` says the two parts share.
  The worker is the authority for that; the page compares no coordinates and
  holds none.
- **THE CANDIDATE CARRIES THE SOURCE'S GROUPS.** The patch is appended, so every
  existing group range still describes exactly its own faces. Dropping them made
  Apply a silent metadata loss on export. The patch faces join NO group: they are
  geometry the file never carried.
- **THE INVENTORY IS CAPPED AND THE COUNT IS NOT.** 256 rows, an exact
  `loopCount`, and the truncation disclosed in words with both numbers. Only the
  SELECTED opening's rim ever crosses to the page.
- **THE WALK IS NOT RUN AT ALL ABOVE `HOLE_FILL_MAX_PART_FACES`** — Stage 6D-R3.
  This listing is AUTOMATIC on every import and was the only automatic
  post-import operation with no resource preflight of any kind. Its cost scales
  with boundary COMPONENTS, of which a mesh of loose triangles has one per FACE:
  measured at 692–1,011 bytes per face on that shape, and in Chromium as two
  100 MiB binary STL files with IDENTICAL triangle counts reaching 1,055 MiB and
  2,650 MiB of renderer footprint. Above the fill ceiling no opening could be
  filled whichever one was chosen, so the inventory would be unusable anyway.
  **`inventoried: false` IS NOT `loopCount: 0`**: the state is a distinct
  `HoleFillInventoryState.NotInventoried` and the panel says CAD Fixer did not
  LOOK, because reporting "no open boundaries" on the strength of a check that
  never ran is exactly the class of claim this interface forbids.
- **THE FILL WORKER IS BUILT ONLY FOR A PREVIEW, OR FOR A PLAN VERIFYING AN
  ADMITTED OPENING — and is terminated when that operation settles.** Opening
  the app, the panel, the listing and a selection construct none. Since
  REPAIR-RC-03 Repair model's plan verifies the openings it admits (see the
  automatic boundary filling invariants), so a part with an admissible opening
  costs one disposable verifier per revision; §85 counts every construction
  and termination.
- **ALL HOLE-FILL COPY LIVES IN `apps/web/src/state/hole-fill-presentation.ts`**,
  all of it, with exhaustive switches and no `default`. Banned by test:
  `watertight`, `printable`, `model repaired`, `hole`, `defect`, `damage`,
  `broken`, and every engine internal — `Geogram`, `narrowphase`, `broadphase`,
  `Euler`, `Float32`, a raw status code. A refusal is toned as a DECISION;
  `INTERNAL_FAILURE` is the only status toned as a failure.
- **APPLY AND UNDO NEVER RUN CONCURRENTLY WITH A REPAIR COMMIT.** One mutation at
  a time across the workspace: two commits racing for one revision would make the
  loser's typed refusal look like a defect to the user.

## Repair invariants (Stage 3B-1)

- **TWO GEOMETRY KERNELS IN PRODUCTION, EACH CONFINED TO ITS WORKERS.**
  Geogram v1.10.0 (Stage 3C-1B) is the WebAssembly kernel behind the read-only
  self-intersection diagnostic and the hole-fill narrowphase. Manifold (Stage
  7A, vendored under `apps/web/src/workers/third-party/manifold/`) runs the
  Boolean behind Split and Texture, called only from
  `manifold-boolean-backend.ts` in a disposable worker. PMP remains a research
  artifact under `experiments/`. Repair itself is still kernel-free. Both
  kernels' licences — and the Emscripten runtime's — ship in
  `third-party-notices.txt` (PR-01).
- **No tolerance in the conservative repair API.** No epsilon, weld distance,
  merge tolerance or proximity threshold. Stage 3A proved no global tolerance
  can be correct — the value that heals R19's crack destroys R21's intentional
  gap. Tolerance belongs to a later assisted stage, explicit and user-chosen.
- **Reversed duplicates are never removed.** They may encode a zero-thickness
  feature. Reported, never deleted.
- **Boundary loops are never filled.** A loop is not a hole; open tubes, vases
  and shells are valid user intent.
- **Winding unification is RELATIVE.** The lowest-indexed surviving face in each
  component keeps its orientation. Never choose a global sign from signed
  volume, world axes, the bounding box or a stored STL normal — see ADR 0010.
- **The authoritative document is never written.** Repair produces a candidate
  for ONE part; `repair/commit` builds a successor document with `withPartMesh`
  and swaps a reference after every guard passes. Every other part is carried
  across BY REFERENCE and stays byte- and reference-identical. A candidate handle
  is a distinct type from `ModelHandle` so it cannot be exported by mistake.
- **The algorithm never decides its own success.** The candidate is re-analysed
  by Stage 2 and judged against the source.
- **`selfIntersectionStatus` is always `not-checked`**, and there is no
  `printable` flag. Repair acceptance is not printability acceptance.
- **React is never the transaction authority.** Apply sends three identifiers and
  the worker re-checks every guard. Never move a guard into a component or a
  hook, and never add a code path that commits without going through
  `repair/commit`.
- **A preview never swaps authority.** The viewport holds two render snapshots
  and toggles `visible`. Switching Before/After must not call `setModel`, must
  not reframe, and must not change any handle.
- **Undo produces a NEW, higher revision.** Revisions only ever move forwards,
  because every staleness guard depends on it. Never reactivate a retained prior
  revision. See `docs/adr/0011-repair-undo-revisions.md` and its Stage 4B-1C
  closure note. **What it restores is the RETAINED MESH OBJECT**, never a
  reconstruction — see the hole-fill workflow invariants above, which now cover
  both kinds of undoable change.
- **THE CANDIDATE KEEPS THE SOURCE'S REPRESENTATION — POLICY B, Stage 4B-1D.**
  Surviving faces keep their ORIGINAL index triplets, in source face order, with
  their winding untouched; retained vertices keep their exact Float32 bytes; and
  the ONLY vertices removed are those no surviving face references, renumbered in
  ASCENDING ORIGINAL INDEX order. When nothing is orphaned the remap is the
  identity and the position buffer is a straight copy of the source's bytes.
- **KEEPING THE WHOLE VERTEX TABLE (Policy A) WAS REJECTED, AND FOR A REASON THAT
  IS NOT TASTE.** `computeBounds` walks every position slot, so retaining an
  orphan would freeze a model's reported bounding box when the faces around an
  extreme corner are removed, and `topologicalVertexCount` would keep counting a
  point no triangle touches. The soup rebuild got both right; a representation
  fix is not allowed to change them.
- **NOTHING IS WELDED WHILE REBUILDING REPRESENTATION.** Two vertices with
  identical coordinates and different indices stay two vertices. Merging them is
  tolerance welding under another name — decided by no user, qualified by nobody
  — and it would change the surviving topology.
- **THE REBUILD DECIDES NOTHING.** The removal mask and the flip mask arrive
  already decided by the plan and the winding solver; `rebuildCandidate` only
  MATERIALISES them. A frozen test compares acceptance, counts, regressions and
  every surviving face's corner COORDINATES against what the pre-4B-1D engine
  produced, for ten fixtures covering every operation and outcome.
- **THE RENDER SNAPSHOT IS EXPANDED; THE CANONICAL MESH IS NOT.**
  `buildDrawableTriangles` materialises three corners per face from the index
  buffer at the render boundary, because the draw is non-indexed. It used to send
  `mesh.positions.slice()` with no reference to the indices at all — correct only
  for STL soup, so every indexed OBJ and 3MF was drawn as a few stray triangles
  out of its own vertex pool, and the `face * 9` overlay builders read the same
  wrong buffer. Expansion also makes shading FLAT by construction: each corner
  carries its own face's normal, so restoring indexing cannot round off a hard
  edge. Never de-index canonical geometry to satisfy a renderer.
- **`repair/commit` PREPARES EVERY FALLIBLE OUTPUT BEFORE THE SWAP** — Stage
  4B-1C, the same ordering `holefill/commit` has. The render snapshot, the part
  descriptors, the totals, the bounds and the undo record are all built first, so
  a snapshot that throws refuses the Apply with the document untouched instead of
  reporting a failure after it changed. Nothing fallible may be added after
  `residentDocuments.replace`, and a boundary test asserts the ordering.
- **Exactly one repair per model is undoable, and redo does not exist.** Undoing
  retains no forward patch, so redo is not derivable from what is kept — building
  it would be a new memory commitment, not a symmetry fix.
- **Repair copy lives in `apps/web/src/state/repair-presentation.ts`, all of it.**
  A reason string written inline in a component is a bug: two screens drift, and
  a new `RepairReason` reaches one of them and not the other. The switches there
  are exhaustive with no `default` on purpose.
- **`geometry-runtime` RESTATES the repair constants; it does not re-export
  them.** A value re-export from `@cadfixer/mesh-repair` makes the engine a
  runtime dependency of the main-thread bundle. `packages/geometry-runtime/src/repair.ts`
  mirrors them and two tests keep the mirror honest — one at compile time, one on
  the runtime values.

## Brand invariants (BRAND-01)

- **THE DISPLAY NAME IS `Pybrix`, EXACTLY.** Not PYBRIX, PyBrix or "Pybrix CAD".
  It lives in `apps/web/src/components/shell/brand.ts`; nothing restates it.
- **NEVER MASS-RENAME `cad-fixer` / `cadfixer` / `CADFIXER_`.** Those are
  identifiers. Only user-visible text changes, and it was changed inside string
  tokens only — never in comments, never in identifiers. Historical documents
  (release notes v0.1–v0.4, stage reports, ADRs) stay historically accurate.
- **BRAND ASSETS:** production derivatives in `apps/web/src/brand/` (Vite
  fingerprints them into `/assets/`: same-origin, immutable, `img-src 'self'`);
  the untouched originals in `apps/web/brand-source/`, never shipped. The
  release packager refuses an artifact without the Pybrix icons, and HV-C21
  asserts the shipped brand set, the Pybrix title and that no deployable file
  holds a local filesystem path.
- **THE LOCKUPS ARE NEVER PLACED ON THE DARK CHROME.** Their navy wordmark is
  illegible there. Dark surfaces get the mark on its white tile beside HTML text.
- **BRAND BLUE HAS TWO ROLES AND NEVER MEANS STATUS.** `--cad-accent` for marks
  on dark, `--cad-accent-fill` for a filled primary with white text. Warning,
  error, success and the workspace colours are untouched.
- **EXPORTS STAMP `Pybrix`, NEVER A USER'S NAME:** the binary STL header, the
  ASCII solid name `pybrix` and the OBJ header comment. File names still come
  from the model.
- **THE PRODUCTION MONITOR ACCEPTS BOTH TITLES** (`IDENTITY_PATTERN`), because it
  runs from `main` every fifteen minutes and `main` moves before the site. Drop
  the CAD Fixer alternative once a Pybrix release is live.
- **NO PERSISTED SETTINGS EXIST** (no `localStorage`, no `sessionStorage`), so
  the rebrand migrated none. If one is ever added, its key is an identifier and
  is not renamed with the brand.

## Workspace action-region invariants (CONVERT-UX-02, WORKSPACE-UX-03)

- **EVERY WORKSPACE FOOTER IS `ActionFooter`, AND IT IS BOUNDED.** The pinned
  region sits inside the tool panel's ONE scroller, which is 140 px tall on a
  short window; every pixel the region takes is taken from the controls above
  it. It holds the action row and AT MOST ONE LINE — progress, else a failure's
  headline, else the state, else why the action is unavailable. v0.6.0's release
  was blocked twice by a footer that grew with its state.
- **A RESULT IS CONTENT, NEVER FOOTER.** Applied-result cards, saved files, the
  full text of a failure, explanations behind ⓘ, and any control that is not the
  immediate action scroll. Do not add a block to a footer "just for this state".
- **ONE CAP: `--action-footer-max`**, which is both the region's `max-height`
  and the scroller's `scroll-padding-bottom`. No per-workspace cap. The padding
  is what makes focus and scroll-into-view land a control ABOVE the region.
- **UNDO MUST ALWAYS BE CLICKABLE.** Test reachability with
  `elementFromPoint` at the control's centre, never `isVisible`: an element
  under a sticky footer is visible and unusable.
- `components/shell/action-footer.test.ts` holds the rule at source and
  `e2e/workspace-short-height.spec.ts` holds it in a browser at thirteen sizes.
  See `docs/design/UI_SHELL.md`.

## Things that will trip you up

- **TypeScript is pinned to `~6.0.3` on purpose.** TS 7 exists but
  typescript-eslint does not support it yet, so upgrading loses type-aware
  linting. See `docs/adr/0006-typescript-version-line.md`. Do not bump it.
- **`erasableSyntaxOnly` is on**: no `enum`, no `namespace`, no constructor
  parameter properties. Use `as const` objects with a matching type alias.
- **`noUncheckedIndexedAccess` is on**: indexing a typed array yields
  `number | undefined`. Prefer iterating (`for (const v of arr)`), which yields
  `number` and is faster.
- **`exactOptionalPropertyTypes` is on**: you cannot assign `undefined` to an
  optional property. Build objects conditionally
  (`...(x === undefined ? {} : { x })`).
- **Worker code has its own tsconfig** at `apps/web/src/workers/tsconfig.json`
  (WebWorker lib). The app tsconfig excludes that directory, because DOM and
  WebWorker globals conflict.
- **Network APIs are lint errors.** `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, and `navigator.sendBeacon` are banned repo-wide. This is
  deliberate — see `docs/PRIVACY_ARCHITECTURE.md`. Do not work around it. The ONLY
  exemptions (ADR 0020) are `apps/web/src/runtime/auto-split-transport.ts`, the
  service's `openai-provider.ts` and the service's own tests, each named in
  `eslint.config.js`, and `production-boundary.test.ts` asserts there are no others.
- **`eslint-plugin-react-hooks` flat config lives at `configs.flat[...]`**; the
  top-level `configs[...]` entries are the legacy shape and ESLint 10 rejects
  them.
- **Transferred buffers are detached.** After transferring a buffer to a worker,
  the sender's view is unusable. Use the buffer from the result.
- **A synchronous worker handler cannot be cancelled.** The cancel arrives as a
  message and cannot be read until the handler returns to the event loop, so a
  polled flag never changes. Long loops must `await context.yieldToEventLoop()`
  between batches. Use the `MessageChannel` yield, not `setTimeout` (clamped to
  ~4 ms when nested).
- **Format capability on the main thread comes from
  `file-formats/capabilities`, not the registry.** Codecs register inside the
  worker, so the main-thread registry is empty by design. A test keeps the
  declaration and the registry in agreement.
- **`ByteScanner.isAtEnd()` is a method, not a getter, because it mutates.**
  Getters that skip whitespace confuse both readers and TypeScript's narrowing.
- **The topology report is CACHED per (documentId, revision, partId).** Analysis runs
  automatically on import, the repair plan is derived from a report, and the
  candidate needs one too — without `TopologyReportCache` the same unchanged mesh
  was analysed three times per repair, and the end-to-end suite started timing
  out because of it. Safe only because geometry at a revision is immutable.
- **A repair peak is not an analysis workspace.** `maxRepairPeakBytes` is its own
  budget field: the authoritative mesh and the candidate coexist by design, so
  the peak is both meshes plus connectivity plus the validation workspace.
- **`RepairPlanPayload.memoryBudgetBytes` may only NARROW the ceiling.**
  `requestRepairPeak` enforces that on the worker side; a message can make CAD
  Fixer more cautious and never less. The `?repairMemoryCeilingMiB=N` URL option
  drives it and is surfaced in the panel whenever active.
- **Cancelling a repair discards, it does not interrupt.** The pipeline is one
  synchronous pass; the handler yields BEFORE registering the candidate, so a
  cancel leaves nothing resident. Yielding after registration would leak a
  candidate that only a discard could clean up.
- **Change samples are SOURCE face indices for all four categories, including
  flips.** Overlays therefore index the source render snapshot the main thread
  already holds. Removed faces are hidden in the After view; flipped faces are
  not, because a flip moves no vertex.
- **Boundary edges and surface area are PREDICTED, not forbidden, after
  duplicate removal.** Two coincident triangles pair each other's edges and look
  closed, and Stage 2 sums every face — so removing the redundant copy correctly
  reveals boundary edges and correctly reduces the summed area. "Must not
  increase" rejects a correct repair. Degenerate removal IS held to the strict
  rule and is refused if it would open a boundary.
- **Winding is solved on the POST-REMOVAL topology.** Solving on the source and
  adjusting for pending removals made repair non-idempotent: a duplicate's
  non-manifold vertices blocked a repair the same pipeline had already made
  safe. Removals are materialised first, then connectivity is rebuilt.
- **Large textual exports must never materialize the complete serialized output
  in multiple browser representations.** Route large OBJ to the transactional
  file sink; retain at most one bounded delivery chunk. Acquire the large native
  destination through a directory and filename separately. Existing files must
  survive cancellation/failure until successful close; abort and guarded cleanup
  of owned new targets complete before cancellation settles. Mandatory production
  record parsing and source-semantic validation finish before commit. Export
  output memory is bounded by the sink/chunk architecture (ADR 0019).
- **The worker owns authoritative geometry.** The main thread holds a
  `DocumentHandle`, scalar part descriptors and render snapshots — never a
  `CanonicalMesh` and never a `GeometryDocument`. Operations name a document by
  handle + revision, and a part by `partId`; a stale revision or an unknown part
  must fail rather than apply to whatever replaced it. See
  `docs/adr/0008-worker-resident-geometry.md` and
  `docs/adr/0014-multi-part-geometry-document-foundation.md`.
- **`ModelHandle` no longer exists.** It is `DocumentHandle` (`documentId` +
  `revision`), and the store is `ResidentDocumentStore`. The PROTOCOL operation
  names did not change — `model/import`, `model/export`, `model/analyze`,
  `model/release`, `model/send-for-diagnostic` describe what the user does, and
  that is unchanged. `LoadedModel` in application state keeps its name for the
  same reason.
- **`Matrix4Tuple` and `IDENTITY_MATRIX4` were removed**, not deprecated. Use
  `PartTransform` / `IDENTITY_PART_TRANSFORM`. Two names for one concept is drift.
- **Allocate canonical arrays through `createPositionArray` / `createIndexArray`.**
  A bare `new Float32Array` at a call site defeats the whole point of the
  `PositionArray` alias, which exists so the open Float32/Float64 decision
  changes in one place.
- **Render buffers are concretely `Float32Array`, not the canonical alias.**
  Float32 is the selected WebGL/Three.js vertex-attribute representation. Naming
  it concretely keeps render precision decoupled from canonical precision, so
  whatever ADR 0004 decides for stored geometry — and whatever a future geometry
  kernel computes in — the snapshot converts at the boundary instead of tracking
  it.

## Honesty rules for the interface

- **Never fake functionality.** If something is not implemented, the interface
  says so plainly.
- **Never report success for work that did not happen.** Screening a filename is
  not importing a model.
- **Never turn diagnostic uncertainty into interface certainty.** No UI path may
  say _printable_, _watertight_, _valid mesh_, _error free_, or _hole_. Stage 2
  checks exact-coordinate topology and nothing else; self-intersections and wall
  thickness are unchecked, and every report says so beside its verdict. The
  banned terms are listed in `apps/web/src/state/topology-presentation.ts` and a
  test asserts none of them can be emitted.
- **Edge manifoldness and vertex manifoldness are separate**, and the interface
  reports them separately. Collapsing them into one "manifold" flag hides the
  bow-tie case, which is precisely the case naive tools miss.
- **Never claim a repair did more than it did.** The repair panel's wording is
  decided in one file and asserted by test: no string it can emit may say
  printable, watertight, fully repaired, all errors fixed, ready to print, fix
  everything, make printable, or hole — and none may claim a repaired model faces
  outward, because winding is unified RELATIVE to neighbours only. What may
  be said after a committed repair is decided by `deriveRepairOutcome`
  (REPAIR-UX-04): `Repair completed` ONLY when the analysis of the repaired
  revision detects no error or warning, `Partial repair completed` whenever any
  remain, `Repair applied` while that analysis is pending, and
  `No changes were made` when nothing changed — each with the unchecked
  qualifier.
- **A SUCCESSFUL REPAIR OPERATION AND A HEALTHY MODEL ARE DISTINCT STATES.**
  Post-repair UI reports both what changed and what remains. The outcome card
  describes the OPERATION; Health describes the MODEL and is never recoloured or
  softened because a repair ran. "No supported repair remains" is not "no
  detected issue remains": a model with supported repairs exhausted and issues
  still detected is PARTIAL. Remaining diagnostics are reported per category
  with their own counts and are NEVER summed — boundaries, vertices and pieces
  are different kinds of thing. Every "after the repair" wording is derived from
  the applied repair being the current document, revision and part, so Undo, a
  replacement model or another edit takes it away.
- **A refusal is not an error, and a preview is not an application.** Refused and
  blocked operations are rendered as decisions with reasons in their own visual
  register; a candidate on screen is labelled `Preview — not applied` until it is
  committed — in the viewport as ONE status pill naming the operation
  (`Repair / Fill / Split / Texture preview — not applied`), which the HUDs do
  not repeat.
- **An expected delta is not a regression.** Once a candidate is ACCEPTED every
  remaining difference was predicted before the rebuild and confirmed after it —
  including a boundary-edge count that rose because a duplicate that was hiding
  an opening has been removed. Never label one of those an error.
- **Never register a stub codec.** All three READERS are real. The `MeshWriter`
  registry still holds only STL, because it is the single-MESH contract the
  active-part export uses — `requireWriter('obj')` and `requireWriter('3mf')`
  must keep failing loudly rather than returning a placeholder. DOCUMENT writing
  is a different contract (`exportDocument`) and covers all three. Two tests
  hold this line: `registry.test.ts` asserts an unimplemented direction throws,
  and `capabilities.test.ts` asserts the capability list the UI reads matches
  exactly what actually registers.

## Out of scope right now

Authentication, accounts, subscriptions, payments, pricing, download gating,
ads, analytics, databases, backends. Leave clean seams; do not build them.

Also out of scope until a task asks: redo, a multi-step undo history,
inter-part overlap detection, an assembly tree editor, transform editing, any
repair operation outside the four conservative ones, and every part of hole
filling beyond the Stage 4B-1B2 workflow — non-planar loops, batch or "fill all"
filling, seam or near-coincident boundary repair, and PMP.

Do not install Manifold, Geogram, lib3mf, OpenVDB, CGAL, OpenCascade, or any
other geometry kernel without an explicit decision — licensing and WASM
portability must be evaluated first.
