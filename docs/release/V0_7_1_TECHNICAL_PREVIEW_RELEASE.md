# Pybrix v0.7.1 Technical Preview

**Status:** a candidate on branch `release-1.1-owner-acceptance-fixes`; not deployed. The live site is
v0.7.0.

Two defects found in owner acceptance of v0.7.0 are corrected. Nothing about connectors, the split
transaction, Apply, Undo or export changes.

## A second model is framed from its own bounds

Opening a different model without refreshing the page kept the previous model's camera whenever the Split
workspace was open, so the new model could appear tiny or out of view. The camera is now fitted once for
each newly opened document and is never moved by anything else: not by a re-render, a preview, Exploded or
Assembled, choosing a part, or any control. A preview or an applied split of the same document keeps the
view you cut from, as before. Opening a model also forgets the previous model's Assembled / Exploded
choice and applied-split layout.

## Auto Split says what it found, and shows it

- **Parts recognized.** The list counts the parts the part-finding service named. That is not a count of
  splits that exist.
- **Located or not.** Each part says whether it was tied to the model's own faces. **Show part** marks the
  surface the service outlined, as seen from six views. It is approximate, needs no split, changes nothing
  in your model and does not move the camera. A part that could not be located offers nothing to show and
  says that is not a finding about splitting.
- **Plain states.** _Built into the body_ (it is part of one connected shell), _No cut suggested_ (nothing
  was proposed, so nothing was checked), _Couldn't isolate this part reliably_, and _No safe split found_,
  which now means a cut was proposed and judged unsafe.
- **Large models.** On a model of 250,000 triangles or more, previewing a part used to spend the whole
  analysis' allowance, and every later part was refused as "No safe split found" without being examined.
  Each part you preview now gets its own bounded check, exactly as large as before. Nothing was raised.

## What did not change

Auto Split's request, its limits, the 2,000,000-triangle ceiling, its disclosure and its privacy are as in
v0.7.0. A part-finding answer the service cannot use is still reported as that; this release does not
change how answers are validated. The live v0.7.0 Auto Split can intermittently reject a service answer
(`PROVIDER_INVALID_RESPONSE`); that is a separate issue, not addressed here.

## Rollback

A static switch back to the previous release directory. Nothing is stored or migrated.
