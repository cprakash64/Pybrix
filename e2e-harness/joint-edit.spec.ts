import { revealControl } from '../e2e/progressive-disclosure';
import { expect, test } from '@playwright/test';
import { Fixture, digest, loadFixture, openHarness, readState } from './harness';
import type { Page } from '@playwright/test';

/*
 * Stage EC-3, IN CHROMIUM. A real split through the application leaves an editable joint in the worker; the connectors are then edited
 * through the production handlers, with the Booleans run by the nested Manifold worker exactly as in the product, and reversed by the
 * existing undo. The page never holds geometry here: it holds descriptors and identifiers, and the document is compared by the worker's
 * own digests.
 */
async function splitWithPin(page: Page): Promise<{ documentId: string; revision: number }> {
  await openHarness(page);
  await loadFixture(page, Fixture.SplitCubeMillimetre);
  await page.getByTestId('workflow-split').click();
  await expect(page.getByTestId('split-workspace')).toBeVisible();
  await revealControl(page, page.getByTestId('split-connector-pin'));
  await page.getByTestId('split-connector-pin').check();
  await page.getByTestId('split-preview').click();
  await expect(page.getByTestId('split-apply')).toBeEnabled({ timeout: 30000 });
  await page.getByTestId('split-apply').click();
  await expect.poll(async () => (await readState(page)).partCount).toBe(2);
  const state = await readState(page);
  return { documentId: state.documentId ?? '', revision: state.revision ?? 0 };
}

test('a split leaves a joint; editing its connectors in Chromium applies one revision and undo restores it exactly', async ({
  page,
}) => {
  const { documentId, revision } = await splitWithPin(page);
  const state = await readState(page);
  const before = await digest(page, state);
  const proof = await page.evaluate(
    async ({ documentId, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const listed = await api.listTestJoints(documentId, revision);
      const joint = listed[0];
      const connector = joint?.connector;
      if (joint === undefined || connector === undefined) throw new Error('no joint');
      const pin = connector.pins[0];
      if (pin === undefined) throw new Error('no pin');
      const edited = await api.editTestJoint(
        documentId,
        revision,
        joint.jointId,
        joint.specDigest ?? '',
        {
          kind: 'SET_CONNECTORS',
          maleSide: connector.maleSide,
          diameterMm: pin.diameterMm - 1,
          depthMm: pin.depthMm,
          clearanceMm: pin.clearanceMm,
          pins: [{ pinId: pin.pinId, u: pin.u, v: pin.v }],
        },
      );
      const afterDigest = await api.digest(documentId, edited.revision);
      const undoRevision = await api.undoTestEdit(documentId, edited.revision, edited.recordId);
      const restored = await api.digest(documentId, undoRevision);
      const restoredJoints = await api.listTestJoints(documentId, undoRevision);
      return { listed, edited, afterDigest, undoRevision, restored, restoredJoints };
    },
    { documentId, revision },
  );
  expect(proof.listed).toHaveLength(1);
  expect(proof.listed[0]?.status).toBe('ATTACHED');
  expect(proof.listed[0]?.pinCount).toBe(1);
  // one revision, the same two parts, different geometry, and the joint attached with the new connector
  expect(proof.edited.revision).toBe(revision + 1);
  expect(proof.edited.descriptors[0]?.status).toBe('ATTACHED');
  expect(proof.edited.descriptors[0]?.connector?.pins[0]?.diameterMm).toBe(
    (proof.listed[0]?.connector?.pins[0]?.diameterMm ?? 0) - 1,
  );
  expect(proof.afterDigest.parts.map((p) => p.partId)).toEqual(before.parts.map((p) => p.partId));
  expect(proof.afterDigest.parts.map((p) => p.positionDigest)).not.toEqual(
    before.parts.map((p) => p.positionDigest),
  );
  // undo: a new, higher revision holding the same geometry and the same joint
  expect(proof.undoRevision).toBe(proof.edited.revision + 1);
  expect(proof.restored.parts).toEqual(before.parts);
  expect(proof.restoredJoints[0]?.status).toBe('ATTACHED');
  expect(proof.restoredJoints[0]?.specDigest).toBe(proof.listed[0]?.specDigest);
});

test('a stale digest and an unknown joint are refused in Chromium, and nothing changes', async ({
  page,
}) => {
  const { documentId, revision } = await splitWithPin(page);
  const outcome = await page.evaluate(
    async ({ documentId, revision }) => {
      const api = window.cadfixerHarness;
      if (!api) throw new Error('Harness unavailable');
      const [joint] = await api.listTestJoints(documentId, revision);
      const connector = joint?.connector;
      if (joint === undefined || connector === undefined) throw new Error('no joint');
      const edit = {
        kind: 'SET_CONNECTORS' as const,
        maleSide: connector.maleSide,
        diameterMm: 2,
        depthMm: 4,
        clearanceMm: 0.2,
        pins: [{ pinId: 'pin-1', u: 0, v: 0 }],
      };
      const attempt = async (id: string, specDigest: string): Promise<string> => {
        try {
          await api.editTestJoint(documentId, revision, id, specDigest, edit);
          return 'applied';
        } catch (error) {
          return String((error as { details?: { code?: unknown } }).details?.code ?? error);
        }
      };
      return {
        stale: await attempt(joint.jointId, 'not-the-digest'),
        unknown: await attempt('no-such-joint', joint.specDigest ?? ''),
        after: await api.listTestJoints(documentId, revision),
      };
    },
    { documentId, revision },
  );
  expect(outcome.stale).toBe('JOINT_SPEC_STALE');
  expect(outcome.unknown).toBe('JOINT_UNKNOWN');
  expect(outcome.after[0]?.status).toBe('ATTACHED');
  expect((await readState(page)).revision).toBe(revision);
});
