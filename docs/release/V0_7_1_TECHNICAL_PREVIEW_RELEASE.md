# Pybrix v0.7.1 Technical Preview

**Status:** a candidate; not deployed. The live site is v0.7.0.

A defect found in owner acceptance of v0.7.0 is corrected: a second model was not framed from its own
bounds. This branch does not contain Auto Split (Beta); that work is carried separately.

## A second model is framed from its own bounds

Opening a different model without refreshing the page kept the previous model's camera whenever the Split
workspace was open, so the new model could appear tiny or out of view. The camera is now fitted once for
each newly opened document and is never moved by anything else: not by a re-render, a preview, Exploded or
Assembled, choosing a part, or any control. A preview or an applied split of the same document keeps the
view you cut from, as before. Opening a model also forgets the previous model's Assembled / Exploded
choice and applied-split layout.

## Rollback

A static switch back to the previous release directory. Nothing is stored or migrated.
