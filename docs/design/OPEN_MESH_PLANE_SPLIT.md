# Conservative plane cuts on open meshes

Pybrix chooses how to execute a plane cut. Repair is no longer a global prerequisite.

`choosePlaneSplitStrategy` checks the immutable canonical mesh, finite plane, the shared 2,000,000-face ceiling and topology workspace budget. A clean closed solid continues through the existing validated Manifold intersections, cut-surface identification, volume checks and connector operations. Open or non-manifold sources use `splitOpenSurface`; an unsafe individual cut is refused without registering a candidate.

The fallback clips the source triangles against both half-spaces. One reusable 72-byte Float64 scratch record handles untouched faces; validation uses scalar arithmetic. Point objects are allocated only at bounded cut neighborhoods, not for every source triangle. It counts output before allocating exact-sized typed arrays, retains untouched coordinates and winding, and checks each clipped face's area conservation. Original source vertices are never moved. Intersection coordinates use a canonical endpoint order and a bounded edge cache, so indexed meshes and STL soup produce identical shared cut coordinates. Signed zero is normalized for identity but remains unchanged in untouched geometry.

Predicates use Float64 arithmetic over exact stored Float32 inputs. Classification allowance is 64 Float64 ULPs of model-relative coordinate scale. Generated Float32 coordinates are checked against a separation allowance of four Float32 ULPs of absolute/model scale, with a subnormal floor. The allowances describe representational uncertainty rather than a fixed world-space distance. Fragments that collapse at canonical precision are refused.

Only current-plane edges enter the cut graph. Duplicate generated segments, incompatible local winding and vertices of degree greater than two are refused. Closed contours are capped; simple open chains retain the source opening and receive no invented closing surface. An open chain inside a prospective cap, crossing contours, unverified coplanar faces at the cap or same-oriented nested shells are refused. These are refusals of that plane, not demands to repair the entire source.

Contours are projected in a stable, origin-relative plane frame. A bounded sweep checks contacts/crossings; a containment tree distinguishes islands and holes. The pinned, pure Mapbox Earcut 3.0.2 implementation already present in Three.js supplies triangulation. The independent admission and validation checks enforce cap boundary incidence, interior incidence, orientation, nonzero triangle area and covered polygon area. The source and shipped notices retain Earcut's ISC license. Rendering code is not imported into geometry packages.

Additional ceilings are 65,536 intersection nodes/segments, 256 closed loops, 8,192 total cap vertices, 16,384 cap triangles, 2,000,000 contour comparisons and 128 MiB estimated intermediate storage. Existing edit limits still bound total output to 5,000,000 triangles, 384 MiB canonical/preview buffers and 1 GiB estimated edit allocation. Output may exceed the input ceiling because clipping and caps add faces; the supported input ceiling remains exactly 2,000,000.

Traversal and writing are linear in source triangles. Existing classification/validation topology uses its established bounded workspace. Cut-contour work scales with the bounded intersection graph; comparison budgets stop pathological sweep/containment cases. Triangulation sees at most 8,192 vertices. No whole-mesh remeshing, simplification, voxelization, hole filling or component deletion occurs.

Every source face belongs to one unchanged output or a conservatively validated pair of clipped polygons. Caps use only cut-contour vertices. Outputs undergo structural, separation and existing candidate validation before Preview. Existing source degenerate faces may remain, but their combined count cannot increase. The source's unrelated openings survive exactly; independent truck qualification compares every boundary endpoint pair before and after.

Component extraction needs no Boolean: it partitions existing triangles into disjoint face components. It retains source defects under the same candidate validation rather than requiring closed solids. Semantic unavailability, empty/all-component selections, stale revisions and resource limits remain refusals.

Preview retains the authoritative source document and Repair state. Apply uses the existing `SplitCandidateStore` transaction and is the first document replacement. Undo retains and restores the exact previous document, including a repaired source. A failed candidate, cancellation, stale generation or failing Apply preparation cannot commit partial pieces.

Plain cuts are supported for the fallback. Connector requests return “Choose None for this split” before clipping; closed-solid pin/dovetail behavior is unchanged. Open-surface volume metrics are marked uninterpretable and the existing volume row is withheld. Strategy names and diagnostics are not added to the product UI.

The request transport, six canonical images, `store:false`, provider attempt accounting and backend source remain unchanged. The annotated real-truck response is a mock fixture containing only normalized semantic boxes; it is neither geometry nor evidence of live AI accuracy. Release audits reject that fixture from browser and service production bundles.

Qualification scripts use `OPEN_MESH_TRUCK_PATH` (defaulting to the original Downloads file) read-only. Frozen-source reproduction additionally uses `OPEN_MESH_BASELINE_ROOT` pointed at a clean `cdcca23` checkout. Generated model buffers and private evidence live under ignored `artifacts/open-mesh-split-01/`. No deployment is part of this change.
