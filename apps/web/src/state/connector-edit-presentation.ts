import type { JointDescriptor } from '@cadfixer/geometry-runtime';

/**
 * HOW THE CONNECTORS OF A CUT ARE WORDED (Stage EC-4). ALL OF IT, IN ONE FILE, as `repair-presentation.ts` and the others hold theirs:
 * a sentence written inline in a component is a bug in this product, because two screens drift and a state the worker can report
 * reaches one of them and not the other. Every switch is exhaustive with NO `default`, so a new retirement reason fails to compile until
 * someone has written its sentence.
 *
 * WHAT THIS FILE WILL NOT SAY. Nothing here claims a connector fits, holds, is strong, is secure or is printable: Pybrix checks where
 * material is and how thick it is around a connector, and nothing about use. And nothing here offers or promises an edit, because this
 * stage adds no control to make one: a sentence that did would describe a feature that does not exist.
 */

/** Said BEFORE a repair or a fill is applied to a piece whose cut has connectors Pybrix can still edit. */
export const RETIRE_DISCLOSURE =
  'This piece has connectors recorded with its cut. Applying this keeps them in the model as plain geometry and ends that record. Undo brings the record back.';

/** The same, for a piece whose cut was recorded with no connectors: the loss is smaller and says so. */
export const RETIRE_DISCLOSURE_PLAIN_CUT =
  'This piece is one side of a recorded cut. Applying this ends that record, and the cut itself is unchanged. Undo brings the record back.';

export const JOINT_LIST_UNAVAILABLE = 'The connectors of this model could not be listed.';

/**
 * Why a record can no longer be edited, in a sentence. The reasons are the worker's, named by the descriptor's own type: the page imports
 * no value from the model, so a new reason fails to compile here instead of reaching a user as nothing.
 */
export function retirementSentence(reason: NonNullable<JointDescriptor['reason']>): string {
  switch (reason) {
    case 'GEOMETRY_CHANGED':
      return 'A piece changed after the connectors were made.';
    case 'PART_REMOVED':
      return 'A piece of this cut is no longer in the model.';
    case 'PLACEMENT_CHANGED':
      return 'A piece was moved after the connectors were made.';
    case 'UNIT_CHANGED':
      return 'The model now states a different unit from the one the connectors were sized in.';
  }
}

/** One line for one recorded cut: what it holds, and when it can no longer be edited, why. */
export function jointSummary(joint: JointDescriptor): string {
  if (joint.status === 'RETIRED')
    return joint.reason === undefined
      ? 'The record of these connectors has ended.'
      : `The record of these connectors has ended. ${retirementSentence(joint.reason)}`;
  if (joint.pinCount === 0) return 'A cut with no connectors.';
  return joint.pinCount === 1
    ? '1 connector recorded.'
    : `${String(joint.pinCount)} connectors recorded.`;
}

/** The disclosure that applies to a repair or a fill of `partId`, or `undefined` when no recorded cut is touched. */
export function disclosureFor(
  joints: readonly JointDescriptor[],
  partId: string,
): string | undefined {
  const touched = joints.filter(
    (joint) =>
      joint.status === 'ATTACHED' && (joint.aPartId === partId || joint.bPartId === partId),
  );
  if (touched.length === 0) return undefined;
  return touched.some((joint) => joint.pinCount > 0)
    ? RETIRE_DISCLOSURE
    : RETIRE_DISCLOSURE_PLAIN_CUT;
}
