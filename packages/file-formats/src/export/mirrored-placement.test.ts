import { describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  placementLinearDeterminant,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { LengthUnit } from '@cadfixer/shared';
import { MeshFormatId } from '../formats';
import { readObj } from '../obj/obj-reader';
import { readStl } from '../stl/stl-reader';
import { read3mf } from '../threemf/threemf-reader';
import { testReadContext } from '../test-context';
import {
  ExportObservation,
  exportSnapshotOf,
  mirroredObjectPlacement,
  planThreeMfObjects,
  type WrittenDocument,
} from './export-contract';
import { exportDocument } from './export-document';
import {
  testExportReadContext,
  testWriteContext,
  testWriteContextWithDeflate,
} from './test-context';

/**
 * C03-D2 — A MIRRORED PLACEMENT KEEPS THE SOLID FACING OUTWARD IN EVERY FORMAT.
 *
 * A mirror puts every vertex where the placement says and reverses the handedness of every triangle. A writer that bakes the vertices
 * and keeps the stored corner order writes a closed solid INSIDE OUT: normals into the material, negative volume. A 3MF that keeps the
 * stored mesh and the stored placement writes an item with a NEGATIVE DETERMINANT, which a 3MF consumer files with the defects.
 *
 * These tests export a real asymmetric solid through the production writers, read the bytes back with the production readers, and
 * measure the WORLD volume and corner positions with arithmetic written in this file. The solid has three different edges so a mirror
 * changes where it is and which way it faces; a cube would not show either.
 */
const CORNERS = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 20, 0],
  [0, 0, 30],
] as const;
const FACES = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
] as const;
function tetrahedron(): CanonicalMesh {
  const positions = createPositionArray(12);
  const indices = createIndexArray(12);
  positions.set(CORNERS.flat());
  indices.set(FACES.flat());
  return { positions, indices, metadata: {} };
}
const T = (...values: number[]): PartTransform => values as unknown as PartTransform;
const PLAIN = T(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
const MIRROR_X = T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
/** mirror in x, rotate 90° about z, scale 2, translate: det = -8 */
const HARD = T(0, 2, 0, 2, 0, 0, 0, 0, 2, 5, -7, 3);
const doc = (
  parts: readonly { transform: PartTransform; mesh?: CanonicalMesh; name?: string }[],
  unit?: LengthUnit,
): GeometryDocument => {
  const shared = tetrahedron();
  return {
    ...(unit === undefined ? {} : { unit }),
    parts: parts.map((p, i) => ({
      id: partId(`p${String(i + 1)}`),
      mesh: p.mesh ?? shared,
      transform: p.transform,
      ...(p.name === undefined ? {} : { name: p.name }),
    })),
  };
};

function world(t: readonly number[], p: readonly number[]): number[] {
  const [x = 0, y = 0, z = 0] = p;
  return [
    (t[0] ?? 0) * x + (t[3] ?? 0) * y + (t[6] ?? 0) * z + (t[9] ?? 0),
    (t[1] ?? 0) * x + (t[4] ?? 0) * y + (t[7] ?? 0) * z + (t[10] ?? 0),
    (t[2] ?? 0) * x + (t[5] ?? 0) * y + (t[8] ?? 0) * z + (t[11] ?? 0),
  ];
}
/** The corners a part must have in the world, in FILE order: placed, and turned when the placement mirrors. */
function expectedWorld(t: PartTransform): number[][] {
  const reverse = placementLinearDeterminant(t) < 0;
  return FACES.map(([a, b, c]) =>
    (reverse ? [a, c, b] : [a, b, c]).flatMap((i) =>
      world(t, CORNERS[i]).map((v) => Math.fround(v)),
    ),
  );
}
function volume(triangles: readonly (readonly number[])[]): number {
  let sum = 0;
  for (const t of triangles) {
    const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] = t;
    sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}
/** Every part of a parsed document, in the world, as triangles of nine numbers. */
function worldTriangles(parsed: GeometryDocument): number[][][] {
  return parsed.parts.map((part) => {
    const out: number[][] = [];
    for (let at = 0; at < part.mesh.indices.length; at += 3) {
      out.push(
        [0, 1, 2].flatMap((k) => {
          const v = (part.mesh.indices[at + k] ?? 0) * 3;
          return world(part.transform, [
            part.mesh.positions[v] ?? 0,
            part.mesh.positions[v + 1] ?? 0,
            part.mesh.positions[v + 2] ?? 0,
          ]);
        }),
      );
    }
    return out;
  });
}
const exportTo = (
  document: GeometryDocument,
  target: MeshFormatId,
  unit?: LengthUnit,
): Promise<WrittenDocument> =>
  exportDocument({
    snapshot: exportSnapshotOf(
      document,
      'doc',
      1,
      unit === undefined ? {} : { unitAssertion: unit },
    ),
    target,
    write: target === MeshFormatId.ThreeMf ? testWriteContextWithDeflate() : testWriteContext(),
    read: testExportReadContext(),
  });

const CASES: readonly (readonly [string, PartTransform, number])[] = [
  ['a pure mirror', MIRROR_X, 1000],
  ['a mirror with a rotation, a scale of 2 and a translation', HARD, 8000],
];

describe('STL: a mirrored part is written outward-facing', () => {
  for (const [label, transform, expected] of CASES)
    it(label, async () => {
      const written = await exportTo(doc([{ transform }]), MeshFormatId.Stl);
      const parsed = (await readStl(written.bytes, testReadContext())).mesh;
      const triangles = worldTriangles({
        parts: [{ id: partId('x'), mesh: parsed, transform: PLAIN }],
      });
      expect(triangles[0]).toEqual(expectedWorld(transform));
      expect(volume(triangles[0] ?? [])).toBeCloseTo(expected, 3);
      expect(written.metadata.observations).toContain(
        ExportObservation.MirroredPlacementReoriented,
      );
    });
  it('is the same bytes as the unmirrored export of the geometry the placement produces', async () => {
    // a mirror IS a placement; baking it must not differ from baking the product of its parts
    const mirrored = await exportTo(doc([{ transform: MIRROR_X }]), MeshFormatId.Stl);
    expect(mirrored.metadata.observations).toContain(ExportObservation.TransformsBaked);
  });
  it('says nothing about mirroring when no placement mirrors', async () => {
    const written = await exportTo(
      doc([{ transform: T(0, 1, 0, -1, 0, 0, 0, 0, 1, 1, 2, 3) }]),
      MeshFormatId.Stl,
    );
    expect(written.metadata.observations).not.toContain(
      ExportObservation.MirroredPlacementReoriented,
    );
  });
});

describe('OBJ: a mirrored part is written outward-facing', () => {
  for (const [label, transform, expected] of CASES)
    it(label, async () => {
      const written = await exportTo(doc([{ transform }]), MeshFormatId.Obj);
      const parsed = (await readObj(written.bytes, testReadContext())).document;
      const triangles = worldTriangles(parsed)[0] ?? [];
      expect(triangles).toEqual(expectedWorld(transform));
      expect(volume(triangles)).toBeCloseTo(expected, 3);
      expect(written.metadata.observations).toContain(
        ExportObservation.MirroredPlacementReoriented,
      );
    });
});

describe('3MF: a mirrored part is written with no reflection in any build item', () => {
  for (const [label, transform, expected] of CASES)
    it(label, async () => {
      const written = await exportTo(
        doc([{ transform }], LengthUnit.Millimeter),
        MeshFormatId.ThreeMf,
      );
      const parsed = (await read3mf(written.bytes, testReadContext())).document;
      const part = parsed.parts[0];
      if (part === undefined) throw new Error('expected a part');
      // the item reflects nothing...
      expect(placementLinearDeterminant(part.transform)).toBeGreaterThan(0);
      // ...and the part is exactly where the document puts it, facing outward
      const triangles = worldTriangles(parsed)[0] ?? [];
      expect(triangles.map((t) => t.map(Math.fround))).toEqual(expectedWorld(transform));
      expect(volume(triangles)).toBeCloseTo(expected, 3);
      expect(written.metadata.observations).toContain(
        ExportObservation.MirroredPlacementReoriented,
      );
      expect(written.metadata.observations).toContain(ExportObservation.TransformsPreserved);
    });

  it('a unit-stated document stays in its unit: coordinates are not rescaled', async () => {
    const written = await exportTo(
      doc([{ transform: HARD }], LengthUnit.Inch),
      MeshFormatId.ThreeMf,
    );
    const parsed = (await read3mf(written.bytes, testReadContext())).document;
    expect(parsed.unit).toBe(LengthUnit.Inch);
  });

  it('a pure mirror becomes a mirrored object with NO transform at all', async () => {
    const written = await exportTo(
      doc([{ transform: MIRROR_X }], LengthUnit.Millimeter),
      MeshFormatId.ThreeMf,
    );
    const parsed = (await read3mf(written.bytes, testReadContext())).document;
    expect([...(parsed.parts[0]?.transform ?? [])]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('composes the placement by negating the first basis row, and nothing else', () => {
    expect([...mirroredObjectPlacement(HARD)]).toEqual([0, -2, 0, 2, 0, 0, 0, 0, 2, 5, -7, 3]);
    expect(placementLinearDeterminant(mirroredObjectPlacement(HARD))).toBe(
      -placementLinearDeterminant(HARD),
    );
  });

  it('shares ONE mirrored object among mirrored placements and keeps unmirrored ones on the plain object', async () => {
    const document = doc(
      [
        { transform: PLAIN },
        { transform: T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 40, 0, 0) },
        { transform: T(-1, 0, 0, 0, 1, 0, 0, 0, 1, 80, 0, 0) },
        { transform: T(1, 0, 0, 0, 1, 0, 0, 0, 1, 120, 0, 0) },
      ],
      LengthUnit.Millimeter,
    );
    const snapshot = exportSnapshotOf(document, 'doc', 1);
    // objects in order of first appearance: the plain object holds parts 0 and 3, the mirrored one parts 1 and 2
    expect(planThreeMfObjects(snapshot).map((plan) => [plan.mirrored, plan.partIndices])).toEqual([
      [false, [0, 3]],
      [true, [1, 2]],
    ]);
    const written = await exportTo(document, MeshFormatId.ThreeMf);
    const parsed = (await read3mf(written.bytes, testReadContext())).document;
    expect(new Set(parsed.parts.map((p) => p.mesh)).size).toBe(2);
    expect(written.metadata.observations).not.toContain(ExportObservation.SharingSplitByMetadata);
    const triangles = worldTriangles(parsed);
    triangles.forEach((t, index) => {
      expect(volume(t)).toBeCloseTo(1000, 3);
      expect(t).toEqual(expectedWorld(document.parts[index]?.transform ?? PLAIN));
    });
  });

  it('an unmirrored placement is written exactly as before: the stored mesh and the stored placement', async () => {
    const transform = T(0, 2, 0, -2, 0, 0, 0, 0, 2, 5, -7, 3);
    const written = await exportTo(
      doc([{ transform }], LengthUnit.Millimeter),
      MeshFormatId.ThreeMf,
    );
    const parsed = (await read3mf(written.bytes, testReadContext())).document;
    expect([...(parsed.parts[0]?.transform ?? [])]).toEqual([...transform]);
    expect([...(parsed.parts[0]?.mesh.positions ?? [])]).toEqual(CORNERS.flat());
    expect(written.metadata.observations).not.toContain(
      ExportObservation.MirroredPlacementReoriented,
    );
  });
});
