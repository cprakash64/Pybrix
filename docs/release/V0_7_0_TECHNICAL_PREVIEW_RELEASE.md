# Pybrix v0.7.0 Technical Preview

**Status:** prepared on branch `release-1-exploded-preview`; not deployed.

A UI-only release. It changes what Split shows and says. It changes no geometry,
no worker, no kernel, no transaction and no planner.

## The R5V4 build was already live under the v0.6.1 label

The R5V4 split build (closed-solid plane kernel, split-transaction recovery) went
live on 2026-11-14 while the interface still read `v0.6.1`. It was not
redeployed only to relabel it. v0.7.0 is the first release whose label differs
from the shipped build, so these notes cover that build retrospectively as well
as the changes below.

## What changed

- **The dovetail connector is no longer offered.** Its two halves could not be
  assembled, so a split that used one produced pieces that do not fit together.
  Split now offers None and round pins (one to four). The engine still names the
  kind internally; the interface can no longer request it.
- **Split Preview can be shown exploded.** An _Assembled | Exploded_ control
  appears over the viewport during a preview, using the same display-only layout
  as the applied result: piece A moves along the cut normal, piece B the other
  way. It changes only how the pieces are drawn. It does not change the model,
  its revision, the Undo history, Apply or any export, and the same layout is
  used after Apply.
- **The Checks line states what was done.** For a surface (open) cut it no
  longer says "Both pieces closed; cut faces capped"; it says the pieces are
  open surfaces and no cut face was added.
- **The connector placement note is accurate.** It said connectors are placed
  "inside its material". Pybrix checks that a connector sits within the cut face
  and away from its edges; it does not measure the wall behind it, and the note
  now says so.

## What did not change

Cut geometry, connector geometry and compatibility checks, the split
transaction, Apply, Undo and export are as in the live R5V4 build. Manual
connector sizes still ignore a part's placement scale; that is a known
limitation scheduled for a geometry release, not changed here.

## Rollback

A static switch back to the previous release directory. Nothing is stored or
migrated.
