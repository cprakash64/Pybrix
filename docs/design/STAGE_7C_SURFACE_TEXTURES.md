# Stage 7C — Surface Texture Patterns

Status: unreleased, `main` only. This does not change the `v0.3.0` release.

## Scope

Texture edits one selected placement and one connected flat surface region. The public MVP patterns are Dots, Lines, and Diamond; each can be Raised (embossed) or Engraved. The result is canonical triangle geometry, not a material, shader, image, UV map, or render-only displacement.

The MVP intentionally excludes curved conformal mapping, arbitrary UV unwrapping, images, text, logos, noise, knurling, multi-part application, printability analysis, and full wall-thickness analysis.

## Selection and local frame

The existing viewport ray pick supplies a stable part ID and source render-triangle index plus the world hit point and normal. Because render triangles retain canonical face order, the authoritative geometry worker uses that index as the seed. No canonical geometry crosses to the page.

`selectEditSurface` grows exact-edge adjacency from the seed using a two-degree normal bound and a 100,000-triangle region ceiling. It creates the existing right-handed Float64 calculation frame (`origin`, `tangentU`, `tangentV`, `normal`). Part transforms remain placement data; all edits are generated in part-local coordinates.

Only `PLANAR` regions are admitted in this MVP. `NEAR_PLANAR` and `NON_PLANAR` regions receive: “This texture tool currently supports flat surfaces. Choose a flatter surface.” This avoids flattening or deceptively projecting onto curved geometry.

## Boundary, holes, and containment

Selected triangles are projected into the qualified local frame. Boundary edges are recovered from selected-face incidence. Point membership is tested against the actual projected triangles, so concave empty space and holes are not treated as material.

Every footprint is conservatively sampled, not merely its centre. Dots sample their circumference. Line and Diamond bars sample both long edges, their centreline, and bounded stations along their length. Every sample must be inside a selected triangle and at least the texture edge margin from every outer or inner boundary. Edge features are omitted rather than clipped.

“Texture edge margin” is only a surface-boundary policy. It is not printable wall thickness.

## Pattern layout

All patterns produce the common `TexturePatternInstance` representation: local centre, orientation, width, length, and profile kind. Layout anchors derive from selected-frame coordinate bounds and configured centre-to-centre spacing, so identical inputs produce identical ordered instances.

- Dots are 24-sided shallow cylinders.
- Lines are parallel rectangular bars. Triangle/scanline intersections produce deterministic, fully contained spans; concavities and holes split or omit spans rather than bridging empty space.
- Diamond is two crossing line families at rotation plus and minus 45 degrees. The combined closed multi-component operand is submitted in one Boolean operation.

Rotation is bounded to 0–180 degrees. Dots ignore rotation. All dimensions must be finite and positive. Spacing means centre-to-centre pitch and must be at least the dot diameter or line width.

## Emboss and engrave

Raised features extend along the selected outward face normal by the requested height. Their operand begins a small distance inside the source so the union is not tangent. Engraved cutters extend inward by the requested depth and a small distance outward so the difference crosses the surface.

The interface overlap is `max(part diagonal × 1e-6, height/depth × 1e-4)`. It is local to the Boolean interface and is never used for topology identity or vertex welding. Requested height/depth excludes that overlap.

## Boolean and resources

Source meshes must already be finite, closed, manifold, consistently oriented, and free of prohibited degeneracy. Texture does not silently repair them.

Accepted primitives are assembled into one closed, possibly disconnected operand. The existing validated Boolean adapter performs one union or difference through the existing disposable child worker. The authoritative worker remains responsive and termination cancels in-Manifold work.

Existing Boolean ceilings remain unchanged: 2,000,000 input triangles, 256 MiB input-copy bytes, and 768 MiB known operation bytes. Texture additionally admits at most 500 elements and 64,000 estimated primitive triangles. These conservative MVP limits bound layout, operand construction, preview cost, and Manifold input; errors report observed metric and limit.

## Candidate lifecycle

The existing `GeometryEditStore` owns the candidate. Changing surface or settings cancels active work, discards the previous candidate, and increments the shared generation. Update Preview is explicit; controls never run Manifold on every input event. Stale results, document replacement, and superseded generations cannot become current.

Apply validates and renders before atomically replacing only the selected part mesh. Placement, name, metadata, sibling ordering, and unrelated parts remain unchanged. Editing a shared mesh placement materializes a private mesh for that placement only. One-step Undo restores the exact prior mesh reference and therefore restores sharing.

Cancel terminates active work, releases the worker-resident candidate and render preview, clears the surface selection, and leaves the document unchanged.

## Units and export

Dimension editing is enabled only when the imported document explicitly declares millimetres, matching the conservative Stage 7B policy. The interface does not label unknown native units as millimetres.

After Apply, the edited canonical geometry flows through the existing whole-document STL, OBJ, and 3MF exporters. There is no texture-specific exporter or render-only texture state.

## Known MVP limitations

- One selected placement and one connected surface region at a time.
- Flat (`PLANAR`) surfaces only; near-planar and curved surfaces are refused.
- Dots, Lines, and Diamond only; Raised and Engraved only.
- Fully contained elements only; no clipped edge elements.
- Explicit-millimetre documents only for dimension editing.
- Printer tolerances and complete local wall thickness are not analysed.
- Resource ceilings apply.

## Qualification evidence

Permanent `7C-*` tests cover planar growth, deterministic spacing and rotation, concave and hole containment, non-planar refusal, density admission, closed operand construction, all six pattern/mode Boolean combinations, and emboss/engrave volume direction. Browser, export/readback, cancellation-tail, performance, retention, privacy, and full regression evidence is recorded by the Stage 7C qualification run before the feature is declared release-ready.

## TEXTURE-FIX-01: two defects found by the Stage T0 baseline

Stage T0 measured the shipped texture and reproduced two defects. This stage fixes them and changes no ceiling, budget, validator or Boolean behaviour.

- **D1, STL models could not be textured.** `projectedRegion` found the selected region's boundary edges by vertex-index pairs. An STL import is triangle soup, so no two triangles share an index and every edge looked like a boundary. A plate was refused ("No texture elements fit inside this surface and its edge margin"), and on a bare six-face box the elements beside each face's diagonal were silently left out: the same cube gave two elements as soup and four indexed. Boundary edges are now keyed by exact stored coordinates (`exactVertexKey`, ADR 0009), the identity region growth already used. Nothing is welded.
- **D2, a refused selection and the selecting indicator never appeared.** The session key carried the unit and the key `pick` stored under did not. One function (`textureSessionKey`) now builds it.
- **D3, the selection limits were plain errors.** A part over 1,000,000 triangles and a region over 100,000 are now typed resource refusals (reason, metric, limit, and the part's size for the first) and are worded on the page from those numbers, instead of printing "has more than 100000 triangles; limit is 100000".

Evidence: `surface-texture.test.ts` (soup and indexed twins give identical layouts and identical textured results, including a `-0` case), `exact-vertex-key.test.ts`, `edit-geometry.test.ts` (typed refusals, both limits and the unmoved boundary), `use-texture-workflow.test.tsx` (indicator and refusal reach the screen state), `texture-presentation.test.ts`, and `e2e/texture-stl-and-refusals.spec.ts` (an STL box is laid out like its indexed twin and is applied and undone; a 100,352-triangle plate is refused on screen). Each was shown failing on the unfixed code first.

Not changed, and still true: the selection scan refuses parts above 1,000,000 triangles (the part, Boolean and split ceiling is 2,000,000), every settings change re-scans the part, and a textured candidate is validated by topology only (no wall-thickness or self-intersection check).
