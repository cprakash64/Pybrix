import type { JointDescriptor } from '@cadfixer/geometry-runtime';

/**
 * HOW THE CONNECTORS OF A CUT ARE WORDED (Stage EC-4). ALL OF IT, IN ONE FILE, as `repair-presentation.ts` and the others hold theirs:
 * a sentence written inline in a component is a bug in this product, because two screens drift and a state the worker can report
 * reaches one of them and not the other. Every switch is exhaustive with NO `default`, so a new retirement reason fails to compile until
 * someone has written its sentence.
 *
 * WHAT THIS FILE WILL NOT SAY. Nothing here claims a connector fits, holds, is strong, is secure or is printable: Pybrix checks where
 * material is and how thick it is around a connector, and nothing about use. And nothing here offers more than the editor can do: it
 * changes the SIZE of the connectors of a cut, their male side, and removes them. It does not move one or add one, and no sentence says
 * it does.
 */

/** Said BEFORE a repair or a fill is applied to a piece whose cut has connectors Pybrix can still edit. */
export const RETIRE_DISCLOSURE =
  'This piece has connectors recorded with its cut. Applying this keeps them in the model as plain geometry, and they can no longer be changed here. Undo brings the record back.';

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
      ? 'These connectors can no longer be changed here.'
      : `These connectors can no longer be changed here. ${retirementSentence(joint.reason)}`;
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

/* ------------------------------------------------------------- the editor -- */

export const CONNECTOR_EDIT_COPY = Object.freeze({
  section: 'Change connectors',
  intro:
    'Change the size of the connectors on this cut, swap which piece carries the pin, or take the connectors off. Where they sit does not change.',
  diameter: 'Pin diameter',
  depth: 'Depth',
  clearance: 'Clearance, per side',
  maleSide: 'Male side',
  maleSideGroup: 'Male connector side',
  check: 'Check change',
  checking: 'Checking the change…',
  cancelChecking: 'Cancel',
  apply: 'Apply change',
  applying: 'Applying the change…',
  discard: 'Cancel change',
  remove: 'Remove connectors',
  undo: 'Undo connector change',
  undoing: 'Undoing…',
  previewLabel: 'Preview — not applied',
  ready: 'The change passed Pybrix’s checks. Nothing has changed yet.',
  removeReady:
    'The connectors would come off both pieces, which would be left as the plain cut. Nothing has changed yet.',
  unchanged: 'Nothing differs from the connectors as they are.',
  applied: 'Connectors changed and checked',
  removed: 'Connectors removed and checked',
  undone: 'Connector change undone.',
  /** What the check was, and what it was not. The same sentence the split states for its own connectors. */
  qualifier:
    'That is a geometric check of the material around each connector, not a claim about strength, and Pybrix did not examine how the pieces go together.',
  nothingToChange: 'The connectors on this cut can no longer be changed here.',
});

/** The sentence for a refusal of an edit: ours for the refusals about the joint, the worker's own for the ones about the geometry. */
export function describeEditRefusal(code: unknown, workerMessage: string): string {
  switch (code) {
    case 'JOINT_SPEC_STALE':
      return 'The connectors changed since these values were shown. Review them and check again.';
    case 'JOINT_RETIRED':
      return 'These connectors can no longer be changed here.';
    case 'JOINT_UNKNOWN':
      return 'That cut is no longer in this model.';
    case 'JOINT_EDIT_NO_CHANGE':
      return CONNECTOR_EDIT_COPY.unchanged;
    case 'JOINT_EDIT_UNKNOWN_PIN':
    case 'JOINT_EDIT_MALFORMED':
      return 'That is not a change Pybrix can make.';
    default:
      // A refusal about the geometry (no room for the socket, too little material around it, a size out of range) has its sentence from
      // the engine's own mapper, one per cause, as the split's has.
      return workerMessage;
  }
}

const mm = (value: number): string => String(Number(value.toFixed(2)));

/** What a change to the size or the male side would do, in one sentence: only the values that differ are named. */
export function describeChange(
  before: JointDescriptor,
  after: JointDescriptor,
  sideLabel: (side: 'A' | 'B') => string,
): string {
  const was = before.connector;
  const now = after.connector;
  if (was === undefined || now === undefined) return CONNECTOR_EDIT_COPY.removeReady;
  const [a] = was.pins;
  const [b] = now.pins;
  if (a === undefined || b === undefined) return CONNECTOR_EDIT_COPY.ready;
  const parts: string[] = [];
  if (a.diameterMm !== b.diameterMm)
    parts.push(`pin diameter ${mm(a.diameterMm)} to ${mm(b.diameterMm)} mm`);
  if (a.depthMm !== b.depthMm) parts.push(`depth ${mm(a.depthMm)} to ${mm(b.depthMm)} mm`);
  if (a.clearanceMm !== b.clearanceMm)
    parts.push(`clearance ${mm(a.clearanceMm)} to ${mm(b.clearanceMm)} mm`);
  if (was.maleSide !== now.maleSide) parts.push(`the pin moves to ${sideLabel(now.maleSide)}`);
  return parts.length === 0
    ? CONNECTOR_EDIT_COPY.ready
    : `${parts.join('; ').replace(/^./, (c) => c.toUpperCase())}. ${CONNECTOR_EDIT_COPY.ready}`;
}
