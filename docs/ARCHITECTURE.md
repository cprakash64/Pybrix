# Pybrix Architecture

Status: Stage 2 (STL import, viewing, export, and read-only topology
diagnostics). This document describes the
architecture as built, plus the intended shape of layers that do not exist yet.
Where a layer is not implemented, its responsibilities are defined so that later
work has somewhere to go, and it is labelled as such.

## 1. Governing constraints

Four constraints shape every decision below.

1. **Local-first.** Raw user geometry stays on the user's machine. There is no
   server-side geometry processing and no file-upload path. The one disclosed
   exception is the opt-in Auto Split (Beta), which sends six rendered views and
   limited model metadata for AI analysis (ADR 0020).
2. **Off the UI thread.** Parsing, validation, repair, booleans, subdivision,
   displacement, hollowing, and export all run in workers. The interface stays
   responsive while they run.
3. **Validation defines success.** A geometry operation is not successful
   because it returned a mesh. It is successful once its output passes
   validation.
4. **No silent modification.** An operation that may materially change a user's
   model states what it will do, warns, supports cancellation where feasible,
   preserves an undoable prior state, and validates its result.

## 2. Layers

```
                          ┌──────────────────────────────┐
                          │  Browser UI (React)          │  apps/web/src/components
                          │  presentation only           │  apps/web/src/viewport
                          └──────────────┬───────────────┘
                                         │ reads snapshots, dispatches intents
                          ┌──────────────▼───────────────┐
                          │  Application/workspace state │  apps/web/src/state
                          │  framework-free store        │
                          └──────────────┬───────────────┘
                                         │ operation requests
                          ┌──────────────▼───────────────┐
                          │  Worker coordinator          │  packages/geometry-runtime
                          │  correlation, progress,      │  apps/web/src/runtime
                          │  cancellation, errors        │
                          └──────────────┬───────────────┘
                                         │ structured-clone protocol + transfers
      ┌──────────────────────────────────▼──────────────────────────────────┐
      │                        Geometry worker thread                        │
      │  ┌────────────────────────┐      ┌──────────────────────────────┐    │
      │  │ STL codec + seams      │      │ Read-only topology analysis  │    │
      │  │ packages/file-formats  │      │ packages/mesh-topology       │    │
      │  └───────────┬────────────┘      └──────────────┬───────────────┘    │
      │              │                                  │                    │
      │  ┌───────────▼──────────────────────────────────▼───────────────┐    │
      │  │ Canonical mesh + structural validation                       │    │
      │  │ packages/mesh-core                                           │    │
      │  └───────────────────────────┬──────────────────────────────────┘    │
      │                              │                                       │
      │  ┌───────────────────────────▼──────────────────────────────────┐    │
      │  │ WASM/native geometry kernels (none selected yet)              │    │
      │  └──────────────────────────────────────────────────────────────┘    │
      └──────────────────────────────────────────────────────────────────────┘
```

### The rule that matters most

**The React/UI layer must not own geometry algorithms.** Components render
state and dispatch intents. They do not parse files, transform meshes, or decide
what a valid mesh is. A component that needs a geometry result asks the
coordinator and waits.

This is enforced three ways: package boundaries, an ESLint `no-restricted-imports`
rule preventing `packages/**` from importing React or Three.js, and a Vitest
project that runs the geometry packages under Node with no DOM at all — a
browser dependency creeping in breaks the test run.

## 3. Module responsibilities

| Module                      | Owns                                                                       | Must not                                       |
| --------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `apps/web/src/components`   | Presentation, layout, accessibility, user intent                           | Geometry, parsing, validation rules            |
| `apps/web/src/viewport`     | Three.js scene, renderer lifecycle, GPU resource disposal                  | Mesh semantics; it renders what it is given    |
| `apps/web/src/state`        | Workspace snapshot, status log, selection, future undo stack               | React APIs, except in `use-*.ts` bindings      |
| `apps/web/src/runtime`      | The only `Worker` construction site; transport adapter                     | Protocol logic, geometry                       |
| `apps/web/src/workers`      | Worker entry point; wires handlers to the host                             | Business logic beyond registration             |
| `packages/geometry-runtime` | Protocol, coordinator, worker host, cancellation, transfers                | DOM, React, Three.js, geometry algorithms      |
| `packages/mesh-core`        | Canonical mesh contract, structural validation                             | File formats, rendering, algorithms            |
| `packages/mesh-topology`    | Read-only topology recovery, diagnostics, area/volume                      | Mutating geometry, welding, UI, rendering      |
| `packages/file-formats`     | Format descriptors, screening, budgets, the STL codec                      | UI, rendering, worker protocol                 |
| `packages/mesh-hole-fill`   | Planar hole-fill engine: eligibility, ear clipping, broadphase, validation | Kernels, UI, rendering, the narrowphase itself |
| `packages/shared`           | Typed errors, units, ids, cancellation primitive                           | Everything domain-specific                     |

Dependency direction is strictly one way:

```
shared ← mesh-core ← file-formats
shared ← mesh-core ← mesh-topology ← geometry-runtime
shared ← mesh-core ← mesh-topology ← mesh-hole-fill
all of the above ← apps/web
```

Nothing in `packages/` may import from `apps/`.

One nuance on `apps/web/src/state`: the store itself is framework-free and
tested without React, but the `use-*.ts` files in that directory are React
bindings and do import hooks. `use-model-import.ts` currently also holds real
sequencing rules — supersede-an-in-flight-import, and "a failed import must not
disturb the loaded model" — which means those rules can only be exercised
through React today. That is a known wrinkle, recorded rather than hidden; the
rules themselves are covered end to end.

`geometry-runtime` gained its `mesh-core` dependency in Stage 1: the operation
map is a compile-time contract, and geometry operations genuinely speak
`CanonicalMesh`. Stage 2 added a **type-only** `mesh-topology` dependency for
the same reason — `model/analyze` returns a `TopologyReport`, and describing it
as `unknown` would put an unchecked contract on a module boundary that two
threads have to agree about. Type-only, so no topology code enters the
main-thread bundle. It deliberately does **not** depend on `file-formats` —
codecs stay behind the worker's operation handlers, so the protocol never knows
which formats exist.

## 4. File ingestion

The production import path, as implemented for STL:

1. **Drop or picker** (`ImportDropZone`) — reads `name` and `size` only. The
   component never touches file contents.
2. **Screening** (`file-formats/screening`) — filename extension and declared
   size. A usability filter, **not** a security boundary. Passing screening
   confers no trust.
3. **Read into a buffer** (`runtime/import-service`) — the ONLY place in the
   application that calls `File.arrayBuffer()`. Centralised so the number of
   live copies of a 500 MB model is answerable by reading one file.
4. **Transfer to the worker** — the buffer is moved, not copied. The main
   thread's view is detached the moment `dispatch` returns.
5. **Detect** (`file-formats/stl/detect`) — structural, never from the
   extension, the MIME type, or a leading `solid`. See
   [ADR 0007](adr/0007-stl-preservation-policy.md).
6. **Parse** (`file-formats/stl`) — in the worker. Treats bytes as hostile:
   declared counts checked against real buffer length, every allocation
   preflighted against `ImportBudget`, no unchecked offset dereferenced,
   non-finite coordinates rejected.
7. **Validate** (`mesh-core/validation`) — structural invariants. **This is the
   gate**: the import succeeds only if `assertMeshStructure` passes.
8. **Derive display data** — bounds and render normals, computed in the worker
   so the main thread never walks the mesh.
9. **Wrap as a document** — the mesh becomes a one-part `GeometryDocument` at
   the identity placement, with whatever unit the source stated (for STL: none).
10. **Validate the document** (`mesh-core/document-validation`) — the second
    gate: unique part ids, finite placements, a recognised unit, and the
    document-wide resource ceilings. Meshes are not re-walked; step 7 already
    cleared them.
11. **Commit as resident** — the document is committed to the worker's
    `ResidentDocumentStore` and STAYS THERE. Only a `DocumentHandle`, scalar
    part descriptors and render snapshots cross back to the main thread.

### Geometry ownership

**The worker owns authoritative geometry. The main thread owns pixels.**

|             | Holds                                                                                 | Why                                           |
| ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Worker      | `GeometryDocument` — parts, each a `CanonicalMesh` plus a placement                   | Every operation that reads geometry runs here |
| Main thread | `DocumentHandle`, part descriptors (ids, names, transforms, counts), render snapshots | The GPU needs vertex data; nothing else does  |

Stage 1 did the opposite: it transferred the canonical mesh to the main thread,
so export had to structured-clone roughly 96 MiB back into the worker for a
two-million-triangle model, and diagnostics, repair and booleans would each have
paid the same toll. See
[ADR 0008](adr/0008-worker-resident-geometry.md).

A handle carries an id AND a revision. Operations name the revision they expect,
so an operation queued against a model that has since been replaced fails loudly
instead of silently applying to different geometry.

**Since Stage 4A-2A the authoritative unit is a DOCUMENT holding one or more
parts, with ONE monotonic revision for the whole document.** An STL still
describes one thing, so an STL import produces a one-part document and every
existing workflow behaves as it did. What changed is that operations which read
or write one mesh — analysis, self-intersection, repair, export — now name a
`partId` explicitly as well as the handle, because two parts of one document
carry identical handles and a handle alone can no longer say which mesh a result
is about. Two parts may share one `CanonicalMesh` object; that sharing survives
commit, undo, the render snapshot and the GPU upload. See
[ADR 0014](adr/0014-multi-part-geometry-document-foundation.md).

Import is **transactional**: the candidate is parsed, validated and prepared
before anything is committed, so a parse failure, a validation failure, a budget
rejection or a cancellation leaves the previously resident model exactly as it
was.

**Since Stage 4A-2B1, three formats can be READ: STL, OBJ and 3MF.** They share
one path — `identifyFormat` decides from the bytes, `requireReader` returns the
reader for that format, every reader returns a `GeometryDocument`, and
`commitImportedDocument` is the single transaction that installs it. OBJ is
triangles only and refuses a polygon rather than fanning it; 3MF supports build
items, component instances and all six units, and never resolves a texture, a
material library or an external reference. See
[ADR 0015](adr/0015-production-obj-and-3mf-import.md).

**Since Stage 4A-2B3, all three can also be WRITTEN.** `exportDocument`
serialises a document snapshot in a disposable worker, reads the bytes back with
the PRODUCTION reader, and returns an artifact only if the two agree — for STL,
OBJ and 3MF alike. The user reaches it through one primary `Export / Convert`
action. See [ADR 0017](adr/0017-format-conversion-workflow.md). Capability is
declared in `file-formats/capabilities` rather than read from the registry,
because the registry is populated inside the worker and is legitimately empty on
the main thread — a test asserts the declaration matches what actually
registers.

#### What each format carries

|                                | STL                                                                             | OBJ                                      | 3MF                                                           |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| triangle geometry              | yes                                                                             | yes                                      | yes                                                           |
| physical unit                  | none — the format has no field                                                  | none                                     | yes, one of six tokens                                        |
| parts                          | none — one implicit object                                                      | one `o` per part                         | one object per part                                           |
| placements                     | baked into coordinates                                                          | baked into coordinates                   | kept as `<item transform>`                                    |
| shared geometry                | expanded, one copy each                                                         | expanded, one copy each                  | one object, many items                                        |
| part names                     | dropped                                                                         | kept (generated when absent)             | kept                                                          |
| face groups                    | dropped                                                                         | kept as `g` / `usemtl`                   | dropped by this writer                                        |
| part material reference        | dropped                                                                         | dropped (OBJ has no per-object slot)     | dropped — no property resource is written for a `pid` to name |
| normals / UVs                  | not written                                                                     | not written                              | not written                                                   |
| materials, textures            | never written; `mtllib` is never emitted or opened, and no 3MF `pid` is emitted |                                          |                                                               |
| names with control characters  | n/a — names dropped                                                             | characters removed, disclosed as a count | characters removed, disclosed as a count                      |
| imported 3MF component nesting | not retained on import, so never rebuilt                                        |                                          |                                                               |

Coordinates are NEVER rescaled in either direction. A unit says what the numbers
mean, not what they are, so a 3MF stating inches exported as OBJ keeps the same
numbers and loses the label — and the workflow says exactly that before the
click.

#### No property reference is ever written

3MF core types `object@pid` as an `ST_ResourceID` naming a property-group
resource that must exist. Pybrix writes no property resources, so it writes
no `pid` — a reference to a resource that is not there is a malformed file, not
a preserved material. The document's opaque `materialRef` is therefore reported
as a loss for every target, before the export. The reader enforces the same
contract on the way in: a `pid` resolving to an unsupported resource is a VALID
file whose materials are not imported; a `pid` resolving to nothing, or one that
is not lexically a positive integer, is refused. See
[ADR 0017](adr/0017-format-conversion-workflow.md#3mf-property-references).

#### Export-time unit assertion

3MF must declare a unit and Pybrix will not invent one. A document that
states none is BLOCKED for 3MF until the user picks one of the six; there is no
default, no preselection and no inference from filename, dimensions, extension
or printer convention. The choice labels the numbers and resizes nothing, it
applies to that export only, and the authoritative document keeps saying it does
not know. The 3MF writer stays fail-closed independently of the interface. See
[ADR 0017](adr/0017-format-conversion-workflow.md).

### Export runs in a second disposable worker

Since Stage 4A-2B2 a document can be written as OBJ or 3MF bytes, and since
Stage 4A-2B3 as whole-document STL as well. The path has two hops and the page
is not in the middle: the controller creates a
`MessageChannel`, hands one port to the authoritative worker and one to a
disposable export worker, and a document SNAPSHOT — one copy per distinct mesh,
never one per placement — travels between them. The finished file comes back to
the page, because that is the artifact the user asked to save.

Cancellation is `terminate()`. Part of the work happens inside
`CompressionStream`, which polls no flag of ours, so a cooperative token alone
would be honest for the writer loops and a lie for the compressor.

No export succeeds until its bytes have been read back by the PRODUCTION reader
and compared against what they were written from. There is no way to skip that.

The serialisers stay in that worker's own chunk. Nothing on the main thread
imports a writer or a reader by name, and the two constants the page genuinely
needs — the binary STL container's arithmetic and the six 3MF unit tokens — live
in leaf modules that import nothing, so reading a compatibility summary cannot
drag a codec into the initial bundle. Boundary tests assert both halves.

**There are two STL exports and they are different operations.**
`model/export` writes the ACTIVE PART and reports what it left out;
`writeStlDocument` writes the WHOLE document flattened into one triangle stream.
The interface names them apart — `Export / Convert…` and `Export active part as
binary STL` — because two controls both called "Export STL", one writing three
parts and one writing a third of them, is a silent loss waiting to happen.

### Cancellation requires yielding

A worker handler that runs one long synchronous loop can never be cancelled. The
cancel arrives as a message, and that message cannot be read until the handler
returns to the event loop, so a cancellation flag polled inside the loop can
never change. Codecs therefore `await context.yieldToEventLoop()` between
batches. The worker supplies a `MessageChannel`-based yield, which is not
subject to the ~4 ms clamp browsers apply to nested `setTimeout`.

This was a real defect found by an end-to-end test, not a theoretical concern.

## 5. Normalized mesh representation

`CanonicalMesh` is an indexed triangle mesh with optional normals, UVs, and
groups, plus metadata naming the source format. Every reader produces it and
every writer consumes it, so conversion paths grow linearly with format count
rather than quadratically.

**A mesh carries neither a unit nor a transform.** Both were removed in Stage
4A-2A so each has exactly one authority: unit belongs to the DOCUMENT — a file
states one unit for everything it contains, and two parts cannot honestly
disagree — and placement belongs to the PART, so a shared mesh cannot be placed
two contradictory ways at once. `undefined` unit means unknown and is never
defaulted to millimetres.

It is deliberately not a BREP/CAD kernel representation. See
[ADR 0004](adr/0004-canonical-mesh-model.md), including the unresolved Float32
vs Float64 question.

## 6. Geometry operations

Every geometry operation must:

1. run in a worker;
2. declare what it will modify before running;
3. report progress and honour cancellation;
4. leave the input mesh unmutated, so the previous state remains undoable;
5. validate its output with `assertMeshStructure` before the result is accepted.

Point 5 is the mechanism behind constraint 3. An operation that returns a mesh
which fails validation has failed, and must surface `GEOMETRY_VALIDATION_FAILED`
rather than hand the user a broken model.

**Conservative repair is the first operation to implement all five**, and it is
the reference for the ones that follow. Point 4 in particular is not a
suggestion there: the authoritative mesh is never written at all. A candidate is
built separately, validated independently, and `repair/commit` swaps one
reference. See section 6b.

## 6b. Conservative repair

The first workflow that CHANGES a user's model, and therefore the first place
where every rule above has to hold at once.

**Five operations, not one.** `repair/plan`, `repair/create-candidate`,
`repair/commit`, `repair/discard`, `repair/undo`. Planning must be observable
without allocating anything; applying must be a separate, explicitly confirmed
act; undoing must be its own transaction rather than a view the UI can fake. A
single `repair/apply` would make preview impossible and would make an accidental
resend destructive.

**`model/analyze` is untouched.** Analysis stays read-only. A repair verb hidden
inside it would make every diagnosis a potential mutation.

**The transaction lives in the worker.** The application sends identifiers; the
worker re-checks revision currency, candidate state, validation acceptance, plan
identity and single use before it swaps anything. React can waste work or show a
wrong label; it cannot apply a repair the runtime refused.

**Preview does not swap authority.** The viewport holds two render snapshots and
toggles visibility between them, sharing one display transform and one camera. No
handle changes, so a preview cannot be exported, cannot be analysed, and cannot
survive the model being replaced.

**The repaired candidate keeps the source's representation** — Stage 4B-1D. The
surviving faces' ORIGINAL index triplets, in source face order, over the source's
own vertices; only vertices no surviving face references are dropped, renumbered
in ascending original order; no coordinate is welded and no winding is changed.
Until Stage 4B-1D the candidate was rebuilt as triangle soup — nine coordinates
per surviving face — so removing one duplicate face from an indexed OBJ or 3MF
silently tripled the model's vertex count and threw away the index structure the
file carried. The render snapshot, which is drawn NON-INDEXED, is expanded from
the index buffer at the render boundary instead
([docs/repair/REPAIR_ARCHITECTURE.md](repair/REPAIR_ARCHITECTURE.md)).

**Undo is a forward transaction.** It puts the RETAINED pre-repair mesh back in
the worker and commits it as a NEW, higher revision — revision numbers only ever
move forwards, because every staleness guard in the runtime depends on that. The
history holds the `CanonicalMesh` OBJECT the document held, not a patch to
rebuild it from, so structural sharing and an indexed representation both survive
the round trip and the file exported after an undo is byte-identical to the file
that would have been exported before the repair (Stage 4B-1C). See
[ADR 0011](adr/0011-repair-undo-revisions.md).

Details, including why the repair contract's constants are RESTATED in
`geometry-runtime` rather than re-exported, are in
[docs/repair/REPAIR_ARCHITECTURE.md](repair/REPAIR_ARCHITECTURE.md).

## 6a. Topology diagnostics

Analysis follows the same shape as import and export, and for the same reason:
presentation components must not sequence worker operations.

```
MeshHealthPanel  (presentation only — renders a report)
      |
useTopologyAnalysis  (React binding: starts, cancels, routes to the store)
      |
runtime/analysis-service  (framework-free: dispatch, phase translation,
      |                    handle verification, cancel-after-result guard)
      |
GeometryClient.analyzeModel
      |
model/analyze  ->  worker  ->  ResidentDocumentStore.resolvePart  ->  mesh-topology
```

**Analysis starts automatically after a successful import**, because topology
defects are the reason a user opens this tool and a button between them and the
answer serves nobody. It is nonetheless _decoupled_ from import: analysis that is
refused for want of memory, cancelled, or failed leaves the imported model fully
loaded, renderable, and exportable. Diagnostics are additional information about
a model, not a precondition for having one.

### A report can only ever be shown beside the geometry it describes

Three independent gates, because this is the failure that would look completely
plausible on screen:

1. **The service** compares the handle AND THE PART the worker echoes against
   what it requested, and refuses a mismatch.
2. **The store** refuses a report whose token is superseded, _or_ whose handle
   does not match the currently loaded model, _or_ whose part is not the active
   one — any check alone would leave a path open.
3. **The viewport** compares the revision and the active part again before
   installing overlays, so the layer that would actually draw the wrong lines
   verifies rather than trusts its callers.

The part is not redundant with the handle. Two parts of one document live at the
same revision, so a report for part A and a report for part B carry **identical
handles** — only the part distinguishes them, and without it a report that
finished after the user switched parts would install itself against geometry
nobody analysed.

Importing a new model clears the previous report and detail outright rather than
flagging them stale: a report kept "just in case" is a report some later code
path can render.

### Exact counts, bounded samples

The report carries **exact** counts for every category and **bounded** samples for
visualisation. A mesh with two million boundary edges reports two million and
ships at most `sampleLimit` of them, with a flag saying so — and the interface
says "showing N of M" rather than implying the sample is the whole.

The DOM has its own separate ceilings on rendered component and boundary rows, so
a hostile model cannot turn an exact count into a million React children.

## 7. Web Workers

The protocol lives in `packages/geometry-runtime`:

- **Correlation** — every message carries an `OperationId`.
- **Progress** — `progress` messages with a 0..1 fraction and optional note.
- **Cancellation** — a `cancel` message; handlers poll a `CancellationToken`.
  Cancellation is cooperative, so a handler that never polls cannot be stopped.
- **Errors** — `SerializedAppError`, reconstructed into a typed `AppError` on
  the receiving side.
- **Termination guarantee** — the host emits exactly one terminal message per
  operation, including when a handler throws.

The coordinator is written against a `MessageEndpoint` interface rather than
`Worker`, which keeps it DOM-free and testable, and leaves room for a worker
pool or `SharedWorker` later without protocol changes.

### Transferable ownership

Buffers listed in a transfer are **moved**, not copied. Once transferred they
are detached in the sending realm and reading them throws.

- The sender must drop its reference immediately after dispatch.
- A handler that returns a buffer it received must return it in its own
  transfer list, or the caller gets nothing back.
- `meshTransferables()` de-duplicates buffers, because attribute arrays may be
  views over one buffer and a duplicate entry throws `DataCloneError`.
- `SharedArrayBuffer` must never appear in a transfer list. `toTransferables`
  rejects it explicitly.

## 8. WebAssembly boundary

No WASM module is present, and Stage 0 adds no geometry kernel.

When one arrives it sits **below** `mesh-core`, behind an interface that speaks
canonical mesh buffers. The UI, the state layer, and the coordinator must not
know which kernel is in use. Requirements already established for it:

- It loads inside the worker, never on the main thread.
- Its memory budget is explicit, and exceeding it raises
  `RESOURCE_LIMIT_EXCEEDED` rather than crashing the tab.
- Its output passes `mesh-core` validation before being accepted, regardless of
  what the kernel reports about itself.
- If it uses pthreads, it needs `SharedArrayBuffer`, which needs cross-origin
  isolation — see [DEPLOYMENT_REQUIREMENTS.md](DEPLOYMENT_REQUIREMENTS.md).
- Its licence must be compatible with a proprietary commercial product, and the
  analysis is per-kernel rather than a blanket rule. Licences in this space range
  from permissive through LGPL-with-exception to GPL, and CGAL's varies **per
  package** within one library. See
  [Geometry kernel licensing](DEPENDENCIES.md#geometry-kernel-licensing) for what
  upstream actually says about CGAL and OCCT.

## 9. Serialization and export

Writers run in a worker. Export produces a `Blob` saved through the browser's
own download path. No export path may transmit data.

Two writer contracts exist, and the difference is the unit of work.
`MeshWriter` takes one `CanonicalMesh` and backs the active-part STL export.
The DOCUMENT writers take an `ExportDocumentSnapshot` and back the conversion
workflow; every one of them goes through `exportDocument`, which validates by
parse-back. A conversion is not finished when bytes exist — it is finished when
those bytes have been read back as the same model.

The compatibility report a user reads before deciding is a PURE function of
scalar document facts, a target and an optional unit assertion. It is derived on
every render rather than stored, so a report can never describe a revision the
user has moved off. Its output is machine-readable facts;
`state/conversion-presentation.ts` is the one place a fact becomes a sentence.

## 10. Persistence

Nothing is persisted in Stage 0. When persistence arrives it will be local
(IndexedDB or Origin Private File System), and it will be explicit: session
recovery is a feature the user can see and clear, not an invisible cache of
their models.

## 11. Telemetry

None exists, and none is permitted to carry geometry, filenames, or file
contents. See [PRIVACY_ARCHITECTURE.md](PRIVACY_ARCHITECTURE.md). ESLint bans
the browser's network APIs outright, so adding telemetry is a deliberate,
reviewable act rather than an accident.

## 12. What is deliberately not implemented

STL, OBJ and 3MF can be read, and all three can be written through a validated
whole-document conversion workflow. Nothing else is implemented:

No unit CONVERSION of any kind — the unit chooser labels numbers and never
rescales them — no OBJ polygons, no MTL resolution, no 3MF textures or
materials, no exported normals or texture coordinates, no exported 3MF group or
property resources, no reconstruction of an imported 3MF's component hierarchy,
no welding, no booleans, no connectors, no splitting, no displacement, no
hollowing, no drainage holes, no wall-thickness analysis, no auth, no billing,
no database, no backend, no analytics, no persistence — and no stub that pretends
to be any of them.

Repair is implemented only in its **conservative** form: exact duplicate removal,
safe degenerate removal, and relative winding unification. It does not weld,
does not close openings, does not rewrite non-manifold topology, and does not
decide which side of a surface is outside. Everything it cannot decide from the
stored coordinates alone is refused with a stated reason rather than guessed. See
[docs/repair/REPAIR_POLICY.md](repair/REPAIR_POLICY.md).

### Filling one selected opening

Stage 4B-1B1 added `packages/mesh-hole-fill`: a validated planar hole-fill
engine. Stage 4B-1B2 put a workflow in front of it — an inventory of open
boundaries, selection of ONE, a patch preview, an explicit Apply and an Undo —
reachable through six protocol operations (`holefill/list-loops`,
`holefill/boundary-preview`, `holefill/send-for-fill`,
`holefill/patch-preview`, `holefill/commit`, `holefill/discard`). The engine
itself is unchanged: every ceiling, refusal and validator it enforced before it
had a user is exactly what it enforces now.

**Three separations carry the design, and each is load-bearing.**

_Listing answers a topological question; the engine answers a geometric one._
`holefill/list-loops` reports whether a boundary component is one ordered,
closed, simple, manifold cycle — exactly decidable from the stored coordinates.
Planarity is not in it, because the planarity policy lives in the fill engine
and the fill engine stays out of the geometry worker. So a perfectly simple rim
that curves out of its plane is listed as ATTEMPTABLE and refused when the engine
looks at it, and the interface says "Pybrix can attempt this opening" rather
than "can be filled" — a promise the listing has no way to keep would be a
promise broken once per curved rim.

_The display index is a label; the `BoundaryLoopId` is the identity._ A row reads
"Opening 3" because it is third in the deterministic order `extractBoundaryLoops`
produces. Every request carries the id the worker produced; the index is never
sent anywhere. A renumbering can therefore produce a wrong label and cannot
produce a wrong operation.

_The preview is READ FROM the stored candidate._ `holefill/patch-preview` reads
the patch faces out of the mesh the candidate store is holding — the same object
Apply installs. Nothing is re-triangulated, so "what you previewed is what was
applied" is structural rather than intended, and a boundary test asserts the
commit path reaches no engine symbol.

**Apply is one transaction and every guard is worker-side.** `holefill/commit`
carries four identifiers and no geometry. `prepareCommit` checks existence,
lifecycle, document, part, opening and revision — the caller's belief and the
store's own reading compared independently — then `withPartMesh` builds the
successor sharing every other part BY REFERENCE and `residentDocuments.replace`
swaps one map entry. That swap is the atomic step. A refusal at any point leaves
the candidate resolved and retryable, because consuming it on a transient race
would destroy a validated fill.

**Undo is the existing one-step history, with two reconstructions.** A fill is
recorded in `RepairHistoryStore` beside conservative repairs and reversed by the
same `repair/undo`; there is still exactly one undoable change per document, and
either kind supersedes the other. Both retain the `CanonicalMesh` the part held
and undo puts the same object back — a fill because it REPLACED one part's mesh
(Stage 4B-1B2-R1), a repair because rebuilding one from a patch lost exactly what
retaining it preserves (Stage 4B-1C). Reference identity, not byte equality:
reconstructing an equal mesh reproduced the coordinates and lost the identity,
so a document whose parts shared one mesh came back holding two, permanently,
along with two GPU geometries and two 3MF object resources. Retaining an
immutable mesh is O(1) and costs nothing extra while a sibling still references
it. The page follows through `meshResourceIndex`: `withPartRender` reuses a
sibling's existing buffers when the successor says the two parts share, because
`SharedPartGeometry` reference-counts by array identity.

What the engine does, and only this: it fills ONE selected boundary loop, which
must be a topologically simple manifold cycle under exact stored-coordinate
identity and must be proven planar by a RELATIVE policy (max deviation over the
loop's own largest extent, at or below 1e-4). Triangulation is in-house
deterministic ear clipping, which adds no vertex, moves no vertex, and appends
exactly `n − 2` faces after the user's. The candidate is then validated
INDEPENDENTLY of the thing that built it — byte-level source preservation,
structural validity, topology postconditions, patch winding against the source's
own directed edges, patch connectivity, Euler as corroboration, and a
PATCH-ATTRIBUTED intersection check against the qualified Geogram narrowphase.

What it does NOT do: non-planar loops, batch or "fill all", tolerance welding,
seam snapping, fairing, smoothing, surrounding remeshing, and any use of PMP —
which ADR 0018 qualified and rejected because it traps uncatchably, loses
append-only provenance and refines heavily. Only `holefill/commit` ever
replaces the resident document. Listing openings, drawing a rim, running the
engine, drawing a patch, cancelling and discarding all leave it byte-identical
and its revision exactly where it was.

Two limits it states rather than implies. **Filling a hole is not repairing a
model** — another opening, a self-intersection, duplicate faces or non-manifold
topology may all remain. And the intersection guarantee is INTRA-PART: whether
the patch collides with a different part of the document in world space is not
checked at all, exactly as self-intersection is not.

See [docs/adr/0018-hole-filling-qualification.md](adr/0018-hole-filling-qualification.md).

Two distinctions the interface is careful about, because both are easy to
overstate:

- **A conversion is lossless only for what Pybrix holds.** Every report says
  "for supported features", because the claim is about this document and this
  build — not about the file the user originally had. A 3MF whose textures were
  never imported still cannot get them back.
- **Numbers unchanged is not scale preserved.** Exporting a known-unit model as
  STL or OBJ writes the same coordinates and drops the label. Saying "scale
  preserved" would imply the file still records how big the model is; both
  phrases are banned by test.
- **Structurally valid is not printable.** Validation checks buffer and index
  integrity. It says nothing about whether a model is watertight, manifold, or
  manufacturable.
- **An accepted repair is not a printable model.** Repair acceptance means the
  requested defects improved and nothing else regressed, judged by Pybrix's
  own re-analysis. Self-intersections and wall thickness remain unchecked, and
  every repair verdict says so beside itself.
- **A validated patch is not a repaired model.** A hole-fill candidate means
  ONE named opening was closed and the patch was independently validated
  against the part it was built from. It does not mean the model is watertight,
  that other openings are gone, that pre-existing crossings were fixed, or that
  the patch clears geometry in another part. The strongest sentence the
  interface may show after an applied fill is `Selected opening filled and
validated`, and the qualifier naming what was NOT examined travels with it —
  both asserted by test.
- **An eligible opening is not a fillable one.** The listing states what it
  knows: the rim is one closed loop. Whether it is flat enough, and whether the
  new surface would cross the model, are decided when the fill runs.
