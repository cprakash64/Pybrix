import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type { PartDescriptor, SplitCommitResult } from '@cadfixer/geometry-runtime';
import {
  assemblyAfterSplit,
  assemblyNormal,
  explosionOffsets,
  connectorAtAssemblyPoint,
  preservesAssemblyInterfaces,
} from './assembly-presentation';
function part(id: string, lo: number, hi: number): PartDescriptor {
  return {
    partId: id,
    transform: IDENTITY_PART_TRANSFORM,
    triangleCount: 12,
    vertexCount: 8,
    meshResourceIndex: 0,
    groupCount: 0,
    groupMaterialRefCount: 0,
    hasNormals: false,
    hasUvs: false,
    bounds: {
      min: [lo, -15, -15],
      max: [hi, 15, 15],
      center: [(lo + hi) / 2, 0, 0],
      size: [hi - lo, 30, 30],
      radius: Math.hypot(hi - lo, 30, 30) / 2,
    },
  };
}
function result(
  recordId: string,
  a: PartDescriptor,
  b: PartDescriptor,
  others: readonly PartDescriptor[],
  x: number,
): SplitCommitResult {
  return {
    recordId,
    metrics: { tolerance: 0.00001 },
    parentRevision: Number(recordId) - 1,
    handle: { documentId: 'assembly-test', revision: Number(recordId) },
    pieceAId: a.partId,
    pieceBId: b.partId,
    parts: [...others, a, b],
    bounds: {
      min: [-40, -15, -15],
      max: [40, 15, 15],
      center: [0, 0, 0],
      size: [80, 30, 30],
      radius: Math.hypot(80, 30, 30) / 2,
    },
    connector: { kind: 'pin', count: 2, diameter: 3.6, depth: 5.4, clearance: 0.2, maleSide: 'A' },
    interface: {
      plane: { origin: [x, 0, 0], normal: [1, 0, 0] },
      center: [x, 0, 0],
      bounds: { min: [x, -15, -15], max: [x, 15, 15] },
      connectorEligible: true,
      placements: [
        [x, -5, 0],
        [x, 5, 0],
      ],
    },
  } as unknown as SplitCommitResult;
}
describe('assembly presentation leaves canonical geometry authoritative', () => {
  it('preserves three cut adjacencies and six explicit connector pairs through four-piece decomposition', () => {
    const p1 = part('first', 20, 40),
      p2 = part('second', 0, 20),
      p3 = part('third', -20, 0),
      p4 = part('fourth', -40, -20),
      firstRest = part('rest1', -40, 20),
      secondRest = part('rest2', -40, 0);
    const context = (
      sourcePartId: string,
      x: number,
    ): {
      sourcePartId: string;
      sourceTransform: readonly number[];
      plane: {
        origin: readonly [number, number, number];
        normal: readonly [number, number, number];
      };
    } => ({
      sourcePartId,
      sourceTransform: IDENTITY_PART_TRANSFORM,
      plane: { origin: [x, 0, 0] as const, normal: [1, 0, 0] as const },
    });
    let assembly = assemblyAfterSplit(
      result('1', p1, firstRest, [], 20),
      context('source', 20),
      undefined,
    );
    assembly = assemblyAfterSplit(
      result('2', p2, secondRest, [p1], 0),
      context('rest1', 0),
      assembly,
    );
    const parts = [p1, p2, p3, p4],
      before = JSON.stringify(parts);
    assembly = assemblyAfterSplit(
      result('3', p3, p4, [p1, p2], -20),
      context('rest2', -20),
      assembly,
    );
    expect(assembly.interfaces.map((e) => [e.a, e.b])).toEqual([
      ['first', 'second'],
      ['second', 'third'],
      ['third', 'fourth'],
    ]);
    expect(assembly.connectorPairs).toHaveLength(6);
    expect(new Set(assembly.connectorPairs.map((p) => p.id)).size).toBe(6);
    for (const pair of assembly.connectorPairs)
      expect(assembly.interfaces.find((e) => e.id === pair.interfaceId)).toMatchObject({
        a: pair.a,
        b: pair.b,
      });
    expect(assembly.offsets).toHaveLength(4);
    expect(explosionOffsets(parts, assembly.interfaces, Math.hypot(80, 30, 30))).toEqual(
      assembly.offsets,
    );
    const xOffsets = new Map(assembly.offsets.map((p) => [p.partId, p.offset[0]]));
    for (let i = 0; i < 3; i++)
      expect(
        (parts[i]?.bounds?.min[0] ?? 0) + (xOffsets.get(parts[i]?.partId ?? '') ?? 0),
      ).toBeGreaterThan(
        (parts[i + 1]?.bounds?.max[0] ?? 0) + (xOffsets.get(parts[i + 1]?.partId ?? '') ?? 0),
      );
    expect(JSON.stringify(parts)).toBe(before);
    expect(assembly.exploded).toBe(true);
  });
  it('moves two pieces only along the transformed cut normal and preserves mirrored/nonuniform orientation', () => {
    const n = assemblyNormal([1, 1, 0], [2, 0, 0, 0, 1, 0, 0, 0, 1, 9, 10, 11]);
    expect(n[1] / n[0]).toBeCloseTo(2);
    expect(assemblyNormal([1, 0, 0], [-2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).toEqual([-1, 0, 0]);
    const a = part('a', 0, 10),
      b = part('b', -10, 0),
      r = result('1', a, b, [], 0),
      assembly = assemblyAfterSplit(
        r,
        {
          sourcePartId: 'source',
          sourceTransform: IDENTITY_PART_TRANSFORM,
          plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
        },
        undefined,
      );
    expect(assembly.offsets[0]?.offset[0]).toBeGreaterThan(0);
    expect(assembly.offsets[1]?.offset[0]).toBeLessThan(0);
    expect(assembly.offsets.every((p) => p.offset[1] === 0 && p.offset[2] === 0)).toBe(true);
  });
  it('selects an explicit pin pair on either side and refuses cuts that would break its geometry', () => {
    const a = part('a', 0, 40),
      b = part('b', -40, 0),
      assembly = assemblyAfterSplit(
        result('1', a, b, [], 0),
        {
          sourcePartId: 'source',
          sourceTransform: IDENTITY_PART_TRANSFORM,
          plane: { origin: [0, 0, 0], normal: [1, 0, 0] },
        },
        undefined,
      ),
      pair = assembly.connectorPairs[0];
    expect(connectorAtAssemblyPoint(assembly, a, [-3, -3.2, 0])).toBe(pair?.id);
    expect(connectorAtAssemblyPoint(assembly, b, [-3, -3, 0])).toBe(pair?.id);
    expect(connectorAtAssemblyPoint(assembly, a, [20, -5, 0])).toBeUndefined();
    expect(
      preservesAssemblyInterfaces(
        assembly,
        'a',
        { origin: [2, 0, 0], normal: [1, 0, 0] },
        IDENTITY_PART_TRANSFORM,
      ),
    ).toBe(false);
    expect(
      preservesAssemblyInterfaces(
        assembly,
        'a',
        { origin: [20, 0, 0], normal: [1, 0, 0] },
        IDENTITY_PART_TRANSFORM,
      ),
    ).toBe(true);
  });
  it('creates no invented interface or connector for disconnected component extraction', () => {
    const r = result('1', part('a', 0, 10), part('b', -10, 0), [], 0),
      assembly = assemblyAfterSplit(
        r,
        { sourcePartId: 'source', sourceTransform: IDENTITY_PART_TRANSFORM, label: 'Wheel group' },
        undefined,
      );
    expect(assembly.interfaces).toEqual([]);
    expect(assembly.connectorPairs).toEqual([]);
    expect(assembly.labels.a).toBe('Wheel group');
  });
});
