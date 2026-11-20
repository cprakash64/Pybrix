# ADR 0033 — Editable connector model

Status: accepted for Stage EC-1 (model, lifecycle, accounting), Stage EC-2 (rebuild engine), Stage EC-3 (transactions) Stage EC-4 (page projection) and Stage EC-5 (the editor) and Stage EC-6 (move and add) and Stage EC-7 (every workspace) and Stage EC-8 (axis labels). Later stages are proposed, not accepted. Supplements ADR 0014 (multi-part document), ADR 0011 (undo) and ADR 0032 (export placement).

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

## Stage EC-5 addendum — the editor

- **Scope: size, male side, removal.** EC-5 changed what a connector is and not where it sits: a pair of numbers on a cut the user cannot see by them is not a control, so moving or adding one waited for a view of the cut. EC-6 built that view.
- **Where it lives.** Beside the split's result, not inside it, and it depends on the worker's joints and not on the split's state. A connector edit keeps what the split showed (the two pieces, Export) through a marker on the revision the edit produced; Undo split is not offered then, because the latest change is the edit.
- **Adoption.** `applyJointEditResult` keeps every part and carries the layout to the new revision, remembering the one it replaced so an Undo, which brings those parts back, finds it. The edit's Undo is the existing `repair/undo`.
- **Two defects found by driving the real flow**, both in the page and both invisible to the unit tests that preceded them: the editor sat inside the split's result and vanished with its Undo as soon as the model moved to the edit's revision; and the split's Export pieces went with it. Each is now held by `e2e/connector-edit.spec.ts`, which also judges the edit by the volumes of the files the application writes.
- **Not done here.** Move and add arrived in EC-6 (below). The editor appears in the Split workspace for the piece in view, not yet in the other workspaces.

## Stage EC-6 addendum — move and add

- **Decision: a 2D picture of the cut, not handles on the model.** The worker describes the cut's outline in the cut's own axes (`JointDescriptor.cutFace`: outline loops, `mmPerCoordinate`, the most pins a cut holds); the page draws it as an SVG. A 3D handle would need the viewport to hold a pick plane, a drag controller and a second statement of where the cut is; the picture needs none of that, is testable in jsdom and Playwright, and leaves the viewport untouched. Cost: the person looks at a flat view of the cut and not at the model; the connector markers in the viewport still show the pins in 3D.
- **The page decides nothing about validity.** A drag is not clamped to the outline and two connectors can be placed too close in the draft. `joint/propose` refuses either with the engine's own sentence and the draft is kept; the alternative, a local test, would be a second implementation of the material and spacing rules.
- **The outline is bounded.** Above 4,096 points it is omitted and the editor says it cannot draw the cut; sizes, the male side and removal still work.
- **Adding.** Add connector appends an unnamed draft pin at the centre of the outline's bounds. The worker names it from `nextPinOrdinal`, which only grows, so a name is never given twice. A plain cut gets its first connector this way.
- **Not done.** (EC-7 has since put the editor in every workspace.) The picture shows the cut in its own axes, which are not labelled against the model's x, y and z, so it does not say which way is which on the model. No snap, no grid, no symmetric placement, no mirror between the two pieces. Whole-browser footprint with a joint retained at the retention ceiling is unmeasured.

## Stage EC-7 addendum — the editor in every workspace

- **Decision: one controller, one visible copy.** The editor's hook runs once in the controllers provider; each of the four workspaces mounts a slot that draws it only while that workspace is shown. Per-workspace copies were rejected: the workspaces stay mounted while hidden, so each would hold its own draft and its own undo, and four sets of controls would share ids.
- **What it means to use.** A connector of a recorded cut can be changed from Repair, Convert, Split & Connect or Surface Texture, wherever a piece of that cut is the piece in view. In the three that are not about the cut it is a collapsed section, so it adds one row to a panel whose primary action is elsewhere. Repairing or texturing a piece still ends the record, and the disclosure that says so is unchanged; editing the connectors first is now possible without going back to Split.
- **Defect found by driving it.** The section's open state was the section's own, and the section is absent for the moment after an apply while `joint/list` is read for the new revision. In Split (open by default) that was invisible; in the others the section returned collapsed with its Undo behind the heading. The state is now the editor's (`PanelSection` gained controlled `open` / `onOpenChange`) and the section is open while there is something to undo.
- **Not done.** No editor in a workspace with no attached cut, and none for a cut whose record has ended (the list says why). A pending Repair or Texture preview and a pending connector check exclude each other in the worker as every candidate does; the editor then shows the worker's sentence. Whole-browser footprint at the retention ceiling is still unmeasured.

## Stage EC-8 addendum — naming the cut's axes against the model's

- **Decision: the worker states directions, the page words them.** `cutFace.axes` is three unit vectors in the scene, from the retained interface frame and the linear part of the first piece's placement. The page never holds a frame, an interface or a transform to work this out, and it names nothing it was not told.
- **Honest naming.** An axis name is used only within 1° of an axis; between 1° and 20° the nearest axis is named with how far the direction is turned; beyond that the components are given. A tilted cut is never labelled as a plain axis.
- **The viewer's side is computed.** The picture has `u` to the right and `v` up; it is seen from the normal's side when u × v equals the normal and from the opposite side when it is reversed. No sentence uses top, front, back, left or right, which need a viewer the model does not state.
- **Judged by the files.** The browser spec moves a pin 5 mm across and 4 mm along and compares the exported displacement with the labelled directions, and the cross product's sign with the stated side.
- **Not done.** The labels are text on a flat picture; there is no marker in the 3D viewport tying a picture direction to the cut on the model. A cut whose outline is too large to draw has no picture, and so no labels. The viewport's own axes marker is the reference for X, Y and Z and is not shown while a thumbnail is captured.

## Not decided here

Persistence beyond the session; one pin size per joint versus several (the schema carries sizes per pin); the rebuild engine; the transaction; the page projection that replaces `connectorPairs`.
