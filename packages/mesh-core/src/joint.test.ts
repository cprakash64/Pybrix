import { describe, expect, it } from 'vitest';
import {
  jointedDocument,
  makePart,
  tetrahedronMesh,
  translation,
  FIXTURE_PIN_SPEC,
} from './document-fixtures';
import { partId, withPartMesh, withPartTransform, type GeometryDocument } from './document';
import {
  attachedJoints,
  jointAttachment,
  jointRetainedBytes,
  JointRetirement,
  liveJoints,
  MAX_JOINT_RETAINED_BYTES,
  MAX_RETIRED_JOINT_DESCRIPTORS,
  retireDetachedJoints,
  retiredJoints,
  type ConnectorJoint,
  type RetiredJoint,
} from './joint';
import { meshByteLength } from './mesh';
import { MAX_SUPPORTED_SPLIT_TRIANGLES } from './split-limits';

/*
 * Stage EC-1. A joint is usable while the parts hold exactly what it built, and "exactly" is object identity. Every test that
 * breaks one of the four conditions breaks ONLY that one, so the reason it reports is the reason that was broken.
 */
const A = partId('part-a');
const B = partId('part-b');

function only(document: GeometryDocument): ConnectorJoint {
  const [joint] = liveJoints(document);
  if (joint === undefined) throw new Error('expected a live joint');
  return joint;
}

describe('attachment is derived from the parts', () => {
  it('holds while both parts hold the built meshes, the built placements and the frame unit', () => {
    const { document, joint } = jointedDocument();
    expect(jointAttachment(document, joint)).toEqual({ attached: true });
    expect(attachedJoints(document)).toEqual([joint]);
  });

  it('a replaced mesh detaches it as GEOMETRY_CHANGED, though the document still carries the joint (the carry-forward hazard)', () => {
    const { document, joint } = jointedDocument();
    const repaired = withPartMesh(document, A, tetrahedronMesh(2));
    if (repaired === undefined) throw new Error('part missing');
    // `withPartMesh` spreads the previous document: the record is still there, and nothing stored says it is stale.
    expect(repaired.joints).toBe(document.joints);
    expect(jointAttachment(repaired, joint)).toEqual({
      attached: false,
      reason: JointRetirement.GeometryChanged,
    });
  });

  it('a byte-equal mesh that is a different object is still a change: identity, never content', () => {
    const { document, joint } = jointedDocument();
    const copy = tetrahedronMesh(2);
    expect([...copy.positions]).toEqual([...joint.a.builtMesh.positions]);
    const next = withPartMesh(document, A, copy);
    if (next === undefined) throw new Error('part missing');
    expect(jointAttachment(next, joint)).toEqual({
      attached: false,
      reason: JointRetirement.GeometryChanged,
    });
  });

  it('a changed placement detaches it as PLACEMENT_CHANGED', () => {
    const { document, joint } = jointedDocument();
    const moved = withPartTransform(document, B, translation(1, 0, 0));
    if (moved === undefined) throw new Error('part missing');
    expect(jointAttachment(moved, joint)).toEqual({
      attached: false,
      reason: JointRetirement.PlacementChanged,
    });
  });

  it('negative zero is the same placement as positive zero', () => {
    const { document, joint } = jointedDocument();
    const same = withPartTransform(document, A, [1, 0, 0, 0, 1, 0, 0, 0, 1, -0, 0, 0]);
    if (same === undefined) throw new Error('part missing');
    expect(jointAttachment(same, joint)).toEqual({ attached: true });
  });

  it('a removed part detaches it as PART_REMOVED', () => {
    const { document, joint } = jointedDocument();
    const without: GeometryDocument = {
      ...document,
      parts: document.parts.filter((p) => p.id !== B),
    };
    expect(jointAttachment(without, joint)).toEqual({
      attached: false,
      reason: JointRetirement.PartRemoved,
    });
  });

  it('a different document unit detaches it as UNIT_CHANGED, and a document that states none does too', () => {
    const { document, joint } = jointedDocument();
    expect(jointAttachment({ ...document, unit: 'inch' }, joint)).toEqual({
      attached: false,
      reason: JointRetirement.UnitChanged,
    });
    const unitless: GeometryDocument = { parts: document.parts, joints: document.joints ?? [] };
    expect(jointAttachment(unitless, joint)).toEqual({
      attached: false,
      reason: JointRetirement.UnitChanged,
    });
  });

  it('gives one reason when several apply: a missing part, then unit, then placement, then geometry', () => {
    const { document, joint } = jointedDocument();
    const everything: GeometryDocument = {
      unit: 'inch',
      parts: [makePart('part-a', tetrahedronMesh(9), { transform: translation(5, 5, 5) })],
    };
    expect(jointAttachment(everything, joint)).toEqual({
      attached: false,
      reason: JointRetirement.PartRemoved,
    });
    const both = [
      makePart('part-a', tetrahedronMesh(9), { transform: translation(5, 5, 5) }),
      makePart('part-b', tetrahedronMesh(9), { transform: translation(5, 5, 5) }),
    ];
    expect(jointAttachment({ unit: 'inch', parts: both }, joint)).toEqual({
      attached: false,
      reason: JointRetirement.UnitChanged,
    });
    expect(jointAttachment({ unit: 'millimeter', parts: both }, joint)).toEqual({
      attached: false,
      reason: JointRetirement.PlacementChanged,
    });
    const sameSpot = both.map((p, i) =>
      makePart(p.id, tetrahedronMesh(9), {
        transform: (i === 0 ? joint.a : joint.b).builtTransform,
      }),
    );
    expect(jointAttachment({ unit: 'millimeter', parts: sameSpot }, joint)).toEqual({
      attached: false,
      reason: JointRetirement.GeometryChanged,
    });
    expect(document.parts).toHaveLength(2);
  });
});

describe('retirement replaces a detached joint with a descriptor and frees what it held', () => {
  it('returns the very same document when every joint is still attached', () => {
    const { document } = jointedDocument();
    expect(retireDetachedJoints(document, 2)).toBe(document);
  });

  it('returns the very same document when it has no joints at all', () => {
    const plain: GeometryDocument = { parts: [makePart('p', tetrahedronMesh())] };
    expect(retireDetachedJoints(plain, 2)).toBe(plain);
    expect(retireDetachedJoints({ parts: plain.parts, joints: [] }, 2).joints).toEqual([]);
  });

  it('keeps the parts array by reference and holds no mesh of the joint afterwards', () => {
    const { document } = jointedDocument();
    const repaired = withPartMesh(document, A, tetrahedronMesh(2));
    if (repaired === undefined) throw new Error('part missing');
    const installed = retireDetachedJoints(repaired, 7);
    expect(installed).not.toBe(repaired);
    expect(installed.parts).toBe(repaired.parts);
    expect(liveJoints(installed)).toEqual([]);
    expect(retiredJoints(installed)).toEqual([
      {
        kind: 'retired-joint',
        jointId: 'document-1/joint/1',
        a: A,
        b: B,
        reason: JointRetirement.GeometryChanged,
        retiredAtRevision: 7,
        pinCount: 1,
      },
    ]);
    expect(jointRetainedBytes(installed)).toBe(0);
  });

  it('records a plain joint as zero pins', () => {
    const { document } = jointedDocument({ connector: undefined });
    const repaired = withPartMesh(document, A, tetrahedronMesh(2));
    if (repaired === undefined) throw new Error('part missing');
    expect(retiredJoints(retireDetachedJoints(repaired, 2))[0]?.pinCount).toBe(0);
  });

  it('is idempotent: a retired record is not retired again, and its revision does not move', () => {
    const { document } = jointedDocument();
    const repaired = withPartMesh(document, A, tetrahedronMesh(2));
    if (repaired === undefined) throw new Error('part missing');
    const once = retireDetachedJoints(repaired, 3);
    expect(retireDetachedJoints(once, 9)).toBe(once);
  });

  it('retires only the joint that changed and leaves a sibling attached and live', () => {
    const first = jointedDocument({ id: 'd/joint/1' });
    const meshC = tetrahedronMesh(4);
    const meshD = tetrahedronMesh(5);
    const c = makePart('part-c', meshC);
    const d = makePart('part-d', meshD);
    const second: ConnectorJoint = {
      ...first.joint,
      jointId: 'd/joint/2' as ConnectorJoint['jointId'],
      a: {
        partId: c.id,
        baseMesh: tetrahedronMesh(3.5),
        builtMesh: meshC,
        builtTransform: c.transform,
      },
      b: {
        partId: d.id,
        baseMesh: tetrahedronMesh(4.5),
        builtMesh: meshD,
        builtTransform: d.transform,
      },
    };
    const both: GeometryDocument = {
      unit: 'millimeter',
      parts: [...first.document.parts, c, d],
      joints: [first.joint, second],
    };
    const changed = withPartMesh(both, A, tetrahedronMesh(2));
    if (changed === undefined) throw new Error('part missing');
    const installed = retireDetachedJoints(changed, 4);
    expect(liveJoints(installed)).toEqual([second]);
    expect(retiredJoints(installed).map((r) => r.jointId)).toEqual(['d/joint/1']);
  });

  it('bounds the trail: the oldest descriptors go first and a live joint is never dropped', () => {
    const { document, joint } = jointedDocument();
    const retired: RetiredJoint[] = Array.from(
      { length: MAX_RETIRED_JOINT_DESCRIPTORS },
      (_, i) => ({
        kind: 'retired-joint',
        jointId: `old/${String(i)}` as RetiredJoint['jointId'],
        a: A,
        b: B,
        reason: JointRetirement.GeometryChanged,
        retiredAtRevision: 1,
        pinCount: 0,
      }),
    );
    const full: GeometryDocument = { ...document, joints: [...retired, joint] };
    const changed = withPartMesh(full, A, tetrahedronMesh(2));
    if (changed === undefined) throw new Error('part missing');
    const installed = retireDetachedJoints(changed, 5);
    const trail = retiredJoints(installed);
    expect(trail).toHaveLength(MAX_RETIRED_JOINT_DESCRIPTORS);
    expect(trail[0]?.jointId).toBe('old/1');
    expect(trail.at(-1)?.jointId).toBe('document-1/joint/1');
  });
});

describe('retained bytes are counted once per distinct mesh and never twice with a part', () => {
  it('is zero without joints', () => {
    expect(jointRetainedBytes({ parts: [makePart('p', tetrahedronMesh())] })).toBe(0);
  });

  it('charges an attached joint its two bases plus the authority, and not the built meshes a part already holds', () => {
    const { document, joint } = jointedDocument({ authorityBytes: 1000 });
    expect(jointRetainedBytes(document)).toBe(
      meshByteLength(joint.a.baseMesh) + meshByteLength(joint.b.baseMesh) + 1000,
    );
  });

  it('charges a base shared by both sides once', () => {
    const { document, joint } = jointedDocument();
    const shared = joint.a.baseMesh;
    const sharing: ConnectorJoint = { ...joint, b: { ...joint.b, baseMesh: shared } };
    expect(jointRetainedBytes({ ...document, joints: [sharing] })).toBe(meshByteLength(shared));
  });

  it('charges a base a sibling part already holds nothing', () => {
    const { document, joint } = jointedDocument();
    const withSibling: GeometryDocument = {
      ...document,
      parts: [...document.parts, makePart('part-c', joint.a.baseMesh)],
    };
    expect(jointRetainedBytes(withSibling)).toBe(meshByteLength(joint.b.baseMesh));
  });

  it('charges a detached live joint its stale built meshes too, because it still holds them', () => {
    const { document, joint } = jointedDocument();
    const changed = withPartMesh(document, A, tetrahedronMesh(2));
    if (changed === undefined) throw new Error('part missing');
    expect(jointRetainedBytes(changed)).toBe(
      meshByteLength(joint.a.baseMesh) +
        meshByteLength(joint.a.builtMesh) +
        meshByteLength(joint.b.baseMesh),
    );
  });

  it('has a ceiling derived from the split ceiling and not a number of its own', () => {
    expect(MAX_JOINT_RETAINED_BYTES).toBe(MAX_SUPPORTED_SPLIT_TRIANGLES * 52);
  });
});

describe('the fixture is the shape the tests claim', () => {
  it('names two different parts, a pin, and a base that is not the built mesh', () => {
    const { joint } = jointedDocument();
    expect(joint.a.partId).toBe(A);
    expect(joint.b.partId).toBe(B);
    expect(joint.connector).toBe(FIXTURE_PIN_SPEC);
    expect(joint.a.baseMesh).not.toBe(joint.a.builtMesh);
    expect(only(jointedDocument().document).kind).toBe('joint');
  });
});
