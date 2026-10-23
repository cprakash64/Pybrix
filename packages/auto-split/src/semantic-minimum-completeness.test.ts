import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SemanticPart, Vec3 } from '@cadfixer/auto-split-contract';
import type { NormalizedGeometry } from './geometry';
import type { PreparedSemanticGeometry } from './semantic';
import type { SemanticPlaneRefinement } from './semantic-plane';
import type { SuggestedPlane } from './suggestions';
import type { MaterialInterface } from './semantic-interface-membership';
import type { InterfaceOwnershipEvidence } from './semantic-interface-ownership';
import * as interfaceEvidence from './semantic-interface-ownership';
import * as grounded from './semantic-grounded-boundary';
import { structuralOwnershipCardinality } from './semantic-structural-ownership';
import { structuralSeamEvidence, seamSupportsPlane } from './semantic-seam';
import {
  ownershipCompleteness,
  exhaustiveOwnershipPublication,
} from './semantic-ownership-completeness';
import { interfaceMembershipSignature } from './semantic-interface-membership';
import { bindRepresentativeRefinement } from './semantic-local-plane';
const noop = (): void => {};
const plane = (offset: number): SuggestedPlane => ({ normal: [1, 0, 0], origin: [offset, 0, 0] });
const profile = (step = false): SemanticPlaneRefinement => ({
  cut: plane(0),
  profileNormal: [1, 0, 0],
  proposedOffset: 0,
  chosenOffset: 0,
  proposedSectionLength: 1,
  chosenSectionLength: 1,
  samples: 9,
  sectionProfile: (step ? [1, 1, 1, 1, 1, 7, 7, 7, 7] : [7, 7, 1, 1, 1, 1, 1, 7, 7]).map(
    (length, i) => ({ offset: (i - 4) / 100, length }),
  ),
});
// Planar source rows and an already resolved original-component map isolate accounting.
// Pixel evidence is supplied independently; source membership and inventory are real.
const geometry = (offsets: readonly number[]): NormalizedGeometry => ({
  positions: Float32Array.from(offsets.flatMap((x) => [x, 0, 0, x, 0, 1, x, 1, 0])),
  indices: Uint32Array.from({ length: offsets.length * 3 }, (_, i) => i),
  faceCount: offsets.length,
  center: [0, 0, 0],
  scale: 1,
  radius: 1,
  extents: [1, 1, 1],
});
const part: SemanticPart = {
  id: 'member',
  label: 'Member',
  parentId: null,
  importance: 'major',
  confidence: 1,
  instances: 1,
  componentIds: [],
  cut: null,
  expectedGeometry: { kind: 'solid_part', likelySeparable: false },
  views: [],
};
const evidence = (
  region: MaterialInterface,
  ownership: InterfaceOwnershipEvidence['ownership'],
  conflict = false,
): InterfaceOwnershipEvidence => ({
  materialInterface: region,
  interfaceSelectedAlternative: null,
  ownership,
  conflict,
  surfaceArea: region.area,
  targetPixels: ownership === 'TARGET_SIDE' ? 8 : 0,
  bodyPixels: ownership === 'BODY_SIDE' ? 8 : 0,
  unknownPixels: ownership === 'AMBIGUOUS' ? 8 : 0,
  pixelVisits: 0,
  faceVisits: region.faces.length,
  scratchBytes: 0,
  positiveFrontierProof: false,
  clippedOperations: 0,
});
let observe: ReturnType<typeof vi.spyOn<typeof interfaceEvidence, 'interfaceOwnershipEvidence'>>;
beforeEach(() => {
  observe = vi.spyOn(interfaceEvidence, 'interfaceOwnershipEvidence');
  observe.mockImplementation((_p, _t, _peers, _cuts, _check, _charge, region) => {
    if (!region) throw Error('missing source row');
    return evidence(region, 'AMBIGUOUS');
  });
  vi.spyOn(grounded, 'collectGroundedBoundaryWitnesses').mockReturnValue([
    {
      normal: [1, 0, 0],
      low: -0.1,
      high: 0.19,
      observedAxes: [0, 1],
      viewPixels: [8, 0, 8, 0, 0, 0],
      pixelVisits: 0,
    },
  ]);
});
afterEach(() => vi.restoreAllMocks());
function audit(
  ownership: InterfaceOwnershipEvidence['ownership'],
  candidates: readonly SuggestedPlane[] = [plane(-0.02), plane(-0.01)],
  offsets = [-0.2, 0, 0.2],
  conflict = false,
  checkpoint = noop,
  refinement = profile(),
) {
  const g = geometry(offsets),
    face = offsets.indexOf(0),
    region: MaterialInterface = {
      faces: [face],
      normal: [1, 0, 0],
      offset: 0,
      area: 0.5,
      sourceFacesInspected: g.faceCount,
      clippedOperations: 0,
      scratchBytes: 0,
    };
  const prepared = {
    geometry: g,
    labelling: { faceRank: Int32Array.from(offsets, () => 0), count: 1 },
    rasters: [],
  } as unknown as PreparedSemanticGeometry;
  const before = g.positions.slice(),
    result = structuralOwnershipCardinality(
      prepared,
      part,
      [],
      [candidates[0]!, candidates[1]!],
      candidates,
      evidence(region, ownership, conflict),
      refinement,
      [[1, 0, 0]],
      candidates,
      checkpoint,
      noop,
    );
  expect(g.positions).toEqual(before);
  return result;
}
it('minimum with positive TARGET source ownership has one identified exhaustive class', () => {
  expect(structuralSeamEvidence(profile(), noop).reason).toBe('STABLE_SECTION_MINIMUM');
  expect(audit('TARGET_SIDE').cardinality).toMatchObject({
    state: 'IDENTIFIED',
    unresolvedClasses: 1,
    ownershipCompleteness: { state: 'COMPLETE' },
  });
});
it('minimum retains AUTO eligibility with a positively bracketed irrelevant secondary row', () => {
  const result = audit('TARGET_SIDE', undefined, [-0.2, 0, 0.12, 0.2]);
  expect(result.cardinality).toMatchObject({
    state: 'IDENTIFIED',
    ownershipCompleteness: { state: 'COMPLETE', resolvedTarget: 1, provenIrrelevant: 1 },
  });
});
it('minimum with invariant UNKNOWN and no opposite representative remains incomplete', () => {
  expect(audit('AMBIGUOUS').cardinality).toMatchObject({
    state: 'INSUFFICIENT_EVIDENCE',
    ownershipCompleteness: { state: 'INCOMPLETE_UNRESOLVED', unrepresentedUnresolved: 1 },
  });
});
it('minimum with both admitted complete ownership signatures remains two-way unresolved', () => {
  const r = audit('AMBIGUOUS', [plane(-0.01), plane(0.01)]);
  expect(r.cardinality).toMatchObject({
    state: 'TWO_WAY_UNRESOLVED',
    unresolvedClasses: 2,
    ownershipCompleteness: { state: 'COMPLETE', representedUnresolved: 1 },
  });
  expect(new Set(r.signatures.map((s) => s.key)).size).toBe(2);
});
it('more than two complete classes cannot authorize minimum publication', () => {
  const c = ownershipCompleteness([{ offset: 0, faces: 1, resolution: 'REPRESENTED_UNRESOLVED' }]);
  expect(structuralSeamEvidence(profile(), noop).admitted).toBe(true);
  expect(exhaustiveOwnershipPublication(c, 3, false)).toBe(false);
});
it('minimum with contradictory positive ownership fails closed', () => {
  expect(audit('TARGET_SIDE', undefined, undefined, true).cardinality).toMatchObject({
    state: 'INSUFFICIENT_EVIDENCE',
    ownershipCompleteness: { state: 'INCOMPLETE_CONFLICTED', conflicted: 1 },
  });
});
it('a STEP refinement outside the minimum plateau cannot represent that minimum', () => {
  const minimum = profile(),
    seam = structuralSeamEvidence(minimum, noop);
  expect(seamSupportsPlane(minimum, plane(0.03), seam)).toBe(false);
  expect(
    seamSupportsPlane(profile(true), plane(0.03), structuralSeamEvidence(profile(true), noop)),
  ).toBe(true);
});
it('intermediate original-source membership cannot be a complete minimum class', () => {
  const g = geometry([0]),
    region: MaterialInterface = {
      faces: [0],
      normal: [1, 0, 0],
      offset: 0,
      area: 0.5,
      sourceFacesInspected: 1,
      clippedOperations: 0,
      scratchBytes: 0,
    },
    n = 1 / Math.sqrt(2),
    cut = { normal: [n, n, 0] as Vec3, origin: [0, 0.5, 0] as Vec3 };
  const s = interfaceMembershipSignature(g, region, cut, noop, noop);
  expect(s.ownership).toBe('INTERMEDIATE');
  expect(s.partialFaces).toBe(1);
  expect(audit('AMBIGUOUS', [plane(-0.01), cut]).cardinality.ownershipCompleteness?.state).toBe(
    'INCOMPLETE_UNRESOLVED',
  );
});
it('minimum support preserves exact plateau endpoints and rejects neighboring profile samples', () => {
  const r = profile(),
    s = structuralSeamEvidence(r, noop);
  expect(s.minimumOffsetRange).toEqual([-0.02, 0.02]);
  for (const x of [-0.02, 0.02]) expect(seamSupportsPlane(r, plane(x), s)).toBe(true);
  for (const x of [-0.03, 0.03]) expect(seamSupportsPlane(r, plane(x), s)).toBe(false);
});
it('cancellation aborts minimum inventory before evidence can be published', () => {
  let calls = 0;
  expect(() =>
    audit('TARGET_SIDE', undefined, undefined, false, () => {
      if (++calls === 4) throw Error('cancelled');
    }),
  ).toThrow('cancelled');
});
it('minimum source feature cap exhaustion fails closed', () => {
  const offsets = [-0.2, ...Array.from({ length: 18 }, (_, i) => (i - 9) / 1000), 0.2];
  expect(audit('TARGET_SIDE', undefined, offsets).cardinality).toMatchObject({
    state: 'INSUFFICIENT_EVIDENCE',
    reason: 'INTERFACE_FEATURE_CAP',
  });
});
it('minimum audit uses only existing immutable candidates and preserves their order', () => {
  const candidates = Object.freeze([Object.freeze(plane(-0.02)), Object.freeze(plane(-0.01))]),
    before = JSON.stringify(candidates);
  audit('TARGET_SIDE', candidates);
  expect(JSON.stringify(candidates)).toBe(before);
  expect(candidates).toHaveLength(2);
});
it('minimum representative metadata names its actual sampled cut without inheriting the discarded offset', () => {
  const r = profile(),
    cut = plane(-0.01),
    bound = bindRepresentativeRefinement(geometry([-0.2, 0, 0.2]), r, cut, noop, noop);
  expect(bound.cut).toBe(cut);
  expect(bound.chosenOffset).toBe(-0.01);
  expect(bound.chosenSectionLength).toBe(1);
  expect(r.chosenOffset).toBe(0);
});
it('the existing STEP route retains identified and represented two-way ownership behavior', () => {
  expect(
    audit('TARGET_SIDE', undefined, undefined, false, noop, profile(true)).cardinality.state,
  ).toBe('IDENTIFIED');
  expect(
    audit('AMBIGUOUS', [plane(-0.01), plane(0.01)], undefined, false, noop, profile(true))
      .cardinality.state,
  ).toBe('TWO_WAY_UNRESOLVED');
});
