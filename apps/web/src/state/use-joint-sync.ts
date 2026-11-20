import { useEffect } from 'react';
import type { JointDescriptor } from '@cadfixer/geometry-runtime';
import { AppErrorCode, toAppError } from '@cadfixer/shared';
import { useGeometryClient } from '../runtime/client-context';
import { useWorkspaceState, useWorkspaceStore } from './store-context';
import { StatusSeverity } from './workspace-store';

/**
 * KEEPS THE PAGE'S VIEW OF THE CONNECTOR JOINTS IN STEP WITH THE WORKER (Stage EC-4).
 *
 * The worker owns every joint, and it can change them at any revision: a split records one, a repair or a fill retires one, an undo
 * brings one back. So the page asks, once, for each revision it comes to hold. That single rule is the whole synchronisation: there is
 * no list of operations that "affect joints" to keep in agreement with the operations that do, which is how the page's own record of the
 * connectors used to drift from the geometry it described.
 *
 * A READ. It changes no document, takes no ticket and never blocks an operation; a list that arrives for a revision the model has left is
 * refused by the store and dropped, because it describes a document the user is no longer looking at.
 *
 * A FAILURE IS NOT SILENT AND IS NOT AN EMPTY LIST. A list that could not be read leaves the slice `UNAVAILABLE`, which the inspector says
 * in words; reading it as "no connectors" would tell a user their connectors were gone.
 */
export function useJointSync(): void {
  const store = useWorkspaceStore();
  const client = useGeometryClient();
  const { model } = useWorkspaceState();
  const handle = model?.handle;
  const documentId = handle?.documentId;
  const revision = handle?.revision;

  useEffect(() => {
    if (client === undefined || documentId === undefined || revision === undefined) return;
    const asked = { documentId, revision };
    // The operation's own handle is not cancelled on cleanup: a read is cheap, and the store drops an answer for a revision that has
    // moved on, so there is nothing to protect by interrupting it.
    client.listJoints(asked).promise.then(
      (result) => {
        const joints: readonly JointDescriptor[] = result.joints;
        store.setJoints({ status: 'READY', ...asked, joints });
      },
      (cause: unknown) => {
        const error = toAppError(cause);
        // A worker that ended is reported where it is noticed; a second line about connectors would only repeat it.
        if (error.code === AppErrorCode.OperationCancelled) return;
        const installed = store.setJoints({ status: 'UNAVAILABLE', ...asked });
        if (installed)
          store.pushStatus(
            StatusSeverity.Warning,
            `The connectors of this model could not be listed: ${error.message}`,
          );
      },
    );
  }, [client, documentId, revision, store]);
}
