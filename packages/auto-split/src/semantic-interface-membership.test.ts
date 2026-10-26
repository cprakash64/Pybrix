import { expect, it } from 'vitest';
import type { NormalizedGeometry } from './geometry';
import type { SuggestedPlane } from './suggestions';
import {
  interfaceTriangleFraction,
  completeSourceInterface,
  collectMaterialInterface,
  interfaceMembershipSignature,
  type MaterialInterface,
} from './semantic-interface-membership';
const geometry: NormalizedGeometry = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  faceCount: 1,
  center: [0, 0, 0],
  scale: 1,
  radius: 1,
  extents: [1, 1, 0],
};
const region: MaterialInterface = {
  faces: [0],
  normal: [0, 0, 1],
  offset: 0,
  area: 0.5,
  sourceFacesInspected: 1,
  clippedOperations: 0,
  scratchBytes: 4,
};
const plane = (offset: number): SuggestedPlane => ({ normal: [1, 0, 0], origin: [offset, 0, 0] });
it('clips the original triangle fraction rather than assigning a straddler as a whole face', () => {
  expect(interfaceTriangleFraction(geometry, 0, plane(0.5))).toBeCloseTo(0.25, 12);
  const signature = interfaceMembershipSignature(
    geometry,
    region,
    plane(0.5),
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  expect(signature.ownership).toBe('INTERMEDIATE');
  expect(signature.partialFaces).toBe(1);
  expect(signature.selectedArea).toBeCloseTo(0.125, 12);
  expect(signature.excludedArea).toBeCloseTo(0.375, 12);
});
it('distinguishes complete ownership classes including the exact edge boundary', () => {
  expect(
    interfaceMembershipSignature(
      geometry,
      region,
      plane(0),
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ).ownership,
  ).toBe('TARGET_SIDE');
  expect(
    interfaceMembershipSignature(
      geometry,
      region,
      plane(1),
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ).ownership,
  ).toBe('BODY_SIDE');
});
it('checks cancellation while constructing membership without mutating the input', () => {
  const before = geometry.positions.slice();
  expect(() =>
    interfaceMembershipSignature(
      geometry,
      region,
      plane(0.5),
      () => {
        throw Error('cancelled');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toThrow('cancelled');
  expect(geometry.positions).toEqual(before);
});

const completionGeometry = (
  triangles: readonly (readonly (readonly number[])[])[],
): NormalizedGeometry => {
  const positions = Float32Array.from(triangles.flat(2));
  return {
    positions,
    indices: Uint32Array.from({ length: triangles.length * 3 }, (_, i) => i),
    faceCount: triangles.length,
    center: [0, 0, 0],
    scale: 1,
    radius: 2,
    extents: [1, 1, 1],
  };
};
const zCut = (z: number): SuggestedPlane => ({ normal: [0, 0, 1], origin: [0, 0, z] });
const fanGeometry = (opposite = false): NormalizedGeometry => {
  const a = [0, 0, 0],
    b = [1, 0, 0],
    c = [1, 1, 0],
    d = [0, 1, 0],
    m = opposite ? [0.0001, 0.9999, 0.0000003] : [0.0001, 0.00005, 0.0000003];
  return completionGeometry(
    opposite
      ? [
          [a, b, c],
          [a, c, m],
          [c, d, m],
          [d, a, m],
        ]
      : [
          [a, b, m],
          [b, c, m],
          [c, a, m],
          [a, c, d],
        ],
  );
};
it('completes a connected supporting-plane fan through noisy-normal original faces', () => {
  const g = fanGeometry(),
    before = g.positions.slice(),
    r = completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [1, 3],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    );
  expect(r.valid).toBe(true);
  if (!r.valid) return;
  expect(r.faces).toHaveLength(4);
  expect(r.telemetry.completedFaces).toBe(4);
  expect(g.positions).toEqual(before);
  expect(
    collectMaterialInterface(
      g,
      [zCut(-0.01), zCut(0.01)],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    )?.faces,
  ).toHaveLength(4);
});
it('completes an independently triangulated thin opposite-corner fan', () => {
  const r = completeSourceInterface(
    fanGeometry(true),
    [0, 0, 1],
    0,
    [0, 1],
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  expect(r.valid).toBe(true);
  if (r.valid) expect(r.faces).toHaveLength(4);
});
it('refuses genuinely disconnected coplanar source surfaces', () => {
  const g = completionGeometry([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [3, 0, 0],
      [4, 0, 0],
      [3, 1, 0],
    ],
  ]);
  expect(
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [0, 1],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toMatchObject({ valid: false, reason: 'DISCONNECTED_MEMBERSHIP_DELTA' });
});
it('does not cross a connected non-coplanar crease', () => {
  const g = completionGeometry([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0.01],
      [0, 1, 0],
    ],
  ]);
  const r = completeSourceInterface(
    g,
    [0, 0, 1],
    0,
    [0],
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  expect(r.valid).toBe(true);
  if (r.valid) expect(r.faces).toEqual([0]);
});
it('rejects an opposed winding face on the supporting plane', () => {
  const g = completionGeometry([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
  ]);
  expect(
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toMatchObject({ valid: false, reason: 'OPPOSED_INTERFACE_ORIENTATION' });
});
it('refuses completion beyond the unchanged8192 original-face bound', () => {
  const g = completionGeometry(
    Array.from({ length: 8193 }, (_, i) => [
      [i * 2, 0, 0],
      [i * 2 + 1, 0, 0],
      [i * 2, 1, 0],
    ]),
  );
  expect(
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [0],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toMatchObject({ valid: false, reason: 'INTERFACE_FACE_CAP' });
});
it('checks cancellation during adjacency completion and preserves source', () => {
  const g = fanGeometry(),
    before = g.positions.slice();
  let checkpoints = 0;
  expect(() =>
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [1, 3],
      () => {
        if (++checkpoints === 3) throw Error('completion cancelled');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toThrow('completion cancelled');
  expect(g.positions).toEqual(before);
});
it('never bridges a spatial gap smaller than plane correspondence', () => {
  const gap = 2e-7,
    g = completionGeometry([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [1 + gap, 0, 0],
        [2, 0, 0],
        [1 + gap, 1, 0],
      ],
    ]);
  expect(
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [0, 1],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toMatchObject({ valid: false, reason: 'DISCONNECTED_MEMBERSHIP_DELTA' });
});
it('rejects ambiguous original adjacency even when the extra face leaves the plane', () => {
  const g = completionGeometry([
    [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0.5, 0.5, 1],
    ],
  ]);
  expect(
    completeSourceInterface(
      g,
      [0, 0, 1],
      0,
      [0, 1],
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toMatchObject({ valid: false, reason: 'AMBIGUOUS_SOURCE_ADJACENCY' });
});
