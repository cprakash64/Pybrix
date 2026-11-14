import { beforeAll, describe, expect, it } from 'vitest';
import {
  cameraFor,
  FRAME_FILL,
  type SemanticHierarchy,
  type SemanticPart,
  type Vec3,
  type ViewName,
} from '@cadfixer/auto-split-contract';
import { box } from './fixtures';
import { fixtureDeflate } from './fixtures/deflate';
import {
  decomposeSemantic,
  prepareSemanticGeometry,
  type PreparedSemanticGeometry,
} from './semantic';
import { GroundingState } from './suggestions';

/**
 * v0.7.1 — A RECOGNIZED PART IS GROUNDED WHEN ITS OUTLINE REACHED FACES OF THE MODEL.
 *
 * Recognition (the service named a part), grounding (Pybrix found faces for it) and a split proposal are
 * three separate facts. These tests hold the middle one: it is retained per part as a face set, it is
 * independent of whether any cut was proposed, and a part no outline reached is NOT_GROUNDED, never
 * guessed at.
 */

let prepared: PreparedSemanticGeometry;
beforeAll(async () => {
  prepared = await prepareSemanticGeometry(box([-6, -3, -3], [6, 3, 3]), fixtureDeflate);
});

/** An outline, in one view, over the half of the box on one side of x = 0. */
function region(view: ViewName, sign: number): SemanticPart['views'][number] {
  const camera = cameraFor(view);
  const projected: number[][] = [];
  for (const x of sign > 0 ? [2, 6] : [-6, -2])
    for (const y of [-3, 3])
      for (const z of [-3, 3]) {
        const point = [x, y, z].map(
          (p, axis) => (p - (prepared.geometry.center[axis] ?? 0)) / prepared.geometry.scale,
        );
        const factor = FRAME_FILL / (2 * prepared.geometry.radius);
        projected.push([
          0.5 + factor * point.reduce((n, p, a) => n + p * (camera.right[a] ?? 0), 0),
          0.5 - factor * point.reduce((n, p, a) => n + p * (camera.up[a] ?? 0), 0),
        ]);
      }
  const lo = [0, 1].map((a) => Math.min(...projected.map((p) => p[a] ?? 0)));
  const hi = [0, 1].map((a) => Math.max(...projected.map((p) => p[a] ?? 0)));
  return {
    view,
    polygons: [
      [
        [lo[0] ?? 0, lo[1] ?? 0],
        [hi[0] ?? 0, lo[1] ?? 0],
        [hi[0] ?? 0, hi[1] ?? 0],
        [lo[0] ?? 0, hi[1] ?? 0],
      ],
    ],
  };
}

const part = (
  id: string,
  views: SemanticPart['views'],
  cut: SemanticPart['cut'] = null,
): SemanticPart => ({
  id,
  label: id,
  parentId: null,
  importance: 'major',
  confidence: 0.95,
  instances: 1,
  componentIds: [],
  expectedGeometry: { kind: 'solid_part', likelySeparable: true },
  cut,
  views,
});

const answer = (parts: SemanticPart[]): SemanticHierarchy => ({
  object: { label: 'Box', confidence: 0.99 },
  parts,
});

const popcount = (bits: Uint32Array): number => {
  let n = 0;
  for (const word of bits) {
    let w = word;
    while (w !== 0) {
      w &= w - 1;
      n += 1;
    }
  }
  return n;
};

describe('grounded faces of a recognized part', () => {
  it('retains the faces the outline reached, as a bit set whose size is the count reported', () => {
    const result = decomposeSemantic(
      prepared,
      answer([part('right', [region('front', 1), region('top', 1)])]),
    );
    const region_ = result.grounding.get('right');
    expect(region_).toBeDefined();
    if (region_ === undefined) return;
    expect(region_.faces).toBeGreaterThan(0);
    expect(region_.faces).toBeLessThanOrEqual(result.faceCount);
    expect(popcount(region_.faceBits)).toBe(region_.faces);
    expect(region_.views).toBeGreaterThanOrEqual(1);
    // Only the surface the outlined views can SEE is grounded: not every face of the box.
    expect(region_.faces).toBeLessThan(result.faceCount);
    const suggestion = result.suggestions.find((s) => s.id === 'right');
    expect(suggestion?.grounding).toEqual({
      state: GroundingState.Grounded,
      faces: region_.faces,
      views: region_.views,
    });
  });

  it('is independent of whether a split was proposed: grounded, and nothing to preview', () => {
    // Outlines in two views that disagree about which half the part is: the engine refuses to propose
    // anything (operation NONE), and the part is still located on the model.
    const result = decomposeSemantic(
      prepared,
      answer([
        part('crossed', [region('front', 1), region('top', -1)], {
          normal: [1, 0, 0] as Vec3,
          origin: [2 / prepared.geometry.scale, 0, 0],
        }),
      ]),
    );
    const suggestion = result.suggestions.find((s) => s.id === 'crossed');
    expect(suggestion?.operation).toBe('NONE');
    expect(suggestion?.grounding?.state).toBe(GroundingState.Grounded);
    expect(suggestion?.grounding?.faces ?? 0).toBeGreaterThan(0);
  });

  it('a part no outline reached is NOT_GROUNDED and has no face set', () => {
    const result = decomposeSemantic(prepared, answer([part('ghost', [])]));
    expect(result.grounding.has('ghost')).toBe(false);
    expect(result.suggestions.find((s) => s.id === 'ghost')?.grounding).toEqual({
      state: GroundingState.NotGrounded,
      faces: 0,
      views: 0,
    });
  });

  it('is deterministic: the same answer grounds the same faces', () => {
    const hierarchy = answer([part('right', [region('front', 1), region('top', 1)])]);
    const a = decomposeSemantic(prepared, hierarchy).grounding.get('right');
    const b = decomposeSemantic(prepared, hierarchy).grounding.get('right');
    expect(a).toBeDefined();
    expect(Array.from(a?.faceBits ?? [])).toEqual(Array.from(b?.faceBits ?? []));
  });
});
