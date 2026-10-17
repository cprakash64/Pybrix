# Offline semantic fixture and evaluation contract

Stage13 changes research infrastructure only. Production remains e5990c7188f4a7922eb51edacc9298ede116d250; local safety baseline is 08660f438d7c68ae278faca89add49e4f1c11398. The P1 prompt at fd58f11ded2fac7c333e88b03797dd3d8e5c56ad remains an **unqualified next candidate**. Stage11's responsiveness blocker remains OPEN. No deployment or provider call is authorized by this infrastructure.

## Entry points

Use `buildSemanticFixture` → `validateSemanticFixture` → `freezeSemanticFixture` from `packages/repair-evaluation/src/semantic-fixture.ts`. This package is isolated from production. `scoreAllOutputs` accepts only validated fixtures. For a future live evaluation, construct requests with `scripts/semantic-evaluation-request.qualify.ts:buildValidatedEvaluationRequest`. It revalidates the entire freeze before rendering and returns only the existing production request. It has no dispatch or credential code. A future dispatcher must use this gate; never spread a fixture/freeze into a provider body.

A fixture specification declares expected triangle/component counts, closed status and outward orientation **before construction**. Defect counts must be zero. Validation reports each component's faces, bounds, volume, orientation, boundary/nonmanifold edges and vertices, winding conflicts, degeneracy and duplicate faces. The production topology analyser and a separate exact-coordinate edge connectivity reconstruction must agree. Timing is excluded from deterministic freeze content.

## Supported construction

The supported generator is a finite shared integer lattice. Box bounds are safe integers, hi is exclusive, and one finite positive scalar converts cell coordinates to source units. Cell count is bounded. Identical overlapping cells within one physical owner are idempotent. Cross-owner occupied-cell overlap is rejected. Every emitted exterior triangle records owner, lattice cell, axis and outward side **when emitted**. No centroid classifier is used. Regeneration must reproduce the exact stored mesh and provenance. Imported meshes and other construction paths are not certified by this version.

Adjacent occupied cells suppress both internal faces. Adjacencies across owners record both cells, both owners, physical interface area, and `REMOVED_INTERNAL_INTERFACE`. These records have no source face IDs and do not contribute to role precision or recall. No internal caps are silently allocated to either role. Native cut/cap triangles belong to output validation, never to source-membership denominators. Ambiguous/shared exterior ownership is unsupported and rejected. A future Boolean generator must supply a separate audited provenance policy before this gate can admit it.

The cubical construction plus clean closed vertex/edge-manifold topology establishes a nonintersecting embedded cubical boundary; grid edge/corner singularities are rejected. Independently asserted fusion requires the same single component and the declared positive interface area. Independent component roles require whole component membership and distinct component identities. Geometry/provenance regeneration prevents intersecting un-unioned shells from masquerading as this construction.

`voxelUnion` in auto-split fixtures is retained byte-for-byte in behavior and documented as a **legacy unit-cell surface extractor**, not a Boolean union. It walks +1 from each lo while < hi; fractional extents can overshoot. `cell` scales output, not iteration. Only identical origin strings deduplicate and exact ±1 neighbor strings suppress surfaces. Different grid phases can overlap without fusion. Same-phase full-face adjacency fuses; edge/vertex contacts can be nonmanifold. It validates neither coordinates, connectivity, intersections nor cell sign. Outward winding depends on positive scale. Its stable sort is not triangle deduplication. Do not use it for new qualification truth.

## Physical roles, containment and families

Every role freezes one scope: exact part, repeated family, assembly scope, fused visible region, detail, whole object, or non-executable unknown. English names do not define extent. Roles freeze face membership, contextual naming policy, visibility and parent relationships. Parent policies explicitly include children, exclude them, or represent an aggregate. Parent/child overlap is allowed only for declared containment; unrelated duplicate source ownership is invalid. Feet and a whole lower-limb assembly are distinct source scopes.

Families freeze ID, count, exact member role IDs (and thus faces/components), allowed subfamilies, distractors, spares, observable members and root executability. Missing, duplicate, overlapping or foreign members fail validation. A complete root and individual child alternatives may intentionally coexist. Duplicate individual sibling ownership is an error.

Legal operation classes are exact component, exact component group, qualified plane, fused non-executable and unknown non-executable. Component classes are derived from actual full component membership and must leave a nonempty complement. Repeated-family controls contain an independent host, so a complete-family extraction is a real partition. A plane class requires an independently successful production native split bound to the exact source and intended plane, source precision/recall, nonempty complementary partition, and closed outward manifold outputs. `prevalidatePlanes` uses the unchanged production Boolean/split/automatic-connector implementation. A successful native split is not itself semantic attribution. Validation independently recomputes the stated plane’s source membership and compares it to the evidence; a native certificate cannot borrow another plane’s membership.

Plane source ownership is vertex-side based; coplanar exterior triangles use outward normals. A triangle that straddles the plane is **refused**, not assigned by centroid. Arbitrary straddling-face area attribution requires a future clipping-aware evaluator and is intentionally outside this implementation's supported fixture domain.

The local negative plane control has a middle slab with lower and upper surrounding slabs. A frozen shared convex-hull witness proves the middle's exact source region cannot have a strict linear separator from the surrounding role. Native-valid arbitrary cuts do not turn this role into an executable scope. This is an exact-region nonseparability certificate, not a general search/certifier for all approximate semantic regions.

Connector truth additionally requires known millimeters, legal plane, closed outputs, positive interface area, production wall/depth/clearance checks, successful automatic plan, matching planned/executed centers, successful male union/female difference, and production transaction exact Undo. Native evidence alone leaves Undo pending and prevents freeze. The Stage13 control uses a new shared-grid solid and a local synthetic semantic response; it is **not live model quality evidence** and does not substitute for consumed f09.

## Independent all-output scoring

Pass the complete local `suggestions` array, exact source component ranks, actual native proofs, and provider records. The scorer enumerates **every READY output**, including generated alternatives and children, completed roots and native-qualified planes. It verifies the component-rank equivalence relation against measured connectivity. READY without an operation is an error. Non-READY reservations are not realization.

Every operation competes against **all legal physical scopes of its operation class**. Component attribution requires exact set equality. Plane attribution uses precision ≥0.90, recall ≥0.90, one qualifying role and dominance margin ≥0.03. Names never break ties. The report retains best/second scope, precision, recall, margin, source faces, operation type, native validity, family validity and naming result. Native proofs bind the actual emitted plane and source, not merely a role's prevalidated opportunity.

Four counts remain separate: `PHYSICAL_READY_ERRORS`, `NATIVE_READY_ERRORS`, `FAMILY_MEMBERSHIP_ERRORS`, `STRICT_UNKNOWN_EXECUTABLE`. Physical realization counts frozen legal non-detail concepts with any valid final operation, independent of names; generated children realize their member scope, never a complete family. Named realization adds the frozen contextual name test. Recognition credits correctly named non-executable roles independently of local refusal. Denominators and realized concept IDs are explicit; zero denominator is reported as a fraction, never invented as a percentage.

Family metrics independently report role recognition, count accuracy, semantic member correctness and observable annotation coverage. Partial annotation is not automatically a role/count error. Direct annotations enter as source-face sets; the scorer derives matched members and rejects duplicates/foreign membership, rather than accepting caller-supplied truth-member IDs. Family physical membership comes from source faces. Contextual ontology examples distinguish Armrests, Push handle, Upper block, Top plate, Feet and lower-limb assembly. Neutral structural names are accepted only in the declared per-concept policy. No global broad-noun substitution is used.

## Evidence, requests and consumed replay

A freeze includes the mesh, full topology/component analysis, deterministic provenance and interfaces, role/family scopes, legal operations, plane/native evidence, connector/Undo evidence, visibility and ontology. Its hash includes validator output. Any source, truth or evidence mutation invalidates the dispatch gate. Evidence objects must be produced by the audited native/UI adapters, not filled in from construction intent; hashes bind evidence but are not cryptographic attestations of a third party's execution.

Provider requests remain exactly six normal PNGs, six component PNGs and bounded production metadata. Truth, memberships, aliases, expected names, qualifying planes, connector proofs and local paths remain local. The request test embeds private sentinels in truth and verifies they never appear on the request wire. Credentials are not needed or loaded.

`auditUnprovenFixture` diagnoses legacy geometry and **always refuses qualification**, because topology alone cannot mint ownership/legal-operation truth. Stage12 replay executes all 16 saved responses locally; it reports every final READY alternative and topology mismatches, while returning `INVALID_FIXTURE` and null quality metrics. The four known count mismatches are f01 11/7, f10 8/1, f11 9/7 and f14 3/2. The other legacy fixtures lack this new provenance/prevalidation contract too. Never repair and rescore this consumed corpus into a pass.

Run focused checks with:

```sh
npx vitest run packages/repair-evaluation/src scripts/semantic-evaluation-request.test.ts --maxWorkers=1
npm run format:check
npm run lint
npm run typecheck
```

Private qualification evidence, replay scripts, retained Stage10 controls, native and browser proofs, and the requested 41-part report are under ignored `artifacts/semantic-evaluation-infra-13/`. They are never bundled or committed as application inputs.
