import {
  IDENTITY_PART_TRANSFORM,
  createIndexArray,
  createPositionArray,
  partId,
  type CanonicalMesh,
  type GeometryDocument,
  type GeometryPart,
  type PartTransform,
} from '@cadfixer/mesh-core';
import {
  duplicateDefectMesh,
  indexedDuplicateDefectMesh,
  faceCountMesh,
  makePart,
  mp02SharedGeometry,
  mp08SharedPlacements,
  selfIntersectingMesh,
  tetrahedronMesh,
  translation,
} from '@cadfixer/mesh-core/fixtures';
import {
  concatMeshes,
  hp02QuadHole,
  hp23PatchPiercesOppositeShell,
  hpBoundaryOfSize,
  tetrahedron as holeFillTetrahedron,
} from '@cadfixer/mesh-hole-fill/fixtures';
import { LengthUnit } from '@cadfixer/shared';

/**
 * THE DOCUMENTS THE BROWSER HARNESS CAN BUILD.
 *
 * Every one of them is assembled from `@cadfixer/mesh-core/fixtures` — the same
 * MP01–MP08 builders the unit and worker suites use — so a browser test and a
 * unit test that name the same fixture are looking at the same geometry rather
 * than at two drifting copies.
 *
 * WHY THIS EXISTS AT ALL. Production import is STL-only, and STL describes
 * exactly one part, so no shipped code path can produce a multi-part document
 * for the viewport to draw. That is the whole reason DF07, DF08 and DF10 had no
 * browser evidence. These fixtures close that gap WITHOUT adding an import
 * format: nothing here is reachable from the application, and the module is not
 * in its import graph.
 *
 * The geometry is deliberately analytic. A tetrahedron of edge 1 at the origin
 * beside the same tetrahedron translated 10 along X is a placement a test can
 * assert on exactly, which a scanned bracket is not.
 */

/** Distances chosen so a wrong or dropped transform is unmistakable, not marginal. */
export const PART_B_OFFSET_X = 10;
export const PART_C_OFFSET_Y = 7;

export const HarnessFixtureId = {
  /** MP-BROWSER-01: two independent parts, different geometry, different places. */
  TwoIndependentParts: 'two-independent-parts',
  /** Two parts sharing ONE CanonicalMesh, placed apart. */
  SharedPairApart: 'shared-pair-apart',
  /** Two parts sharing one mesh at the SAME place: overlapping, both valid. */
  SharedPairOverlapping: 'shared-pair-overlapping',
  /** Three parts, three distinct placements, one shared mesh. */
  ThreeTransformedParts: 'three-transformed-parts',
  /** A repairable duplicate defect beside a clean part. */
  DefectAndClean: 'defect-and-clean',
  /** A self-intersecting part beside a clean part that overlaps it in space. */
  CrossingAndOverlappingClean: 'crossing-and-overlapping-clean',
  /** A small part beside one above the self-intersection face ceiling. */
  SmallAndOversized: 'small-and-oversized',
  /** Ten placements of one mesh. */
  Shared10: 'shared-10',
  SevenSharedMillimetre: 'seven-shared-millimetre',
  /** One hundred placements of one mesh. */
  Shared100: 'shared-100',
  /** One thousand placements of one mesh. */
  Shared1000: 'shared-1000',
  /** A single part, for comparing against the STL-era baseline. */
  SinglePart: 'single-part',
  /*
   * WITH A DECLARED UNIT, for export.
   *
   * Every fixture above states none — which is correct for a document derived
   * from an STL, and is exactly why a 3MF export of one is BLOCKED. These two
   * exist so the browser suite can exercise both sides of that rule against the
   * same geometry rather than only the refusal.
   */
  MillimetreTwoParts: 'millimetre-two-parts',
  SplitCubeMillimetre: 'split-cube-millimetre',
  SplitHeavySphereMillimetre: 'split-heavy-sphere-millimetre',
  SplitSmallSphereMillimetre: 'split-small-sphere-millimetre',
  SplitLargeSphereMillimetre: 'split-large-sphere-millimetre',
  MillimetreShared1000: 'millimetre-shared-1000',
  /*
   * LARGE, FOR EXPORT RESPONSIVENESS. Stage 4A-2B2-R1.
   *
   * The fixtures above are small on purpose — they exist to make a placement or
   * a defect unmistakable, and a browser test of RENDERING does not need
   * megabytes. Measuring whether a page stays usable while a document is
   * serialised does: an export that finishes in twelve milliseconds has no
   * window to be unresponsive in.
   *
   * Grid meshes rather than repeated tetrahedra, because a serialiser's cost is
   * per vertex and per triangle and a four-triangle mesh repeated a thousand
   * times measures the placement loop instead of the geometry loop.
   */
  MillimetreLargeSinglePart: 'millimetre-large-single-part',
  /** 400 placements of a 1,152-triangle mesh: 460,800 triangles once baked. */
  MillimetreSharedMedium400: 'millimetre-shared-medium-400',
  /** 1,000 placements of the same mesh. One resource; a million triangles placed. */
  MillimetreSharedMedium1000: 'millimetre-shared-medium-1000',

  /*
   * HOLE-FILL DOCUMENTS. Stage 4B-1B1.
   *
   * The shipped application still imports STL, OBJ and 3MF, so it CAN produce a
   * part with a fillable hole — but not one beside a clean part, not a
   * 512-vertex boundary on a hundred thousand faces, and not the HP23
   * configuration whose patch pierces an internal wall. These three exist so
   * the browser can be shown the cases that decide the stage.
   */
  /** A small fillable hole beside an untouched clean part. */
  HoleFillSmall: 'hole-fill-small',
  /** A 512-vertex boundary on a part near the face ceiling. The worst in-policy case. */
  HoleFillLarge: 'hole-fill-large',
  /** HP23: topologically perfect, and the patch runs through an opposing surface. */
  HoleFillPierced: 'hole-fill-pierced',
  /**
   * TWO PARTS SHARING ONE FILLABLE MESH. The hard gate of Stage 4B-1B2.
   *
   * Filling A must give A the candidate and leave B holding the ORIGINAL mesh
   * object, still open, byte-identical. A fill that mutated in place would
   * silently close both, and no shipped importer can produce this document for
   * a browser test to try it on.
   */
  HoleFillSharedPair: 'hole-fill-shared-pair',
  /**
   * ONE FILLABLE PART, PLACED SOMEWHERE OTHER THAN THE ORIGIN AND MIRRORED.
   *
   * The rim and the patch are part-LOCAL, so the viewport has to compose the
   * placement to draw them where the opening actually is. A reflection is
   * included because it reverses orientation, which is exactly the case a
   * transform-aware overlay is most likely to get wrong.
   */
  HoleFillTransformed: 'hole-fill-transformed',
  /**
   * A SHARED FILLABLE PAIR THAT STATES A UNIT — Stage 4B-1B2-R1.
   *
   * The same shared pair, plus millimetres, so the 3MF writer will accept it. 3MF
   * is where structural sharing is OBSERVABLE in a file: parts that share a mesh
   * become one `<object>` resource referenced twice. That makes it the strongest
   * available evidence that undo restored the document rather than merely its
   * coordinates — a byte-equal copy would silently become a second resource.
   */
  HoleFillSharedPairMillimetre: 'hole-fill-shared-pair-mm',
  /**
   * ONE FILLABLE MESH, A THOUSAND PLACEMENTS — Stage 4B-1B2-R1.
   *
   * `Shared1000` is a thousand closed tetrahedra, so it has no opening to fill.
   * This is the same shape with geometry that HAS one, which is what makes it
   * possible to ask the question that matters at this scale: after filling one
   * placement and undoing it, does the document hold ONE mesh again, or a
   * thousand-and-one?
   */
  HoleFillShared1000: 'hole-fill-shared-1000',
  /**
   * TWO PARTS SHARING ONE REPAIRABLE MESH — Stage 4B-1C.
   *
   * The conservative-repair counterpart of `HoleFillSharedPair`. Repairing one
   * part must isolate it and leave the other on the ORIGINAL mesh; undoing must
   * put them back on the same object. Millimetres, so the 3MF writer will accept
   * it — 3MF is where structural sharing is OBSERVABLE in a file, and the same
   * name on both parts is what makes an object-resource count a statement about
   * mesh sharing rather than about naming.
   */
  RepairSharedPairMillimetre: 'repair-shared-pair-mm',
  /**
   * ONE REPAIRABLE MESH, A THOUSAND PLACEMENTS — Stage 4B-1C.
   *
   * `Shared1000` is a thousand CLEAN tetrahedra, so a repair of it is a no-op
   * and measures nothing. This is the same shape with geometry that has a real
   * duplicate face, which is what makes the memory question askable at scale:
   * repairing ONE placement must add exactly one mesh, and undoing it must
   * leave the document holding ONE again rather than a thousand-and-one.
   */
  RepairShared1000Millimetre: 'repair-shared-1000-mm',
  /**
   * TWO PARTS SHARING ONE REPAIRABLE, GENUINELY INDEXED MESH — Stage 4B-1D.
   *
   * `RepairSharedPairMillimetre` is soup, which is a fine control and can say
   * nothing about indexing. Four vertices carrying five faces can: a candidate
   * rebuilt as soup comes back with twelve, and the sharing question and the
   * representation question can be asked of the same Apply.
   */
  RepairSharedIndexedPairMillimetre: 'repair-shared-indexed-pair-mm',
  /**
   * REPAIR-CORE-06A-BROWSER-GATE. Local pinch repair fixtures: three bounded, generated pinched
   * vertices (success); one pinched vertex with a reversed face, which only the residual phase
   * (component winding resolution and link retriangulation) repairs; one with two reversed faces
   * whose fan is not one consistent chain, which the engine must refuse; and four hundred pinched
   * vertices, a workload for a lowered work ceiling.
   */
  LocalRepairPinch: 'local-repair-pinch',
  LocalRepairResidual: 'local-repair-residual',
  LocalRepairRefusal: 'local-repair-refusal',
  LocalRepairHeavy: 'local-repair-heavy',
  /** A pinch whose apex also carries a non-manifold edge: unsupported, so nothing is attempted. */
  LocalRepairUnsupportedEdge: 'local-repair-unsupported-edge',
} as const;

export type HarnessFixtureId = (typeof HarnessFixtureId)[keyof typeof HarnessFixtureId];

export function isHarnessFixtureId(value: string): value is HarnessFixtureId {
  return Object.values(HarnessFixtureId).some((id) => id === value);
}

type Vec3 = readonly [number, number, number];
type Tri = readonly [number, number, number];

function meshFrom(points: readonly Vec3[], faces: readonly Tri[]): CanonicalMesh {
  const positions = createPositionArray(points.length * 3);
  points.forEach((point, index) => {
    positions.set(point, index * 3);
  });
  const indices = createIndexArray(faces.length * 3);
  faces.forEach((face, index) => {
    indices.set(face, index * 3);
  });
  return { positions, indices, metadata: {} };
}

/** `count` tetrahedron pairs, each pair sharing ONE corner coordinate: one pinched vertex each. */
function pinchedPairs(count: number): CanonicalMesh {
  const points: Vec3[] = [];
  const faces: Tri[] = [];
  for (let i = 0; i < count; i += 1) {
    const dx = (i % 10) * 6;
    const dy = Math.floor(i / 10) * 6;
    const base: Vec3[] = [
      [0, 0, 0],
      [1, 0, 1],
      [-0.5, 0.9, 1],
      [-0.5, -0.9, 1.1],
      [-1, 0.1, -1],
      [0.5, -0.9, -1.2],
      [0.45, 0.95, -1.1],
    ];
    const offset = points.length;
    for (const p of base) points.push([p[0] + dx, p[1] + dy, p[2]]);
    for (const f of [
      [0, 2, 1],
      [0, 3, 2],
      [0, 1, 3],
      [1, 2, 3],
      [0, 4, 5],
      [0, 5, 6],
      [0, 6, 4],
      [4, 6, 5],
    ] as const) {
      faces.push([f[0] + offset, f[1] + offset, f[2] + offset]);
    }
  }
  return meshFrom(points, faces);
}

/** Two closed cones of `n` faces meeting at one coordinate, `reversed` of whose faces are flipped. */
function bowtie(
  n: number,
  heightA: number,
  heightB: number,
  reversed: readonly number[],
): CanonicalMesh {
  const points: Vec3[] = [[0, 0, 0]];
  const faces: [number, number, number][] = [];
  const cone = (height: number, phase: number): void => {
    const base = points.length;
    for (let k = 0; k < n; k += 1) {
      const angle = phase + (2 * Math.PI * k) / n;
      points.push([Math.cos(angle), Math.sin(angle), height]);
    }
    for (let k = 0; k < n; k += 1) {
      faces.push(
        height >= 0 ? [0, base + k, base + ((k + 1) % n)] : [0, base + ((k + 1) % n), base + k],
      );
    }
  };
  cone(heightA, 0);
  cone(heightB, 0.3);
  for (const index of reversed) {
    const face = faces[index];
    if (face !== undefined) faces[index] = [face[0], face[2], face[1]];
  }
  return meshFrom(points, faces);
}

function named(
  id: string,
  mesh: CanonicalMesh,
  name: string,
  transform: PartTransform = IDENTITY_PART_TRANSFORM,
): GeometryPart {
  return { id: partId(id), mesh, transform, name };
}

/**
 * Two clean parts occupying the SAME world space.
 *
 * The case ADR 0013 exists to keep honest: neither part's own faces cross, so
 * neither is self-intersecting, however much they overlap each other. A
 * diagnostic that flattened the document before checking would report a
 * crossing that does not exist.
 */
function sharedPairOverlapping(): GeometryDocument {
  const shared = tetrahedronMesh();
  return {
    parts: [named('a', shared, 'Overlapping A'), named('b', shared, 'Overlapping B')],
  };
}

function crossingAndOverlappingClean(): GeometryDocument {
  return {
    parts: [
      // Its own two faces genuinely cross each other.
      named('a', selfIntersectingMesh(), 'Crossing'),
      // Clean, and deliberately placed INSIDE the first part's bounding volume
      // so any flattening would manufacture crossings between the two.
      named('b', tetrahedronMesh(2), 'Clean overlapping', translation(1, 1, 0)),
    ],
  };
}

/**
 * A `side x side` quad grid: `side * side * 2` triangles over shared corners.
 *
 * Deterministic and cheap to build, and every coordinate is a small exact
 * Float32 — so a round trip that loses one is a mismatch a test can point at,
 * not a rounding argument.
 */
function gridMesh(side: number): CanonicalMesh {
  const positions = new Float32Array((side + 1) * (side + 1) * 3);
  let at = 0;
  for (let row = 0; row <= side; row += 1) {
    for (let column = 0; column <= side; column += 1) {
      positions[at] = column;
      positions[at + 1] = row;
      positions[at + 2] = ((column * 7 + row * 13) % 17) * 0.25;
      at += 3;
    }
  }

  const indices = new Uint32Array(side * side * 6);
  let out = 0;
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      const base = row * (side + 1) + column;
      indices[out] = base;
      indices[out + 1] = base + 1;
      indices[out + 2] = base + side + 1;
      indices[out + 3] = base + 1;
      indices[out + 4] = base + side + 2;
      indices[out + 5] = base + side + 1;
      out += 6;
    }
  }
  return { positions, indices, metadata: {} };
}

/** `count` placements of ONE grid mesh, spread along X. Shared, never copied. */
function sharedGridPlacements(side: number, count: number): GeometryDocument {
  const mesh = gridMesh(side);
  return {
    unit: LengthUnit.Millimeter,
    parts: Array.from({ length: count }, (_part, index) =>
      makePart(`p${String(index)}`, mesh, {
        transform: translation(index * (side + 4), 0, 0),
      }),
    ),
  };
}

function splitCube(size = 20): CanonicalMesh {
  const h = size / 2,
    values = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    faces = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(values.length),
    indices = createIndexArray(faces.length);
  positions.set(values);
  indices.set(faces);
  return { positions, indices, metadata: {} };
}
function splitSphere(segments = 360, rings = 180, radius = 20): CanonicalMesh {
  const vertexTotal = 2 + (rings - 1) * segments,
    triangleTotal = segments * 2 + (rings - 2) * segments * 2,
    positions = createPositionArray(vertexTotal * 3),
    indices = createIndexArray(triangleTotal * 3);
  positions.set([0, 0, radius], 0);
  let p = 3;
  for (let ring = 1; ring < rings; ring++) {
    const phi = (ring / rings) * Math.PI,
      z = Math.cos(phi) * radius,
      ringRadius = Math.sin(phi) * radius;
    for (let segment = 0; segment < segments; segment++) {
      const theta = (segment / segments) * Math.PI * 2;
      positions.set([Math.cos(theta) * ringRadius, Math.sin(theta) * ringRadius, z], p);
      p += 3;
    }
  }
  const south = vertexTotal - 1;
  positions.set([0, 0, -radius], south * 3);
  let at = 0;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([0, 1 + segment, 1 + next], at);
    at += 3;
  }
  for (let ring = 0; ring < rings - 2; ring++) {
    const row = 1 + ring * segments,
      nextRow = row + segments;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      indices.set([row + segment, nextRow + segment, row + next], at);
      at += 3;
      indices.set([row + next, nextRow + segment, nextRow + next], at);
      at += 3;
    }
  }
  const last = 1 + (rings - 2) * segments;
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    indices.set([last + segment, south, last + next], at);
    at += 3;
  }
  return { positions, indices, metadata: {} };
}

export function buildHarnessDocument(id: HarnessFixtureId): GeometryDocument {
  switch (id) {
    case HarnessFixtureId.TwoIndependentParts:
      return {
        parts: [
          named('a', tetrahedronMesh(1), 'Alpha'),
          named('b', tetrahedronMesh(2), 'Beta', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.SharedPairApart: {
      const document = mp02SharedGeometry();
      // Renamed and re-placed for legibility in the browser, still one mesh.
      const mesh = document.parts[0]?.mesh ?? tetrahedronMesh();
      return {
        parts: [
          named('a', mesh, 'Shared A'),
          named('b', mesh, 'Shared B', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.SevenSharedMillimetre: {
      const shared = tetrahedronMesh();
      return {
        unit: LengthUnit.Millimeter,
        parts: Array.from({ length: 7 }, (_, index) =>
          named(
            `p${String(index + 1)}`,
            shared,
            `Part ${String(index + 1)}`,
            translation(index * 5, 0, 0),
          ),
        ),
      };
    }

    case HarnessFixtureId.SharedPairOverlapping:
      return sharedPairOverlapping();

    case HarnessFixtureId.ThreeTransformedParts: {
      const mesh = tetrahedronMesh();
      return {
        parts: [
          named('a', mesh, 'At origin'),
          named('b', mesh, 'Along X', translation(PART_B_OFFSET_X, 0, 0)),
          named('c', mesh, 'Along Y', translation(0, PART_C_OFFSET_Y, 0)),
        ],
      };
    }

    case HarnessFixtureId.DefectAndClean:
      return {
        parts: [
          named('a', duplicateDefectMesh(), 'Defective'),
          named('b', tetrahedronMesh(), 'Clean', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.CrossingAndOverlappingClean:
      return crossingAndOverlappingClean();

    case HarnessFixtureId.SmallAndOversized:
      return {
        parts: [
          named('a', tetrahedronMesh(), 'Small'),
          // Above SELF_INTERSECTION_MAX_FACES. Cheap by construction: three
          // corners and many indices, so proving the size band is refused does
          // not allocate the memory the band exists to refuse.
          named('b', faceCountMesh(250_001), 'Oversized', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.Shared10:
      return mp08SharedPlacements(10);
    case HarnessFixtureId.Shared100:
      return mp08SharedPlacements(100);
    case HarnessFixtureId.Shared1000:
      return mp08SharedPlacements(1000);

    case HarnessFixtureId.SinglePart:
      return { parts: [makePart('only', tetrahedronMesh(), { name: 'Only part' })] };

    case HarnessFixtureId.MillimetreTwoParts:
      return {
        unit: LengthUnit.Millimeter,
        parts: [
          named('a', tetrahedronMesh(1), 'Alpha'),
          named('b', tetrahedronMesh(2), 'Beta', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.SplitCubeMillimetre:
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('cube', splitCube(), { name: 'Split cube' })],
      };
    case HarnessFixtureId.SplitHeavySphereMillimetre:
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('heavy-sphere', splitSphere(), { name: 'Heavy split sphere' })],
      };
    case HarnessFixtureId.SplitSmallSphereMillimetre:
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('small-sphere', splitSphere(72, 72), { name: '10k split sphere' })],
      };
    case HarnessFixtureId.SplitLargeSphereMillimetre:
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('large-sphere', splitSphere(500, 500), { name: '500k split sphere' })],
      };

    case HarnessFixtureId.MillimetreShared1000:
      return { unit: LengthUnit.Millimeter, ...mp08SharedPlacements(1000) };

    case HarnessFixtureId.MillimetreLargeSinglePart:
      // 400 x 400 quads = 320,000 triangles. Roughly 30 MiB of OBJ text and
      // 2.5 MiB of 3MF, which is a serialisation window long enough to be
      // unresponsive in if the work were on the wrong thread.
      return {
        unit: LengthUnit.Millimeter,
        parts: [makePart('large', gridMesh(400), { name: 'Large plate' })],
      };

    case HarnessFixtureId.MillimetreSharedMedium400:
      return sharedGridPlacements(24, 400);

    case HarnessFixtureId.MillimetreSharedMedium1000:
      return sharedGridPlacements(24, 1000);

    case HarnessFixtureId.LocalRepairPinch:
      return { parts: [named('a', pinchedPairs(3), 'Three pinched vertices')] };

    case HarnessFixtureId.LocalRepairResidual:
      return { parts: [named('a', bowtie(6, 0.05, -0.05, [1]), 'Pinch with a reversed face')] };

    case HarnessFixtureId.LocalRepairRefusal:
      return { parts: [named('a', bowtie(4, 0.5, -0.5, [1, 4]), 'Pinch the engine must refuse')] };

    case HarnessFixtureId.LocalRepairUnsupportedEdge: {
      // The residual-phase bowtie plus a third face on the edge (apex, first rim vertex).
      const base = bowtie(6, 0.05, -0.05, []);
      const vertexCount = base.positions.length / 3;
      const positions = createPositionArray(base.positions.length + 3);
      positions.set(base.positions);
      positions.set([0, 0, 3], base.positions.length);
      const indices = createIndexArray(base.indices.length + 3);
      indices.set(base.indices);
      indices.set([0, 1, vertexCount], base.indices.length);
      return {
        parts: [
          named('a', { positions, indices, metadata: {} }, 'Pinch beside a non-manifold edge'),
        ],
      };
    }

    case HarnessFixtureId.LocalRepairHeavy:
      return { parts: [named('a', pinchedPairs(400), 'Four hundred pinched vertices')] };

    case HarnessFixtureId.HoleFillSmall:
      return {
        parts: [
          named('a', hp02QuadHole(), 'Open tube'),
          // Deliberately present and deliberately far away: a fill must not
          // touch it, and a digest proves that byte for byte.
          named('b', tetrahedronMesh(), 'Untouched', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };

    case HarnessFixtureId.HoleFillLarge:
      /*
       * THE WORST CASE THE POLICY ALLOWS: a 512-vertex boundary — the ceiling —
       * on roughly 100,000 faces. Measured at ~1.25 s off-thread, which is a
       * long enough window for a responsiveness test to have something to
       * sample, and long enough for a cancellation to have something to
       * interrupt.
       */
      return { parts: [named('a', largeFillablePart(), 'Large fillable')] };

    case HarnessFixtureId.HoleFillPierced:
      return { parts: [named('a', hp23PatchPiercesOppositeShell(), 'Pierced by its own patch')] };

    case HarnessFixtureId.HoleFillSharedPair: {
      // ONE MESH OBJECT, TWO PARTS. Not two equal meshes — the same reference,
      // which is what makes the isolation question meaningful at all.
      const shared = hp02QuadHole();
      return {
        parts: [
          named('a', shared, 'Shared A'),
          named('b', shared, 'Shared B', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.HoleFillShared1000: {
      // ONE mesh object, a thousand parts. Not a thousand equal meshes — the
      // whole point is that the sharing is real before the fill touches it.
      const shared = hp02QuadHole();
      return {
        parts: Array.from({ length: 1_000 }, (_, index) =>
          named(`p${String(index)}`, shared, 'Placement', translation(index * 4, 0, 0)),
        ),
      };
    }

    case HarnessFixtureId.RepairShared1000Millimetre: {
      const shared = duplicateDefectMesh();
      return {
        unit: LengthUnit.Millimeter,
        parts: Array.from({ length: 1_000 }, (_, index) =>
          named(`p${String(index)}`, shared, 'Placement', translation(index * 4, 0, 0)),
        ),
      };
    }

    case HarnessFixtureId.RepairSharedIndexedPairMillimetre: {
      const shared = indexedDuplicateDefectMesh();
      return {
        unit: LengthUnit.Millimeter,
        parts: [
          named('a', shared, 'Shared component'),
          named('b', shared, 'Shared component', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.RepairSharedPairMillimetre: {
      const shared = duplicateDefectMesh();
      return {
        unit: LengthUnit.Millimeter,
        parts: [
          named('a', shared, 'Shared component'),
          named('b', shared, 'Shared component', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.HoleFillSharedPairMillimetre: {
      const shared = hp02QuadHole();
      /*
       * BOTH PARTS CARRY THE SAME NAME, and that is load-bearing rather than
       * lazy. The 3MF writer groups objects by (MESH, NAME) — the metadata an
       * `<object>` element actually carries — so two placements that share a
       * mesh but disagree about their name correctly become two resources.
       * Naming them alike is what makes a resource count a statement about MESH
       * SHARING and nothing else, which is what this fixture exists to observe.
       */
      return {
        unit: LengthUnit.Millimeter,
        parts: [
          named('a', shared, 'Shared component'),
          named('b', shared, 'Shared component', translation(PART_B_OFFSET_X, 0, 0)),
        ],
      };
    }

    case HarnessFixtureId.HoleFillTransformed:
      return {
        parts: [
          named('a', hp02QuadHole(), 'Placed and mirrored', [
            // Non-uniform scale on X and Y, a mirror on Z, and a translation.
            // Row-major 3x4: the linear block then the translation.
            2,
            0,
            0,
            0,
            3,
            0,
            0,
            0,
            -1,
            PART_B_OFFSET_X,
            PART_C_OFFSET_Y,
            4,
          ]),
        ],
      };
  }
}

/** A 512-vertex boundary on ~100,000 faces of unrelated bulk. */
function largeFillablePart(): CanonicalMesh {
  const bodies: CanonicalMesh[] = [hpBoundaryOfSize(512)];
  for (let index = 0; index < 25_000; index += 1) {
    // Far from the hole, so the bulk exercises the broadphase rather than the
    // narrowphase — the question is whether a large part costs anything when
    // none of it is anywhere near the patch.
    bodies.push(holeFillTetrahedron([100_000 + index * 0.5, 0, 0], 0.25));
  }
  return concatMeshes(...bodies);
}
