import {
  applyPartTransform,
  jointAttachment,
  meshByteLength,
  retiredJoints,
  type CanonicalMesh,
  type ConnectorJoint,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { jointSpecDigest } from './connector-rebuild';
import type { JointDescriptor } from './protocol';

/**
 * What the page may be told about the joints of a document. It is derived from the document, bounded, and free of geometry.
 *
 * Live records come first, in the document's order, then the retired trail. A live record that is no longer attached is reported
 * as retired with its reason and WITHOUT a revision, because it has not been installed yet; once the resident store installs the
 * document it becomes a retired descriptor and carries the revision it retired at.
 *
 * `retainedBytes` charges a mesh once across the whole listing, as `jointRetainedBytes` does, so the per-joint numbers add up to
 * the document's total and never exceed it.
 */
export function describeJoints(document: GeometryDocument): readonly JointDescriptor[] {
  const records = document.joints;
  if (records === undefined || records.length === 0) return [];
  const counted = new Set<CanonicalMesh>();
  for (const part of document.parts) counted.add(part.mesh);
  const descriptors: JointDescriptor[] = [];
  for (const record of records) {
    if (record.kind !== 'joint') continue;
    const attachment = jointAttachment(document, record);
    let retainedBytes = record.authority.retainedBytes;
    for (const side of [record.a, record.b])
      for (const mesh of [side.baseMesh, side.builtMesh]) {
        if (counted.has(mesh)) continue;
        counted.add(mesh);
        retainedBytes += meshByteLength(mesh);
      }
    descriptors.push(
      Object.freeze({
        jointId: record.jointId,
        aPartId: record.a.partId,
        bPartId: record.b.partId,
        status: attachment.attached ? ('ATTACHED' as const) : ('RETIRED' as const),
        ...(attachment.attached ? {} : { reason: attachment.reason }),
        pinCount: record.connector?.elements.length ?? 0,
        retainedBytes,
        ...(attachment.attached ? { specDigest: jointSpecDigest(record) } : {}),
        ...(attachment.attached && record.connector !== undefined
          ? {
              connector: {
                maleSide: record.connector.maleSide,
                axis: insertionAxisInScene(record),
                mmPerSceneUnit: record.frame.mmPerUnit,
                pins: record.connector.elements.map((pin) => ({
                  pinId: pin.pinId,
                  u: pin.site.u,
                  v: pin.site.v,
                  center: applyPartTransform(record.a.builtTransform, ...pin.site.local),
                  diameterMm: pin.diameterMm,
                  depthMm: pin.depthMm,
                  clearanceMm: pin.clearanceMm,
                })),
              },
            }
          : {}),
      }),
    );
  }
  for (const record of retiredJoints(document))
    descriptors.push(
      Object.freeze({
        jointId: record.jointId,
        aPartId: record.a,
        bPartId: record.b,
        status: 'RETIRED' as const,
        reason: record.reason,
        retiredAtRevision: record.retiredAtRevision,
        pinCount: record.pinCount,
        retainedBytes: 0,
      }),
    );
  return descriptors;
}

/**
 * Which way a pin points from the cut, in the scene's coordinates. The pin extends away from the cut along the cut's normal or against
 * it by male side, and the placement's LINEAR part (translation dropped) carries that direction into the scene; for a similarity, which
 * is the only placement a joint exists on, the result is the direction scaled and is normalised. Unit length, or the zero vector for a
 * degenerate placement, which no joint is made on.
 */
function insertionAxisInScene(joint: ConnectorJoint): readonly [number, number, number] {
  const sign = joint.connector?.maleSide === 'A' ? -1 : 1;
  const [nx, ny, nz] = joint.cutNormal;
  const t = joint.a.builtTransform;
  const linear: PartTransform = [t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8], 0, 0, 0];
  const [x, y, z] = applyPartTransform(linear, sign * nx, sign * ny, sign * nz);
  const length = Math.hypot(x, y, z);
  return length === 0 ? [0, 0, 0] : [x / length, y / length, z / length];
}
