import { describe, expect, it } from 'vitest';
import { IDENTITY_PART_TRANSFORM } from '@cadfixer/mesh-core';
import type {
  JointDescriptor,
  PartDescriptor,
  SplitCommitResult,
} from '@cadfixer/geometry-runtime';
import { connectorAtPoint, connectorPairsOf } from './joint-presentation';
import {
  assemblyAfterSplit,
  assemblyForSplitPreview,
  assemblyNormal,
  explosionOffsets,
  preservesAssemblyInterfaces,
} from './assembly-presentation';
import type { SplitAssemblyContext } from './assembly-presentation';
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
  it('preserves three cut adjacencies through four-piece decomposition', () => {
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
    // The presentation keeps no record of connectors: which exist is the worker's to say (`joint-presentation.test.ts`).
    expect('connectorPairs' in assembly).toBe(false);
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
  it("selects a pin on either side from the worker's list and refuses cuts that would break its geometry", () => {
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
      );
    // two 3.6 mm pins with 0.2 clearance and 5.4 mm depth on the cut at x = 0, as the worker lists them, in a model read in millimetres
    const listed: JointDescriptor = {
      jointId: 'assembly-test/joint/1',
      aPartId: 'a',
      bPartId: 'b',
      status: 'ATTACHED',
      pinCount: 2,
      retainedBytes: 0,
      specDigest: 'digest',
      connector: {
        maleSide: 'A',
        axis: [-1, 0, 0],
        mmPerSceneUnit: 1,
        pins: [-5, 5].map((y, index) => ({
          pinId: `pin-${String(index + 1)}`,
          u: y,
          v: 0,
          center: [0, y, 0] as const,
          diameterMm: 3.6,
          depthMm: 5.4,
          clearanceMm: 0.2,
        })),
      },
    };
    const pairs = connectorPairsOf([listed]),
      pair = pairs[0];
    expect(connectorAtPoint(pairs, a, [-3, -3.2, 0])).toBe(pair?.id);
    expect(connectorAtPoint(pairs, b, [-3, -3, 0])).toBe(pair?.id);
    expect(connectorAtPoint(pairs, a, [20, -5, 0])).toBeUndefined();
    expect(
      preservesAssemblyInterfaces(
        assembly,
        'a',
        { origin: [2, 0, 0], normal: [1, 0, 0] },
        IDENTITY_PART_TRANSFORM,
        pairs,
      ),
    ).toBe(false);
    expect(
      preservesAssemblyInterfaces(
        assembly,
        'a',
        { origin: [20, 0, 0], normal: [1, 0, 0] },
        IDENTITY_PART_TRANSFORM,
        pairs,
      ),
    ).toBe(true);
    // what guards that plane is the worker's connectors alone: with none listed, the same cut beside the same interface is allowed
    expect(
      preservesAssemblyInterfaces(
        assembly,
        'a',
        { origin: [2, 0, 0], normal: [1, 0, 0] },
        IDENTITY_PART_TRANSFORM,
        [],
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
    expect(assembly.labels.a).toBe('Wheel group');
  });
});

describe('the assembly of a split PREVIEW', () => {
  const source = { documentId: 'assembly-test' as never, revision: 4 };
  const a = part('piece-a', 0, 40),
    b = part('piece-b', -40, 0);
  const preview = (x: number, parts = [a, b]): Parameters<typeof assemblyForSplitPreview>[1] => {
    const commit = result('5', a, b, [], x);
    return {
      candidate: { candidateId: 'rt:split-candidate-9' },
      parts,
      pieceAId: commit.pieceAId,
      pieceBId: commit.pieceBId,
      connector: commit.connector,
      metrics: commit.metrics,
      interface: commit.interface,
    } as unknown as Parameters<typeof assemblyForSplitPreview>[1];
  };
  const context = (x: number): SplitAssemblyContext => ({
    sourcePartId: 'source',
    sourceTransform: IDENTITY_PART_TRANSFORM,
    plane: { origin: [x, 0, 0] as const, normal: [1, 0, 0] as const },
  });

  it('is built by the same code as the applied view, so the two cannot disagree', () => {
    const shown = assemblyForSplitPreview(source, preview(0), context(0), undefined);
    const applied = assemblyAfterSplit(
      result('5', a, b, [], 0),
      { ...context(0), sourcePartId: 'source' },
      undefined,
    );
    expect(shown.offsets).toEqual(applied.offsets);
    expect(shown.connectorMode).toBe(applied.connectorMode);
    expect(shown.interfaces.map((e) => e.normal)).toEqual(applied.interfaces.map((e) => e.normal));
  });

  it('starts assembled, names a provisional revision and marks its identities as preview', () => {
    const shown = assemblyForSplitPreview(source, preview(0), context(0), undefined);
    expect(shown.exploded).toBe(false);
    expect(shown.documentId).toBe('assembly-test');
    expect(shown.revision).toBe(5);
    expect(shown.interfaces[0]?.id).toBe('rt:split-candidate-9#preview');
  });

  it('separates the two pieces along the cut normal only: A (the +N side) one way, B the other', () => {
    const shown = assemblyForSplitPreview(source, preview(0), context(0), undefined);
    const offsetA = shown.offsets.find((o) => o.partId === 'piece-a')?.offset ?? [0, 0, 0],
      offsetB = shown.offsets.find((o) => o.partId === 'piece-b')?.offset ?? [0, 0, 0];
    expect(offsetA[0]).toBeGreaterThan(0);
    expect(offsetB[0]).toBeCloseTo(-offsetA[0], 12);
    expect(offsetA[1]).toBeCloseTo(0, 12);
    expect(offsetA[2]).toBeCloseTo(0, 12);
    // The distance is a fraction of the assembly's own size: scale-independent.
    const distance = Math.hypot(...offsetA);
    expect(distance).toBeCloseTo(Math.hypot(80, 30, 30) * 0.14, 6);
  });

  it('reads its inputs and changes none of them: translation only, nothing mutated', () => {
    const input = preview(0),
      before = JSON.stringify([input, context(0)]);
    assemblyForSplitPreview(source, input, context(0), undefined);
    expect(JSON.stringify([input, context(0)])).toBe(before);
  });

  it("measures the assembly in world units, through each part's own placement", () => {
    const scaled = (p: PartDescriptor): PartDescriptor => ({
      ...p,
      transform: [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0],
    });
    const plain = assemblyForSplitPreview(source, preview(0), context(0), undefined),
      doubled = assemblyForSplitPreview(
        source,
        preview(0, [scaled(a), scaled(b)]),
        { ...context(0), sourceTransform: [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0] },
        undefined,
      );
    const distance = (assembly: typeof plain): number =>
      Math.hypot(...(assembly.offsets.find((o) => o.partId === 'piece-a')?.offset ?? [0, 0, 0]));
    expect(distance(doubled)).toBeCloseTo(distance(plain) * 2, 6);
  });
});
