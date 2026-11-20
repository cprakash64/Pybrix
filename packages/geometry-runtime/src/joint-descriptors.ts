import {
  jointAttachment,
  meshByteLength,
  retiredJoints,
  type CanonicalMesh,
  type GeometryDocument,
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
                pins: record.connector.elements.map((pin) => ({
                  pinId: pin.pinId,
                  u: pin.site.u,
                  v: pin.site.v,
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
