import type { StructuralTargetOwnershipAudit } from './semantic-structural-ownership';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PreparedSemanticGeometry } from './semantic';
import type { SemanticPart } from '@cadfixer/auto-split-contract';
import type { SemanticPlaneRefinement } from './semantic-plane';
const state = vi.hoisted(() => ({
  valid: true,
  cap: false,
  secondFailure: false,
  body: false,
  irrelevant: false,
  conflict: false,
  calls: 0,
}));
vi.mock('./semantic-ownership-source-component', () => ({
  resolveOwnershipSourceComponent: (): {
    proven: boolean;
    component: number;
    evidenceKind: string;
    provenanceFacesInspected: number;
    anchorFace: number;
  } => ({
    proven: true,
    component: 0,
    evidenceKind: 'MATERIAL_INTERFACE_SOURCE',
    provenanceFacesInspected: 1,
    anchorFace: 0,
  }),
}));
vi.mock('./semantic-ownership-completeness', async (original) => ({
  ...(await original<object>()),
  inventorySourceInterfacePlanes: (): {
    valid: boolean;
    reason: string;
    groups: { offset: number }[];
    sourceFaceVisits: number;
  } => ({
    valid: state.valid,
    reason: state.valid ? 'SOURCE_INTERFACE_PLANES_INVENTORIED' : 'NONPLANAR_SOURCE_INTERFACE',
    groups: [{ offset: 0 }, { offset: 2 }],
    sourceFaceVisits: 4,
  }),
}));
vi.mock('./semantic-grounded-boundary', () => ({
  groundedSourceFaceNormal: (): { vector: number[]; length: number } => ({
    vector: [-1, 0, 0],
    length: 1,
  }),
  collectGroundedBoundaryWitnesses: (): {
    low: number;
    high: number;
    observedAxes: number[];
    pixelVisits: number;
  }[] => [{ low: -1, high: 4, observedAxes: [0, 1], pixelVisits: 0 }],
}));
vi.mock('./semantic-interface-membership', async (original) => ({
  ...(await original<object>()),
  completeSourceInterface: (
    _g: unknown,
    _n: unknown,
    offset: number,
  ): {
    valid: boolean;
    reason: string;
    faces: number[];
    area: number;
    scratchBytes: number;
    telemetry: {
      seedFaces: number;
      candidateFaces: number;
      completedFaces: number;
      adjacencyTraversals: number;
      sourceFaceVisits: number;
    };
  } => {
    state.calls++;
    return {
      valid: !(state.cap || (state.secondFailure && offset === 2)),
      reason: 'INTERFACE_FACE_CAP',
      faces: [offset === 0 ? 0 : 1],
      area: 0.5,
      scratchBytes: 0,
      telemetry: {
        seedFaces: 1,
        candidateFaces: 1,
        completedFaces: 1,
        adjacencyTraversals: 0,
        sourceFaceVisits: 2,
      },
    };
  },
  interfaceMembershipSignature: (
    _g: unknown,
    region: { offset: number },
  ): {
    ownership: string;
    selectedArea: number;
    excludedArea: number;
    partialFaces: number;
    clippedOperations: number;
  } => ({
    ownership: region.offset === 2 && state.body ? 'BODY_SIDE' : 'TARGET_SIDE',
    selectedArea: 0.5,
    excludedArea: 0,
    partialFaces: 0,
    clippedOperations: 1,
  }),
}));
vi.mock('./semantic-interface-ownership', () => ({
  interfaceOwnershipEvidence: (): {
    ownership: string;
    conflict: boolean;
    pixelVisits: number;
  } => ({
    ownership: state.body ? 'BODY_SIDE' : state.irrelevant ? 'AMBIGUOUS' : 'TARGET_SIDE',
    conflict: false,
    pixelVisits: 0,
  }),
}));
import { structuralOwnershipCardinality } from './semantic-structural-ownership';
const no = (): void => {
  // Intentionally empty hook; preserve the undefined return value.
};
const run = (checkpoint = no): StructuralTargetOwnershipAudit => {
  const geometry = {
    positions: Float32Array.from([0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 0, 2, 0, 1, 2, 1, 0]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
    faceCount: 2,
    center: [0, 0, 0],
    scale: 1,
    radius: 3,
    extents: [2, 1, 1],
  };
  const prepared = {
    geometry,
    labelling: { count: 1, faceRank: new Int32Array(2) },
  } as unknown as PreparedSemanticGeometry;
  const region = {
    faces: [0],
    normal: [1, 0, 0],
    offset: 0,
    area: 0.5,
    sourceFacesInspected: 2,
    clippedOperations: 0,
    scratchBytes: 0,
  };
  const primary = {
    ownership: 'TARGET_SIDE',
    conflict: state.conflict,
    materialInterface: region,
    pixelVisits: 0,
  };
  const profile = {
    profileNormal: [1, 0, 0],
    sectionProfile: [
      { offset: -0.5, length: 2 },
      { offset: 0.5, length: 1 },
    ],
  } as unknown as SemanticPlaneRefinement;
  const cuts = [
    { normal: [1, 0, 0], origin: [-0.2, 0, 0] },
    { normal: [1, 0, 0], origin: [-0.1, 0, 0] },
  ] as const;
  return structuralOwnershipCardinality(
    prepared,
    {} as SemanticPart,
    [],
    cuts,
    cuts,
    primary as never,
    profile,
    [[1, 0, 0]],
    cuts,
    checkpoint,
    no,
  );
};
beforeEach(() =>
  Object.assign(state, {
    valid: true,
    cap: false,
    secondFailure: false,
    body: false,
    irrelevant: false,
    conflict: false,
    calls: 0,
  }),
);
it('01 successful audit exposes every completed row', () => {
  expect(run().resolvedInterfaces).toHaveLength(2);
});
it('02 exact original face identities are preserved', () => {
  expect(run().resolvedInterfaces?.map((r) => r.region.faces)).toEqual([[0], [1]]);
});
it('03 existing row order is preserved', () => {
  expect(run().resolvedInterfaces?.map((r) => r.region.offset)).toEqual([0, 2]);
});
it('04 positive target resolution is preserved', () => {
  expect(run().resolvedInterfaces?.[0]?.resolution).toBe('POSITIVELY_TARGET_OWNED');
});
it('05 positive body resolution is preserved', () => {
  state.body = true;
  expect(run().resolvedInterfaces?.[1]?.resolution).toBe('POSITIVELY_BODY_OWNED');
});
it('06 proven irrelevant remains an explicit row', () => {
  state.irrelevant = true;
  expect(run().resolvedInterfaces?.[1]?.resolution).toBe('PROVEN_IRRELEVANT');
});
it('07 conflict remains visible and cannot expose usable rows', () => {
  state.conflict = true;
  const a = run();
  expect(a.primaryOwnership?.conflict).toBe(true);
  expect(a.resolvedInterfaces).toBeUndefined();
});
it('08 existing source component provenance is retained', () => {
  expect(run().cardinality.sourceComponentResolution).toMatchObject({
    proven: true,
    component: 0,
    anchorFace: 0,
  });
});
it('09 failed inventory exposes no rows', () => {
  state.valid = false;
  expect(run().resolvedInterfaces).toBeUndefined();
});
it('10 cancellation cannot return a partial payload', () => {
  expect(() =>
    run(() => {
      throw Error('cancelled');
    }),
  ).toThrow('cancelled');
});
it('11 completed face cap failure exposes no rows', () => {
  state.cap = true;
  expect(run().resolvedInterfaces).toBeUndefined();
});
it('12 consumer cannot mutate evidence or ordering', () => {
  const rows = requiredValue(run().resolvedInterfaces);
  expect(() => (rows as unknown[]).pop()).toThrow();
  expect(() => (requiredValue(rows[0]).region.faces as number[]).push(9)).toThrow();
  expect(() => Object.assign(requiredValue(rows[0]), { ownership: 'BODY_SIDE' })).toThrow();
  expect(() => ((requiredValue(rows[0]).region.normal as unknown as number[])[0] = 0)).toThrow();
});
it('13 handoff performs no second completion walk', () => {
  run();
  expect(state.calls).toBe(2);
});
it('14 cardinality is unchanged', () => {
  expect(run().cardinality).toMatchObject({
    state: 'IDENTIFIED',
    reason: 'POSITIVE_SINGLE_TARGET_OWNERSHIP_CLASS',
    materialInterfaces: 2,
    ownershipSignatures: 1,
  });
});
it('15 completeness accounting is unchanged', () => {
  expect(run().cardinality.ownershipCompleteness).toMatchObject({
    state: 'COMPLETE',
    inventoried: 2,
    resolvedTarget: 2,
  });
});
it('16 existing semantic key and assignment ordering is unchanged', () => {
  state.body = true;
  expect(run().signatures.map((s) => s.key)).toEqual([
    'TARGET_SIDE|BODY_SIDE',
    'TARGET_SIDE|BODY_SIDE',
  ]);
});

/** Bounds, cardinality or membership is established by the caller's exact invariant.
 * Missing evidence aborts; it never supplies a geometric or semantic default. */
function requiredValue<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw Error('Required invariant value is missing.');
  return value;
}
