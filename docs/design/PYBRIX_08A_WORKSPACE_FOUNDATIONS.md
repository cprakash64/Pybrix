# PYBRIX-08A — Workspace foundations and production Manual Split

## Scope

Three foundations, no new geometry kernel and no change to Repair:

1. **The Inspector starts collapsed.**
2. **A shared model unit interpretation**, so a unitless STL no longer disables
   physical-size features.
3. **Manual Split** completed as a production operation on the Stage 7B engine.

Semantic Auto Split and Surface Texture 2.0 are not in this stage. The structure
below is what they will build on.

## Evidence this stage started from

- The Inspector opened by default and took ~280 px of the viewport.
- Split connectors and Surface Texture were disabled for any model that did not
  state millimetres, which is every STL.
- Split refused the development truck (~1.99 M triangles).

## 1. Inspector

`inspectorCollapsed` is React layout state in `ShellLayoutProvider` and now
initialises to `true`. Nothing is persisted, so no stored preference can force
the panel open or shut. `Inspector` re-collapses it when the document id changes
(a new file), and nothing else opens it: a load, a selection, a Repair and a
workspace change leave it alone. Below 1200 px the Inspector is a drawer that
the CSS already treats independently of the collapsed flag. The collapsed rail
button is named, keyboard-operable, `aria-expanded="false"` and
`aria-controls="inspector"`.

Consequence for tests: the Inspector's facts exist in the DOM while it is
collapsed (it is `display: none`, not unmounted), so `toHaveText` assertions on
them still hold. Only `toBeVisible` on an Inspector element needs the panel open.

## 2. Model unit interpretation

**What it is.** A statement by the user about how to READ a unitless model's
coordinates. It is workspace metadata (`WorkspaceState.unitInterpretation`),
`{ documentId, unit }`.

**What it is not.** Not a unit conversion and not a geometry edit. No coordinate
is rewritten, no revision is consumed, and `GeometryDocument.unit` is untouched,
so an STL document still states nothing and exports still refuse to claim a unit
the file never had.

**Why not a document edit.** A document edit consumes a revision, which
invalidates every analysis and candidate for the document: re-running topology on
a two-million-triangle model to change a label. `documentId` is stable across
revisions, so Repair, Split, Texture and the Undo of any of them all see the same
reading.

**Precedence.** A unit the file states always wins and cannot be overridden
(`setUnitInterpretation` returns `false`). The interpretation applies only to a
document whose file states none.

**Lifetime.** Cleared on every new import; additionally ignored whenever its
`documentId` is not the loaded document's, so it cannot apply to the next file
even if a clear were missed.

**Nothing is guessed.** There is no inference from bounding-box size. The prompt
preselects nothing.

**Coordinates versus physical size.** STL coordinate 8.0 read as inches is
203.2 mm. Physical parameters the user types (connector diameter, texture
feature size) are millimetres in the interface and are converted into the
model's coordinate units when the request is built
(`millimetresToCoordinates`). The mesh itself is never scaled. A parameter that
is valid in millimetres but outside the engine's range in the model's units
(0.1 mm in a model read as inches is 0.004 in, below the engine's 0.01 floor) is
refused with a message, not silently clamped.

**Cross-workspace.** `useUnitInterpretation` is the one reader. Split connectors,
Surface Texture, the Model panel and Convert use it. Convert's `unitAssertion`
is seeded from the interpretation on open and writing it in Convert updates the
interpretation, so the two are one statement. A split session and a texture
session include the unit in their session key, so a preview made under one
reading is retired when the reading changes.

## 3. Manual Split

### What the engine already is (audited, not rewritten)

The Stage 7B engine (`packages/geometry-runtime/src/split-connectors.ts`) is not
a centroid classifier. For a plane it builds two finite oriented half-space
cutters and intersects the source with each through the pinned Manifold kernel.
Manifold splits the intersected triangles exactly and caps the cut. The result
is then validated independently:

| Requirement                                                                 | Where it is met                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Intersect with the user plane, split crossing triangles                     | Manifold intersection with each half-space cutter                                                             |
| Robust predicates and ownership of on-plane vertices, edges, coplanar faces | Kernel's exact predicates; permanent tests for oblique, near-end, vertex, edge and thin planes (`7B-S02/S05`) |
| Cut contours, multiple and nested                                           | Recovered from the cap triangles in `identifyCutSurface` (torus: two loops; two shells: disconnected loops)   |
| Cap with correct winding                                                    | The kernel's constrained triangulation; each side receives an opposing cap                                    |
| Output validation                                                           | Both pieces closed, edge-manifold, consistently wound, no degenerates; volume conservation within `1e-4`      |
| Fail closed                                                                 | Missing/tangent plane, empty or near-empty piece, any failed check refuse before Preview                      |
| Preview == Apply                                                            | Preview reads the stored candidate; Apply installs that candidate with one transaction                        |
| Undo                                                                        | Retains the exact previous document graph                                                                     |
| Cancellation                                                                | Disposable nested worker, terminated on Cancel                                                                |

No new cutting implementation was written. Auto Split must propose a plane
through this same pipeline.

### Source policy (decided from a six-case audit)

`apps/web/src/workers/node-tests/split-source-audit.test.ts` runs the production
engine on six source classes:

| Case                                          | Result                     |
| --------------------------------------------- | -------------------------- |
| A. clean closed solid                         | splits                     |
| B. complex closed solid (torus, two outlines) | splits                     |
| C. closed solid with one opening left         | refused: `OPEN_BOUNDARIES` |
| D. open manifold surface                      | refused: `OPEN_BOUNDARIES` |
| E. several closed components                  | splits (see below)         |
| F. edge- or vertex-sharing solids             | refused: `NON_MANIFOLD`    |

The decision is **closed manifold solids only**. Splitting an open surface and
capping only the new cut is not implemented: the cap is built by the kernel from
a closed solid, and a surface with an existing opening has no inside for the
kernel to cut. That is a limitation of the approach, not a safety rule being
held for its own sake, and it is stated plainly to the user.

The refusal now carries typed reasons (`SplitSourceReason`) in
`AppError.details`. The sentence names Repair **only** when every reason is one
Repair's conservative operations address (winding conflicts, degenerate or
duplicate triangles). It never says "Run Repair" for an opening or a
non-manifold edge, because Repair cannot promise to make those eligible.

**The development truck.** It has open boundaries and non-manifold vertices, so
it is refused with `OPEN_BOUNDARIES` and `NON_MANIFOLD`. That refusal is correct
and the truck was not used to weaken any requirement.

### Multi-component sources

A closed source with several disconnected components is accepted. The plane cuts
the components it intersects; a component the plane misses lies wholly on one
side of it and is carried, intact, into the piece on that side by the kernel's
intersection with that side's half-space. Nothing is discarded. A plane that
intersects nothing is refused (`SPLIT_PLANE_DOES_NOT_INTERSECT_PART`).

### Plane controls added in this stage

- **Roll**: a second rotation about the remaining axis, so orientation is not one
  lean in one direction. Zero is skipped rather than applied, so an unrolled
  plane is byte-identical to the qualified construction.
- **Swap sides**: reverses the normal, which exchanges Piece A and Piece B. The
  plane in space does not move.
- **Piece visibility**: Both / Piece A / Piece B for the preview. Presentation
  only: a mesh's `visible` flag, no upload, no disposal, no camera change.
- **Validation row** in the result.

Already present and kept: X/Y/Z presets, numeric position, slider, tilt, Reset,
drag along the normal, Update Preview, Apply, Undo, Cancel, Piece A/B tints,
cross-section outline, per-piece triangle counts and volumes.

### Not done in this stage (stated, not hidden)

- **Free-form plane orientation** (align-to-face, three-point plane, arbitrary
  normal entry). Orientation is axis preset + tilt + roll.
- **Open-surface splitting.** See the source policy above.
- **A manual connector placement editor.** Placement stays automatic and
  deterministic.
- **A cut gizmo with a rotation handle.** Rotation is numeric (and therefore
  keyboard-operable); the arrow drags position only.
- **Memory measurements and a 2 M-face run.** The 500 k-triangle split is
  covered by the Stage 7B benchmark; nothing in this stage changed the engine,
  so those numbers are inherited, not re-measured.

## Verification

See the 08A section of the stage report. Public-UI coverage is in
`e2e/split-foundation-08a.spec.ts`; the engine audit in
`split-source-audit.test.ts`; unit semantics in
`unit-interpretation.test.ts` and `workspace-unit-interpretation.test.ts`.
