import { describe, expect, it } from 'vitest';
import { jointedDocument, makePart, tetrahedronMesh, FIXTURE_PIN_SPEC } from './document-fixtures';
import { validateGeometryDocument, DocumentValidationCode } from './document-validation';
import {
  jointId,
  JointRetirement,
  MAX_PINS_PER_JOINT,
  MAX_RETIRED_JOINT_DESCRIPTORS,
} from './joint';
import type { ConnectorJoint, JointConnectorSpec, JointPin, RetiredJoint } from './joint';
import type { GeometryDocument } from './document';
import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';

/*
 * Stage EC-1. The document gate learns what a joint is. Tests assert the CODES, never the sentences, and each breaks exactly one
 * thing in an otherwise valid document, so a code that fires is the code for what was broken.
 */
function codes(document: GeometryDocument, validateMeshes = false): string[] {
  return [
    ...new Set(validateGeometryDocument(document, { validateMeshes }).issues.map((i) => i.code)),
  ];
}
function withJoint(change: Partial<ConnectorJoint>): GeometryDocument {
  const { document, joint } = jointedDocument();
  return { ...document, joints: [{ ...joint, ...change }] };
}
function withSpec(elements: readonly JointPin[], maleSide: 'A' | 'B' = 'A'): GeometryDocument {
  const spec: JointConnectorSpec = { ...FIXTURE_PIN_SPEC, maleSide, elements };
  return withJoint({ connector: spec });
}
const PIN: JointPin = {
  pinId: 'pin-1',
  site: { u: 0, v: 0, local: [0, 0, 0] },
  diameterMm: 4,
  depthMm: 6,
  clearanceMm: 0.2,
};

describe('a valid jointed document', () => {
  it('passes, attached or plain, with the sites it is given', () => {
    expect(codes(jointedDocument().document, true)).toEqual([]);
    expect(codes(jointedDocument({ connector: undefined }).document, true)).toEqual([]);
    expect(codes(withSpec([{ ...PIN, site: { u: 1.5, v: -2, local: [1, 2, 3] } }]))).toEqual([]);
    expect(
      codes(
        withSpec(
          Array.from({ length: MAX_PINS_PER_JOINT }, (_, i) => ({
            ...PIN,
            pinId: `pin-${String(i + 1)}`,
          })),
        ),
      ),
    ).toEqual([]);
  });

  it('is unchanged for a document with no joints', () => {
    expect(codes({ parts: [makePart('p', tetrahedronMesh())] }, true)).toEqual([]);
  });
});

describe('a joint that contradicts itself is refused', () => {
  it('rejects an empty identifier', () => {
    expect(codes(withJoint({ jointId: jointId('') }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
  });
  it('rejects one part on both sides', () => {
    const { joint } = jointedDocument();
    expect(codes(withJoint({ b: { ...joint.b, partId: joint.a.partId } }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
  });
  it('rejects a side with an unusable placement', () => {
    const { joint } = jointedDocument();
    const broken = [...joint.a.builtTransform];
    broken[3] = Number.NaN;
    expect(
      codes(
        withJoint({
          a: { ...joint.a, builtTransform: broken as unknown as typeof joint.a.builtTransform },
        }),
      ),
    ).toContain(DocumentValidationCode.JointMalformed);
  });
  it.each([
    ['an unrecognised unit', { unit: 'parsec' as unknown as 'millimeter' }],
    ['a zero scale', { placementScale: 0 }],
    ['a non-finite factor', { mmPerUnit: Number.POSITIVE_INFINITY }],
    ['a negative size per coordinate', { mmPerCoordinate: -1 }],
  ])('rejects %s in the frame', (_label, change) => {
    const { joint } = jointedDocument();
    expect(codes(withJoint({ frame: { ...joint.frame, ...change } }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
  });
  it('rejects an authority with no identity or an impossible size', () => {
    const { joint } = jointedDocument();
    expect(codes(withJoint({ authority: { ...joint.authority, provenanceSHA: '' } }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
    expect(codes(withJoint({ authority: { ...joint.authority, retainedBytes: -1 } }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
    expect(codes(withJoint({ authority: { ...joint.authority, retainedBytes: 1.5 } }))).toContain(
      DocumentValidationCode.JointMalformed,
    );
  });
  it('rejects two records with one identifier', () => {
    const { document, joint } = jointedDocument();
    expect(codes({ ...document, joints: [joint, joint] })).toContain(
      DocumentValidationCode.JointDuplicateId,
    );
  });
});

describe('a connector outside the model is refused', () => {
  it('rejects no pins and too many pins', () => {
    expect(codes(withSpec([]))).toContain(DocumentValidationCode.JointConnectorMalformed);
    const many = Array.from({ length: MAX_PINS_PER_JOINT + 1 }, (_, i) => ({
      ...PIN,
      pinId: `pin-${String(i + 1)}`,
    }));
    expect(codes(withSpec(many))).toContain(DocumentValidationCode.JointConnectorMalformed);
  });
  it('rejects a repeated or empty pin identifier', () => {
    expect(codes(withSpec([PIN, PIN]))).toContain(DocumentValidationCode.JointConnectorMalformed);
    expect(codes(withSpec([{ ...PIN, pinId: '' }]))).toContain(
      DocumentValidationCode.JointConnectorMalformed,
    );
  });
  it.each<readonly [string, Partial<JointPin>]>([
    ['a zero diameter', { diameterMm: 0 }],
    ['a negative depth', { depthMm: -1 }],
    ['a non-finite depth', { depthMm: Number.NaN }],
    ['a negative clearance', { clearanceMm: -0.1 }],
    ['a non-finite clearance', { clearanceMm: Number.POSITIVE_INFINITY }],
    ['a non-finite u', { site: { u: Number.NaN, v: 0, local: [0, 0, 0] } }],
    ['a non-finite local point', { site: { u: 0, v: 0, local: [0, Number.POSITIVE_INFINITY, 0] } }],
    [
      'a local point of the wrong length',
      { site: { u: 0, v: 0, local: [0, 0] as unknown as [number, number, number] } },
    ],
  ])('rejects %s', (_label, change) => {
    expect(codes(withSpec([{ ...PIN, ...change }]))).toContain(
      DocumentValidationCode.JointConnectorMalformed,
    );
  });
  it('accepts a zero clearance', () => {
    expect(codes(withSpec([{ ...PIN, clearanceMm: 0 }]))).toEqual([]);
  });
  it('rejects a male side that is neither A nor B', () => {
    expect(codes(withSpec([PIN], 'C' as unknown as 'A'))).toContain(
      DocumentValidationCode.JointConnectorMalformed,
    );
  });
});

describe('one part belongs to at most one attached joint', () => {
  it('rejects two attached joints over one part', () => {
    const { document, joint } = jointedDocument();
    const c = makePart('part-c', tetrahedronMesh(6));
    const second: ConnectorJoint = {
      ...joint,
      jointId: jointId('d/joint/2'),
      b: {
        partId: c.id,
        baseMesh: tetrahedronMesh(5.5),
        builtMesh: c.mesh,
        builtTransform: c.transform,
      },
    };
    const doc: GeometryDocument = {
      ...document,
      parts: [...document.parts, c],
      joints: [joint, second],
    };
    expect(codes(doc)).toContain(DocumentValidationCode.JointPartShared);
  });
  it('does not count a joint that is no longer attached or one that is retired', () => {
    const { document, joint } = jointedDocument();
    const c = makePart('part-c', tetrahedronMesh(6));
    const stale: ConnectorJoint = {
      ...joint,
      jointId: jointId('d/joint/2'),
      // names part-a on a side, but over a mesh part-a no longer holds
      a: { ...joint.a, builtMesh: tetrahedronMesh(7) },
      b: {
        partId: c.id,
        baseMesh: tetrahedronMesh(5.5),
        builtMesh: c.mesh,
        builtTransform: c.transform,
      },
    };
    const retired: RetiredJoint = {
      kind: 'retired-joint',
      jointId: jointId('d/joint/3'),
      a: joint.a.partId,
      b: joint.b.partId,
      reason: JointRetirement.GeometryChanged,
      retiredAtRevision: 2,
      pinCount: 1,
    };
    const doc: GeometryDocument = {
      ...document,
      parts: [...document.parts, c],
      joints: [joint, stale, retired],
    };
    expect(codes(doc)).not.toContain(DocumentValidationCode.JointPartShared);
  });
});

describe('what a document may retain is bounded', () => {
  it('refuses retained bytes above the ceiling', () => {
    const { document, joint } = jointedDocument();
    const huge: ConnectorJoint = {
      ...joint,
      authority: { ...joint.authority, retainedBytes: 2 ** 40 },
    };
    expect(codes({ ...document, joints: [huge] })).toContain(
      DocumentValidationCode.JointRetentionTooLarge,
    );
  });
  it('refuses a trail longer than the cap', () => {
    const { document } = jointedDocument();
    const trail: RetiredJoint[] = Array.from(
      { length: MAX_RETIRED_JOINT_DESCRIPTORS + 1 },
      (_, i) => ({
        kind: 'retired-joint',
        jointId: jointId(`old/${String(i)}`),
        a: document.parts[0]?.id ?? ('x' as RetiredJoint['a']),
        b: document.parts[1]?.id ?? ('y' as RetiredJoint['b']),
        reason: JointRetirement.PartRemoved,
        retiredAtRevision: 1,
        pinCount: 0,
      }),
    );
    expect(codes({ ...document, joints: trail })).toContain(DocumentValidationCode.TooManyJoints);
  });
});

describe('a retired descriptor must be one the model can describe', () => {
  const base: RetiredJoint = {
    kind: 'retired-joint',
    jointId: jointId('old/1'),
    a: jointedDocument().joint.a.partId,
    b: jointedDocument().joint.b.partId,
    reason: JointRetirement.PartRemoved,
    retiredAtRevision: 3,
    pinCount: 2,
  };
  const doc = (record: RetiredJoint): GeometryDocument => ({
    ...jointedDocument().document,
    joints: [record],
  });
  it('accepts a well-formed one', () => {
    expect(codes(doc(base))).toEqual([]);
  });
  it.each([
    ['an unknown reason', { reason: 'BECAUSE' as unknown as RetiredJoint['reason'] }],
    ['revision zero', { retiredAtRevision: 0 }],
    ['a fractional revision', { retiredAtRevision: 1.5 }],
    ['a negative pin count', { pinCount: -1 }],
    ['more pins than a joint holds', { pinCount: MAX_PINS_PER_JOINT + 1 }],
    ['an empty identifier', { jointId: jointId('') }],
  ])('rejects %s', (_label, change) => {
    expect(codes(doc({ ...base, ...change }))).toContain(
      DocumentValidationCode.RetiredJointMalformed,
    );
  });
});

describe('retained meshes are geometry and are checked like a part', () => {
  function broken(): CanonicalMesh {
    const positions = createPositionArray(9);
    const indices = createIndexArray(3);
    indices.set([0, 1, 7]);
    return { positions, indices, metadata: {} };
  }
  it('refuses a base that is not a well-formed mesh, when meshes are validated', () => {
    const { joint, document } = jointedDocument();
    const bad: ConnectorJoint = { ...joint, a: { ...joint.a, baseMesh: broken() } };
    expect(codes({ ...document, joints: [bad] }, true)).toContain(
      DocumentValidationCode.InvalidPartMesh,
    );
  });
  it('does not walk them when the caller already has, as for parts', () => {
    const { joint, document } = jointedDocument();
    const bad: ConnectorJoint = { ...joint, a: { ...joint.a, baseMesh: broken() } };
    expect(codes({ ...document, joints: [bad] }, false)).toEqual([]);
  });
});
