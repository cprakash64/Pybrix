import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  triangleCount,
  singlePartDocument,
  partId,
  type CanonicalMesh,
} from '@cadfixer/mesh-core';
import { CancellationSource, uncancellable, isAppError } from '@cadfixer/shared';
import { writeBinaryStl } from '@cadfixer/file-formats';
import { testReadContext } from '../../../../../packages/file-formats/src/test-context';
import {
  dovetailFemaleDimensions,
  meshVolume,
  roundSocketRadius,
  splitWithConnectors,
  ResidentDocumentStore,
  RepairHistoryStore,
  GeometryEditStore,
  SplitCandidateStore,
  type SplitConnector,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size = 20): CanonicalMesh {
  const h = size / 2,
    p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    i = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
function translatedCube(x: number, y: number, z: number, size = 10): CanonicalMesh {
  const mesh = cube(size),
    positions = createPositionArray(mesh.positions.length);
  for (let at = 0; at < positions.length; at += 3) {
    positions[at] = (mesh.positions[at] ?? 0) + x;
    positions[at + 1] = (mesh.positions[at + 1] ?? 0) + y;
    positions[at + 2] = (mesh.positions[at + 2] ?? 0) + z;
  }
  return { ...mesh, positions };
}
function combine(...meshes: readonly CanonicalMesh[]): CanonicalMesh {
  const positions = createPositionArray(
      meshes.reduce((sum, mesh) => sum + mesh.positions.length, 0),
    ),
    indices = createIndexArray(meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0));
  let positionAt = 0,
    indexAt = 0,
    vertexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, positionAt);
    for (const index of mesh.indices) indices[indexAt++] = index + vertexOffset;
    positionAt += mesh.positions.length;
    vertexOffset += mesh.positions.length / 3;
  }
  return { positions, indices, metadata: {} };
}
function indexArray(values: readonly number[]): ReturnType<typeof createIndexArray> {
  const result = createIndexArray(values.length);
  result.set(values);
  return result;
}
function torus(major = 8, minor = 3, around = 64, tube = 24): CanonicalMesh {
  const positions = createPositionArray(around * tube * 3),
    indices = createIndexArray(around * tube * 6);
  let p = 0,
    f = 0;
  for (let i = 0; i < around; i++)
    for (let j = 0; j < tube; j++) {
      const u = (i / around) * Math.PI * 2,
        v = (j / tube) * Math.PI * 2,
        radius = major + minor * Math.cos(v);
      positions.set([radius * Math.cos(u), radius * Math.sin(u), minor * Math.sin(v)], p);
      p += 3;
      const nextI = (i + 1) % around,
        nextJ = (j + 1) % tube,
        a = i * tube + j,
        b = nextI * tube + j,
        c = nextI * tube + nextJ,
        d = i * tube + nextJ;
      indices.set([a, b, d, b, c, d], f);
      f += 6;
    }
  return { positions, indices, metadata: {} };
}
async function runOn(source: CanonicalMesh, connector: SplitConnector): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary);
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin: [0, 0, 0], normal: [0, 0, 1] }, connector },
    new CancellationSource().token,
  );
}
async function splitAt(
  source: CanonicalMesh,
  origin: readonly [number, number, number],
  normal: readonly [number, number, number],
): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary);
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin, normal }, connector: { kind: 'none' } },
    new CancellationSource().token,
  );
}
function cylinderMesh(segments = 64, radius = 8, height = 20): CanonicalMesh {
  const positions = createPositionArray(segments * 2 * 3),
    indices = createIndexArray((segments * 2 + (segments - 2) * 2) * 3);
  for (let side = 0; side < 2; side++)
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2,
        at = (side * segments + i) * 3;
      positions.set(
        [Math.cos(angle) * radius, Math.sin(angle) * radius, side ? height / 2 : -height / 2],
        at,
      );
    }
  let at = 0;
  for (let i = 1; i + 1 < segments; i++) {
    indices.set([0, i + 1, i], at);
    at += 3;
    indices.set([segments, segments + i, segments + i + 1], at);
    at += 3;
  }
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    indices.set([i, next, segments + next, i, segments + next, segments + i], at);
    at += 6;
  }
  return { positions, indices, metadata: {} };
}
function concavePrism(): CanonicalMesh {
  const outline = [
      [-6, -6],
      [6, -6],
      [6, -2],
      [-2, -2],
      [-2, 6],
      [-6, 6],
    ] as const,
    positions = createPositionArray(outline.length * 2 * 3),
    faces: number[] = [],
    cap = [
      [0, 1, 2],
      [0, 2, 3],
      [0, 3, 5],
      [3, 4, 5],
    ] as const;
  for (let side = 0; side < 2; side++)
    outline.forEach(([x, y], i) => {
      positions.set([x, y, side ? 5 : -5], (side * outline.length + i) * 3);
    });
  for (const [a, b, c] of cap) faces.push(a, c, b, a + 6, b + 6, c + 6);
  for (let i = 0; i < 6; i++) {
    const n = (i + 1) % 6;
    faces.push(i, n, n + 6, i, n + 6, i + 6);
  }
  return { positions, indices: indexArray(faces), metadata: {} };
}
async function run(connector: SplitConnector): Promise<SplitResult> {
  const backend = await createManifoldBooleanBackend(binary),
    source = cube();
  return splitWithConnectors(
    backend,
    source,
    { plane: { origin: [0, 0, 0], normal: [1, 0, 0] }, connector },
    new CancellationSource().token,
  );
}

describe('Stage 7B split and connectors', () => {
  it('7B-S01/S12 creates two closed pieces and conserves cube volume', async () => {
    const source = cube(),
      result = await run({ kind: 'none' });
    expect(triangleCount(result.pieceA)).toBeGreaterThan(0);
    expect(triangleCount(result.pieceB)).toBeGreaterThan(0);
    expect(result.cutA.triangleIds.length).toBeGreaterThan(0);
    expect(result.cutB.triangleIds.length).toBeGreaterThan(0);
    expect(result.metrics.volumeRelativeError).toBeLessThan(1e-5);
    expect(meshVolume(result.pieceA) + meshVolume(result.pieceB)).toBeCloseTo(
      meshVolume(source),
      4,
    );
  });
  it('7B-S03/S04 refuses a missing or tangent plane before Boolean work', async () => {
    const backend = await createManifoldBooleanBackend(binary),
      source = cube();
    for (const x of [10, 30])
      await expect(
        splitWithConnectors(
          backend,
          source,
          { plane: { origin: [x, 0, 0], normal: [1, 0, 0] }, connector: { kind: 'none' } },
          new CancellationSource().token,
        ),
      ).rejects.toThrow(/does not pass through enough/);
  });
  it('7B-P01 adds a round pin and socket with radial clearance', async () => {
    const baseline = await run({ kind: 'none' }),
      result = await run({
        kind: 'pin',
        count: 1,
        diameter: 3,
        depth: 4,
        clearance: 0.2,
        maleSide: 'A',
      });
    expect(result.connector).toMatchObject({ kind: 'pin', clearance: 0.2 });
    // Male A grows into B and the socket is removed from B. These volume
    // directions catch a cavity accidentally built on the non-receiving side.
    expect(meshVolume(result.pieceA)).toBeGreaterThan(meshVolume(baseline.pieceA));
    expect(meshVolume(result.pieceB)).toBeLessThan(meshVolume(baseline.pieceB));
  });
  it('7B-P02/P03/P04 places multiple pins, flips the mating sides, and applies radial clearance once', async () => {
    const baseline = await run({ kind: 'none' }),
      noGap = await run({
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 3,
        clearance: 0,
        maleSide: 'B',
      }),
      gap = await run({
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 3,
        clearance: 0.4,
        maleSide: 'B',
      });
    expect(meshVolume(noGap.pieceB)).toBeGreaterThan(meshVolume(baseline.pieceB));
    expect(meshVolume(noGap.pieceA)).toBeLessThan(meshVolume(baseline.pieceA));
    expect(meshVolume(gap.pieceA)).toBeLessThan(meshVolume(noGap.pieceA));
    expect(meshVolume(gap.pieceB)).toBeCloseTo(meshVolume(noGap.pieceB), 5);
  });
  it('7B-D01 adds one bounded dovetail', async () => {
    const baseline = await run({ kind: 'none' }),
      result = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0.2,
        maleSide: 'B',
        orientationDegrees: 90,
      });
    expect(result.connector).toMatchObject({ kind: 'dovetail', orientationDegrees: 90 });
    expect(meshVolume(result.pieceB)).toBeGreaterThan(meshVolume(baseline.pieceB));
    expect(meshVolume(result.pieceA)).toBeLessThan(meshVolume(baseline.pieceA));
  });
  it('7B-D02/D03/D04 aligns both orientations and expands only the female profile', async () => {
    const zero = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
      gap = await run({
        kind: 'dovetail',
        width: 4,
        depth: 3,
        length: 6,
        clearance: 0.3,
        maleSide: 'A',
        orientationDegrees: 90,
      });
    expect(meshVolume(gap.pieceA)).toBeCloseTo(meshVolume(zero.pieceA), 5);
    expect(meshVolume(gap.pieceB)).toBeLessThan(meshVolume(zero.pieceB));
  });
  it('7B-P05/D06 refuses connectors that do not fit the cut surface', async () => {
    await expect(
      run({ kind: 'pin', count: 1, diameter: 30, depth: 4, clearance: 0.2, maleSide: 'A' }),
    ).rejects.toThrow(/does not fit/);
    await expect(
      run({
        kind: 'dovetail',
        width: 30,
        depth: 3,
        length: 30,
        clearance: 0.2,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
    ).rejects.toThrow(/does not fit/);
  });
  it('7B-P04/D04 defines clearance dimensions directly', () => {
    expect(roundSocketRadius(4, 0.2)).toBe(2.2);
    expect(dovetailFemaleDimensions(8, 12, 0.2)).toEqual({ width: 8.4, length: 12.4 });
  });
  it('7B-C01/C02 keeps placement in material on a cap with a hole and refuses oversize', async () => {
    const source = torus(),
      result = await runOn(source, {
        kind: 'pin',
        count: 1,
        diameter: 1,
        depth: 2,
        clearance: 0.1,
        maleSide: 'A',
      }),
      placement = result.placements[0];
    expect(placement).toBeDefined();
    const radial = Math.hypot(placement?.[0] ?? 0, placement?.[1] ?? 0);
    expect(radial).toBeGreaterThan(5);
    expect(radial).toBeLessThan(11);
    expect(result.cutA.centerEdgeDistance).toBeGreaterThan(0.6);
    await expect(
      runOn(source, {
        kind: 'pin',
        count: 1,
        diameter: 6,
        depth: 2,
        clearance: 0.2,
        maleSide: 'A',
      }),
    ).rejects.toThrow(/edge margin|does not fit/);
  });
  it('7B-C04 places a dovetail in torus material rather than across its hole', async () => {
    const result = await runOn(torus(), {
        kind: 'dovetail',
        width: 1,
        depth: 2,
        length: 2,
        clearance: 0.1,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
      placement = result.placements[0];
    expect(Math.hypot(placement?.[0] ?? 0, placement?.[1] ?? 0)).toBeGreaterThan(5);
  });
  it('7B-C03 chooses deterministic valid regions across disconnected cut loops', async () => {
    const source = combine(translatedCube(0, -12, 0), translatedCube(0, 12, 0)),
      connector: SplitConnector = {
        kind: 'pin',
        count: 2,
        diameter: 2,
        depth: 2,
        clearance: 0.1,
        maleSide: 'A',
      },
      first = await runOn(source, connector),
      second = await runOn(source, connector);
    expect(first.placements).toEqual(second.placements);
    expect(first.placements).toHaveLength(2);
    for (const placement of first.placements) expect(Math.abs(placement[1])).toBeGreaterThan(7);
  });
  it('7B-P07 qualifies four non-overlapping pins with edge inset', async () => {
    const result = await run({
      kind: 'pin',
      count: 4,
      diameter: 2,
      depth: 3,
      clearance: 0.1,
      maleSide: 'A',
    });
    expect(result.placements).toHaveLength(4);
    for (let a = 0; a < result.placements.length; a++)
      for (let b = a + 1; b < result.placements.length; b++) {
        const left = result.placements[a] ?? [0, 0, 0],
          right = result.placements[b] ?? [0, 0, 0];
        expect(
          Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]),
        ).toBeGreaterThan(2);
      }
  });
  it('7B-P06/D05 qualifies explicit safe inset and near-edge refusals', async () => {
    const safePin = await run({
      kind: 'pin',
      count: 1,
      diameter: 2,
      depth: 3,
      clearance: 0.2,
      maleSide: 'A',
    });
    expect(safePin.cutA.centerEdgeDistance).toBeGreaterThan(1.55);
    await expect(
      run({ kind: 'pin', count: 1, diameter: 16, depth: 3, clearance: 0.2, maleSide: 'A' }),
    ).rejects.toThrow(/edge margin|does not fit/);
    await expect(
      run({
        kind: 'dovetail',
        width: 17,
        depth: 3,
        length: 17,
        clearance: 0.2,
        maleSide: 'A',
        orientationDegrees: 0,
      }),
    ).rejects.toThrow(/edge margin|does not fit/);
  });
  it('7B-S02/S05 closes the oblique, near-end, vertex, edge and thin-side plane matrix', async () => {
    await expect(splitAt(cube(), [0, 0, 0], [1, 1, 0])).resolves.toMatchObject({
      connector: { kind: 'none' },
    });
    await expect(splitAt(cube(), [9, 0, 0], [1, 0, 0])).resolves.toMatchObject({
      connector: { kind: 'none' },
    });
    await expect(splitAt(cube(), [10, 10, 10], [1, 1, 1])).rejects.toThrow(
      /does not pass through enough/,
    );
    await expect(splitAt(cube(), [10, 10, 0], [1, 1, 0])).rejects.toThrow(
      /does not pass through enough/,
    );
    await expect(splitAt(cube(), [9.99999, 0, 0], [1, 0, 0])).rejects.toThrow(
      /does not pass through enough/,
    );
  });
  it('7B-SH01 closes cylinder, sphere-like torus, concave, and disconnected-shell shapes', async () => {
    await expect(splitAt(cylinderMesh(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(splitAt(torus(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(splitAt(concavePrism(), [0, 0, 0], [0, 0, 1])).resolves.toBeDefined();
    await expect(
      splitAt(combine(translatedCube(0, -12, 0), translatedCube(0, 12, 0)), [0, 0, 0], [1, 0, 0]),
    ).resolves.toBeDefined();
  });

  it('UI-04 reports the real cross-section: area, outline loops and a bounded outline', async () => {
    // A 20 mm cube cut through its middle: one square outline of exactly 400.
    const cubeResult = await run({ kind: 'none' });
    expect(cubeResult.cutA.area).toBeCloseTo(400, 6);
    expect(cubeResult.cutA.loopCount).toBe(1);
    expect(cubeResult.cutA.outlineTruncated).toBe(false);
    // Every outline point lies on the cut plane x = 0.
    const outline = cubeResult.cutA.outline;
    expect(outline.length % 6).toBe(0);
    expect(outline.length).toBeGreaterThanOrEqual(4 * 6);
    for (let at = 0; at < outline.length; at += 3)
      expect(Math.abs(outline[at] ?? 1)).toBeLessThan(1e-4);

    // Two separate 10 mm squares: two outlines, 200 in total.
    const two = await runOn(combine(translatedCube(0, -12, 0), translatedCube(0, 12, 0)), {
      kind: 'none',
    });
    expect(two.cutA.loopCount).toBe(2);
    expect(two.cutA.area).toBeCloseTo(200, 6);

    // An annulus is ONE region with TWO outlines, which is why the count names
    // outlines rather than pieces. Its area lies between the inner and outer
    // circles' and below the ideal annulus, because the torus is polygonal.
    const annulus = await runOn(torus(), { kind: 'none' });
    expect(annulus.cutA.loopCount).toBe(2);
    expect(annulus.cutA.area).toBeGreaterThan(250);
    expect(annulus.cutA.area).toBeLessThan(Math.PI * (11 * 11 - 5 * 5));
  });

  it('uses coplanar neighbors for connector selection while reporting only the generated cap', async () => {
    const source = combine(cube(), translatedCube(30, 0, 5, 10));
    const backend = await createManifoldBooleanBackend(binary);
    const result = await splitWithConnectors(
      backend,
      source,
      {
        plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
        connector: { kind: 'automatic', unit: 'millimeter' },
      },
      uncancellable,
    );
    expect(result.automaticConnectorDiagnostics?.reason).toBe('NO_SAFE_SITE');
    const clip = result.closedPlaneClip;
    expect(clip?.interface.area).toBe(400);
    expect(clip?.interface.frame.N).toEqual([0, 0, 1]);
    for (const [cut, provenance] of [
      [result.cutA, clip?.provenanceA],
      [result.cutB, clip?.provenanceB],
    ] as const) {
      expect(cut).toMatchObject({
        authority: 'generated-mating-interface',
        area: 400,
        loopCount: 1,
      });
      expect(cut.triangleIds).toHaveLength(clip?.interface.capFaces ?? 0);
      expect(cut.triangleIds.every((face) => provenance?.[face] === -1)).toBe(true);
      expect(cut.bounds?.max[0]).toBe(10);
    }
  });

  it('UI-04 reports the finished piece volumes after connectors, beside the cut volumes', async () => {
    const plain = await run({ kind: 'none' });
    expect(plain.metrics.pieceAFinalVolume).toBe(plain.metrics.pieceAVolume);
    expect(plain.metrics.pieceBFinalVolume).toBe(plain.metrics.pieceBVolume);

    const pinned = await run({
      kind: 'pin',
      count: 1,
      diameter: 4,
      depth: 6,
      clearance: 0.2,
      maleSide: 'A',
    });
    // The male piece gains the pin; the other loses the larger socket.
    expect(pinned.metrics.pieceAFinalVolume).toBeCloseTo(meshVolume(pinned.pieceA), 9);
    expect(pinned.metrics.pieceAFinalVolume).toBeGreaterThan(pinned.metrics.pieceAVolume);
    expect(pinned.metrics.pieceBFinalVolume).toBeLessThan(pinned.metrics.pieceBVolume);
    const pinVolume = pinned.metrics.pieceAFinalVolume - pinned.metrics.pieceAVolume;
    const socketVolume = pinned.metrics.pieceBVolume - pinned.metrics.pieceBFinalVolume;
    expect(socketVolume).toBeGreaterThan(pinVolume);
  });
});

describe('bounded automatic connector realization', () => {
  it('sizes real male/socket geometry from a known millimetre cap and retains paired positions', async () => {
    const backend = await createManifoldBooleanBackend(binary),
      source = cube(30);
    const result = await splitWithConnectors(
      backend,
      source,
      {
        plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
        connector: { kind: 'automatic', unit: 'millimeter' },
      },
      new CancellationSource().token,
    );
    expect(result.automaticConnector).toBe('applied');
    expect(result.connector.kind).toBe('pin');
    if (result.connector.kind !== 'pin') throw new Error('Automatic pin missing');
    expect(result.connector.count).toBe(2);
    expect(result.connector.diameter).toBeGreaterThanOrEqual(1);
    expect(result.connector.diameter).toBeLessThanOrEqual(6);
    expect(result.placements).toHaveLength(2);
    expect(result.interface?.placements).toEqual(result.placements);
    expect(result.metrics.pieceAFinalVolume).toBeGreaterThan(result.metrics.pieceAVolume);
    expect(result.metrics.pieceBFinalVolume).toBeLessThan(result.metrics.pieceBVolume);
  });
  it('restores both plain pieces when a connector boolean fails after preparation', async () => {
    const backend = await createManifoldBooleanBackend(binary);
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          if (kind === 'difference') throw new Error('Controlled socket failure');
          return backend.operate(kind, a, b, token);
        },
      },
      cube(30),
      {
        plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
        connector: { kind: 'automatic', unit: 'millimeter' },
      },
      new CancellationSource().token,
    );
    expect(result.automaticConnector).toBe('unavailable');
    expect(result.connector).toEqual({ kind: 'none' });
    expect(result.placements).toEqual([]);
    expect(meshVolume(result.pieceA)).toBeCloseTo(13500, 3);
    expect(meshVolume(result.pieceB)).toBeCloseTo(13500, 3);
  });
  it('declines unsafe thin caps and nonuniform physical scaling without losing the plain split', async () => {
    const backend = await createManifoldBooleanBackend(binary);
    for (const [source, scale] of [
      [cube(4), 1],
      [cube(30), NaN],
    ] as const) {
      const result = await splitWithConnectors(
        backend,
        source,
        {
          plane: { origin: [0, 0, 0], normal: [0, 0, 1] },
          connector: { kind: 'automatic', unit: 'millimeter' },
        },
        new CancellationSource().token,
        undefined,
        scale,
      );
      expect(result.automaticConnector).toBe('unavailable');
      expect(result.connector.kind).toBe('none');
      expect(result.metrics.volumeRelativeError).toBeLessThan(1e-4);
    }
  });
  it('builds four oriented pieces with three independently matched physical pin interfaces', async () => {
    const backend = await createManifoldBooleanBackend(binary),
      source = cube(30);
    for (let i = 0; i < source.positions.length; i += 3)
      source.positions[i] = ((source.positions[i] ?? 0) * 80) / 30;
    const pieces: CanonicalMesh[] = [];
    let remainder = source;
    for (const x of [20, 0, -20]) {
      const result = await splitWithConnectors(
        backend,
        remainder,
        {
          plane: { origin: [x, 0, 0], normal: [1, 0, 0] },
          connector: { kind: 'automatic', unit: 'millimeter' },
        },
        new CancellationSource().token,
      );
      expect(result.automaticConnector).toBe('applied');
      expect(result.placements.length).toBeGreaterThan(0);
      expect(result.placements.every((p) => Math.abs(p[0] - x) < 1e-5)).toBe(true);
      pieces.push(result.pieceA);
      remainder = result.pieceB;
    }
    pieces.push(remainder);
    expect(pieces).toHaveLength(4);
    expect(pieces.every((p) => triangleCount(p) > 12)).toBe(true);
  });
});

it('automatic multi-part transactions export physical pairs and Undo restores the exact pre-action document', async () => {
  const backend = await createManifoldBooleanBackend(binary),
    mesh = cube(30);
  for (let i = 0; i < mesh.positions.length; i += 3)
    mesh.positions[i] = ((mesh.positions[i] ?? 0) * 80) / 30;
  const doc = singlePartDocument(mesh),
    resident = new ResidentDocumentStore(),
    history = new RepairHistoryStore(),
    edits = new GeometryEditStore(resident, history),
    splits = new SplitCandidateStore(resident, history, edits);
  let source = resident.commit(doc),
    currentPart = partId('part-1');
  let beforeLast = doc,
    lastRecord = '';
  const snapshots: Uint8Array[][] = [];
  for (const x of [20, 0, -20]) {
    const current = resident.resolve(source);
    if (isAppError(current)) throw current;
    const target = current.parts.find((p) => p.id === currentPart);
    if (!target) throw Error('Source part missing');
    beforeLast = current;
    snapshots.push(
      await Promise.all(
        current.parts.map(async (p) => (await writeBinaryStl(p.mesh, testReadContext())).bytes),
      ),
    );
    const ticket = splits.begin(source, currentPart),
      result = await splitWithConnectors(
        backend,
        target.mesh,
        {
          plane: { origin: [x, 0, 0], normal: [1, 0, 0] },
          connector: { kind: 'automatic', unit: 'millimeter' },
        },
        uncancellable,
      ),
      summary = splits.resolve(ticket, result, uncancellable);
    expect(result.automaticConnector).toBe('applied');
    const applied = splits.commit(summary.candidate, source, currentPart, (d) => d);
    source = applied.handle;
    currentPart = summary.pieceBId;
    lastRecord = applied.recordId;
    expect(applied.value.parts).toHaveLength(snapshots.length + 1);
  }
  const current = resident.resolve(source);
  if (isAppError(current)) throw current;
  expect(current.parts).toHaveLength(4);
  for (const p of current.parts) {
    const written = await writeBinaryStl(p.mesh, testReadContext());
    expect(new DataView(written.bytes.buffer).getUint32(80, true)).toBe(triangleCount(p.mesh));
    expect(triangleCount(p.mesh)).toBeGreaterThan(12);
  }
  const undo = history.prepareUndo(lastRecord, source, source.revision);
  if (isAppError(undo)) throw undo;
  expect(undo.inverse.previousDocument).toBe(beforeLast);
  const restored = resident.replace(source, beforeLast);
  if (isAppError(restored)) throw restored;
  history.markUndone(lastRecord);
  expect(resident.resolve(restored)).toBe(beforeLast);
  const after = await Promise.all(
    beforeLast.parts.map(async (p) => (await writeBinaryStl(p.mesh, testReadContext())).bytes),
  );
  expect(after).toEqual(snapshots[2]);
  expect(splits.stats().candidateCount).toBe(0);
});

it('retains the exact wall/depth-proven automatic sites on an oblique cap', async () => {
  const backend = await createManifoldBooleanBackend(binary),
    source = cube(24);
  for (let i = 0; i < source.positions.length; i += 3) {
    const x = source.positions[i] ?? 0,
      y = source.positions[i + 1] ?? 0;
    source.positions[i] = x * Math.cos(0.23) - y * Math.sin(0.23);
    source.positions[i + 1] = x * Math.sin(0.23) + y * Math.cos(0.23);
    source.positions[i + 2] = (source.positions[i + 2] ?? 0) * 1.5;
  }
  const plane = { origin: [0, 0, -10] as const, normal: [0, 0, -1] as const };
  const plain = await splitWithConnectors(
    backend,
    source,
    { plane, connector: { kind: 'none' } },
    uncancellable,
  );
  const { identifyConnectorCompatibilitySurface, splitTolerance } =
    await import('../../../../../packages/geometry-runtime/src/split-connectors');
  const { automaticPinPlan } =
    await import('../../../../../packages/geometry-runtime/src/automatic-connectors');
  const plan = automaticPinPlan(
    plain.pieceA,
    plain.pieceB,
    identifyConnectorCompatibilitySurface(plain.pieceA, plane, splitTolerance(source)),
    plane.normal,
    'millimeter',
    1,
    plain.metrics.tolerance,
    uncancellable,
  );
  const result = await splitWithConnectors(
    backend,
    source,
    { plane, connector: { kind: 'automatic', unit: 'millimeter' } },
    uncancellable,
  );
  expect(plan).toBeDefined();
  expect(result.automaticConnector).toBe('applied');
  expect(result.placements).toEqual(plan?.centers);
  expect(result.automaticConnectorDiagnostics).toMatchObject({
    reason: 'AVAILABLE',
    placementAttempts: 2,
    scratchBytes: 0,
  });
  expect(result.automaticConnectorDiagnostics?.rayTriangleVisits).toBeLessThanOrEqual(8000000);
});
it('connector site search observes cancellation without returning a partial plan', async () => {
  const backend = await createManifoldBooleanBackend(binary),
    source = cube(30),
    plane = { origin: [0, 0, 0] as const, normal: [0, 0, 1] as const };
  const plain = await splitWithConnectors(
    backend,
    source,
    { plane, connector: { kind: 'none' } },
    uncancellable,
  );
  const { identifyConnectorCompatibilitySurface, splitTolerance } =
    await import('../../../../../packages/geometry-runtime/src/split-connectors');
  const { automaticPinPlan } =
    await import('../../../../../packages/geometry-runtime/src/automatic-connectors');
  let polls = 0;
  expect(() =>
    automaticPinPlan(
      plain.pieceA,
      plain.pieceB,
      identifyConnectorCompatibilitySurface(plain.pieceA, plane, splitTolerance(source)),
      plane.normal,
      'millimeter',
      1,
      plain.metrics.tolerance,
      {
        get isCancelled(): boolean {
          return ++polls > 4;
        },
        onCancelled: (): (() => void) => (): void => undefined,
      },
    ),
  ).toThrow();
});
