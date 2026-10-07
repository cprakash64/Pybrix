# REPAIR-CORE-06B — the production Repair experience

Branch `repair-core-06b-repair-experience`, from `51c640f`. Not pushed, merged, deployed or tagged.
No repair geometry semantics changed: the 06A engine, its budgets and its outcomes are as qualified.

## What a user now gets

Import a broken model → the issue list shows what was detected → **Repair model** → honest stage
progress with **Cancel** → a **Preview** of the actual candidate → **Apply repairs** (or **Discard
preview**) → fresh diagnostics for the new revision → **Undo repair**.

Repair always asks for every qualified safe automatic capability. There is **no Local Repair
control** and no algorithm name on screen; the worker decides what it may do, and the production
budgets are the only budgets (a URL option can only narrow the work limit — see below).

## Audit of the existing UX (before changes)

The Repair workspace already had one derived action state (`RepairActionKind`), a sticky action
footer, a plan → candidate → commit → undo flow, change overlays from engine samples, and a result
card driven by the new revision's analysis. What assumed conservative repairs only:

- `repair-workspace-presentation.ts` — non-manifold vertices were hard-coded "Not automatically
  repairable"; the action was Ready only for conservative work or fillable openings;
  `describeAppliedChanges` listed only conservative counts (a local-only repair read "No changes").
- `use-conservative-repair.ts` / store — no local plan, no outcome, plan/candidate never asked for it.
- `create-change-overlays.ts` + `ViewportPanel` — four categories, all from conservative samples; a
  local repair would have been invisible in the viewport.
- The preview showed an engineering metrics table and operation counts, not fixed/remaining.
- Progress showed a percentage; "Cancel preview" labelled the discard; the workflow summary said
  "Conservative repair".

## State machine

The existing derived model is the repair-session state: `deriveRepairAction` over the store's plan,
candidate and commit slices (analysis → planning → ready → building → preview → applying →
undoing → nothing-safe / nothing-found), plus typed outcomes on the candidate. No parallel
booleans were added. Extended: _Ready_ also when the local plan has eligible pinched vertices.

## Preview = the candidate

The preview is derived from the candidate C and the exact S → C delta, never from operation labels:

- **Delta.** The worker returns `LocalRepairChange` (`geometry-runtime/local-repair.ts`) built from
  the patch the candidate was assembled from: exact totals (replaced, added, reversed) plus a
  bounded deterministic stride sample of at most 2,048 faces of each kind — removed/reversed as
  _source_ face indices (the page already holds that render snapshot), added faces as positions.
  The candidate itself never leaves the worker.
- **Overlay.** Two new categories — replaced triangles (current model only) and added triangles
  (candidate only) — and reversed faces merge into the existing orientation markers.
- **Large changes.** Totals are exact and never sampled; the controls say "showing N of M" when
  the drawn sample is smaller. Measured on the qualification models (production limits):

  | model | faces     | replaced | payload | generation | note                                   |
  | ----- | --------- | -------- | ------- | ---------- | -------------------------------------- |
  | X10   | 5,426     | 19       | 0.7 KB  | 0.1 ms     | small local repair                     |
  | X7    | 2,396     | 1,748    | 68 KB   | 0.8 ms     | medium                                 |
  | X15   | 32,642    | 750      | 29 KB   | 0.7 ms     | residual phase                         |
  | X12   | 471,462   | 2,956    | 80 KB   | 1.3 ms     | largest completed; sampled (truncated) |
  | D0    | 1,988,877 | 372      | 15 KB   | 0.8 ms     | 2 M-face part                          |

  Payload is bounded by the cap (≈ 90 KB worst case), independent of mesh size.

## Preview summary and outcome mapping

`state/repair-preview-summary.ts` (pure, tested) answers: what is fixed, what remains, how the
current model compares ("Current model" / "After repair", in issue **types**). Fixed and remaining
come from the two analyses the worker ran on exactly these two meshes; each category keeps its own
count and nothing is summed. Geometry edits ("19 triangles replaced") are secondary and are never
presented as issues fixed.

| typed outcome            | what the user sees                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| complete                 | "Ready to apply" (+ other detected issues remain, when they do)                                    |
| partial_unsupported      | "Some issues need manual repair"                                                                   |
| partial_limit            | "Part of this model can be repaired … too complex for this automatic repair pass"                  |
| partial_ambiguous        | "Some areas were left unchanged … could change the intended shape"                                 |
| no_change (issues exist) | neutral note: "Pybrix couldn't safely repair these issues automatically. Your model is unchanged." |
| nothing to repair        | "No repairable problems found." (distinct wording)                                                 |

Partial outcomes can be applied when a valid candidate exists, and none is styled as an error. A
no-safe-change result is a `role="status"` note, never `role="alert"`; real failures still alert.
`limitLikely` is advisory: one subtle line before Repair runs, never disabling, never changing an
outcome — the action function does not even receive it (tested).

## Progress, cancel, apply, undo

- Stage text from the one existing mapping (`runtime/repair-service.ts`) and an indeterminate bar:
  no percentage, because the engine does not know what remains. Cancel uses the 06A path; "Repair
  was cancelled. Nothing was changed." is neutral. No wall-clock timeout was added.
- Apply commits the previewed candidate (same handle), shows "Applying repairs…", then "Checking
  repaired model…" until the analysis of the new revision arrives; the result card, the Health line
  and the issue counts all read that analysis. Undo is the 06A exact Undo; fresh diagnostics return.
- "Cancel preview" is now "Discard preview", distinct from Cancel while work runs.

## Narrowing-only work limit (test seam)

`?repairWorkCeiling=N` can only make automatic repair stop sooner (the worker takes the smaller of
it and the production budget), mirroring `repairMemoryCeilingMiB`; the repair panel states it
whenever it is in force. It exists so the typed limit outcome can be exercised in a real browser
with a small model. There is no control for it.

## Behaviour change to existing coverage (disclosed)

Repair now separates pinched vertices and the fill stage closes the openings they become, so the
cube with 6 simple + 7 branched openings is repaired **completely** (13 filled, 7 vertices
repaired). Specs that encoded the old partial result were updated to assert the new truth, and use
a separate connected piece (`extraPiece`, which Repair reports and never repairs) for a stable
partial case. The timing spec's percentage arming was replaced with stage-text arming; its
threshold (`T_cancel < 0.8 · T_full`, saving > 300 ms) is unchanged.

## Verification and visual review

See the final report. Screenshots were reviewed at 1440×900 and 390×844 for: before, running,
preview, partial preview, after Apply, Undo; mobile running, partial preview and preview. The
review found the preview summary below the sticky actions; fixed by revealing the preview on mount.

## Remaining product debt

- The "Repair options" checkboxes (the four conservative operations and fill) remain; local repair
  has no row because it is not a user choice.
- Camera is never moved by repair; a "Focus changes" action was not added.
- Per-process browser memory peaks are not recorded by the existing harness.
