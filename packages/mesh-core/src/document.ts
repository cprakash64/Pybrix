import type { LengthUnit } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  triangleCount,
  vertexCount,
  type CanonicalMesh,
} from './mesh';
import { placementReversesOrientation } from './placement';
import type { MeshBounds, Vector3Tuple } from './analysis';
import type { JointRecord } from './joint';

/**
 * The canonical multi-part geometry document.
 *
 * WHY THIS EXISTS. Until Stage 4A-2A the authoritative unit of geometry was one
 * `CanonicalMesh`. That was adequate while STL was the only format, because an
 * STL file describes exactly one triangle soup. OBJ and 3MF do not: an OBJ `o`
 * record and a 3MF `<build><item>` each declare a separate thing, and a 3MF
 * component may place the SAME geometry twice. A single-mesh authority can only
 * represent those by flattening, which destroys per-item transforms and object
 * identity — see docs/adr/0013 for why that was rejected.
 *
 * WHAT THIS IS NOT. Not a scene graph. There are no cameras, no lights, no
 * animation, no hierarchy and no B-rep. The only concepts here are the ones the
 * qualified research showed OBJ, 3MF, conversion and future splitting need.
 *
 * WHERE IDENTITY AND REVISION LIVE. Deliberately NOT here. A document object
 * carrying its own `revision` field would be a second revision authority beside
 * the resident store's, and the two could disagree. The store owns identity and
 * the single monotonic revision; this type owns content only.
 */

declare const partIdBrand: unique symbol;

/**
 * Stable identity of a part within one document.
 *
 * Branded so a part can never be passed where a document is expected, and vice
 * versa. Part identity is NOT encoded into the document revision: a part keeps
 * its id across every revision in which it survives, which is what lets a
 * repair name the part it repaired and an undo put the result back where it
 * came from.
 */
export type PartId = string & { readonly [partIdBrand]: true };

export function partId(value: string): PartId {
  return value as PartId;
}

/**
 * A part's placement, as twelve Float64 values in the order 3MF states them:
 * `[m00 m01 m02, m10 m11 m12, m20 m21 m22, m30 m31 m32]`, where the last three
 * are the translation.
 *
 * POINTS ARE ROW VECTORS: `p' = p * M`, so
 * `x' = x*m00 + y*m10 + z*m20 + m30`. That is the 3MF core specification's own
 * convention and the one the Stage 4A research qualified against — see RT05 in
 * `experiments/format-io/threemf-matrix.mjs`, which places `(1,0,0)` under
 * `[0 2 0, -2 0 0, 0 0 2, 0 0 0]` and expects `(0, 2, …)`.
 *
 * THIS IS THE TRANSPOSE OF THE COLUMN-VECTOR READING, and getting it backwards
 * is invisible until a file contains a rotation: translation lives at indices
 * 9..11 either way, so identity and pure-translation fixtures agree under both.
 * Stage 4A-2A had only those, and read the values the other way round; Stage
 * 4A-2B1 corrected it when real 3MF rotations arrived.
 *
 * TWELVE, NOT SIXTEEN. The bottom row of an affine 3D transform is always
 * `0 0 0 1`; storing it invites a caller to write something else there and
 * produce a projective transform the rest of the product cannot honour. This is
 * also the shape 3MF states its `transform` attribute in, so an import neither
 * reorders nor pads.
 *
 * FLOAT64, NOT FLOAT32. Transforms are read from text and written back to text.
 * The research measured a Float32 narrowing as introducing an error the source
 * never had, and a `toFixed(6)` writer as losing 51,649 of 99,959 values. A
 * plain JS number tuple IS Float64, so the contract is met by construction
 * rather than by a comment.
 *
 * NEVER BAKED INTO POSITIONS. Applying a transform to canonical Float32
 * coordinates is irreversible and would turn two placements of one component
 * into two unrelated meshes.
 */
export type PartTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const IDENTITY_PART_TRANSFORM: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * Composes two placements: `outer` applied after `inner`.
 *
 * WHY THIS BELONGS HERE. 3MF components nest, and each level carries its own
 * transform, so a leaf placement is the composition of every transform on the
 * path to it. Composing in the importer would put matrix arithmetic in a
 * parser; composing here keeps one implementation beside the convention it
 * depends on, where a reader can check the two against each other.
 *
 * Float64 throughout — see `PartTransform` on why placements are never
 * narrowed.
 */
export function composePartTransforms(outer: PartTransform, inner: PartTransform): PartTransform {
  /*
   * DESTRUCTURED RATHER THAN INDEXED. `noUncheckedIndexedAccess` types a
   * computed index into a tuple as possibly `undefined`, so an arithmetic loop
   * over these would be a wall of `?? 0` defaults that quietly turn a wiring
   * mistake into a zero. Naming all twenty-four values costs two lines and
   * makes the composition below read as the matrix product it is.
   */
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, a30, a31, a32] = inner;
  const [b00, b01, b02, b10, b11, b12, b20, b21, b22, b30, b31, b32] = outer;

  return [
    a00 * b00 + a01 * b10 + a02 * b20,
    a00 * b01 + a01 * b11 + a02 * b21,
    a00 * b02 + a01 * b12 + a02 * b22,

    a10 * b00 + a11 * b10 + a12 * b20,
    a10 * b01 + a11 * b11 + a12 * b21,
    a10 * b02 + a11 * b12 + a12 * b22,

    a20 * b00 + a21 * b10 + a22 * b20,
    a20 * b01 + a21 * b11 + a22 * b21,
    a20 * b02 + a21 * b12 + a22 * b22,

    a30 * b00 + a31 * b10 + a32 * b20 + b30,
    a30 * b01 + a31 * b11 + a32 * b21 + b31,
    a30 * b02 + a31 * b12 + a32 * b22 + b32,
  ];
}

/**
 * One thing in the document.
 *
 * `mesh` may be the SAME object as another part's mesh. That is not an
 * accident to be defended against — it is how repeated 3MF component
 * placements are represented without duplicating vertex buffers. Meshes are
 * immutable at a given revision, so sharing one is safe.
 */
export interface GeometryPart {
  readonly id: PartId;
  readonly mesh: CanonicalMesh;
  readonly transform: PartTransform;
  /** As the source named it. Opaque content, never a path. Absent if unnamed. */
  readonly name?: string;
  /** Opaque material reference. Never resolved, never dereferenced. */
  readonly materialRef?: string;
}

export interface GeometryDocument {
  /**
   * The document's physical unit, or `undefined` when the source stated none.
   *
   * THE SINGLE UNIT AUTHORITY. Parts inside one document cannot disagree about
   * physical unit, because a part has no unit field to disagree with. STL and
   * OBJ state no unit and produce `undefined`; nothing defaults it to
   * millimetres.
   */
  readonly unit?: LengthUnit;
  /** Ordered. Order is the source's order and is preserved on export. */
  readonly parts: readonly GeometryPart[];
  /**
   * The editable connectors this session made (Stage EC-1), or a bounded trail of the ones that stopped being usable.
   *
   * SESSION STATE, NOT FILE CONTENT. No reader produces it and no writer reads it: an export carries the pieces as plain
   * geometry, exactly as before. Whether a record is still usable is DERIVED from the parts (`jointAttachment`), never read
   * from a flag, because every operation that replaces a part spreads the previous document and would carry a flag along.
   */
  readonly joints?: readonly JointRecord[];
}

/**
 * Bounds on what may become authoritative.
 *
 * WHY A CEILING AT ALL. A 3MF archive can legally describe thousands of build
 * items, and component expansion multiplies them. Committing an unbounded
 * document would let a file decide how much memory the worker holds, which is
 * exactly the decision the budgets exist to take away from untrusted input.
 *
 * WHERE THESE NUMBERS COME FROM. `maxParts` mirrors the 4,096-entry archive cap
 * qualified in ADR 0013 — a part cannot outnumber the entries that could
 * describe it. The triangle and vertex ceilings are `DEFAULT_IMPORT_BUDGET`'s,
 * now applied across the whole document rather than to one mesh, so splitting a
 * model into parts cannot be used to walk past a limit one mesh could not.
 * `maxTotalGeometryBytes` equals the session's `maxResidentBytes`: a document
 * that could not be held resident must not be built in the first place. The
 * string caps mirror the 512-byte path cap for the same reason names arrive
 * from the same untrusted files.
 *
 * These are MVP values derived from current evidence, not values frozen by the
 * Stage 4A research. They are stated so they can be argued with.
 */
export interface DocumentLimits {
  readonly maxParts: number;
  readonly maxTotalTriangles: number;
  readonly maxTotalVertices: number;
  readonly maxTotalGeometryBytes: number;
  readonly maxNameLength: number;
  readonly maxMaterialRefLength: number;
}

export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = {
  maxParts: 4096,
  maxTotalTriangles: 20_000_000,
  maxTotalVertices: 60_000_000,
  maxTotalGeometryBytes: 768 * 1024 * 1024,
  maxNameLength: 512,
  maxMaterialRefLength: 512,
};

/* ----------------------------------------------------------- construction -- */

export interface SinglePartDocumentOptions {
  readonly id?: PartId;
  readonly unit?: LengthUnit;
  readonly name?: string;
}

/**
 * The one-part document an STL import produces.
 *
 * Identity transform, `undefined` unit unless the caller states one. This is
 * the shape every existing single-mesh workflow now sees, and it is why the
 * STL era's behaviour survives the migration unchanged.
 */
export function singlePartDocument(
  mesh: CanonicalMesh,
  options: SinglePartDocumentOptions = {},
): GeometryDocument {
  const part: GeometryPart = {
    id: options.id ?? partId('part-1'),
    mesh,
    transform: IDENTITY_PART_TRANSFORM,
    ...(options.name === undefined ? {} : { name: options.name }),
  };
  return {
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    parts: [part],
  };
}

/* ------------------------------------------------------------- inspection -- */

export function findPart(document: GeometryDocument, id: PartId): GeometryPart | undefined {
  for (const part of document.parts) {
    if (part.id === id) return part;
  }
  return undefined;
}

export function partIndexOf(document: GeometryDocument, id: PartId): number {
  for (let index = 0; index < document.parts.length; index += 1) {
    const part = document.parts[index];
    if (part?.id === id) return index;
  }
  return -1;
}

export function documentTriangleCount(document: GeometryDocument): number {
  let total = 0;
  for (const part of document.parts) total += triangleCount(part.mesh);
  return total;
}

export function documentVertexCount(document: GeometryDocument): number {
  let total = 0;
  for (const part of document.parts) total += vertexCount(part.mesh);
  return total;
}

/**
 * The DISTINCT meshes a document holds, in first-appearance order.
 *
 * Distinct by object identity, which is what makes structural sharing
 * measurable: a document with 1,000 placements of one component returns one
 * mesh here, and any byte accounting built on this counts that geometry once.
 */
export function distinctMeshes(document: GeometryDocument): readonly CanonicalMesh[] {
  const seen = new Set<CanonicalMesh>();
  const meshes: CanonicalMesh[] = [];
  for (const part of document.parts) {
    if (seen.has(part.mesh)) continue;
    seen.add(part.mesh);
    meshes.push(part.mesh);
  }
  return meshes;
}

/* -------------------------------------------------------------- rewriting -- */

/**
 * Produces a new document in which one part carries a different mesh.
 *
 * STRUCTURAL SHARING IS THE POINT. Every other part is carried over BY
 * REFERENCE — the same `GeometryPart` object, holding the same `CanonicalMesh`
 * object, holding the same buffers. Repairing one part of a hundred-part
 * document therefore allocates one new part record and one array of a hundred
 * references, not a hundred copies of geometry.
 *
 * Returns `undefined` when the part is not in the document, so a caller cannot
 * mistake a no-op for a successful edit.
 */
export function withPartMesh(
  document: GeometryDocument,
  id: PartId,
  mesh: CanonicalMesh,
): GeometryDocument | undefined {
  const index = partIndexOf(document, id);
  if (index < 0) return undefined;
  const existing = document.parts[index];
  if (existing === undefined) return undefined;

  const parts = document.parts.slice();
  parts[index] = { ...existing, mesh };
  return { ...document, parts };
}

/**
 * Produces a new document in which one part carries a different transform.
 *
 * The MESH OBJECT IS UNTOUCHED — the same reference, the same bytes. A
 * placement change must never rewrite coordinates.
 */
export function withPartTransform(
  document: GeometryDocument,
  id: PartId,
  transform: PartTransform,
): GeometryDocument | undefined {
  const index = partIndexOf(document, id);
  if (index < 0) return undefined;
  const existing = document.parts[index];
  if (existing === undefined) return undefined;

  const parts = document.parts.slice();
  parts[index] = { ...existing, transform };
  return { ...document, parts };
}

/* ------------------------------------------------------------- placement -- */

/**
 * Applies a part transform to a point.
 *
 * ROW-MAJOR 3x4, matching `PartTransform`: the first nine values are the basis
 * and the last three are the translation. Computed in Float64 — JS numbers —
 * because a placement composed of several transforms should not accumulate
 * Float32 error on the way to a bounding box.
 */
export function applyPartTransform(
  transform: PartTransform,
  x: number,
  y: number,
  z: number,
): Vector3Tuple {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22, m30, m31, m32] = transform;
  // Row-vector convention: the FIRST index of each term varies with the input
  // axis, not with the output axis. See `PartTransform`.
  return [
    m00 * x + m10 * y + m20 * z + m30,
    m01 * x + m11 * y + m21 * z + m31,
    m02 * x + m12 * y + m22 * z + m32,
  ];
}

/**
 * A mesh as it stands once its placement has been applied: a COPY whose positions are the placed coordinates and whose triangles keep
 * their outside facing out (Stage C03-D).
 *
 * THE PLACEMENT IS APPLIED ONCE, in Float64 by `applyPartTransform`, and narrowed ONCE to the canonical Float32 on assignment — the same
 * single narrowing every writer performs, so a baked copy and a streamed bake agree bit for bit. A placement that mirrors the part
 * (`placementReversesOrientation`) also swaps the second and third corner of every triangle; without that a closed solid comes out
 * inside out, with its normals into the material and a negative volume. Vertices, triangle order and groups are otherwise untouched, so
 * every face keeps its index and every group range still names exactly its own faces.
 *
 * WHAT IT DROPS: stored normals and texture coordinates. A normal is placed by the inverse transpose and a texture coordinate is not
 * a position; this carries neither, and every consumer of a placed mesh (an STL or OBJ writer) derives or ignores them. Nothing is
 * stored back: the authoritative mesh is never replaced by this.
 *
 * It exists for the operations that hold ONE mesh and cannot stream a bake, notably the active-part STL export. The document writers
 * bake while writing and never build this: there is no flattened mesh of a whole document anywhere.
 */
export function placeMesh(mesh: CanonicalMesh, transform: PartTransform): CanonicalMesh {
  const positions = createPositionArray(mesh.positions.length);
  for (let at = 0; at + 2 < mesh.positions.length; at += 3) {
    const [x, y, z] = applyPartTransform(
      transform,
      mesh.positions[at] ?? 0,
      mesh.positions[at + 1] ?? 0,
      mesh.positions[at + 2] ?? 0,
    );
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
  }
  const indices = createIndexArray(mesh.indices.length);
  const reversed = placementReversesOrientation(transform);
  for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
    indices[at] = mesh.indices[at] ?? 0;
    indices[at + 1] = mesh.indices[at + (reversed ? 2 : 1)] ?? 0;
    indices[at + 2] = mesh.indices[at + (reversed ? 1 : 2)] ?? 0;
  }
  return {
    positions,
    indices,
    ...(mesh.groups === undefined ? {} : { groups: mesh.groups }),
    metadata: mesh.metadata,
  };
}

/**
 * The world-space axis-aligned box of a part-local box under a placement.
 *
 * ALL EIGHT CORNERS, not the two extremes. Transforming only `min` and `max`
 * is the classic bug: under any rotation the transformed extremes are not the
 * extremes of the transformed box, and the result silently clips the model.
 */
export function transformBounds(bounds: MeshBounds, transform: PartTransform): MeshBounds {
  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;

  let loX = Number.POSITIVE_INFINITY;
  let loY = Number.POSITIVE_INFINITY;
  let loZ = Number.POSITIVE_INFINITY;
  let hiX = Number.NEGATIVE_INFINITY;
  let hiY = Number.NEGATIVE_INFINITY;
  let hiZ = Number.NEGATIVE_INFINITY;

  for (const cx of [minX, maxX]) {
    for (const cy of [minY, maxY]) {
      for (const cz of [minZ, maxZ]) {
        const [x, y, z] = applyPartTransform(transform, cx, cy, cz);
        if (x < loX) loX = x;
        if (y < loY) loY = y;
        if (z < loZ) loZ = z;
        if (x > hiX) hiX = x;
        if (y > hiY) hiY = y;
        if (z > hiZ) hiZ = z;
      }
    }
  }

  return boundsFromExtremes(loX, loY, loZ, hiX, hiY, hiZ);
}

/** The smallest box containing both, or whichever one exists. */
export function unionBounds(
  a: MeshBounds | undefined,
  b: MeshBounds | undefined,
): MeshBounds | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return boundsFromExtremes(
    Math.min(a.min[0], b.min[0]),
    Math.min(a.min[1], b.min[1]),
    Math.min(a.min[2], b.min[2]),
    Math.max(a.max[0], b.max[0]),
    Math.max(a.max[1], b.max[1]),
    Math.max(a.max[2], b.max[2]),
  );
}

function boundsFromExtremes(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): MeshBounds {
  const size: Vector3Tuple = [maxX - minX, maxY - minY, maxZ - minZ];
  const center: Vector3Tuple = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    size,
    center,
    radius: Math.hypot(size[0], size[1], size[2]) / 2,
  };
}
