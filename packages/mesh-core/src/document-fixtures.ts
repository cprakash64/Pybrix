import { createIndexArray, createPositionArray, type CanonicalMesh } from './mesh';
import {
  jointId,
  type ConnectorJoint,
  type JointConnectorSpec,
  type JointFrame,
  type JointId,
} from './joint';
import {
  IDENTITY_PART_TRANSFORM,
  partId,
  type GeometryDocument,
  type GeometryPart,
  type PartTransform,
} from './document';

/**
 * DETERMINISTIC MULTI-PART FIXTURES — MP01 to MP08.
 *
 * WHY THESE ARE SYNTHETIC. Production import is still STL-only, and STL
 * describes exactly one part. Rather than register a fake multi-part format
 * purely so tests have something to load — which would put a codec in the
 * interface that does not exist — the documents below are constructed directly.
 * Every one of them is the shape a real OBJ or 3MF import will produce in Stage
 * 4A-2B, so the guards they exercise are the guards that will be load-bearing
 * then.
 *
 * TEST-ONLY. Exposed through the package's `./fixtures` subpath, exactly as
 * `mesh-topology/fixtures` is, and no production path imports it.
 */

/* --------------------------------------------------------------- meshes -- */

/**
 * A closed tetrahedron: four faces, four topological vertices, no defects.
 *
 * Written as soup — twelve corners, indices 0..11 — because that is what an STL
 * import produces and therefore what the rest of the product is calibrated on.
 */
export function tetrahedronMesh(scale = 1): CanonicalMesh {
  const a: readonly [number, number, number] = [0, 0, 0];
  const b: readonly [number, number, number] = [scale, 0, 0];
  const c: readonly [number, number, number] = [0, scale, 0];
  const d: readonly [number, number, number] = [0, 0, scale];
  return soup([
    [a, c, b],
    [a, b, d],
    [b, c, d],
    [c, a, d],
  ]);
}

/**
 * A tetrahedron with one face repeated in the SAME orientation.
 *
 * MP06's defect. An exact duplicate is the one removal the conservative engine
 * will always take, so this is a document a repair genuinely changes.
 */
export function duplicateDefectMesh(): CanonicalMesh {
  const a: readonly [number, number, number] = [0, 0, 0];
  const b: readonly [number, number, number] = [1, 0, 0];
  const c: readonly [number, number, number] = [0, 1, 0];
  const d: readonly [number, number, number] = [0, 0, 1];
  return soup([
    [a, c, b],
    [a, c, b],
    [a, b, d],
    [b, c, d],
    [c, a, d],
  ]);
}

/**
 * The same defective tetrahedron, INDEXED: four vertices, five faces.
 *
 * MP06's defect over a shared vertex table, because `duplicateDefectMesh` is
 * soup and soup cannot show what Stage 4B-1D is about. Five faces referencing
 * four corners is a 3.75:1 sharing ratio, so a candidate rebuilt as soup is
 * unmistakable: twelve vertices where four went in.
 */
export function indexedDuplicateDefectMesh(): CanonicalMesh {
  const positions = createPositionArray(12);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const indices = createIndexArray(15);
  // Face 1 repeats face 0 in the same orientation — the one removal the
  // conservative engine will always take.
  indices.set([0, 2, 1, 0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  return { positions, indices, metadata: { sourceFormat: 'obj' } };
}

/**
 * Two triangles that genuinely cross each other.
 *
 * MP07. One lies in the XY plane; the other stands vertically and passes
 * through its interior, so the crossing is a property of THIS mesh's own faces —
 * which is what self-intersection means, and what makes it different from two
 * parts that merely overlap in world space.
 */
export function selfIntersectingMesh(): CanonicalMesh {
  return soup([
    [
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
    ],
    [
      [1, 1, -2],
      [1, 1, 2],
      [3, 1, 0],
    ],
  ]);
}

/**
 * A mesh with `faces` triangles over three shared corners.
 *
 * DELIBERATELY DEGENERATE, and deliberately cheap. The policy bands are decided
 * by FACE COUNT alone, so a fixture that proves the >250,000 band is refused
 * before any allocation must not itself allocate the megabytes that band exists
 * to refuse. Three positions and `faces * 3` indices does that: structurally
 * valid, in-range, and a fraction of the memory.
 */
export function faceCountMesh(faces: number): CanonicalMesh {
  const positions = createPositionArray(9);
  positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = createIndexArray(faces * 3);
  for (let index = 0; index < indices.length; index += 1) indices[index] = index % 3;
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

function soup(
  triangles: readonly (readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ])[],
): CanonicalMesh {
  const positions = createPositionArray(triangles.length * 9);
  const indices = createIndexArray(triangles.length * 3);
  let cursor = 0;
  for (const triangle of triangles) {
    for (const corner of triangle) {
      positions[cursor] = corner[0];
      positions[cursor + 1] = corner[1];
      positions[cursor + 2] = corner[2];
      cursor += 3;
    }
  }
  for (let index = 0; index < indices.length; index += 1) indices[index] = index;
  return { positions, indices, metadata: { sourceFormat: 'stl' } };
}

/* ------------------------------------------------------------ documents -- */

export function translation(x: number, y: number, z: number): PartTransform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
}

export function makePart(
  id: string,
  mesh: CanonicalMesh,
  options: { readonly transform?: PartTransform; readonly name?: string } = {},
): GeometryPart {
  return {
    id: partId(id),
    mesh,
    transform: options.transform ?? IDENTITY_PART_TRANSFORM,
    ...(options.name === undefined ? {} : { name: options.name }),
  };
}

/** MP01 — two independent parts, each with its own mesh. */
export function mp01TwoIndependentParts(): GeometryDocument {
  return {
    parts: [
      makePart('a', tetrahedronMesh(1)),
      makePart('b', tetrahedronMesh(2), { transform: translation(10, 0, 0) }),
    ],
  };
}

/** MP02 — two parts sharing ONE `CanonicalMesh` reference. */
export function mp02SharedGeometry(): GeometryDocument {
  const shared = tetrahedronMesh();
  return {
    parts: [makePart('a', shared), makePart('b', shared, { transform: translation(5, 0, 0) })],
  };
}

/** MP03 — three parts at three different placements. */
export function mp03DistinctTransforms(): GeometryDocument {
  const shared = tetrahedronMesh();
  return {
    parts: [
      makePart('a', shared, { transform: translation(0, 0, 0) }),
      makePart('b', shared, { transform: translation(3, 0, 0) }),
      makePart('c', shared, { transform: translation(0, 7, -2) }),
    ],
  };
}

/** MP04 — named parts, so the selector has something to quote. */
export function mp04NamedParts(): GeometryDocument {
  return {
    parts: [
      makePart('a', tetrahedronMesh(), { name: 'Left bracket' }),
      makePart('b', tetrahedronMesh(), { name: 'Right bracket' }),
    ],
  };
}

/** MP05 — one small part beside one above the self-intersection ceiling. */
export function mp05SmallAndOversized(oversizedFaces = 250_001): GeometryDocument {
  return {
    parts: [makePart('small', tetrahedronMesh()), makePart('huge', faceCountMesh(oversizedFaces))],
  };
}

/** MP06 — a repairable duplicate defect in part A, a clean part B. */
export function mp06RepairableDefect(): GeometryDocument {
  return {
    parts: [
      makePart('a', duplicateDefectMesh(), { name: 'Defective' }),
      makePart('b', tetrahedronMesh(), { name: 'Clean', transform: translation(9, 0, 0) }),
    ],
  };
}

/** MP07 — a part whose own faces cross, beside a clean one. */
export function mp07SelfIntersecting(): GeometryDocument {
  return {
    parts: [
      makePart('a', selfIntersectingMesh(), { name: 'Crossing' }),
      makePart('b', tetrahedronMesh(), { name: 'Clean', transform: translation(20, 0, 0) }),
    ],
  };
}

/**
 * MP08 — many placements of ONE mesh.
 *
 * The memory and performance fixture. Every part references the same
 * `CanonicalMesh` object, so the document's geometry cost is one mesh no matter
 * how large `count` is — which is the property the whole sharing design exists
 * to deliver, and the one these fixtures let a test measure.
 */
export function mp08SharedPlacements(count = 1000): GeometryDocument {
  const shared = tetrahedronMesh();
  const parts: GeometryPart[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(makePart(`p${String(index)}`, shared, { transform: translation(index * 2, 0, 0) }));
  }
  return { parts };
}

/* ------------------------------------------------------- editable joints -- */

export interface JointFixtureOptions {
  readonly id?: string;
  /** `undefined` is a plain joint. Defaults to one resolver-sited pin. */
  readonly connector?: JointConnectorSpec | undefined;
  /** Bytes the interface authority claims to hold. */
  readonly authorityBytes?: number;
  readonly frame?: JointFrame;
}

export const FIXTURE_JOINT_FRAME: JointFrame = Object.freeze({
  unit: 'millimeter',
  mmPerUnit: 1,
  placementScale: 1,
  mmPerCoordinate: 1,
});

export const FIXTURE_PIN_SPEC: JointConnectorSpec = Object.freeze({
  policy: 'units-v2',
  kind: 'pin',
  maleSide: 'A',
  elements: Object.freeze([
    Object.freeze({
      pinId: 'pin-1',
      site: 'RESOLVED' as const,
      diameterMm: 4,
      depthMm: 6,
      clearanceMm: 0.2,
    }),
  ]),
});

/**
 * A document of two parts, A and B, joined by one ATTACHED joint: each part holds the mesh the joint built, the base is a
 * DIFFERENT mesh (the piece before its connector), and the document's unit is the frame's. Returns the document and the joint so a
 * test can break exactly one of the four things attachment depends on.
 */
export function jointedDocument(options: JointFixtureOptions = {}): {
  readonly document: GeometryDocument;
  readonly joint: ConnectorJoint;
  readonly id: JointId;
} {
  const frame = options.frame ?? FIXTURE_JOINT_FRAME;
  const builtA = tetrahedronMesh(2);
  const builtB = tetrahedronMesh(3);
  const a = makePart('part-a', builtA);
  const b = makePart('part-b', builtB);
  const id = jointId(options.id ?? 'document-1/joint/1');
  const joint: ConnectorJoint = Object.freeze({
    kind: 'joint',
    jointId: id,
    a: Object.freeze({
      partId: a.id,
      baseMesh: tetrahedronMesh(1.5),
      builtMesh: builtA,
      builtTransform: a.transform,
    }),
    b: Object.freeze({
      partId: b.id,
      baseMesh: tetrahedronMesh(2.5),
      builtMesh: builtB,
      builtTransform: b.transform,
    }),
    frame,
    authority: Object.freeze({
      provenanceSHA: 'sha-fixture',
      retainedBytes: options.authorityBytes ?? 0,
      detail: Object.freeze({}),
    }),
    connector: 'connector' in options ? options.connector : FIXTURE_PIN_SPEC,
  });
  return {
    document: { unit: frame.unit, parts: [a, b], joints: [joint] },
    joint,
    id,
  };
}
