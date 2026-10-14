import { required } from '../required';
/** Deterministic annotated fixtures ONLY. Never imported by production entry points. */
import {
  VIEW_NAMES,
  semanticComponentId,
  type SemanticHierarchy,
  type SemanticPart,
} from '@cadfixer/auto-split-contract';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import type { PreparedSemanticGeometry } from '../semantic';
import { box, concatMeshes } from './solids';
export const SEMANTIC_FIXTURE_MARKER = 'SEMANTIC_DECOMPOSITION_ANNOTATED_FIXTURE_ONLY';
export interface SemanticFixture {
  readonly label: string;
  readonly mesh: CanonicalMesh;
  readonly groups: readonly {
    id: string;
    label: string;
    sources: readonly number[];
    instances?: number;
  }[];
}
const legs = (): CanonicalMesh[] =>
  [-1.5, 1.5].flatMap((x) =>
    [-1.5, 1.5].map((z) => box([x - 0.2, -2, z - 0.2], [x + 0.2, -0.2, z + 0.2])),
  );
export function semanticFixture(
  kind: 'vehicle' | 'chair' | 'character' | 'mechanical' | 'unknown',
): SemanticFixture {
  if (kind === 'vehicle')
    return {
      label: 'utility vehicle',
      mesh: concatMeshes([
        box([-2, 0, -1.5], [2, 0.5, 1.5]),
        box([-1.7, 0.8, -1.3], [-0.1, 1.8, 1.3]),
        ...[-2.4, 2.4].flatMap((x) =>
          [-1, 1].map((z) => box([x - 0.3, -0.9, z - 0.3], [x + 0.3, -0.3, z + 0.3])),
        ),
      ]),
      groups: [
        { id: 'bed', label: 'Cargo tray', sources: [1] },
        { id: 'wheels', label: 'Wheels', sources: [2, 3, 4, 5], instances: 4 },
      ],
    };
  if (kind === 'chair')
    return {
      label: 'chair',
      mesh: concatMeshes([
        box([-2, 0, -2], [2, 0.4, 2]),
        box([-2, 0.7, 1.8], [2, 3, 2.2]),
        ...legs(),
      ]),
      groups: [
        { id: 'back', label: 'Backrest', sources: [1] },
        { id: 'legs', label: 'Legs', sources: [2, 3, 4, 5], instances: 4 },
      ],
    };
  if (kind === 'character')
    return {
      label: 'humanoid figure',
      mesh: concatMeshes([
        box([-0.6, 0, -0.4], [0.6, 2, 0.4]),
        box([-0.5, 2.3, -0.5], [0.5, 3.3, 0.5]),
        box([-1.5, 0.2, -0.2], [-0.9, 1.8, 0.2]),
        box([0.9, 0.2, -0.2], [1.5, 1.8, 0.2]),
        box([-0.6, -2, -0.3], [-0.1, -0.3, 0.3]),
        box([0.1, -2, -0.3], [0.6, -0.3, 0.3]),
      ]),
      groups: [
        { id: 'head', label: 'Head', sources: [1] },
        { id: 'arms', label: 'Arms', sources: [2, 3], instances: 2 },
        { id: 'legs', label: 'Legs', sources: [4, 5], instances: 2 },
      ],
    };
  if (kind === 'mechanical')
    return {
      label: 'mechanical assembly',
      mesh: concatMeshes([
        box([-1, -1, -1], [1, 1, 1]),
        box([1.3, -0.2, -0.2], [2.8, 0.2, 0.2]),
        box([-2.8, -0.2, -0.2], [-1.3, 0.2, 0.2]),
        box([-0.3, 1.4, -0.3], [0.3, 2, 0.3]),
        box([-0.1, 2.1, -0.1], [0.1, 2.3, 0.1]),
      ]),
      groups: [
        { id: 'shafts', label: 'Shafts', sources: [1, 2], instances: 2 },
        { id: 'knob', label: 'Control knob', sources: [3, 4] },
      ],
    };
  return {
    label: 'unidentified assembly',
    mesh: concatMeshes([box([-1, -1, -1], [1, 1, 1]), box([2, -0.4, -0.4], [2.8, 0.4, 0.4])]),
    groups: [{ id: 'attachment', label: 'Side attachment', sources: [1] }],
  };
}
/** Truth annotations are made from visible source membership, in the actual deterministic camera frame. */
export function annotatedPart(
  prepared: PreparedSemanticGeometry,
  id: string,
  label: string,
  ranks: readonly number[],
  instances = 1,
): SemanticPart {
  const selected = new Set(ranks);
  const views: SemanticPart['views'][number][] = [];
  for (const [vi, raster] of prepared.rasters.entries()) {
    let x0 = 1,
      y0 = 1,
      x1 = 0,
      y1 = 0,
      count = 0;
    for (let i = 0; i < raster.face.length; i++) {
      const f = required(raster.face[i], 'raster.face[i]');
      if (
        f < 0 ||
        !selected.has(required(prepared.labelling.faceRank[f], 'prepared.labelling.faceRank[f]'))
      )
        continue;
      const x = (i % raster.size) / raster.size,
        y = Math.floor(i / raster.size) / raster.size;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1 / raster.size);
      y1 = Math.max(y1, y + 1 / raster.size);
      count++;
    }
    if (count < 8) continue;
    const bounds = (wanted: Set<number>): [number, number, number, number] | undefined => {
      let loX = 1,
        loY = 1,
        hiX = 0,
        hiY = 0,
        n = 0;
      for (let i = 0; i < raster.face.length; i++) {
        const f = required(raster.face[i], 'raster.face[i]');
        if (
          f < 0 ||
          !wanted.has(required(prepared.labelling.faceRank[f], 'prepared.labelling.faceRank[f]'))
        )
          continue;
        const x = (i % raster.size) / raster.size,
          y = Math.floor(i / raster.size) / raster.size;
        loX = Math.min(loX, x);
        loY = Math.min(loY, y);
        hiX = Math.max(hiX, x + 1 / raster.size);
        hiY = Math.max(hiY, y + 1 / raster.size);
        n++;
      }
      return n >= 8 ? [loX, loY, hiX, hiY] : undefined;
    };
    let boxes: [[number, number, number, number], ...[number, number, number, number][]] = [
      [x0, y0, x1, y1],
    ];
    if (ranks.length === 2) {
      const individual = ranks
        .map((r) => bounds(new Set([r])))
        .filter((b): b is [number, number, number, number] => b !== undefined);
      if (individual.length > 0) boxes = individual as typeof boxes;
    }
    let total = 0,
      correct = 0;
    for (let i = 0; i < raster.face.length; i++) {
      const f = required(raster.face[i], 'raster.face[i]');
      if (f < 0) continue;
      const x = ((i % raster.size) + 0.5) / raster.size,
        y = (Math.floor(i / raster.size) + 0.5) / raster.size;
      if (!boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) continue;
      total++;
      if (selected.has(required(prepared.labelling.faceRank[f], 'prepared.labelling.faceRank[f]')))
        correct++;
    }
    // An annotator omits views whose coarse box includes unrelated visible geometry.
    if (correct / total < 0.8) continue;
    views.push({
      view: required(VIEW_NAMES[vi], 'VIEW_NAMES[vi]'),
      polygons: boxes.map(([a, b, c, d]) => [
        [a, b],
        [c, b],
        [c, d],
        [a, d],
      ]),
    });
  }
  return {
    id,
    label,
    parentId: null,
    importance: 'major',
    confidence: 0.98,
    instances,
    views,
    componentIds: ranks.map(semanticComponentId),
    expectedGeometry: {
      kind: instances > 1 ? 'repeated_part' : 'solid_part',
      likelySeparable: true,
    },
    cut: null,
  };
}
export function annotatedFixture(
  prepared: PreparedSemanticGeometry,
  fixture: SemanticFixture,
): SemanticHierarchy {
  return {
    object: { label: fixture.label, confidence: 0.98 },
    parts: fixture.groups.map((g) =>
      annotatedPart(
        prepared,
        g.id,
        g.label,
        g.sources.map((s) =>
          required(prepared.labelling.faceRank[s * 12], 'prepared.labelling.faceRank[s * 12]'),
        ),
        g.instances,
      ),
    ),
  };
}
