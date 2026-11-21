# Pybrix v0.8.0 Technical Preview

**Status:** a candidate; not deployed.

**Auto Split is not included in this v0.8.0 candidate while its semantic engine undergoes separate
requalification.** Split offers a manual plane cut with optional connectors.

**Deploying this candidate would remove Auto Split (Beta) from the public site.** The public site's bundle, read on
2026-11-21, contains the Auto Split (Beta) panel and is labelled v0.7.1, so it contains work this candidate does not.
Whether that removal is acceptable is a release decision, and this note does not make it.

Release 2 changes what a connector is. Until now a split wrote two plain parts and the pins and sockets were
baked in; nothing remained that could be changed. From v0.8.0 the connectors of a split can be changed
afterwards, and manual connector sizes mean what they say in millimetres.

## Connectors can be changed after a split

After a split is applied, the connector editor changes the cut without cutting again:

- **Size** of the pins (diameter, depth, clearance) and which piece carries the pin.
- **Position**: type a place, drag a connector on the drawing of the cut, or use the arrow keys.
- **Add** a connector (up to four) or **take them all off**, which leaves the plain cut.
- The cut is marked on the model while the editor is open, and the drawing names its axes against the
  model's.
- The editor is in every workspace, not only Split.

Every change is **checked before it is applied** and shown as `Preview — not applied`. A change the worker
refuses is explained in the worker's words and changes nothing. Applying is one step and **one Undo** puts the
earlier pieces back exactly (the same pieces, not a rebuild). There is no Redo and no multi-step history.

A change is rebuilt from the pieces as they were before the connectors, never by reversing a Boolean, and a
rebuild with unchanged settings is byte-identical to the original split.

The record is kept for the session only. It ends, and the editor says why, when either piece is changed by
something else, replaced, moved, rescaled or removed, or when the model's unit changes. Nothing is stored in
the file or on disk.

## Manual connector sizes are physical

A manual pin of 4 mm is 4 mm on the build plate, whatever unit the model's numbers are in and whatever uniform
scale the part is placed at. A model that states no unit (an STL) needs you to say how to read it before a pin
is sized; Pybrix does not guess. A placement a round pin cannot be sized for (for example a non-uniform scale)
is refused with a sentence that says why, and the model is unchanged. Mirrored placements are supported.

## Exports write what you see

- Exporting one part as STL or OBJ applies the part's placement, and a mirrored placement is written with its
  winding reversed, so the file's facing matches the model. The export says when it applied a placement.
- 3MF keeps the placement as stored.

## Also in this release: a second model is framed from its own bounds

This carries the fix first written for the v0.7.1 camera-fix candidate branch. Opening a different
model without refreshing no longer keeps the previous model's camera. Opening a model also forgets the previous
model's Assembled / Exploded choice and applied-split layout.

## Scale: what was measured, and what was not

The general split limit is **2,000,000 triangles** for a part. That limit is about the part's size. Editable
connectors have a smaller demonstrated range, because a connector is made by an exact cut that meters its own
processing and stops when that budget is spent. Measured on the shipped build, with closed test spheres:

- **About 1.5 million triangles: qualified.** A closed model of 1,499,400 triangles took a connector, kept an
  editable connector record, previewed and applied an edit, and undid it to byte-identical pieces, with memory
  steady across the cycle. This is the largest size at which the full editing workflow was run. It is a measured
  point and **not a stated maximum**: the source defines no limit there.
- **Between about 1.5 and 2.0 million triangles: may be refused.** Whether a closed model is cut depends on the model and
  on where the cut is, not on the triangle count alone. A 1,560,000-triangle test sphere was cut at its centre and was
  refused at a cut off-centre. A 1,999,396-triangle test sphere was refused at every position tried.
- **The refusal says so.** It reads "This operation is too large to process safely with the current limits. Try a
  smaller model or a simpler operation." It does not say the cut is unsafe or that moving it will help, because it does
  not judge the cut at all. Nothing changed and nothing was sent.
- **Memory at the 2,000,000-triangle retention boundary was not exercised.** The connector path reaches its work limit
  before a closed model that large can be cut, so the editable record that bound describes (99.2 MiB, as accounted in
  Node) was never held in the browser at that size. That ceiling is an accounting bound, and it is not claimed as passed.

## Known limitations

- **Connectors need a closed solid.** A model with open edges can be split as a plain cut only. A request for a
  connector on it is refused with "Choose None for this split." The owner's real test model (about 1.99 million
  triangles) is an open surface, so it supports plain splitting and not connector creation. Repairing a model first can
  help, but hole filling is limited to parts of 250,000 faces or fewer, so it does not apply to very large models.
- **Larger models can be refused while below the split limit.** See Scale above.
- **Pauses at large sizes.** On a closed model of about 1.5 million triangles the page stopped responding for
  4 to 6 seconds while importing, applying and undoing, on a test machine with 8 GiB of memory under load.
- **One failing automated check is inherited.** The "200% browser zoom" end-to-end test fails by a few pixels on the
  CI runner. It fails the same way on `main` before this change and passes when run locally; it is not fixed here.
- Connector positions are numbers on the cut and a drawing; there is no snapping or grid, and no symmetric
  placement or mirroring between the two pieces.
- The connector check is geometric (the material around each connector). It is not a claim about strength, and
  Pybrix does not examine how the pieces go together.
- Not examined: collisions between separate parts, self-intersection of a result, wall thickness.

## Rollback

A static switch back to the previous release directory. Nothing is stored or migrated.
