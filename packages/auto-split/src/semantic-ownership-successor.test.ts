import type { WholeInterfaceCertificate } from './semantic-whole-interface-certificate';
import type { InterfaceOwnership } from './semantic-boundary-confirmation';
import type { InterfaceEvidenceLevel } from './semantic-interface-ownership';
import type { InterfaceResolution } from './semantic-ownership-completeness';
import { expect, it } from 'vitest';
import type { SemanticPart } from '@cadfixer/auto-split-contract';
import type { PreparedSemanticGeometry } from './semantic';
import type { MaterialInterface } from './semantic-interface-membership';
import { certifyWholeInterface } from './semantic-whole-interface-certificate';
import {
  classifyInterfaceOwnershipSupport as classify,
  interfaceOwnershipEvidence,
  type InterfaceObservationSupport,
} from './semantic-interface-ownership';
import {
  ownershipCompleteness as completeness,
  resolveOwnershipInterface as resolve,
  exhaustiveOwnershipPublication as publish,
} from './semantic-ownership-completeness';
import { planOwnershipCompletion } from './semantic-ownership-representative-completion';
import type { StructuralTargetOwnershipAudit } from './semantic-structural-ownership';
import type { SemanticPlaneRefinement } from './semantic-plane';
const noop = (): void => {
  // Intentionally empty hook; preserve the undefined return value.
};
const owner = (
  polygons: number[][][] = [
    [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.9, 0.9],
      [0.1, 0.9],
    ],
  ],
): SemanticPart => ({
  id: 'member',
  label: 'Member',
  parentId: null,
  importance: 'major',
  confidence: 1,
  instances: 1,
  views: [{ view: 'front', polygons: polygons as [number, number][][] }],
  componentIds: [],
  expectedGeometry: { kind: 'solid_part', likelySeparable: true },
  cut: null,
});
const prepared = (extra: number[] = []): PreparedSemanticGeometry =>
  ({
    geometry: {
      positions: Float32Array.from([0, 0, 0, 0.4, 0, 0, 0, 0, 0.4, ...extra]),
      indices: Uint32Array.from({ length: 3 + extra.length / 3 }, (_, i) => i),
      faceCount: 1 + extra.length / 9,
      center: [0, 0, 0],
      scale: 1,
      radius: 1,
      extents: [1, 1, 1],
    },
    rasters: [],
  }) as unknown as PreparedSemanticGeometry;
const region = (faces = [0]): MaterialInterface => ({
  faces,
  normal: [0, 1, 0],
  offset: 0,
  area: 0.08,
  sourceFacesInspected: faces.length,
  clippedOperations: 0,
  scratchBytes: 0,
});
const observe = (
  view: InterfaceObservationSupport['view'],
  target = 0,
  body = 0,
  unknown = 0,
): InterfaceObservationSupport => ({
  view,
  visiblePixels: target + body + unknown,
  targetPixels: target,
  bodyPixels: body,
  unknownPixels: unknown,
});
const row = (
  resolution: Parameters<typeof completeness>[0][number]['resolution'],
): { offset: number; faces: number; resolution: InterfaceResolution } => ({
  offset: 0,
  faces: 1,
  resolution,
});
const local = (): {
  readonly evidenceLevel: InterfaceEvidenceLevel;
  readonly ownership: InterfaceOwnership;
  readonly conflict: boolean;
  readonly category:
    | 'DIRECT_EXHAUSTIVE'
    | 'DIRECT_CORROBORATED'
    | 'FRONTIER_CORROBORATED'
    | 'SPARSE_UNCORROBORATED'
    | 'CONFLICTED'
    | 'UNKNOWN';
  readonly targetAxes: readonly number[];
  readonly bodyAxes: readonly number[];
} => classify([observe('front', 8, 0, 1), observe('left', 8, 0, 1)], false);
const proof = (): WholeInterfaceCertificate =>
  certifyWholeInterface(prepared(), region(), [owner()], noop, noop);
it('01 complete positive TARGET geometry and observations prove whole TARGET', () => {
  expect(classify([observe('front', 8)], false, proof()).evidenceLevel).toBe(
    'WHOLE_INTERFACE_TARGET_PROVEN',
  );
});
it('02 identical positive BODY obligations prove whole BODY', () => {
  expect(classify([observe('front', 0, 8)], false, proof()).evidenceLevel).toBe(
    'WHOLE_INTERFACE_BODY_PROVEN',
  );
});
it('03 one uncertified original triangle prevents whole proof', () => {
  const p = prepared([0.7, 0, 0, 0.9, 0, 0, 0.7, 0, 0.2]);
  expect(
    certifyWholeInterface(
      p,
      region([0, 1]),
      [
        owner([
          [
            [0.1, 0.1],
            [0.75, 0.1],
            [0.75, 0.9],
            [0.1, 0.9],
          ],
        ]),
      ],
      noop,
      noop,
    ).complete,
  ).toBe(false);
});
it('04 numerical uncertainty fails closed', () => {
  const p = prepared();
  p.geometry.positions[0] = NaN;
  expect(certifyWholeInterface(p, region(), [owner()], noop, noop).complete).toBe(false);
});
it('05 an original-source occluder over positive area prevents proof', () => {
  expect(
    certifyWholeInterface(
      prepared([0, -0.1, 0, 0.4, -0.1, 0, 0, -0.1, 0.4]),
      region(),
      [owner()],
      noop,
      noop,
    ).complete,
  ).toBe(false);
});
it('06 full projected triangle contained in a positive region certifies', () => {
  expect(proof()).toMatchObject({ complete: true, certifiedFaces: 1 });
});
it('07 a labelled triangle-center patch is insufficient', () => {
  expect(
    certifyWholeInterface(
      prepared(),
      region(),
      [
        owner([
          [
            [0.54, 0.4],
            [0.6, 0.4],
            [0.6, 0.48],
            [0.54, 0.48],
          ],
        ]),
      ],
      noop,
      noop,
    ).complete,
  ).toBe(false);
});
it('08 raster face-center evidence alone is insufficient', () => {
  expect(classify([observe('front', 1)], false).evidenceLevel).toBe('LOCAL_TARGET_ASSOCIATION');
  expect(classify([observe('front', 1)], false).ownership).toBe('AMBIGUOUS');
});
it('09 zero UNKNOWN observations alone do not prove whole source', () => {
  expect(classify([observe('front', 200)], false).evidenceLevel).toBe('LOCAL_TARGET_ASSOCIATION');
});
it('10 continuous proof succeeds without any raster center hits', () => {
  expect(prepared().rasters).toHaveLength(0);
  expect(proof().complete).toBe(true);
});
it('11 cancellation propagates out of continuous geometry work', () => {
  expect(() =>
    certifyWholeInterface(
      prepared(),
      region(),
      [owner()],
      () => {
        throw Error('cancelled');
      },
      noop,
    ),
  ).toThrow('cancelled');
});
it('12 interface cap and caller work budget fail closed', () => {
  expect(
    certifyWholeInterface(prepared(), region(Array<number>(8193).fill(0)), [owner()], noop, noop)
      .complete,
  ).toBe(false);
  let work = 0;
  expect(() =>
    certifyWholeInterface(prepared(), region(), [owner()], noop, () => {
      if (++work > 20) throw Error('budget');
    }),
  ).toThrow('budget');
});
it('13 successful and failed certificates preserve source bytes', () => {
  const p = prepared(),
    before = p.geometry.positions.slice();
  certifyWholeInterface(p, region(), [owner()], noop, noop);
  certifyWholeInterface(
    p,
    region(),
    [
      owner([
        [
          [0.1, 0.1],
          [0.2, 0.1],
          [0.2, 0.2],
        ],
      ]),
    ],
    noop,
    noop,
  );
  expect(p.geometry.positions).toEqual(before);
});
it('14 existing corroborated frontier supplies LOCAL_TARGET only', () => {
  expect(classify([], true)).toMatchObject({
    evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
    ownership: 'AMBIGUOUS',
  });
});
it('15 partial independent direct TARGET evidence remains local', () => {
  expect(local()).toMatchObject({
    evidenceLevel: 'LOCAL_TARGET_ASSOCIATION',
    ownership: 'AMBIGUOUS',
  });
});
it('16 partial independent direct BODY evidence remains local', () => {
  expect(classify([observe('front', 0, 8, 1), observe('left', 0, 8, 1)], false)).toMatchObject({
    evidenceLevel: 'LOCAL_BODY_ASSOCIATION',
    ownership: 'AMBIGUOUS',
  });
});
it('17 sparse one-axis evidence does not gain corroborated strength', () => {
  expect(classify([observe('front', 8, 0, 1)], false).evidenceLevel).toBe('UNKNOWN');
});
it('18 incompatible positive observations and frontier remain CONFLICT', () => {
  expect(classify([observe('front', 0, 8)], true)).toMatchObject({
    evidenceLevel: 'CONFLICT',
    conflict: true,
    ownership: 'AMBIGUOUS',
  });
});
it('19 local evidence is not a semantic completeness resolution', () => {
  const r = resolve(local().ownership, false, false, true, true);
  expect(completeness([row(r)])).toMatchObject({
    state: 'INCOMPLETE_UNRESOLVED',
    semanticComplete: false,
  });
});
it('20 independently proven positive span irrelevance remains discharged', () => {
  expect(resolve('AMBIGUOUS', false, true, true, true)).toBe('PROVEN_IRRELEVANT');
});
it('21 invariant candidate membership alone cannot prove irrelevance', () => {
  expect(resolve('AMBIGUOUS', false, false, true, false)).toBe('UNREPRESENTED_UNRESOLVED');
});
it('22 scope rejection cannot prove irrelevance or BODY', () => {
  expect(resolve('AMBIGUOUS', false, false, false, true)).toBe('UNREPRESENTED_UNRESOLVED');
});
it('23 all whole-owned or independently irrelevant rows are complete', () => {
  expect(
    completeness([
      row('POSITIVELY_TARGET_OWNED'),
      row('POSITIVELY_BODY_OWNED'),
      row('PROVEN_IRRELEVANT'),
    ]),
  ).toMatchObject({ state: 'COMPLETE', semanticComplete: true, inventoryComplete: true });
});
it('24 a represented LOCAL row blocks AUTO knowledge', () => {
  const c = completeness([row(resolve(local().ownership, false, false, true, true))]);
  expect(publish(c, 1, true)).toBe(false);
});
it('25 one unrepresented UNKNOWN blocks inventory completeness', () => {
  expect(completeness([row('UNREPRESENTED_UNRESOLVED')])).toMatchObject({
    state: 'INCOMPLETE_UNRESOLVED',
    inventoryComplete: false,
  });
});
it('26 conflict blocks both automatic and confirmation publication', () => {
  const c = completeness([row('CONFLICTED')]);
  expect(c.state).toBe('INCOMPLETE_CONFLICTED');
  expect(publish(c, 1, true)).toBe(false);
  expect(publish(c, 2, false)).toBe(false);
});
it('27 two open dimensions cannot be closed by two sampled keys', () => {
  expect(
    publish(completeness([row('REPRESENTED_UNRESOLVED'), row('REPRESENTED_UNRESOLVED')]), 2, false),
  ).toBe(false);
});
it('28 strict complete one-class knowledge admits the unchanged downstream AUTO path', () => {
  expect(publish(completeness([row('POSITIVELY_TARGET_OWNED')]), 1, true)).toBe(true);
});
it('29 local unresolved ownership cannot authorize one-class publication', () => {
  expect(publish(completeness([row('REPRESENTED_UNRESOLVED')]), 1, true)).toBe(false);
});
it('30 one binary open dimension and all other requirements discharged admit exact-two confirmation', () => {
  expect(
    publish(completeness([row('REPRESENTED_UNRESOLVED'), row('PROVEN_IRRELEVANT')]), 2, false),
  ).toBe(true);
});
it('31 a third complete interpretation cannot publish', () => {
  expect(publish(completeness([row('REPRESENTED_UNRESOLVED')]), 3, false)).toBe(false);
});
it('32 unchanged R5O completion cannot manufacture resolution for LOCAL', () => {
  const audit: StructuralTargetOwnershipAudit = {
    cardinality: {
      state: 'IDENTIFIED',
      reason: 'test',
      ownershipCompleteness: completeness([row('REPRESENTED_UNRESOLVED')]),
      materialInterfaces: 1,
      interfaceComponents: 1,
      unresolvedClasses: 1,
      admittedCandidatesInspected: 2,
      sourceFaceVisits: 0,
      clippedOperations: 0,
      pixelVisits: 0,
      scratchBytes: 0,
    },
    signatures: [],
  };
  const profile: SemanticPlaneRefinement = {
    profileNormal: [0, 1, 0],
    cut: { normal: [0, 1, 0], origin: [0, 0, 0] },
    proposedOffset: 0,
    chosenOffset: 0,
    proposedSectionLength: 1,
    chosenSectionLength: 1,
    samples: 9,
    sectionProfile: [8, 8, 8, 8, 1, 1, 1, 1, 1].map((length, i) => ({
      offset: (i - 4) / 100,
      length,
    })),
  };
  expect(
    planOwnershipCompletion(
      prepared().geometry,
      audit,
      'EXECUTABLE',
      profile,
      0,
      2,
      [],
      noop,
      noop,
    ),
  ).toBeUndefined();
});
it('33 native telemetry cannot upgrade LOCAL evidence', () => {
  const evidence = Object.assign(observe('front', 8, 0, 1), { nativeValid: true });
  expect(classify([evidence, observe('left', 8, 0, 1)], false).ownership).toBe('AMBIGUOUS');
});
it('34 supported scope telemetry cannot upgrade LOCAL evidence', () => {
  const evidence = Object.assign(observe('front', 8, 0, 1), { scope: 'TARGET_SCOPE_SUPPORTED' });
  expect(classify([evidence, observe('left', 8, 0, 1)], false).ownership).toBe('AMBIGUOUS');
});
it('35 evidence collection before Apply preserves source geometry', () => {
  const p = prepared(),
    before = p.geometry.positions.slice();
  interfaceOwnershipEvidence(
    p,
    owner(),
    [],
    [
      { normal: [0, 1, 0], origin: [0, -1, 0] },
      { normal: [0, 1, 0], origin: [0, 1, 0] },
    ],
    noop,
    noop,
    region(),
  );
  expect(p.geometry.positions).toEqual(before);
});

it('36 opposite positive continuous labels conflict even without raster center hits', () => {
  const certificate = certifyWholeInterface(prepared(), region(), [owner()], noop, noop, [owner()]);
  expect(certificate).toMatchObject({ complete: false, conflict: true });
  expect(classify([observe('front', 8)], false, certificate).evidenceLevel).toBe('CONFLICT');
});
it('37 a disjoint positive opposite region does not deny a valid whole certificate', () => {
  expect(
    certifyWholeInterface(prepared(), region(), [owner()], noop, noop, [
      owner([
        [
          [0.1, 0.7],
          [0.2, 0.7],
          [0.2, 0.8],
          [0.1, 0.8],
        ],
      ]),
    ]).complete,
  ).toBe(true);
});
it('38 unsupported self-intersecting owner regions never prove whole ownership', () => {
  expect(
    certifyWholeInterface(
      prepared(),
      region(),
      [
        owner([
          [
            [0.1, 0.1],
            [0.9, 0.9],
            [0.1, 0.9],
            [0.9, 0.1],
          ],
        ]),
      ],
      noop,
      noop,
    ).complete,
  ).toBe(false);
});
it('39 exactly equal-depth source triangles do not become fictitious occluders', () => {
  expect(
    certifyWholeInterface(
      prepared([0, 0, 0, 0.4, 0, 0, 0, 0, 0.4]),
      region(),
      [owner()],
      noop,
      noop,
    ).complete,
  ).toBe(true);
});
it('40 a recorded raster face hit cannot replace a missing positive region', () => {
  const p = prepared();
  Object.assign(p, { rasters: [{ view: 'front', size: 1, face: new Int32Array([0]) }] });
  const missing = { ...owner(), views: [] };
  expect(certifyWholeInterface(p, region(), [missing], noop, noop).complete).toBe(false);
});
