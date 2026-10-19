import { expect, it } from 'vitest';
import {
  cameraFor,
  FRAME_FILL,
  VIEW_NAMES,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import { voxelUnion } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import { prepareSemanticGeometry } from './semantic';
import { refineSemanticPlanes, semanticShoulderOwnership } from './semantic-plane';
import { CHECKPOINT_STRIDE } from './checkpoint';

it('preserves shoulder surface ownership when the minimum plateau extends beyond the refinement band', async () => {
  const mesh = voxelUnion([
      { lo: [-37, -3, -2], hi: [8, 3, 2] },
      { lo: [8, -12, -8], hi: [43, 12, 8] },
    ]),
    prepared = await prepareSemanticGeometry(mesh, fixtureDeflate),
    cut = {
      normal: [1, 0, 0] as const,
      origin: [(8.26 - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0] as const,
    },
    part: SemanticPart = {
      id: 'member',
      label: 'Unfamiliar member',
      parentId: null,
      confidence: 0.99,
      instances: 1,
      componentIds: [],
      views: [],
      importance: 'major',
      expectedGeometry: { kind: 'solid_part', likelySeparable: true },
      cut,
    },
    before = prepared.geometry.positions.slice(),
    result = refineSemanticPlanes(prepared.geometry, [part], () => undefined),
    refinement = result.refinements.get(part.id);
  expect(refinement?.cut).toEqual(cut);
  expect(refinement?.chosenOffset).toBe(refinement?.proposedOffset);
  expect(refinement?.sectionProfile).toHaveLength(9);
  expect(prepared.geometry.positions).toEqual(before);
});

it('retains refinement toward a neck minimum bracketed inside the bounded section profile', async () => {
  const mesh = voxelUnion([
      { lo: [-37, -12, -8], hi: [-1, 12, 8] },
      { lo: [-1, -3, -2], hi: [0, 3, 2] },
      { lo: [0, -12, -8], hi: [43, 12, 8] },
    ]),
    prepared = await prepareSemanticGeometry(mesh, fixtureDeflate),
    cut = {
      normal: [1, 0, 0] as const,
      origin: [(0.4 - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0] as const,
    },
    part: SemanticPart = {
      id: 'member',
      label: 'Unfamiliar member',
      parentId: null,
      confidence: 0.99,
      instances: 1,
      componentIds: [],
      views: [],
      importance: 'major',
      expectedGeometry: { kind: 'solid_part', likelySeparable: true },
      cut,
    },
    refinement = refineSemanticPlanes(prepared.geometry, [part], () => undefined).refinements.get(
      part.id,
    );
  expect(refinement?.chosenOffset).not.toBe(refinement?.proposedOffset);
  expect(refinement?.chosenSectionLength).toBeLessThan(
    (refinement?.proposedSectionLength ?? 0) * 0.9,
  );
});

it('keeps grounded and peerless policies independent even when they share a proposed plane', async () => {
  const mesh = voxelUnion([
      { lo: [-37, -3, -2], hi: [8, 3, 2] },
      { lo: [8, -12, -8], hi: [43, 12, 8] },
    ]),
    prepared = await prepareSemanticGeometry(mesh, fixtureDeflate),
    cut = {
      normal: [1, 0, 0] as const,
      origin: [(8.26 - prepared.geometry.center[0]) / prepared.geometry.scale, 0, 0] as const,
    },
    part: SemanticPart = {
      id: 'grounded',
      label: 'Unfamiliar member',
      parentId: null,
      confidence: 0.99,
      instances: 1,
      componentIds: [],
      views: [],
      importance: 'major',
      expectedGeometry: { kind: 'solid_part', likelySeparable: true },
      cut,
    },
    parts = [part, { ...part, id: 'peerless' }],
    result = refineSemanticPlanes(prepared.geometry, parts, () => undefined, new Set(['grounded']));
  expect(result.refinements.get('grounded')?.cut).toEqual(cut);
  expect(result.refinements.get('peerless')?.chosenOffset).not.toBe(
    result.refinements.get('peerless')?.proposedOffset,
  );
  const before = prepared.geometry.positions.slice();
  let checkpoints = 0;
  expect(() =>
    refineSemanticPlanes(prepared.geometry, parts, () => {
      if (++checkpoints === Math.ceil(prepared.geometry.faceCount / CHECKPOINT_STRIDE) + 1)
        throw Error('cancel decision');
    }),
  ).toThrow('cancel decision');
  expect(prepared.geometry.positions).toEqual(before);
});

it('uses independent raw polygon boundaries to include or exclude a crossed shoulder and preserves ambiguity', async () => {
  const mesh = voxelUnion([
      { lo: [-37, -3, -2], hi: [8, 3, 2] },
      { lo: [8, -12, -8], hi: [43, 12, 8] },
    ]),
    prepared = await prepareSemanticGeometry(mesh, fixtureDeflate),
    geometry = prepared.geometry,
    surface = (8 - geometry.center[0]) / geometry.scale;
  for (const sign of [1, -1])
    for (const included of [false, true]) {
      const boundary = (8 + (included ? -0.1 : 0.1) * sign - geometry.center[0]) / geometry.scale,
        views: SemanticPart['views'] = VIEW_NAMES.flatMap((view) => {
          const camera = cameraFor(view);
          if (Math.abs(camera.forward[0]) > 1e-6) return [];
          const horizontal = (camera.right[0] * sign * 2 * geometry.radius) / FRAME_FILL,
            vertical = (-camera.up[0] * sign * 2 * geometry.radius) / FRAME_FILL,
            coefficient = horizontal || vertical,
            edge = 0.5 + (boundary * sign) / coefficient,
            lo = coefficient > 0 ? edge : 0,
            hi = coefficient > 0 ? 1 : edge,
            polygon: [number, number][] = horizontal
              ? [
                  [lo, 0],
                  [hi, 0],
                  [hi, 1],
                  [lo, 1],
                ]
              : [
                  [0, lo],
                  [1, lo],
                  [1, hi],
                  [0, hi],
                ];
          return [{ view, polygons: [polygon] }];
        }),
        part: SemanticPart = {
          id: 'scope',
          label: 'Unfamiliar member',
          parentId: null,
          confidence: 0.99,
          instances: 1,
          componentIds: [],
          importance: 'major',
          views,
          expectedGeometry: { kind: 'solid_part', likelySeparable: true },
          cut: {
            normal: [sign, 0, 0],
            origin: [(8.26 - geometry.center[0]) / geometry.scale, 0, 0],
          },
        };
      expect(semanticShoulderOwnership(geometry, part, [1, 0, 0], surface, () => undefined)).toBe(
        included ? 'INCLUDED' : 'EXCLUDED',
      );
      const oneAxis = {
        ...part,
        views: views.filter((v) => v.view === 'front' || v.view === 'rear'),
      };
      expect(
        semanticShoulderOwnership(geometry, oneAxis, [1, 0, 0], surface, () => undefined),
      ).toBe('AMBIGUOUS');
      {
        const refinement = refineSemanticPlanes(geometry, [part], () => undefined).refinements.get(
          part.id,
        );
        expect(refinement?.shoulderEvidence?.ownership).toBe(included ? 'INCLUDED' : 'EXCLUDED');
        expect(refinement?.chosenOffset === refinement?.proposedOffset).toBe(included === sign < 0);
      }
    }
});
