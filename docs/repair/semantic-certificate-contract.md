# Offline semantic non-plane certificate

This contract belongs to research evaluation infrastructure. It does not change
product semantic admission, plane synthesis, native geometry, or model behavior.

`FUSED_NONEXECUTABLE` means a supported simple-plane obstruction has been
certified for a frozen source role. It does not mean no conceivable curved
surface, multiple cuts, or future operation could separate that region.

The opposing scope is an explicitly authored physical role. Its exact frozen
source-face set must be nonempty and disjoint from the target. The validator
computes `witnessExclusiveFaces = witnessFaces - targetFaces`; an empty result
rejects. Any overlap also rejects, including identical sets, ancestors containing
the target, contained children, and partial overlap. The validator does not
silently reinterpret the witness as its exclusive portion. To certify an assembly
complement, define a separately grounded role whose source membership actually
represents that complement. It must not default to the entire model.

Both scopes must belong to the same measured source component and have a measured
fusion interface between their source-owned cells. Hierarchy alone proves none of
this. INCLUDE_CHILDREN and AGGREGATE_ONLY may aggregate semantic membership;
EXCLUDE_CHILDREN retains own membership. Those policies cannot certify geometric
nonseparability.

Each side supplies 4–64 source vertex references with finite strictly positive
weights summing exactly to one. Each selected point set must span affine rank
three, and the two weighted points must be exactly equal. Positive combinations
of full-dimensional sets place the common point in both convex-hull interiors.
A plane assigning those independent point sets to opposite closed halfspaces
would force the common point onto its boundary, contradicting interiority. This
is a sufficient obstruction to a simple plane separator in the audited
shared-grid domain. It is not necessary: unsupported non-plane cases must reject
rather than receive invented proof. Mere hull boundary contact, adjacent shared
interfaces, and target-containing hulls do not suffice.

The executable/non-executable conflict is checked by exact physical source scope,
including component unions, executable aliases, declared planes, and qualified
native evidence. Multiple qualified executable planes for one executable role
are permitted. A non-executable role cannot borrow that same scope while denying
its executable operation. UNKNOWN_NONEXECUTABLE is separate semantic uncertainty,
not a proof of fused plane obstruction.

Native attestations must bind their source hash, role, plane, selected faces and
complete disjoint complement. Every attestation is checked, including extras;
one valid proof cannot hide a stale or mismatched one. Freeze, all-output scoring
and request construction revalidate admission. Invalid truth yields
qualificationEligible=false and null metrics, never a model safety count.

The offline `countercheckConstructionPlanes` adapter tests both orientations of
axis-aligned box-boundary planes, at most 192 candidates. Exact face selection
uses the existing source-membership oracle; geometry uses production
splitWithConnectors and Boolean validation. It records native refusals separately.
It neither exhaustively searches arbitrary planes nor turns a backend refusal
into nonseparability evidence. Full-interior disjoint certificates provide the
mathematical admission condition; bounded native checks supply independent
negative controls.

The canonical Stage14 cuboid remains exactly native separable at z=3 (90/90,
precision=recall=1, closed positive volumes 27+27, area9). Its target-versus-parent
certificate must reject before freeze, request construction or scoring. The
new 3×4×5 interleaved-band control has independent disjoint opposing geometry and
retains a valid common-interior certificate.
