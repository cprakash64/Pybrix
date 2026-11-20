# ADR 0033 — Editable connector model

Status: accepted for Stage EC-1 (model, lifecycle, accounting), Stage EC-2 (rebuild engine), Stage EC-3 (transactions) and Stage EC-4 (page projection). Later stages are proposed, not accepted. Supplements ADR 0014 (multi-part document), ADR 0011 (undo) and ADR 0032 (export placement).

## Context

A committed split is two plain parts. Pins and sockets are Boolean results baked into the two meshes; the connector plan manifest is built for the candidate and is gone after commit. The only surviving record of a connector is the page's own `AssemblyPresentation.connectorPairs`, which is React state, is built from local sizes and a transform-norm bound, and re-maps itself after later cuts with a `1e-8` sign test. Nothing that exists can be edited, and editing means rebuilding the connectors from something retained.

## Decision

- A **joint** (one cut between two parts, plus the connectors across it) is recorded in the worker-resident `GeometryDocument` as optional session state. Each side keeps the pre-connector piece the connectors were built on and the exact mesh object the part held when they were.
- **Validity is derived by object identity** (`jointAttachment`): both parts present, the frame's unit, both placements equal, both meshes the built objects. It is not stored, because every mesh replacement spreads the previous document.
- **Retirement happens at the one install path.** `ResidentDocumentStore.replace`/`commit` replace a no-longer-attached joint with a bounded descriptor and release what it held. Undo installs the previous document object, so it re-attaches a joint with no rule of its own.
- Connector intent is stored in **millimetres with its physical frame** (ADR for C03-C). A site is resolver-chosen or an explicit `(u, v)` in the interface frame; either is validated, never trusted.
- Retained geometry is **counted once per distinct mesh** and included in `documentByteLength`. The retention ceiling is derived from the split triangle ceiling (`2,000,000 × 52` bytes) and is a policy bound: above it connectors stay plain geometry and the split is not refused.
- The page receives `JointDescriptor`s only. Export writes geometry only and never carries a joint.

## Measured

`npm run bench:joint-retention` (Node typed-array bytes; **not** a browser footprint): accounting equals the bytes the process holds to 0.1 MiB, and retirement releases them. Retained cost is 22.0 B/triangle for indexed content and 52.0 B/triangle for unshared content; a split source at the 2,000,000-triangle ceiling retains 42.0 MiB indexed and 99.2 MiB unshared, i.e. one extra copy of the two pieces' geometry. Chromium footprint is not measured here.

## Consequences

- A repair, fill or further split of a piece in an attached joint retires the joint; undoing it restores the joint. Disclosing that before Apply is a later stage's copy, not this one's.
- Handlers that report `documentByteLength(successor)` before install over-count a joint about to retire. No joint exists yet, so nothing is wrong today; the stage that creates one retires first.
- Holding a joint costs about one extra copy of its two pieces for as long as it stays attached.
- Nothing in this stage creates, edits or lists joints through the wire protocol.

## Stage EC-2 addendum — the rebuild engine

- The pin stage (`constructPinConnectors`) was extracted unchanged from `splitWithConnectors`; a split and a rebuild both call it. The existing 12 engine test files (300 tests, real kernel) and the pinned references pass unmodified.
- `rebuildJointConnectors` starts from the retained pre-connector pieces (`PinCut`) and a spec, never from the built pieces, and never inverts a Boolean. A joint rebuilt from its own cut is byte-identical to the split that made it (manual and automatic; one to three pins; male side A and B; millimetre, inch, centimetre and metre; a uniform placement scale).
- A pin site is always explicit: the exact `local` point plus `(u, v)` read from it. The model's `RESOLVED` site was removed (it carried no point to rebuild from).
- **A defect found and closed:** explicit sites bypass the resolver, and nothing else enforced pin spacing, so a rebuild could have built two overlapping pins a split would never place. The spacing rule is now one function used by the resolver and the rebuild (`CONNECTOR_DOES_NOT_FIT`, as the resolver throws it).
- The refusal codes a rebuild raises are a split's own: socket breakthrough, dimension out of policy, unsupported transform, footprint outside, support insufficient. Rebuild-only refusals are `INVALID_PLAN`: a plan that contradicts what the joint was built from.
- Observed, not yet acted on: reading an automatic joint's sizes back as millimetres reproduces its coordinates exactly but need not reproduce the planner's round figure (4.799999892711639 for 4.8 in metres). The stage that records a joint should record the planner's own figure for display.

## Stage EC-3 addendum — creation and the transaction

- **A split records the joint** (`recordJointFromSplit`, at candidate resolve) and is never refused for it. Where it cannot, `SplitCandidateSummary.editableConnector` says why, with the metric, value and limit for the retention ceiling.
- **Operations:** `joint/list` (read), `joint/propose` (builds a candidate by rebuilding from the retained cut; applies nothing), `joint/commit` (the only mutation), `joint/discard`. The edit vocabulary is numbers only: a male side, one size in millimetres, and positions `(u, v)` on the cut; the worker places the points.
- **Single-phase commit, not the split's two-phase.** The design said to reuse the split transaction. It was not reused: that protocol exists because the page must ADOPT a split (new part ids, new assembly, new view) and can fail part way. An edit keeps every part id, name and placement, so there is nothing to adopt but a revision. It commits in one step like a hole fill; the worker dying between the swap and the reply is the boundary Policy A already covers. This is a deviation from the Stage EC-0 design, made for that reason.
- **Guards** are the caller's and are read again by the store: document and revision, joint id, spec digest. A refused commit consumes nothing. Everything fallible is built before the swap.
- **Defect found and closed: undo did not re-attach a joint for a repair, a fill or a generic edit.** Their inverse is mesh-only, so undoing one restored the mesh and left a retired descriptor where the joint was; only a split's and a joint edit's inverse carried `previousDocument`. A change that retires a joint now records the document it came from, and the claim in the Stage EC-1 text ("undo needs no rule of its own") is true for every kind of change.
- **Defect found and closed: handlers reported `residentBytes` from the successor before the swap**, counting the bases of a joint the install was about to retire. Handlers now retire first.
- **Unit-less models.** A joint on an STL records the unit the user asserted for the split in its frame; the document never gains one, and an edit sizes from the frame.
- **A new test project** (`apps/web/src/workers/node-integration-tests`, Node types plus the DOM lib) drives the worker's own handlers on the real kernel. The worker handler modules name `Worker` and `Transferable`, so they compile only with a lib that declares them; the kernel-only project and the WebWorker project are unchanged.

## Stage EC-4 addendum — the page is a projection

- **The page's own record of a connector is gone.** It lived inside the assembly layout, was built from the size a split asked for and a transform-norm bound, and was carried across later cuts by a sign test at `1e-8` that dropped what it could not place. The page now holds the descriptors `joint/list` returned for the revision it holds, and nothing for any other.
- **One read per revision** (`useJointSync`, mounted once). No list of operations that "affect joints" to keep in agreement with the operations that do. A failed read is `UNAVAILABLE`, said in words, and never "no connectors".
- **The worker describes a pin in the scene**: centre, axis and `mmPerSceneUnit`. This needed one more field on the joint, `cutNormal`, recorded from the interface frame, because the descriptor must say which way a pin points without the page holding the interface.
- **What stayed.** The assembly layout's interfaces (explode offsets, labels, the footprints a later cut is tested against) are presentation and do not hold a connector. They keep their own sign test, which is about layout and not about whether a connector exists. This is a narrower change than "delete the sign test", and it is stated here so that the sign test's survival is not mistaken for the old connector record's.
- **A repair or a fill discloses, before Apply**, that the connectors recorded with the piece's cut end as a record and remain as plain geometry, and that Undo brings the record back (true since EC-3).
- **Not done.** No control edits a connector; the client has the methods and nothing calls them. A cut that crosses an attached pin is still refused by the page's guard, now sourced from the worker's list.

## Not decided here

Persistence beyond the session; one pin size per joint versus several (the schema carries sizes per pin); the rebuild engine; the transaction; the page projection that replaces `connectorPairs`.
