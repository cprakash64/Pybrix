import {
  distinctMeshes,
  placementReversesOrientation,
  triangleCount,
  type CanonicalMesh,
  type GeometryDocument,
} from '@cadfixer/mesh-core';
import { ExportRefusal, exportBlocked, exportInternal } from './export-errors';
import {
  mirroredObjectPlacement,
  planThreeMfObjects,
  type ExportDocumentSnapshot,
} from './export-contract';
import { xmlSafeText } from '../threemf/xml-scan';

/**
 * PARSE-BACK VALIDATION: a serialiser returning bytes is not proof of a file.
 *
 * Every successful OBJ and 3MF export has been read back by the PRODUCTION
 * reader and compared with what it was written from. There is no
 * "skip validation for speed" option, and there is not going to be one: the
 * whole value of an exporter is that the file opens somewhere else, and the
 * only evidence we can gather locally is that it opens here.
 *
 * The comparison is on SEMANTICS, not on bytes. Two files can be textually
 * different and describe the same document — and one file can be textually
 * plausible and describe a different one, which is the case this exists to
 * catch.
 */

function fail(detail: string, details?: Record<string, string | number>): never {
  throw exportInternal(
    ExportRefusal.ValidationFailed,
    'Pybrix wrote a file it could not read back as the same model, so the export was refused.',
    { detail, ...details },
  );
}

/* ------------------------------------------------------ request validation -- */

function looksLikeArray(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Rejects a snapshot that could not describe a document at all.
 *
 * DEFENSIVE, at the boundary the export worker is reached through. Everything
 * here is impossible if the authoritative worker built the snapshot correctly —
 * which is exactly why it is checked: a malformed snapshot reaching a
 * serialiser turns into an out-of-range read, and an out-of-range read on a
 * typed array is a silent zero rather than an error.
 */
export function assertExportSnapshot(snapshot: ExportDocumentSnapshot): void {
  /*
   * CHECKED THROUGH A HELPER, because `Array.isArray` on a value declared
   * `readonly T[]` narrows it to `any[]` — which then silently disables type
   * checking for every use of it below. The guard is the point; the narrowing
   * is a side effect that costs more than the guard is worth.
   */
  if (!looksLikeArray(snapshot.parts) || !looksLikeArray(snapshot.meshes)) {
    throw exportBlocked(
      ExportRefusal.MalformedSnapshot,
      'The export request did not contain a usable document.',
    );
  }
  if (snapshot.parts.length === 0) {
    throw exportBlocked(
      ExportRefusal.NoParts,
      'This document has no parts, so there is nothing to write.',
    );
  }

  for (const [index, mesh] of snapshot.meshes.entries()) {
    if (!(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
      throw exportBlocked(
        ExportRefusal.MalformedSnapshot,
        'The export request contained geometry Pybrix cannot read.',
        { meshIndex: index },
      );
    }
    if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) {
      throw exportBlocked(
        ExportRefusal.MalformedSnapshot,
        'The export request contained geometry of the wrong shape.',
        { meshIndex: index },
      );
    }
    const vertices = mesh.positions.length / 3;
    for (const index0 of mesh.indices) {
      if (index0 >= vertices) {
        throw exportBlocked(
          ExportRefusal.MalformedSnapshot,
          'The export request contained a triangle referring to a vertex that does not exist.',
          { meshIndex: index },
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const [index, part] of snapshot.parts.entries()) {
    if (typeof part.partId !== 'string' || part.partId.length === 0) {
      throw exportBlocked(
        ExportRefusal.MalformedSnapshot,
        'A part in the export request has no identifier.',
        { partIndex: index },
      );
    }
    if (seen.has(part.partId)) {
      throw exportBlocked(
        ExportRefusal.DuplicatePartId,
        'Two parts in the export request claim the same identifier.',
        { partIndex: index },
      );
    }
    seen.add(part.partId);

    if (snapshot.meshes[part.meshResourceIndex] === undefined) {
      throw exportBlocked(
        ExportRefusal.MissingMeshResource,
        'A part in the export request refers to geometry that is not present.',
        { partIndex: index },
      );
    }
    /*
     * The TYPE says twelve, so the length is not re-checked: a tuple that
     * arrived with a different length came through `structuredClone` and would
     * have failed to be one. What CAN differ at runtime is the VALUES, because
     * a non-finite number survives cloning perfectly well.
     */
    for (const value of part.transform) {
      if (!Number.isFinite(value)) {
        throw exportBlocked(
          ExportRefusal.NonFiniteTransform,
          'A part in the export request has a placement Pybrix cannot write.',
          { partIndex: index },
        );
      }
    }
  }
}

/* --------------------------------------------------------------- helpers -- */

/**
 * Every triangle's three corner coordinates, in face order.
 *
 * WHY NOT COMPARE THE POSITION ARRAYS. A reader renumbers a part's vertices in
 * first-use order, and it drops any vertex no face refers to — both are correct
 * behaviours and both change the array without changing the model. Comparing
 * what the triangles actually touch is a statement about the geometry rather
 * than about one representation of it.
 */
function cornerCoordinates(mesh: CanonicalMesh): Float32Array {
  const out = new Float32Array(mesh.indices.length * 3);
  let at = 0;
  for (const index of mesh.indices) {
    out[at] = mesh.positions[index * 3] ?? 0;
    out[at + 1] = mesh.positions[index * 3 + 1] ?? 0;
    out[at + 2] = mesh.positions[index * 3 + 2] ?? 0;
    at += 3;
  }
  return out;
}

function compareCorners(expected: CanonicalMesh, actual: CanonicalMesh, partIndex: number): void {
  if (triangleCount(expected) !== triangleCount(actual)) {
    fail('triangle count', {
      partIndex,
      expected: triangleCount(expected),
      actual: triangleCount(actual),
    });
  }
  const a = cornerCoordinates(expected);
  const b = cornerCoordinates(actual);
  for (let at = 0; at < a.length; at += 1) {
    // `Object.is`, not `===`: `-0 === 0` is true, and losing a negative zero is
    // a real change to a stored value that a loose comparison would hide.
    if (!Object.is(a[at], b[at])) {
      fail('coordinate', { partIndex, at, expected: String(a[at]), actual: String(b[at]) });
    }
  }
}

/* ------------------------------------------------------------------- OBJ -- */

/**
 * Compares an OBJ read-back against what an OBJ export is expected to become.
 *
 * The expectation is built by `expectedObjRoundTrip`, which states the losses
 * precisely — transforms baked, unit unknown — rather than pretending the file
 * came back unchanged.
 */
export function validateObjRoundTrip(expected: GeometryDocument, parsed: GeometryDocument): void {
  if (parsed.unit !== undefined) {
    fail('unit', { expected: 'undefined', actual: parsed.unit });
  }
  if (parsed.parts.length !== expected.parts.length) {
    fail('part count', { expected: expected.parts.length, actual: parsed.parts.length });
  }

  for (const [index, expectedPart] of expected.parts.entries()) {
    const actual = parsed.parts[index];
    if (actual === undefined) fail('missing part', { partIndex: index });

    compareCorners(expectedPart.mesh, actual.mesh, index);

    if ((expectedPart.name ?? '') !== (actual.name ?? '')) {
      fail('name', { partIndex: index });
    }
    // EVERY TRANSFORM IS THE IDENTITY after a bake. A non-identity here would
    // mean the placement had been applied twice.
    for (const value of actual.transform) {
      if (value !== 0 && value !== 1) fail('transform not identity', { partIndex: index });
    }

    const expectedGroups = expectedPart.mesh.groups ?? [];
    const actualGroups = actual.mesh.groups ?? [];
    if (expectedGroups.length !== actualGroups.length) {
      fail('group count', {
        partIndex: index,
        expected: expectedGroups.length,
        actual: actualGroups.length,
      });
    }
    for (const [at, expectedGroup] of expectedGroups.entries()) {
      const actualGroup = actualGroups[at];
      if (actualGroup === undefined) fail('missing group', { partIndex: index, at });
      if (actualGroup.name !== expectedGroup.name) {
        fail('group name', {
          partIndex: index,
          at,
          expected: expectedGroup.name,
          actual: actualGroup.name,
        });
      }
      if ((actualGroup.materialRef ?? '') !== (expectedGroup.materialRef ?? '')) {
        fail('group material', { partIndex: index, at });
      }
      if (actualGroup.indexCount !== expectedGroup.indexCount) {
        fail('group extent', {
          partIndex: index,
          at,
          expected: expectedGroup.indexCount,
          actual: actualGroup.indexCount,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ STL -- */

/**
 * Compares an STL read-back against what a whole-document STL export becomes.
 *
 * THE STRUCTURAL LOSSES ARE ASSERTED, not tolerated. A file that came back with
 * two parts, a non-identity placement or a unit would mean the writer had done
 * something this format cannot express — so each of those is checked explicitly
 * rather than left out of the comparison because "STL cannot have one anyway".
 */
export function validateStlRoundTrip(expected: GeometryDocument, parsed: GeometryDocument): void {
  if (parsed.unit !== undefined) {
    fail('unit', { expected: 'undefined', actual: parsed.unit });
  }
  if (parsed.parts.length !== 1) {
    fail('part count', { expected: 1, actual: parsed.parts.length });
  }

  const expectedPart = expected.parts[0];
  const actual = parsed.parts[0];
  if (expectedPart === undefined || actual === undefined) fail('missing part', { partIndex: 0 });

  compareCorners(expectedPart.mesh, actual.mesh, 0);

  // A NON-IDENTITY PLACEMENT HERE WOULD MEAN A BAKE THAT DID NOT HAPPEN. STL
  // states no transform, so the reader can only ever produce the identity —
  // which is exactly why a difference would be evidence of a defect elsewhere.
  for (const value of actual.transform) {
    if (value !== 0 && value !== 1) fail('transform not identity', { partIndex: 0 });
  }
  if (actual.name !== undefined) fail('name', { partIndex: 0 });
}

/* ------------------------------------------------------------------ 3MF -- */

/**
 * Compares a 3MF read-back against the snapshot it was written from.
 *
 * 3MF loses nothing this document layer holds, so this is a full semantic
 * equality check rather than a normalised one — which is precisely why it is
 * worth running: any difference at all is a writer bug.
 */
export function validate3mfRoundTrip(
  snapshot: ExportDocumentSnapshot,
  parsed: GeometryDocument,
): void {
  if (parsed.unit !== snapshot.unit) {
    fail('unit', { expected: String(snapshot.unit), actual: String(parsed.unit) });
  }
  if (parsed.parts.length !== snapshot.parts.length) {
    fail('part count', { expected: snapshot.parts.length, actual: parsed.parts.length });
  }

  for (const [index, part] of snapshot.parts.entries()) {
    const actual = parsed.parts[index];
    if (actual === undefined) fail('missing part', { partIndex: index });

    const mesh = snapshot.meshes[part.meshResourceIndex];
    if (mesh === undefined) fail('missing mesh resource', { partIndex: index });

    // A placement that mirrors the part is written as the mesh mirrored in x, its triangles turned, and the placement composed with
    // that mirror (`mirroredObjectPlacement`): the expected geometry is built the same way, from the same one function.
    const mirrored = placementReversesOrientation(part.transform);
    const expectedPlacement = mirrored ? mirroredObjectPlacement(part.transform) : part.transform;
    if (actual.mesh.indices.length !== mesh.indices.length) {
      fail('index count', {
        partIndex: index,
        expected: mesh.indices.length,
        actual: actual.mesh.indices.length,
      });
    }
    for (let at = 0; at < mesh.indices.length; at += 1) {
      const within = at % 3;
      const source = mirrored && within !== 0 ? at + (within === 1 ? 1 : -1) : at;
      if (actual.mesh.indices[at] !== mesh.indices[source]) {
        fail('index', { partIndex: index, at });
      }
    }
    if (actual.mesh.positions.length !== mesh.positions.length) {
      fail('vertex count', {
        partIndex: index,
        expected: mesh.positions.length / 3,
        actual: actual.mesh.positions.length / 3,
      });
    }
    for (let at = 0; at < mesh.positions.length; at += 1) {
      const expected = mirrored && at % 3 === 0 ? -(mesh.positions[at] ?? 0) : mesh.positions[at];
      if (!Object.is(actual.mesh.positions[at], expected)) {
        fail('coordinate', {
          partIndex: index,
          at,
          expected: String(expected),
          actual: String(actual.mesh.positions[at]),
        });
      }
    }

    for (let at = 0; at < 12; at += 1) {
      if (!Object.is(actual.transform[at], expectedPlacement[at])) {
        fail('transform', {
          partIndex: index,
          at,
          expected: String(expectedPlacement[at]),
          actual: String(actual.transform[at]),
        });
      }
    }

    /*
     * COMPARED AGAINST THE XML-SAFE NAME. A control character cannot be written
     * into XML at all, so the writer drops it — and a validator comparing
     * against the raw name would report the writer's only legal option as a
     * bug. What must be true is that everything XML CAN carry came back.
     */
    if (xmlSafeText(part.name ?? '') !== (actual.name ?? '')) fail('name', { partIndex: index });

    /*
     * THE MATERIAL REFERENCE MUST BE GONE, and this asserts its ABSENCE rather
     * than its survival.
     *
     * It used to assert the reference round-tripped, which it did — through an
     * `object@pid` that pointed at a property resource this writer never emits.
     * Our reader accepted the dangling reference, so writer and reader agreed
     * about a file no conforming consumer would accept, and parse-back
     * validation passed on it.
     *
     * The contract is now that CAD Fixer writes no `pid` at all, so a parsed
     * material reference here would mean one had been written — the exact
     * regression this check now exists to catch.
     */
    if (actual.materialRef !== undefined) {
      fail('material reference written', { partIndex: index });
    }
  }

  /*
   * SHARING SURVIVED. A writer that flattened a thousand placements into a
   * thousand objects would satisfy every check above and produce a file a
   * thousand times too large — this is the assertion that notices.
   */
  const parsedDistinct = distinctMeshes(parsed).length;
  const expectedObjects = planThreeMfObjects(snapshot).length;
  if (parsedDistinct !== expectedObjects) {
    fail('mesh sharing', { expected: expectedObjects, actual: parsedDistinct });
  }
}
