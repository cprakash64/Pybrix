import {
  BoundsComparison,
  RepairAcceptance,
  RepairDecision,
  RepairOperation,
  RepairReason,
  RepairRegression,
  VolumeComparison,
  type RepairOperationDecision,
  type RepairValidation,
} from '@cadfixer/geometry-runtime';

/**
 * How conservative repair is worded for a user.
 *
 * FRAMEWORK-FREE ON PURPOSE, exactly like `topology-presentation.ts`. Every
 * phrase the repair interface shows is decided here and tested here, without a
 * DOM. Wording is a correctness concern in this product: the difference between
 * "refused" and "failed", or between "previewed" and "applied", is the
 * difference between a claim the engine supports and one it does not.
 *
 * THE FOUR RULES THIS FILE ENFORCES:
 *
 *   1. A REFUSAL IS NOT AN ERROR. `REFUSED_UNSAFE` and
 *      `BLOCKED_BY_PRECONDITION` are correct outcomes of a conservative engine
 *      doing its job. They are reported as decisions with reasons, never as
 *      failures.
 *   2. A PREVIEW IS NOT AN APPLICATION. Nothing here describes a candidate as
 *      having changed the model.
 *   3. RELATIVE WINDING IS NOT OUTWARD. Nothing here says a repaired model faces
 *      outward, because the engine deliberately never decides that — ADR 0010.
 *   4. AN ACCEPTED REPAIR IS NOT A PRINTABLE MODEL. Self-intersections and wall
 *      thickness remain unchecked, and every verdict says so.
 */

/**
 * Terms that must never appear in repair-derived interface text.
 *
 * Enforced by test against the strings this module produces. The first five are
 * inherited from topology presentation for the same reasons; the rest are the
 * claims a repair screen is specifically tempted to make.
 */
export const REPAIR_FORBIDDEN_TERMS: readonly string[] = [
  'hole', // a boundary loop may be an intended opening
  'printable', // needs self-intersection and thickness, neither checked
  'watertight', // implies a verified closed solid
  'valid mesh', // structural validity is a different, narrower claim
  'error free', // nothing here can establish that
  'fully repaired', // only a named subset of defects was even attempted
  'ready to print', // the strongest unearned claim of all
  'all errors fixed', // the engine fixes four things and refuses the rest
  'fix everything', // the same claim in the imperative
  'make printable', // the same claim as a promise
];

/* --------------------------------------------------------------- workflow -- */

/**
 * The workflow's name.
 *
 * "Conservative repair", not "Repair" and certainly not "Fix everything". The
 * adjective is load-bearing: this stage handles a specific, exactly-decidable
 * subset, and a name that promised more would be the first false claim on the
 * screen.
 */
export const REPAIR_WORKFLOW_TITLE = 'Conservative repair';

export const REPAIR_WORKFLOW_SUMMARY =
  'Removes exactly-identifiable redundant and degenerate triangles and makes neighbouring ' +
  'triangles agree on their winding. Every change is previewed and revalidated before it is ' +
  'applied, and anything that cannot be decided from the stored coordinates alone is refused.';

/**
 * What this workflow does NOT do, stated on screen rather than in a document.
 *
 * Part A2. A user who cannot find their defect in the operation list needs to
 * know whether CAD Fixer looked and refused, or never looked at all.
 */
export const REPAIR_EXCLUSIONS: readonly string[] = Object.freeze([
  'Merge vertices that are near each other but not identical. No tolerance is used anywhere in this workflow.',
  'Close boundary loops or openings in the surface. An opening may be exactly what the model is meant to have.',
  'Resolve non-manifold edges or vertices. They are reported, and they can block operations, but they are never rewritten.',
  'Detect or resolve self-intersections. Nothing in Pybrix checks for these yet.',
  'Decide which side of the surface is outside. Winding is made consistent relative to its neighbours, not turned outward.',
  'Determine whether a model will print. Wall thickness is not measured and self-intersections are not checked.',
]);

/**
 * The qualifier that follows every repair verdict.
 *
 * A separate REQUIRED constant rather than a suffix a caller may forget — the
 * same construction as `summariseTopology`, for the same reason.
 */
export const REPAIR_QUALIFIER = 'Self-intersections and wall thickness have not yet been checked.';

/**
 * Shown INSTEAD of the repair workflow when the browsing context cannot provide
 * an interruptible cancellation signal.
 *
 * WHY THE WORKFLOW DISAPPEARS RATHER THAN DEGRADING. Conservative repair's
 * contract includes stopping a repair that is already running. Without
 * cross-origin isolation there is no `SharedArrayBuffer`, so the only
 * cancellation left is a message the worker cannot read until its synchronous
 * pass has finished — a Cancel control that does nothing on precisely the large
 * models where a user reaches for it. Offering it would be the dishonest
 * interface this product forbids.
 *
 * It names the deployment fault because that is what it is: CAD Fixer's own
 * deployment requirements mandate COOP and COEP
 * (docs/DEPLOYMENT_REQUIREMENTS.md), so a context without them is misconfigured
 * rather than merely old. Import, analysis and export are unaffected and say so,
 * because losing repair should not read as losing the application.
 */
export const REPAIR_ISOLATION_HEADLINE = 'Repair is unavailable in this context';

export const REPAIR_ISOLATION_DETAIL =
  'Repair needs a cancellation signal it can act on while the work is running, which requires a cross-origin isolated page (COOP and COEP). This page is not cross-origin isolated, so Pybrix will not offer a repair it could not stop. Import, mesh analysis and export are unaffected.';

/* ------------------------------------------------------------- operations -- */

export interface RepairOperationCopy {
  readonly label: string;
  readonly help: string;
}

/**
 * One label and one sentence per operation, in the engine's own terms.
 *
 * Repeated-position and zero-area degeneracy stay SEPARATE, as they are in the
 * contract. They are different defects — a triangle with a duplicated corner
 * versus three distinct but exactly collinear corners — and merging them would
 * hide which one was actually removed.
 */
export const REPAIR_OPERATION_COPY: Readonly<Record<RepairOperation, RepairOperationCopy>> = {
  [RepairOperation.RemoveDuplicateFaces]: {
    label: 'Remove exact duplicate triangles',
    help: 'Extra triangles occupying the same three recovered vertices in the same rotational order. The first is kept; the redundant copies are removed. Reversed duplicates are never removed — they may describe a deliberate zero-thickness feature.',
  },
  [RepairOperation.RemoveRepeatedPositionFaces]: {
    label: 'Remove repeated-position triangles',
    help: 'Triangles with fewer than three distinct corners. They carry no surface and are removed only when removing them cannot open the surface or create a non-manifold edge.',
  },
  [RepairOperation.RemoveZeroAreaFaces]: {
    label: 'Remove exact zero-area triangles',
    help: 'Triangles whose three distinct corners are exactly collinear. Exactly, from the stored coordinates — no tolerance and no "nearly flat" judgement.',
  },
  [RepairOperation.UnifyWinding]: {
    label: 'Unify relative face winding',
    help: 'Makes neighbouring triangles traverse their shared edge in opposite directions, so the surface is consistently wound. The choice is RELATIVE: the lowest-numbered surviving triangle in each component keeps its orientation, and Pybrix never decides which side is outside.',
  },
};

/**
 * Operation order for display: the pipeline order the engine actually runs.
 *
 * Not alphabetical and not "applicable first". The list a user reads should be
 * the sequence the repair performs, because the earlier operations change what
 * the later ones see — duplicates are removed before winding is solved, and that
 * is why some winding refusals disappear once duplicates are gone.
 */
export const REPAIR_OPERATION_ORDER: readonly RepairOperation[] = Object.freeze([
  RepairOperation.RemoveDuplicateFaces,
  RepairOperation.RemoveRepeatedPositionFaces,
  RepairOperation.RemoveZeroAreaFaces,
  RepairOperation.UnifyWinding,
]);

/* --------------------------------------------------------------- decisions -- */

/**
 * How an operation's decision is CLASSIFIED for the interface.
 *
 * Deliberately not the same axis as severity. A refusal is a considered answer,
 * not a fault, and styling it as an error would teach users that a careful tool
 * is a broken one.
 */
export const RepairDecisionTone = {
  /** Will run if selected. */
  Available: 'available',
  /** Nothing to do, or not asked for. */
  Inactive: 'inactive',
  /** The engine considered it and declined. Not a fault. */
  Withheld: 'withheld',
} as const;

export type RepairDecisionTone = (typeof RepairDecisionTone)[keyof typeof RepairDecisionTone];

export interface RepairDecisionPresentation {
  readonly verdict: string;
  readonly tone: RepairDecisionTone;
  /** Why, in one sentence. Never left to the caller to invent. */
  readonly reason: string;
  /** True only when the user may choose to run it. */
  readonly selectable: boolean;
}

/**
 * The one place a machine decision becomes a sentence.
 *
 * CENTRALISED DELIBERATELY. Reason strings scattered across components drift:
 * two screens end up describing the same refusal differently, and a new reason
 * added to the contract reaches one of them and not the other. Here, an
 * unhandled reason is a compile error.
 */
export function presentDecision(entry: RepairOperationDecision): RepairDecisionPresentation {
  switch (entry.decision) {
    case RepairDecision.Applicable:
      return {
        verdict: 'Can be repaired conservatively',
        tone: RepairDecisionTone.Available,
        reason: describeApplicable(entry),
        selectable: true,
      };
    case RepairDecision.NotNeeded:
      return presentNotNeeded(entry);
    case RepairDecision.RefusedUnsafe:
      return {
        verdict: 'Not changed automatically',
        tone: RepairDecisionTone.Withheld,
        reason: describeReason(entry),
        selectable: false,
      };
    case RepairDecision.BlockedByPrecondition:
      return {
        verdict: 'Blocked by the model’s topology',
        tone: RepairDecisionTone.Withheld,
        reason: describeReason(entry),
        selectable: false,
      };
    case RepairDecision.Unsupported:
      return {
        verdict: 'Outside this repair mode',
        tone: RepairDecisionTone.Withheld,
        reason: describeReason(entry),
        selectable: false,
      };
  }
}

/**
 * `NOT_NEEDED` covers THREE genuinely different situations.
 *
 * "There is nothing to fix", "you did not ask for this", and "an earlier
 * operation in this plan already resolves it" are the same enum member but not
 * the same message. Collapsing them would leave a user who deselected an
 * operation staring at "no matching issue found" for a defect they can see in
 * Mesh Health — and, worse, would tell a user with three winding conflicts that
 * CAD Fixer found none, when what actually happened is that removing the
 * duplicate hiding them leaves the survivors consistently wound.
 *
 * That third case is real and reachable: winding is solved on the POST-REMOVAL
 * topology, so `targetedCount` counts what the SOURCE has while the decision
 * describes what will be LEFT.
 */
function presentNotNeeded(entry: RepairOperationDecision): RepairDecisionPresentation {
  if (entry.reason !== RepairReason.NotRequested) {
    return {
      verdict:
        entry.targetedCount > 0 ? 'Already resolved by this plan' : 'No matching issue found',
      tone: RepairDecisionTone.Inactive,
      reason:
        entry.targetedCount > 0
          ? `Analysis reports ${formatCount(entry.targetedCount, 'instance')} of this in your model, but the earlier operations in this plan resolve all of them — the triangles that survive leave nothing for this operation to do.`
          : 'Pybrix checked for this and found none.',
      selectable: true,
    };
  }
  return {
    verdict: 'Not selected',
    tone: RepairDecisionTone.Inactive,
    reason:
      entry.targetedCount > 0
        ? `This model has ${formatCount(entry.targetedCount, 'instance')}, but this operation is not selected. Select it to include it in the plan.`
        : 'This operation is not selected, and this model has nothing for it to act on.',
    selectable: true,
  };
}

function describeApplicable(entry: RepairOperationDecision): string {
  if (entry.operation === RepairOperation.UnifyWinding) {
    return `${formatCount(entry.targetedCount, 'edge')} disagree about winding. ${formatCount(entry.expectedFaceMutations, 'triangle')} would be reversed to make neighbours agree.`;
  }
  return `${formatCount(entry.targetedCount, 'instance')} found. ${formatCount(entry.expectedFaceMutations, 'triangle')} would be removed.`;
}

/**
 * The machine reason, in one sentence.
 *
 * Every member of `RepairReason` has a branch. The switch is exhaustive with no
 * default, so adding a reason to the contract and forgetting it here fails the
 * build rather than showing a user an empty explanation.
 */
export function describeReason(entry: RepairOperationDecision): string {
  switch (entry.reason) {
    case RepairReason.NoDefectPresent:
      return 'Pybrix checked for this and found none.';
    case RepairReason.NotRequested:
      return 'This operation is not selected, so it was left out of the plan.';
    case RepairReason.NonManifoldEdgePresent:
      return 'More than two triangles meet along at least one edge in this component. Relative winding cannot be assigned without choosing arbitrarily which pair of triangles are neighbours, so Pybrix leaves it unchanged.';
    case RepairReason.NonManifoldVertexPresent:
      return 'Triangles around at least one vertex in this component do not form a single continuous fan. Relative winding cannot be propagated across that pinch conservatively.';
    case RepairReason.NonOrientableComponent:
      return 'This component cannot be given one consistent set of face orientations. Any answer would require an arbitrary choice, so Pybrix makes none.';
    case RepairReason.RemovalIntroducesBoundary:
      return 'Removing these triangles would leave the surface open where it is currently closed. That is a change to the model’s shape, not a cleanup, so it is refused.';
    case RepairReason.RemovalIntroducesNonManifold:
      return 'Removing these triangles would create or worsen a non-manifold edge. That is a change to the model’s structure, not a cleanup, so it is refused.';
    case RepairReason.RemovalChangesComponents:
      return 'Removing these triangles would split or join connected pieces of the model, which conservative repair never does.';
    case RepairReason.RemovalIntroducesWindingConflict:
      return 'Removing these triangles would leave neighbouring triangles disagreeing about winding where they currently agree.';
    case RepairReason.DuplicatesSpanGroups:
      return 'Identical triangles occur in different mesh groups. Removing one would discard a group assignment the file records, so Pybrix leaves them unchanged.';
    case RepairReason.OperationNotImplemented:
      return 'This operation is not part of conservative repair.';
    case RepairReason.ResourceLimitExceeded:
      return 'This repair would need more memory than Pybrix’s safety limit allows on this device.';
  }
}

/* -------------------------------------------------------------- acceptance -- */

export interface RepairAcceptancePresentation {
  readonly headline: string;
  /** Always rendered with the headline. */
  readonly qualifier: string;
  readonly detail: string;
  /** True when a candidate exists and may be previewed and applied. */
  readonly previewable: boolean;
  /** True when returning to the selection and trying again could help. */
  readonly retryable: boolean;
}

/**
 * The verdict on a built candidate.
 *
 * NEVER "the model is now correct". The strongest thing said anywhere here is
 * that the requested defects improved and nothing else regressed, which is
 * exactly what the validator established and no more.
 */
export function presentAcceptance(
  acceptance: RepairAcceptance,
  regressions: readonly RepairRegression[] = [],
): RepairAcceptancePresentation {
  switch (acceptance) {
    case RepairAcceptance.Accepted:
      return {
        headline: 'Repair validated — not applied yet',
        qualifier: REPAIR_QUALIFIER,
        detail:
          'Pybrix re-analysed the proposed result and confirmed the selected issues improved and nothing else regressed. Nothing has changed yet: review the preview, then apply or discard it.',
        previewable: true,
        retryable: false,
      };
    case RepairAcceptance.NoOp:
      return {
        headline: 'Nothing to change',
        qualifier: REPAIR_QUALIFIER,
        detail:
          'The selected operations found nothing to do on this model, so no proposed result was built.',
        previewable: false,
        retryable: false,
      };
    case RepairAcceptance.RejectedRegression:
      return {
        headline: 'Proposed repair rejected',
        qualifier: REPAIR_QUALIFIER,
        detail: `Pybrix built a proposed result, re-analysed it, and refused it: ${listRegressions(regressions)} Your model is unchanged.`,
        previewable: false,
        retryable: true,
      };
    case RepairAcceptance.BlockedPrecondition:
      return {
        headline: 'Repair could not proceed',
        qualifier: REPAIR_QUALIFIER,
        detail:
          'A condition an operation depends on stopped holding partway through, so no proposed result was produced. Your model is unchanged.',
        previewable: false,
        retryable: true,
      };
    case RepairAcceptance.ResourceLimit:
      return {
        headline: 'Not enough memory for this repair',
        qualifier: REPAIR_QUALIFIER,
        detail: RESOURCE_LIMIT_DETAIL,
        previewable: false,
        retryable: false,
      };
    case RepairAcceptance.Cancelled:
      return {
        headline: 'Repair cancelled',
        qualifier: REPAIR_QUALIFIER,
        detail:
          'The repair was cancelled before a proposed result existed. Your model is unchanged and can be repaired again.',
        previewable: false,
        retryable: true,
      };
    case RepairAcceptance.InternalFailure:
      return {
        headline: 'Repair did not complete',
        qualifier: REPAIR_QUALIFIER,
        detail: 'Pybrix could not finish this repair. Your model is unchanged.',
        previewable: false,
        retryable: true,
      };
  }
}

/**
 * The resource-limit explanation.
 *
 * NOT A GENERIC FAILURE, and explicitly not an invitation to reload. The model
 * is intact, resident, viewable and exportable — telling the user to load it
 * again would suggest their file is the problem when the limit is ours.
 */
export const RESOURCE_LIMIT_DETAIL =
  'This repair needs more local memory than Pybrix’s current safety limit allows, so it was ' +
  'refused before anything was allocated. Your model is still loaded and can be viewed, ' +
  'analysed and exported as usual.';

function listRegressions(regressions: readonly RepairRegression[]): string {
  if (regressions.length === 0) return 'the result did not match what the plan predicted.';
  const described = [...new Set(regressions)].map((entry) => describeRegression(entry));
  return described.join(' ');
}

export function describeRegression(regression: RepairRegression): string {
  switch (regression) {
    case RepairRegression.NonFiniteCoordinate:
      return 'The result contained a coordinate that is not a finite number.';
    case RepairRegression.StructurallyInvalid:
      return 'The result did not pass structural validation.';
    case RepairRegression.BoundaryEdgesIncreased:
      return 'The surface would have been left open in places the plan did not predict.';
    case RepairRegression.NonManifoldEdgesIncreased:
      return 'The result had non-manifold edges the plan did not predict.';
    case RepairRegression.NonManifoldVerticesIncreased:
      return 'The result had more non-manifold vertices than the model started with.';
    case RepairRegression.WindingConflictsIncreased:
      return 'Winding disagreements did not end up where the plan predicted.';
    case RepairRegression.ReversedDuplicatesChanged:
      return 'Reversed duplicate triangles changed, and conservative repair must never touch them.';
    case RepairRegression.ComponentCountChanged:
      return 'The number of connected pieces changed in a way removals do not explain.';
    case RepairRegression.TargetDefectNotRemoved:
      return 'An issue the operation targeted was still present afterwards.';
    case RepairRegression.UnexpectedFaceCountChange:
      return 'The triangle count did not change by the number of triangles that were removed.';
    case RepairRegression.SurfaceAreaChanged:
      return 'The total surface area moved by more than the removed triangles account for.';
    case RepairRegression.CoordinateMoved:
      return 'A surviving vertex moved, and conservative repair never moves a coordinate.';
  }
}

/* ----------------------------------------------------------- change summary -- */

/**
 * How a before/after difference should READ.
 *
 * The distinction Part F1 exists for. Once a candidate is ACCEPTED, every
 * remaining difference was predicted by the validator and checked against the
 * candidate — including a boundary-edge count that went UP because two
 * coincident triangles were paired against each other and one has been removed.
 * Labelling that "3 new boundary errors" would be the interface inventing a
 * problem the engine explicitly reasoned about and allowed.
 */
export const DeltaMeaning = {
  /** No change. */
  Unchanged: 'unchanged',
  /** Changed, and the validator predicted and accepted this change. */
  Expected: 'expected',
  /** Changed, and the validator rejected the candidate because of it. */
  Regression: 'regression',
} as const;

export type DeltaMeaning = (typeof DeltaMeaning)[keyof typeof DeltaMeaning];

export interface RepairMetricRow {
  readonly key: string;
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly meaning: DeltaMeaning;
  /** Present only when the change deserves a sentence of its own. */
  readonly note?: string;
}

/**
 * The before/after table.
 *
 * Every row is shown even when it did not move, for the same reason Mesh Health
 * shows zeros: an absent row leaves the user wondering whether the check ran.
 */
export function buildMetricRows(validation: RepairValidation): readonly RepairMetricRow[] {
  const accepted = validation.acceptance === RepairAcceptance.Accepted;
  const { before, after } = validation;

  const row = (
    key: string,
    label: string,
    b: number,
    a: number,
    note?: string,
  ): RepairMetricRow => {
    const delta = a - b;
    const meaning =
      delta === 0
        ? DeltaMeaning.Unchanged
        : accepted
          ? DeltaMeaning.Expected
          : DeltaMeaning.Regression;
    return {
      key,
      label,
      before: b,
      after: a,
      delta,
      meaning,
      ...(note === undefined || delta === 0 ? {} : { note }),
    };
  };

  return [
    row('triangles', 'Triangles', before.sourceFaceCount, after.sourceFaceCount),
    row(
      'vertices',
      'Recovered vertices',
      before.topologicalVertexCount,
      after.topologicalVertexCount,
    ),
    row(
      'boundaryEdges',
      'Boundary edges',
      before.boundaryEdgeCount,
      after.boundaryEdgeCount,
      BOUNDARY_DELTA_NOTE,
    ),
    row(
      'nonManifoldEdges',
      'Non-manifold edges',
      before.nonManifoldEdgeCount,
      after.nonManifoldEdgeCount,
    ),
    row(
      'nonManifoldVertices',
      'Non-manifold vertices',
      before.nonManifoldVertexCount,
      after.nonManifoldVertexCount,
    ),
    row(
      'windingConflicts',
      'Winding conflicts',
      before.windingConflictEdgeCount,
      after.windingConflictEdgeCount,
    ),
    row(
      'duplicates',
      'Duplicate triangles',
      before.sameOrientationDuplicateCount,
      after.sameOrientationDuplicateCount,
    ),
    row(
      'reversedDuplicates',
      'Reversed duplicate triangles',
      before.reversedOrientationDuplicateCount,
      after.reversedOrientationDuplicateCount,
      'Reversed duplicates are never removed by conservative repair. This count should not move.',
    ),
    row(
      'repeatedPosition',
      'Repeated-position triangles',
      before.repeatedPositionFaceCount,
      after.repeatedPositionFaceCount,
    ),
    row('zeroArea', 'Zero-area triangles', before.zeroAreaFaceCount, after.zeroAreaFaceCount),
    row('components', 'Connected components', before.componentCount, after.componentCount),
  ];
}

/**
 * Why a boundary-edge count can legitimately RISE after a correct repair.
 *
 * Two coincident triangles pair each other's edges, so the surface looks closed
 * where it is actually doubled. Removing the redundant copy reveals the boundary
 * that was there all along. The engine predicts this exactly and checks the
 * candidate against the prediction — see docs/repair/REPAIR_ARCHITECTURE.md.
 */
export const BOUNDARY_DELTA_NOTE =
  'Removing a duplicate triangle can reveal boundary edges that the duplicate was hiding: two ' +
  'coincident triangles pair each other’s edges and look closed. Pybrix predicted this exact ' +
  'count before rebuilding and confirmed it afterwards.';

export function describeVolumeComparison(comparison: VolumeComparison): string {
  switch (comparison) {
    case VolumeComparison.Unchanged:
      return 'Unchanged';
    case VolumeComparison.ChangedByOrientation:
      return 'Changed because triangle orientation changed';
    case VolumeComparison.ChangedUnexpectedly:
      return 'Changed although no triangle was reversed';
    case VolumeComparison.NotInterpretable:
      return 'Not interpretable for this surface';
  }
}

export function describeVolumeComparisonHelp(comparison: VolumeComparison): string {
  switch (comparison) {
    case VolumeComparison.Unchanged:
      return 'The algebraic signed volume is the same before and after.';
    case VolumeComparison.ChangedByOrientation:
      return 'Signed volume is an algebraic sum over oriented triangles, so reversing triangles changes it by design. It says nothing about whether the model gained or lost material, and nothing about which side is outside.';
    case VolumeComparison.ChangedUnexpectedly:
      return 'Signed volume moved even though no triangle was reversed. This is recorded rather than ignored.';
    case VolumeComparison.NotInterpretable:
      return 'This surface is open or not consistently wound, so the algebraic sum is not a physical volume.';
  }
}

export function describeBoundsComparison(comparison: BoundsComparison): string {
  switch (comparison) {
    case BoundsComparison.Identical:
      return 'Unchanged';
    case BoundsComparison.ChangedExplainedByRemovedFaces:
      return 'Changed — explained by removed triangles';
    case BoundsComparison.ChangedUnexplained:
      return 'Changed — not explained by removed triangles';
    case BoundsComparison.NotComparable:
      return 'Not comparable';
  }
}

/* ------------------------------------------------------------- committing -- */

/**
 * Beneath the repair outcome (REPAIR-UX-04 decides the headline, in
 * `repair-workspace-presentation.ts`): what was done to the issues that were
 * selected, followed by the same qualifier as everywhere else. Not "fixed",
 * not "repaired successfully", and certainly nothing about printing.
 */
export const REPAIR_APPLIED_DETAIL = 'Selected topological issues were repaired and revalidated.';

export const NO_REPAIRS_AVAILABLE_HEADLINE = 'No safe automatic repairs are currently available.';

/**
 * Why there is nothing to offer.
 *
 * Two genuinely different situations, and the user needs to know which. Saying
 * only "nothing to do" would let someone with a torn model conclude it is fine.
 */
export function describeNoRepairsAvailable(hasRemainingDefects: boolean): string {
  return hasRemainingDefects
    ? 'This model still has topological issues, but none of them can be resolved from the stored ' +
        'coordinates alone. Resolving them needs assisted or reconstructive repair, which Pybrix ' +
        'does not offer yet. The operations above show what was checked and why each was ' +
        'left alone.'
    : 'The four operations above found nothing to act on. That covers exact duplicates, degenerate ' +
        'triangles and relative winding only — it is not a statement about the entire model.';
}

/* ------------------------------------------------------------- overlays --- */

/**
 * Sampling wording for change overlays.
 *
 * The viewport draws at most `sampleLimit` faces per category while the exact
 * count may be far larger. Saying so is the difference between a representative
 * picture and a false one.
 */
export function describeChangeSampling(drawn: number, exact: number): string | undefined {
  if (drawn >= exact) return undefined;
  return `Showing ${drawn.toLocaleString()} of ${exact.toLocaleString()} changes.`;
}

/* -------------------------------------------------------------- utilities -- */

function formatCount(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;
}

/* --------------------------------------------------- analysis dependency -- */

/**
 * Why conservative repair cannot be planned yet.
 *
 * FOUR GENUINELY DIFFERENT SITUATIONS, and the difference decides what a user
 * should do: "still running" needs patience, "cancelled" needs a click, "failed"
 * needs to know the model itself is still fine, and "no report for this version"
 * — the state immediately after a repair or an undo — needs neither.
 *
 * Lives here rather than in the panel for the reason every other sentence does:
 * one place decides the wording, and a state added to the analysis lifecycle
 * fails the build here instead of rendering an empty explanation.
 */
export function describeAnalysisDependency(state: AnalysisLifecycle, running: boolean): string {
  if (running || state === 'analyzing') {
    return 'Repair is planned from the topology report. Analysis is still running, so there is nothing to plan from yet.';
  }
  switch (state) {
    case 'cancelled':
      return 'Topology analysis was cancelled, so there is no report to plan a repair from. Run it again to continue.';
    case 'failed':
      return 'Topology analysis did not produce a report, so no repair can be planned. Your model is still loaded and can be viewed and exported.';
    case 'ready':
      // Ready, but not for THIS revision: the model moved on under the report.
      // The state a user meets immediately after applying or undoing a repair.
      return 'The topology report describes a different version of this model. A new analysis is needed before a repair can be planned.';
    case 'idle':
    case 'unavailable':
      return 'Repair is planned from the topology report. Analysis has not produced one for this version of the model yet.';
  }
}

/**
 * The analysis lifecycle as this module needs to know it.
 *
 * Restated structurally rather than imported from the store, so the presentation
 * layer stays free of the state container — the same separation `topology-
 * presentation.ts` keeps. `AnalysisState` is assignable to it, which is what
 * makes the switch above exhaustive against the real lifecycle.
 */
export type AnalysisLifecycle =
  'unavailable' | 'idle' | 'analyzing' | 'ready' | 'failed' | 'cancelled';
