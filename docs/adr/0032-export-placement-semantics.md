# ADR 0032 — Export placement semantics

Status: accepted (Release 2, Stage C03-D). Supplements ADR 0016 (validated document export) and ADR 0017 (format conversion workflow).

## Context

A document part is a mesh in its own coordinates plus one placement (`GeometryPart.transform`, twelve Float64 values). Connector sizing (Stage C03-C) is physically true inside the application: a connector asked for as 4 mm is 4 mm once the unit and the uniform placement scale are applied. Export must not destroy that truth. An audit of the three formats found:

1. **Active-part STL (`model/export`) dropped the placement.** It wrote `part.mesh`. A part placed at ×2 was written at half its physical size and at the wrong position; split pieces, which inherit the source's placement, were exported the same way.
2. **A mirrored placement turned the solid inside out in whole-document STL and OBJ.** Vertices were baked correctly and the corner order was kept, so every triangle faced into the material and the signed volume was negative.
3. **3MF wrote the mirrored placement as a build-item transform with a negative determinant**, which the 3MF Consortium's conformance suite files with the defects a consumer must reject.

## Decision

- A file holds the part where the document puts it, in every format. Active-part STL writes `placeMesh(part.mesh, part.transform)`; an identity placement allocates nothing.
- One arithmetic (`applyPartTransform`) and one orientation question (`placementReversesOrientation`, the sign of `placementLinearDeterminant`, which `classifyPlacement` also reads) serve every exporter.
- Wherever a placement is baked into vertices, a placement that mirrors also exchanges the second and third corner of every triangle.
- 3MF keeps placements as item transforms, except that a part whose placement mirrors is written as its mesh mirrored in x, triangles turned, with the placement composed with that mirror (first basis row negated). The item never reflects; world positions are bit-exact (negations only). Mirrored placements of one mesh share one mirrored object.
- STL and OBJ state no unit and baking never rescales: coordinates are the document's. 3MF still refuses a unit-less document rather than inventing a unit.
- The connector plan manifest is not touched: a plan describes a cut, not a file.

## Consequences

- A re-imported 3MF of a mirrored part is the same physical object but a different (mesh, transform) pair.
- STL and OBJ exports of placed parts have their placement applied and no longer round-trip to the stored local coordinates; the active-part export says so with `STL_EXPORT_PLACEMENT_APPLIED`.
- Baking narrows once to Float32, so a large translation costs the precision Float32 has at that magnitude; 3MF keeps the Float64 placement and is not affected.
- The active-part export holds one transient placed copy of the part for a non-identity placement.
