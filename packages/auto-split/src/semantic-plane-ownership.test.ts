import { beforeAll, describe, expect, it } from 'vitest';
import {
  VIEW_NAMES,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import {
  decomposeSemantic,
  prepareSemanticGeometry,
  type PreparedSemanticGeometry,
} from './semantic';
import {
  confirmSemanticPlane,
  planeOwnershipTelemetry,
  synthesizeSemanticPlane,
} from './semantic-local-plane';
import { box, concatMeshes, voxelUnion } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { required } from './required';
let mesh: CanonicalMesh, prepared: PreparedSemanticGeometry, answer: SemanticHierarchy;
let faceRoles: number[];
const names = ['Base', 'Body', 'Neck', 'Cap'];
function annotated(
  p: PreparedSemanticGeometry,
  roles: readonly number[],
  count = 4,
): SemanticHierarchy {
  const parts: SemanticPart[] = Array.from({ length: count }, (_x, i) => ({
    id: `role-${String(i)}`,
    label: names[i] ?? `Physical role ${String(i)}`,
    parentId: null,
    importance: 'major',
    confidence: 0.99,
    instances: 1,
    componentIds: [],
    expectedGeometry: { kind: 'solid_part', likelySeparable: true },
    cut: null,
    views: [],
  }));
  for (const [vi, view] of VIEW_NAMES.entries()) {
    const raster = required(p.rasters[vi], 'raster'),
      bounds = parts.map(() => [raster.size, raster.size, -1, -1]);
    for (let pixel = 0; pixel < raster.face.length; pixel++) {
      const face = raster.face[pixel] ?? -1,
        role = roles[face];
      if (face < 0 || role === undefined) continue;
      const b = bounds[role];
      if (!b) continue;
      const x = pixel % raster.size,
        y = Math.floor(pixel / raster.size);
      b[0] = Math.min(b[0] ?? raster.size, x);
      b[1] = Math.min(b[1] ?? raster.size, y);
      b[2] = Math.max(b[2] ?? -1, x);
      b[3] = Math.max(b[3] ?? -1, y);
    }
    parts.forEach((part, i) => {
      const b = required(bounds[i], 'bounds');
      if ((b[2] ?? -1) < 0) return;
      const x0 = (b[0] ?? 0) / raster.size,
        y0 = (b[1] ?? 0) / raster.size,
        x1 = ((b[2] ?? 0) + 1) / raster.size,
        y1 = ((b[3] ?? 0) + 1) / raster.size;
      parts[i] = {
        ...part,
        views: [
          ...part.views,
          {
            view,
            polygons: [
              [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
              ],
            ],
          },
        ],
      };
    });
  }
  return { object: { label: 'Unspecified connected physical chain', confidence: 0.99 }, parts };
}
function membership(
  p: PreparedSemanticGeometry,
  result: ReturnType<typeof decomposeSemantic>,
  id: string,
  roles: readonly number[],
  role: number,
): { precision: number; recall: number } {
  const s = required(
    result.suggestions.find((x) => x.id === id),
    'suggestion',
  );
  expect(s.operation).toBe('PLANE');
  expect(s.quality).toBe('READY');
  const plane = required(s.plane ?? undefined, 'plane');
  let selected = 0,
    hit = 0,
    truth = 0;
  for (let f = 0; f < p.geometry.faceCount; f++) {
    let signed = 0;
    for (let a = 0; a < 3; a++) {
      let c = 0;
      for (let k = 0; k < 3; k++)
        c += (p.geometry.positions[(p.geometry.indices[f * 3 + k] ?? 0) * 3 + a] ?? 0) / 3;
      const source = c * p.geometry.scale + (p.geometry.center[a] ?? 0);
      signed += (source - (plane.origin[a] ?? 0)) * (plane.normal[a] ?? 0);
    }
    if (roles[f] === role) truth++;
    if (signed >= 0) {
      selected++;
      if (roles[f] === role) hit++;
    }
  }
  return { precision: hit / selected, recall: hit / truth };
}
beforeAll(async () => {
  mesh = voxelUnion([
    { lo: [-4, -3, 0], hi: [4, 3, 1] },
    { lo: [-2, -2, 1], hi: [2, 2, 4] },
    { lo: [-1, -1, 4], hi: [1, 1, 7] },
    { lo: [-3, -3, 7], hi: [3, 3, 9] },
  ]);
  faceRoles = Array.from({ length: mesh.indices.length / 3 }, (_x, f) => {
    const z =
      [0, 1, 2].reduce(
        (n, k) => n + (mesh.positions[(mesh.indices[f * 3 + k] ?? 0) * 3 + 2] ?? 0),
        0,
      ) / 3;
    return z >= 7 ? 3 : z >= 4 ? 2 : z >= 1 ? 1 : 0;
  });
  prepared = await prepareSemanticGeometry(mesh, fixtureDeflate);
  answer = annotated(prepared, faceRoles);
});
describe('all-peer semantic plane ownership before publication', () => {
  it('the nearby neck wins over a far base; all chain peers remain individually visible', () => {
    const local = decomposeSemantic(prepared, answer),
      metric = membership(prepared, local, 'role-3', faceRoles, 3);
    expect(metric.precision).toBeGreaterThanOrEqual(0.9);
    expect(metric.recall).toBeGreaterThanOrEqual(0.9);
    const evidence = required(
      local.evidence.find((e) => e.id === 'role-3')?.localPlane,
      'plane evidence',
    );
    expect(evidence.ownership.rule).toBe('CLEAN_PHYSICAL_EXTENT');
    expect(evidence.ownership.peers.map((p) => p.id).sort()).toEqual([
      'role-0',
      'role-1',
      'role-2',
    ]);
    expect(evidence.ownership.worstPeerLeakage).toBeLessThanOrEqual(0.1);
  });
  it('a geometrically attractive prior swallowing the neck cannot bypass final ownership', () => {
    const cap = required(answer.parts[3], 'cap'),
      raw = { ...cap, cut: { normal: [0, 0, 1] as const, origin: [0, 0, -0.25] as const } };
    const proposal = synthesizeSemanticPlane(prepared, answer, raw, () => undefined);
    expect(proposal).toBeDefined();
    expect(proposal?.ownership.worstPeerLeakage).toBeLessThanOrEqual(0.1);
    expect(
      confirmSemanticPlane(
        prepared,
        answer,
        raw,
        raw.cut,
        required(proposal, 'proposal'),
        () => undefined,
      ),
    ).toBeUndefined();
  });
  it('arbitrary physical labels cannot change plane ownership', () => {
    const renamed = {
      ...answer,
      parts: answer.parts.map((p, i) => ({ ...p, label: `Anonymous member ${String(i)}` })),
    };
    const metric = membership(
      prepared,
      decomposeSemantic(prepared, renamed),
      'role-3',
      faceRoles,
      3,
    );
    expect(metric.precision).toBeGreaterThanOrEqual(0.9);
  });
  it('a missing peer polygon cannot erase other grounded views', () => {
    const missing = {
      ...answer,
      parts: answer.parts.map((p) => (p.id === 'role-2' ? { ...p, views: p.views.slice(1) } : p)),
    };
    const metric = membership(
      prepared,
      decomposeSemantic(prepared, missing),
      'role-3',
      faceRoles,
      3,
    );
    expect(metric.precision).toBeGreaterThanOrEqual(0.9);
  });
  it('ancestors are not competing peers, but independently meaningful siblings are', () => {
    const parent = {
      ...required(answer.parts[1], 'parent'),
      id: 'parent',
      importance: 'detail' as const,
    };
    const nested = {
      ...answer,
      parts: [parent, ...answer.parts.map((p) => ({ ...p, parentId: 'parent' }))],
    };
    const local = decomposeSemantic(prepared, nested),
      metric = membership(prepared, local, 'role-3', faceRoles, 3);
    expect(metric.precision).toBeGreaterThanOrEqual(0.9);
    expect(
      local.evidence
        .find((e) => e.id === 'role-3')
        ?.localPlane?.ownership.peers.some((p) => p.id === 'parent'),
    ).toBe(false);
  });
  it('surface-only decorative children do not become physical competition', () => {
    const cap = required(answer.parts[3], 'cap'),
      detail = {
        ...cap,
        id: 'surface',
        parentId: cap.id,
        importance: 'detail' as const,
        expectedGeometry: { kind: 'surface_part' as const, likelySeparable: false },
      };
    const local = decomposeSemantic(prepared, { ...answer, parts: [...answer.parts, detail] });
    expect(
      local.evidence
        .find((e) => e.id === cap.id)
        ?.localPlane?.ownership.peers.some((p) => p.id === 'surface'),
    ).toBe(false);
    expect(membership(prepared, local, cap.id, faceRoles, 3).precision).toBeGreaterThanOrEqual(0.9);
  });
  it('an independent component is stronger than a loose background region', async () => {
    const extra = box([6, -2, 2], [9, 2, 4]),
      combined = concatMeshes([mesh, extra]),
      roles = [...faceRoles, ...Array<number>(extra.indices.length / 3).fill(4)],
      p = await prepareSemanticGeometry(combined, fixtureDeflate),
      a = annotated(p, roles, 5),
      local = decomposeSemantic(p, a);
    const peer = local.evidence
      .find((e) => e.id === 'role-3')
      ?.localPlane?.ownership.peers.find((p) => p.id === 'role-4');
    expect(peer?.exactComponent).toBe(true);
    expect(peer?.leakage).toBeLessThanOrEqual(0.1);
    expect(membership(p, local, 'role-3', roles, 3).precision).toBeGreaterThanOrEqual(0.9);
  });
  it('translation and rotation do not introduce fixture-axis rules', async () => {
    const positions = mesh.positions.slice();
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] ?? 0,
        y = positions[i + 1] ?? 0,
        z = positions[i + 2] ?? 0;
      positions[i] = x + 13;
      positions[i + 1] = -z - 8;
      positions[i + 2] = y + 3;
    }
    const p = await prepareSemanticGeometry({ ...mesh, positions }, fixtureDeflate),
      a = annotated(p, faceRoles),
      local = decomposeSemantic(p, a),
      metric = membership(p, local, 'role-3', faceRoles, 3);
    expect(metric.precision).toBeGreaterThanOrEqual(0.9);
    expect(metric.recall).toBeGreaterThanOrEqual(0.9);
  });
  it('projection, peer scoring, offset sweep and ranking all charge the existing bounded work sink', () => {
    const t = planeOwnershipTelemetry();
    let charged = 0;
    const cap = required(answer.parts[3], 'cap');
    const proposal = synthesizeSemanticPlane(prepared, answer, cap, () => undefined, {
      telemetry: t,
      charge: () => {
        charged++;
      },
    });
    expect(proposal).toBeDefined();
    expect(t.workUnits).toBe(charged);
    expect(t.peers).toBeLessThanOrEqual(23);
    expect(t.normals).toBeLessThanOrEqual(32);
    expect(t.histogramBins).toBe(64);
    expect(t.offsets).toBeLessThanOrEqual(32 * 64 * 2);
    expect(t.finalists).toBeLessThanOrEqual(3);
  });
  for (const work of [1, 30000, 120000, 300000])
    it(`cancellation/work abort at ${String(work)} publishes no candidate`, () => {
      const t = planeOwnershipTelemetry(),
        before = prepared.geometry.positions.slice();
      let count = 0,
        result: unknown;
      expect(() => {
        result = synthesizeSemanticPlane(
          prepared,
          answer,
          required(answer.parts[3], 'cap'),
          () => undefined,
          {
            telemetry: t,
            charge: () => {
              if (++count === work) throw Error('cancelled');
            },
          },
        );
      }).toThrow('cancelled');
      expect(result).toBeUndefined();
      expect(prepared.geometry.positions).toEqual(before);
    });
  for (const phase of [
    'projection',
    'peer scoring',
    'offset sweep',
    'ranking',
    'finalists',
  ] as const)
    it(`checkpoint cancellation during ${phase} publishes nothing`, () => {
      const t = planeOwnershipTelemetry();
      let result: unknown;
      const checkpoint = (): void => {
        const reached =
          phase === 'projection'
            ? t.normals > 0
            : phase === 'peer scoring'
              ? t.peerScoringPasses > 0
              : phase === 'offset sweep'
                ? t.offsets > 0
                : phase === 'ranking'
                  ? t.rankingComparisons > 0
                  : t.finalists > 0;
        if (reached) throw Error('cancelled');
      };
      expect(() => {
        result = synthesizeSemanticPlane(
          prepared,
          answer,
          required(answer.parts[3], 'cap'),
          checkpoint,
          { telemetry: t, charge: () => undefined },
        );
      }).toThrow('cancelled');
      expect(result).toBeUndefined();
    });
  it('calling a target an assembly cannot excuse avoidable nearby physical support', () => {
    const fused = {
      ...answer,
      parts: answer.parts.map((p) => ({
        ...p,
        label: `${p.label} assembly`,
        expectedGeometry: { ...p.expectedGeometry, likelySeparable: false },
      })),
    };
    const local = decomposeSemantic(prepared, fused);
    expect(membership(prepared, local, 'role-3', faceRoles, 3).precision).toBeGreaterThanOrEqual(
      0.9,
    );
    expect(local.evidence.find((e) => e.id === 'role-3')?.localPlane?.ownership.rule).toBe(
      'CLEAN_PHYSICAL_EXTENT',
    );
  });
  it('a coarse whole-object concept cannot invent a split from an unknown border', async () => {
    const solid = box([-2, -1, -3], [2, 1, 3]),
      p = await prepareSemanticGeometry(solid, fixtureDeflate),
      hierarchy = annotated(p, Array<number>(solid.indices.length / 3).fill(0), 1);
    const part = required(hierarchy.parts[0], 'whole concept');
    const cropped = {
      ...part,
      views: part.views.map((v) => ({
        ...v,
        polygons: v.polygons.map((poly) =>
          poly.map(
            ([x, y]) => [x < 0.5 ? x + 0.002 : x - 0.002, y < 0.5 ? y + 0.002 : y - 0.002] as const,
          ),
        ),
      })),
    };
    expect(decomposeSemantic(p, { ...hierarchy, parts: [cropped] }).suggestions[0]?.operation).toBe(
      'NONE',
    );
  });

  it('an intentionally inclusive fused frame assembly survives when no cleaner comparable cut exists', async () => {
    const fused = voxelUnion([
      { lo: [-6, -2, -3], hi: [6, 2, -2] },
      { lo: [-1, -1, -2], hi: [1, 1, 4] },
      { lo: [-5, -1, 0], hi: [-3, 1, 12] },
      { lo: [3, -1, 0], hi: [5, 1, 12] },
      { lo: [-3, -1, 10], hi: [3, 1, 12] },
      { lo: [-3, -1, 4], hi: [1, 1, 5] },
    ]);
    const roles = Array.from({ length: fused.indices.length / 3 }, (_x, f) => {
      const c = [0, 1, 2].map(
        (a) =>
          [0, 1, 2].reduce(
            (n, k) => n + (fused.positions[(fused.indices[f * 3 + k] ?? 0) * 3 + a] ?? 0),
            0,
          ) / 3,
      );
      return (c[2] ?? 0) < 0
        ? 0
        : (c[0] ?? 0) <= -3 || (c[0] ?? 0) >= 3 || (c[2] ?? 0) >= 10
          ? 2
          : 1;
    });
    const p = await prepareSemanticGeometry(fused, fixtureDeflate),
      a = annotated(p, roles, 3);
    const parts = a.parts.map((part, i) => ({
      ...part,
      label: i === 2 ? 'Frame assembly' : part.label,
      parentId: i === 1 ? 'role-2' : null,
      expectedGeometry: { ...part.expectedGeometry, likelySeparable: false },
    }));
    const result = synthesizeSemanticPlane(
      p,
      { ...a, parts },
      required(parts[2], 'frame'),
      () => undefined,
    );
    expect(result).toBeDefined();
    expect(result?.ownership.rule).toBe('BEST_FEASIBLE_FUSED_ASSEMBLY');
    expect(result?.ownership.targetRecall).toBeGreaterThanOrEqual(0.95);
    expect(result?.ownership.comparableCleanerCandidates).toBe(0);
    expect(result?.ownership.peers.some((peer) => peer.id === 'role-1' && peer.leakage > 0.1)).toBe(
      true,
    );
  });
});
