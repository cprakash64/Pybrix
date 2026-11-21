function getAt<T>(values: Readonly<Record<number, T>>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('fixture index');
  return value;
}
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { CancellationSource, uncancellable } from '@cadfixer/shared';
import { choosePlaneSplitStrategy, splitOpenSurface } from './open-plane-split';
import { splitWithConnectors, type SplitPlane } from './split-connectors';
const P = [-1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1];
const I = [
  0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7,
  1, 7, 5,
];
function mesh(p: readonly number[], i: readonly number[]): CanonicalMesh {
  const positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
function cube(open = true): CanonicalMesh {
  return mesh(P, open ? I.filter((_, i) => i < 6 || i >= 12) : I);
}
function combine(...models: CanonicalMesh[]): CanonicalMesh {
  const p: number[] = [],
    i: number[] = [];
  for (const m of models) {
    const offset = p.length / 3;
    p.push(...m.positions);
    i.push(...Array.from(m.indices, (x) => x + offset));
  }
  return mesh(p, i);
}
function shift(m: CanonicalMesh, x: number, y = 0, z = 0): CanonicalMesh {
  return mesh(
    Array.from(m.positions, (v, i) => v + getAt([x, y, z], i % 3)),
    Array.from(m.indices),
  );
}
const plane: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };
const topology = (m: CanonicalMesh): ReturnType<typeof analyseTopology>['report'] =>
  analyseTopology(m, {
    documentId: 't',
    documentRevision: 0,
    partId: 'p',
    cancellation: uncancellable,
    sampleLimit: 0,
  }).report;
const run = (m: CanonicalMesh, p = plane): ReturnType<typeof splitOpenSurface> =>
  splitOpenSurface(m, p, uncancellable);
const bytes = (m: CanonicalMesh): Uint8Array => new Uint8Array(m.positions.buffer.slice(0));
describe('conservative open plane split', () => {
  it('keeps a clean cube on the exact strategy', () => {
    expect(choosePlaneSplitStrategy(cube(false), plane, uncancellable).strategy).toBe(
      'exact-solid',
    );
  });
  it('caps a cut despite an unrelated opening, retaining that opening', () => {
    const source = cube(),
      snapshot = bytes(source),
      r = run(source);
    expect(choosePlaneSplitStrategy(source, plane, uncancellable).strategy).toBe('open-surface');
    expect(r.cutA.loopCount).toBe(1);
    expect(r.cutA.area).toBe(4);
    expect(topology(r.pieceA).boundaryEdgeCount).toBe(4);
    expect(topology(r.pieceB).boundaryEdgeCount).toBe(0);
    expect(bytes(source)).toEqual(snapshot);
    expect(r.surfaceValidation?.sourceFaces).toBe(10);
    expect(r.surfaceValidation?.sourceArea).toBe(r.surfaceValidation?.outputArea);
  });
  it('preserves an opening crossing the plane as an uncapped chain', () => {
    const source = mesh(
      P,
      I.filter((_, i) => i < 30),
    );
    const r = run(source);
    expect(r.surfaceValidation?.openChains).toBe(1);
    expect(r.cutA.loopCount).toBe(0);
    expect(r.cutA.area).toBe(0);
    expect(r.surfaceValidation?.sourceArea).toBe(r.surfaceValidation?.outputArea);
  });
  it('handles disconnected shells and multiple loops', () => {
    const r = run(combine(shift(cube(), -3), shift(cube(), 3)));
    expect(r.cutA.loopCount).toBe(2);
    expect(r.cutA.area).toBe(8);
  });
  it.each([
    { origin: [0, 0, 0], normal: [1, 1, 0] },
    { origin: [0, 0, 0], normal: [1, 1, 1] },
  ] as const)('cuts through source vertices and edges deterministically %j', (p) => {
    const m = cube(),
      a = run(m, p),
      b = run(m, p);
    expect(a.pieceA.positions).toEqual(b.pieceA.positions);
    expect(a.pieceB.positions).toEqual(b.pieceB.positions);
  });
  it('declines a coplanar outer face when the plane does not separate the source', () => {
    expect(() => run(cube(), { origin: [0, 0, 1], normal: [0, 0, 1] })).toThrow();
  });
  it('refuses branching intersections without touching source', () => {
    const sheet = mesh(
      [0, 0, -1, 0, 1, 1, 0, -1, 1, -1, 0, 1, 1, 0, 1],
      [0, 1, 2, 0, 3, 4, 0, 1, 4],
    );
    const snapshot = bytes(sheet);
    expect(() => run(sheet)).toThrow();
    expect(bytes(sheet)).toEqual(snapshot);
  });
  it('retains untouched zero-area triangles and refuses collapsed cut fragments', () => {
    const m = combine(cube(), mesh([4, 0, 2, 4, 0, 2, 4, 0, 2], [0, 1, 2]));
    const r = run(m);
    expect(r.surfaceValidation?.sourceFaces).toBe(11);
    expect(topology(r.pieceA).repeatedPositionFaceCount).toBe(1);
  });
  it('handles many disconnected open components', () => {
    const r = run(combine(...Array.from({ length: 100 }, (_, i) => shift(cube(), i * 3))));
    expect(r.cutA.loopCount).toBe(100);
  });
  it('gives indexed and triangle soup identical triangle coordinates', () => {
    const a = cube(),
      p = Array.from(a.indices).flatMap((i) => Array.from(a.positions.slice(i * 3, i * 3 + 3))),
      soup = mesh(
        p,
        Array.from({ length: p.length / 3 }, (_, i) => i),
      );
    const r = run(a),
      s = run(soup);
    expect(r.pieceA.positions).toEqual(s.pieceA.positions);
    expect(r.pieceB.positions).toEqual(s.pieceB.positions);
  });
  it.each([1e-12, 1e12])('is model-scale aware at %s', (scale) => {
    const m = mesh(
      P.map((v) => v * scale),
      I.filter((_, i) => i < 6 || i >= 12),
    );
    const r = run(m);
    expect(r.surfaceValidation?.clippedFaces).toBeGreaterThan(0);
    expect(Number.isFinite(r.cutA.area)).toBe(true);
  });
  it('is translation safe at large coordinates', () => {
    const m = shift(
      mesh(
        P.map((v) => v * 1024),
        I.filter((_, i) => i < 6 || i >= 12),
      ),
      1e8,
      1e8,
      1e8,
    );
    const r = run(m, { origin: [1e8, 1e8, 1e8], normal: [0, 0, 1] });
    expect(r.cutA.loopCount).toBe(1);
  });
  it('does not call Boolean or add connectors for open input', async () => {
    let calls = 0;
    const backend = {
      operate: (): never => {
        calls++;
        throw Error('Boolean');
      },
    };
    const r = await splitWithConnectors(
      backend,
      cube(),
      { plane, connector: { kind: 'none' } },
      uncancellable,
    );
    expect(calls).toBe(0);
    expect(r.surfaceValidation).toBeDefined();
    await expect(
      splitWithConnectors(
        backend,
        cube(),
        {
          plane,
          connector: { kind: 'pin', count: 1, diameter: 1, depth: 1, clearance: 0, maleSide: 'A' },
        },
        uncancellable,
      ),
    ).rejects.toThrow('Choose None');
  });
  it('cancels before allocation', () => {
    const c = new CancellationSource();
    c.cancel();
    expect(() => splitOpenSurface(cube(), plane, c.token)).toThrow();
  });
});

describe('open split validation and transaction safety', () => {
  it('caps a nested cavity without filling its hole', () => {
    const outer = cube(),
      inner = mesh(
        P.map((x) => x / 2),
        Array.from(cube().indices),
      );
    for (let i = 0; i < inner.indices.length; i += 3) {
      const b = getAt(inner.indices, i + 1);
      inner.indices[i + 1] = getAt(inner.indices, i + 2);
      inner.indices[i + 2] = b;
    }
    const r = run(combine(outer, inner));
    expect(r.cutA.loopCount).toBe(2);
    expect(r.cutA.area).toBe(3);
    expect(topology(r.pieceA).nonManifoldEdgeCount).toBe(0);
    expect(topology(r.pieceB).boundaryEdgeCount).toBe(0);
  });
  it('preserves signed zero and all untouched coordinates exactly', () => {
    const extra = mesh([-0, 3, 2, 1, 3, 2, -0, 4, 2], [0, 1, 2]),
      r = run(combine(cube(), extra));
    const p = r.pieceA.positions;
    expect(Object.is(p[p.length - r.cutA.triangleIds.length * 9 - 9], -0)).toBe(true);
  });
  it('refuses a source above the unchanged 2M ceiling before topology work', () => {
    const source = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], []);
    const indices = createIndexArray(2_000_001 * 3);
    expect(() => choosePlaneSplitStrategy({ ...source, indices }, plane, uncancellable)).toThrow(
      'resource limit',
    );
  });
  it('rejects an invalid normal and finite geometry violations', () => {
    expect(() => run(cube(), { origin: [0, 0, 0], normal: [0, 0, 0] })).toThrow();
    const source = cube();
    source.positions[0] = NaN;
    expect(() => run(source)).toThrow();
  });
});

it('clips nearly coplanar triangles without collecting unrelated near-plane edges', () => {
  const r = run(mesh([-1, 0, 1e-10, 1, 0, -1e-10, 0, 1, 1e-10], [0, 1, 2]));
  expect(r.surfaceValidation?.openChains).toBe(1);
  expect(r.surfaceValidation?.clippedFaces).toBe(1);
  expect(r.cutA.area).toBe(0);
});
it('refuses duplicate cut segments transactionally', () => {
  const m = combine(cube(), mesh(P, I.slice(12, 15))),
    snapshot = bytes(m);
  let refusal: unknown;
  try {
    run(m);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    details: { code: 'CUT_NOT_SAFE', reason: 'duplicate-cut-segment' },
  });
  expect(bytes(m)).toEqual(snapshot);
});
it('refuses an unverified coplanar face at a prospective cap', () => {
  const m = combine(cube(), mesh([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], [0, 1, 2])),
    snapshot = bytes(m);
  expect(() => run(m)).toThrow();
  expect(bytes(m)).toEqual(snapshot);
});
it('enforces total cap vertex limits before triangulation', () => {
  const count = 4097,
    p: number[] = [],
    i: number[] = [];
  for (let k = 0; k < count; k++) {
    const a = (k * 2 * Math.PI) / count;
    p.push(Math.cos(a), Math.sin(a), -1, Math.cos(a), Math.sin(a), 1);
    const x = k * 2,
      y = ((k + 1) % count) * 2;
    i.push(x, y, y + 1, x, y + 1, x + 1);
  }
  expect(() => run(mesh(p, i))).toThrow('resource limit');
});
