# Pybrix v0.8.0 Technical Preview

**Status:** a candidate; not deployed. The live site is v0.7.0. This branch does not contain Auto Split (Beta);
v0.7.0 does not offer it either, so nothing the live site has is removed.

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

This carries the fix first written for the v0.7.1 candidate, which was never released. Opening a different
model without refreshing no longer keeps the previous model's camera. Opening a model also forgets the previous
model's Assembled / Exploded choice and applied-split layout.

## Known limitations

- **Connectors need a closed solid.** A model with open edges can be split as a plain cut only. A request for a
  connector on it is refused with "Choose None for this split." Repairing the model first can help; hole filling
  is limited to parts of 250,000 faces or fewer, so it does not apply to very large models.
- **Very large closed models can be refused.** The cut's exact work budget refuses some closed models well
  before the 2,000,000-triangle limit: a test sphere cut at 1,499,400 triangles and was refused at 1,560,000.
  The message reads "This cut can't be made safely. Try moving the cut or choose another part", but for this
  refusal moving the cut does not help. A joint is only kept for a split that succeeds, so a connector can be
  edited only on models the cut accepts.
- **Pauses at large sizes.** On a closed model of about 1.5 million triangles the page stopped responding for
  4 to 6 seconds while importing, applying and undoing, on a test machine with 8 GiB of memory under load.
- Connector positions are numbers on the cut and a drawing; there is no snapping or grid, and no symmetric
  placement or mirroring between the two pieces.
- The connector check is geometric (the material around each connector). It is not a claim about strength, and
  Pybrix does not examine how the pieces go together.
- Not examined: collisions between separate parts, self-intersection of a result, wall thickness.

## Rollback

A static switch back to the previous release directory. Nothing is stored or migrated.
