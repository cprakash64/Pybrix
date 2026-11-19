import { beforeEach, describe, expect, it } from 'vitest';
import {
  createIndexArray,
  createPositionArray,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  isDocument,
  isPart,
  type DocumentHandle,
  type OperationContext,
} from '@cadfixer/geometry-runtime';
import { operationCancelled, uncancellable } from '@cadfixer/shared';
import { modelExportHandler, residentDocuments, repairHistory } from './stl-handlers';

/**
 * C03-D1 — THE ACTIVE-PART STL IS THE PART WHERE THE DOCUMENT HAS IT.
 *
 * `model/export` used to write `part.mesh` and ignore `part.transform`, so a placed, scaled or mirrored part was written somewhere
 * other than where the document puts it. These tests drive the real worker handler on a real resident document and read the real
 * bytes back with a parser written in this file, comparing against placed coordinates computed here with its own arithmetic. They
 * use an ASYMMETRIC solid: a cube is the same cube after most placements and would prove nothing about which placement was applied.
 */
const A = partId('part-a');
const B = partId('part-b');

/** Row-vector 3×4, the document's own layout: the images of the x, y and z axes, then the translation. */
const IDENTITY: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function placement(
  scale: number,
  degrees: number,
  mirror: boolean,
  translation: readonly [number, number, number],
): PartTransform {
  const radians = (degrees * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = mirror ? -1 : 1;
  return [
    m * scale * c,
    m * scale * s,
    0,
    -scale * s,
    scale * c,
    0,
    0,
    0,
    scale,
    ...translation,
  ] as unknown as PartTransform;
}
function worldOf(t: readonly number[], p: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = p;
  return [
    (t[0] ?? 0) * x + (t[3] ?? 0) * y + (t[6] ?? 0) * z + (t[9] ?? 0),
    (t[1] ?? 0) * x + (t[4] ?? 0) * y + (t[7] ?? 0) * z + (t[10] ?? 0),
    (t[2] ?? 0) * x + (t[5] ?? 0) * y + (t[8] ?? 0) * z + (t[11] ?? 0),
  ];
}

/** A tetrahedron with three different edges, wound outward: signed volume 10 × 20 × 30 ÷ 6 = 1000. */
const CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 20, 0],
  [0, 0, 30],
];
const FACES: readonly (readonly [number, number, number])[] = [
  [0, 2, 1],
  [0, 1, 3],
  [0, 3, 2],
  [1, 2, 3],
];
function tetrahedron(): CanonicalMesh {
  const positions = createPositionArray(CORNERS.length * 3);
  const indices = createIndexArray(FACES.length * 3);
  positions.set(CORNERS.flat());
  indices.set(FACES.flat());
  return { positions, indices, metadata: {} };
}

function context(): OperationContext {
  return {
    cancellation: uncancellable,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (uncancellable.isCancelled) throw operationCancelled();
    },
  };
}
function commit(document: GeometryDocument): DocumentHandle {
  return residentDocuments.commit(document);
}

/** Corner coordinates of a binary or ASCII STL, nine numbers a triangle, by a parser that shares nothing with the product's. */
function trianglesOf(bytes: Uint8Array): number[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.byteLength >= 84 ? view.getUint32(80, true) : -1;
  if (bytes.byteLength === 84 + 50 * count) {
    return Array.from({ length: count }, (_unused, i) =>
      Array.from({ length: 9 }, (_v, k) => view.getFloat32(84 + i * 50 + 12 + k * 4, true)),
    );
  }
  const numbers = [
    ...new TextDecoder().decode(bytes).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g),
    // ASCII carries nine significant digits, which identify one Float32; a reader narrows the text to Float32, so the comparison does too.
  ].flatMap((m) => [
    Math.fround(Number(m[1])),
    Math.fround(Number(m[2])),
    Math.fround(Number(m[3])),
  ]);
  return Array.from({ length: numbers.length / 9 }, (_unused, i) =>
    numbers.slice(i * 9, i * 9 + 9),
  );
}
function volumeOf(triangles: readonly number[][]): number {
  let sum = 0;
  for (const t of triangles) {
    const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] = t;
    sum += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return sum;
}
/** What the file must contain: every local corner placed in Float64, narrowed once, in the source's own face order, turned if mirrored. */
function expectedTriangles(transform: PartTransform): number[][] {
  const determinant =
    transform[0] * (transform[4] * transform[8] - transform[5] * transform[7]) -
    transform[1] * (transform[3] * transform[8] - transform[5] * transform[6]) +
    transform[2] * (transform[3] * transform[7] - transform[4] * transform[6]);
  return FACES.map((face) => {
    const [a, b, c] = face;
    const order = determinant < 0 ? [a, c, b] : [a, b, c];
    return order.flatMap((index) =>
      worldOf(transform, CORNERS[index] ?? [0, 0, 0]).map((value) => Math.fround(value)),
    );
  });
}

async function exported(
  handle: DocumentHandle,
  id = A,
  encoding: 'binary' | 'ascii' = 'binary',
): Promise<{
  readonly triangles: number[][];
  readonly warnings: readonly { readonly code: string; readonly details?: unknown }[];
  readonly bytes: Uint8Array;
}> {
  const written = await modelExportHandler({ handle, partId: id, encoding }, context());
  const bytes = new Uint8Array(written.value.bytes);
  return { triangles: trianglesOf(bytes), warnings: written.value.warnings, bytes };
}

beforeEach(() => {
  residentDocuments.releaseAll();
  repairHistory.releaseAll();
});

const PLACED: readonly (readonly [string, PartTransform])[] = [
  ['a translation', placement(1, 0, false, [5, -7, 3])],
  ['a rotation', placement(1, 90, false, [0, 0, 0])],
  ['a uniform scale of 2', placement(2, 0, false, [0, 0, 0])],
  ['a uniform scale of 0.5', placement(0.5, 0, false, [0, 0, 0])],
  ['a translation, a rotation and a uniform scale together', placement(2, 30, false, [5, -7, 3])],
];

describe('the file holds the part where the document places it (the reported defect)', () => {
  for (const [label, transform] of PLACED)
    for (const encoding of ['binary', 'ascii'] as const)
      it(`${encoding}: ${label}`, async () => {
        const handle = commit({ parts: [{ id: A, mesh: tetrahedron(), transform }] });
        const { triangles } = await exported(handle, A, encoding);
        expect(triangles).toEqual(expectedTriangles(transform));
      });

  it('a part with no placement is written exactly as stored, and says nothing about a placement', async () => {
    const handle = commit({ parts: [{ id: A, mesh: tetrahedron(), transform: IDENTITY }] });
    const { triangles, warnings } = await exported(handle);
    expect(triangles).toEqual(expectedTriangles(IDENTITY));
    expect(warnings.map((w) => w.code)).not.toContain('STL_EXPORT_PLACEMENT_APPLIED');
  });

  it('a placed part carries the one note that says its placement was applied', async () => {
    const handle = commit({
      parts: [{ id: A, mesh: tetrahedron(), transform: placement(2, 0, false, [1, 2, 3]) }],
    });
    const { warnings } = await exported(handle);
    expect(warnings.find((w) => w.code === 'STL_EXPORT_PLACEMENT_APPLIED')?.details).toEqual({
      mirrored: false,
    });
  });
});

describe('a mirrored placement keeps the solid facing outward', () => {
  it('writes the mirrored vertices with the triangles turned, so the volume is positive', async () => {
    const transform = placement(1, 0, true, [0, 0, 0]);
    const handle = commit({ parts: [{ id: A, mesh: tetrahedron(), transform }] });
    const { triangles, warnings } = await exported(handle);
    expect(triangles).toEqual(expectedTriangles(transform));
    expect(volumeOf(triangles)).toBeCloseTo(1000, 3);
    expect(warnings.find((w) => w.code === 'STL_EXPORT_PLACEMENT_APPLIED')?.details).toEqual({
      mirrored: true,
    });
  });
  it('is right together with a rotation, a scale and a translation, in ASCII as well', async () => {
    const transform = placement(2, 90, true, [5, -7, 3]);
    const handle = commit({ parts: [{ id: A, mesh: tetrahedron(), transform }] });
    for (const encoding of ['binary', 'ascii'] as const) {
      const { triangles } = await exported(handle, A, encoding);
      expect(triangles).toEqual(expectedTriangles(transform));
      expect(volumeOf(triangles)).toBeCloseTo(8000, 2);
    }
  });
});

describe('the volume is the placed volume', () => {
  it('scales as the cube of the placement scale', async () => {
    for (const scale of [0.5, 1, 2, 4]) {
      residentDocuments.releaseAll();
      const handle = commit({
        parts: [{ id: A, mesh: tetrahedron(), transform: placement(scale, 0, false, [0, 0, 0]) }],
      });
      expect(volumeOf((await exported(handle)).triangles)).toBeCloseTo(1000 * scale ** 3, 3);
    }
  });
});

describe('exporting is a read', () => {
  it('changes no revision, no transform and no mesh of the authoritative document', async () => {
    const transform = placement(2, 30, true, [5, -7, 3]);
    const mesh = tetrahedron();
    const before = [...mesh.positions];
    const handle = commit({ parts: [{ id: A, mesh, transform }] });
    const revision = residentDocuments.revisionOf(handle.documentId);
    await exported(handle);
    const document = residentDocuments.resolve(handle);
    if (!isDocument(document)) throw new Error('expected a resident document');
    expect(residentDocuments.revisionOf(handle.documentId)).toBe(revision);
    expect(document.parts[0]?.mesh).toBe(mesh);
    expect([...mesh.positions]).toEqual(before);
    expect(document.parts[0]?.transform).toEqual(transform);
  });

  it('writes each placement of a shared mesh where that part is, and the sibling is untouched', async () => {
    const mesh = tetrahedron();
    const first = placement(2, 0, false, [0, 0, 0]);
    const second = placement(1, 90, true, [9, 9, 9]);
    const handle = commit({
      parts: [
        { id: A, mesh, transform: first },
        { id: B, mesh, transform: second },
      ],
    });
    expect((await exported(handle, A)).triangles).toEqual(expectedTriangles(first));
    expect((await exported(handle, B)).triangles).toEqual(expectedTriangles(second));
    const part = residentDocuments.resolvePart(handle, A);
    if (!isPart(part)) throw new Error('expected a part');
    expect(part.mesh).toBe(mesh);
  });
});

describe('the writer sees what the document has, whatever the placement is', () => {
  it('bakes a non-uniform placement too: this export has no support policy to refuse one', async () => {
    const transform = [2, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 3] as unknown as PartTransform;
    const handle = commit({ parts: [{ id: A, mesh: tetrahedron(), transform }] });
    expect((await exported(handle)).triangles).toEqual(expectedTriangles(transform));
  });
});
