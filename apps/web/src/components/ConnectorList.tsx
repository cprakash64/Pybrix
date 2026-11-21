import type { ReactNode } from 'react';
import { JOINT_LIST_UNAVAILABLE, jointSummary } from '../state/connector-edit-presentation';
import { connectorPairsOf, currentJoints, jointsFor } from '../state/joint-presentation';
import type { LoadedModel } from '../state/model';
import { useWorkspaceState, useWorkspaceStore } from '../state/store-context';
import type { WorkspaceState } from '../state/workspace-store';

/**
 * THE CONNECTORS OF AN APPLIED SPLIT (Stage EC-4): what the worker says exists for this revision, and nothing the page remembered.
 *
 * A connector appears here only while the worker lists its cut as attached; a cut whose record has ended says so in words, and a list
 * that could not be read says that instead of showing an empty one. It offers selection, which highlights a connector on the model, and
 * no edit: this stage adds none, and the sentence "Connection 1" must not suggest otherwise.
 */
export function ConnectorList({
  assembly,
  model,
}: {
  /** The layout of the applied split, as the store holds it. */
  readonly assembly: NonNullable<WorkspaceState['assembly']>;
  readonly model: LoadedModel | undefined;
}): ReactNode {
  const { joints } = useWorkspaceState();
  const store = useWorkspaceStore();
  const jointList = currentJoints(joints, model?.handle);
  const pairs = connectorPairsOf(jointList);
  const status = jointsFor(joints, model?.handle)?.status;
  return (
    <>
      <h3>Connectors</h3>
      <p>
        {pairs.length
          ? assembly.connectorMode === 'manual'
            ? 'Paired'
            : 'Automatic'
          : !assembly.interfaces.length
            ? 'No new cut interface'
            : assembly.connectorMode === 'unavailable'
              ? 'Unavailable for this split'
              : 'Not added'}
      </p>
      {pairs.map((pair, index) => (
        <button
          key={pair.id}
          type="button"
          className="secondary-action"
          aria-pressed={assembly.selectedPairId === pair.id}
          onClick={() => {
            store.selectConnectorPair(assembly.selectedPairId === pair.id ? undefined : pair.id);
          }}
        >{`Connection ${String(index + 1)}: ${assembly.labels[pair.a] ?? 'Piece'} and ${assembly.labels[pair.b] ?? 'Piece'}`}</button>
      ))}
      {status === 'READY'
        ? jointList
            .filter((joint) => joint.status === 'RETIRED')
            .map((joint) => (
              <p key={joint.jointId} data-testid="joint-retired">
                {jointSummary(joint)}
              </p>
            ))
        : null}
      {status === 'UNAVAILABLE' ? (
        <p data-testid="joint-list-unavailable">{JOINT_LIST_UNAVAILABLE}</p>
      ) : null}
    </>
  );
}
