# ADR 0033 — Editable connector model

Status: accepted for Stage EC-1 (model, lifecycle, accounting). Later stages are proposed, not accepted. Supplements ADR 0014 (multi-part document), ADR 0011 (undo) and ADR 0032 (export placement).

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

## Not decided here

Persistence beyond the session; one pin size per joint versus several (the schema carries sizes per pin); the rebuild engine; the transaction; the page projection that replaces `connectorPairs`.
