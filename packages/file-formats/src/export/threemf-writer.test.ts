import { describe, expect, it } from 'vitest';
import { AppErrorCode, CancellationSource, isAppError, LengthUnit } from '@cadfixer/shared';
import {
  createIndexArray,
  createPositionArray,
  distinctMeshes,
  IDENTITY_PART_TRANSFORM,
  partId,
  placementLinearDeterminant,
  triangleCount,
  type CanonicalMesh,
  type GeometryDocument,
  type PartTransform,
} from '@cadfixer/mesh-core';
import { read3mf, THREE_MF_UNITS } from '../threemf/threemf-reader';
import { MeshFormatId } from '../formats';
import {
  DEFAULT_EXPORT_LIMITS,
  exportSnapshotOf,
  ExportObservation,
  type ExportDocumentSnapshot,
  type WrittenDocument,
} from './export-contract';
import { ExportRefusal, exportRefusalOf } from './export-errors';
import { exportDocument } from './export-document';
import { write3mfDocument } from './threemf-writer';
import { testExportReadContext, testWriteContextWithDeflate } from './test-context';
import { checkModelXml, inspect3mf } from './threemf-oracle';
import { writeFloat64Text } from './numeric';
import { float32Corpus } from './obj-writer.test';

/**
 * MF-W01 – MF-W20, through the PRODUCTION writer and the PRODUCTION reader.
 *
 * 3MF loses nothing this document layer holds, so the parse-back comparison is
 * full semantic equality rather than a normalised one — unit, coordinates,
 * indices, transforms, names, material references AND the sharing between
 * parts. Any difference at all is a writer bug, which is exactly what makes the
 * check worth running on every export.
 *
 * An INDEPENDENT oracle re-derives the archive from its central directory,
 * verifies every CRC, and checks the model XML, because production reader plus
 * production writer agreeing proves only that they agree.
 */

function mesh(positions: readonly number[], indices: readonly number[]): CanonicalMesh {
  const p = createPositionArray(positions.length);
  for (const [at, value] of positions.entries()) p[at] = value;
  const i = createIndexArray(indices.length);
  for (const [at, value] of indices.entries()) i[at] = value;
  return { positions: p, indices: i, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
}

const TRIANGLE = mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);

function tetrahedron(size = 10): CanonicalMesh {
  return mesh([0, 0, 0, size, 0, 0, 0, size, 0, 0, 0, size], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
}

function translation(x: number, y = 0, z = 0): PartTransform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
}

interface PartInput {
  readonly mesh: CanonicalMesh;
  readonly transform?: PartTransform;
  readonly name?: string;
  readonly materialRef?: string;
}

function documentOf(parts: readonly PartInput[], unit?: LengthUnit): GeometryDocument {
  return {
    ...(unit === undefined ? {} : { unit }),
    parts: parts.map((part, index) => ({
      id: partId(`part-${String(index + 1)}`),
      mesh: part.mesh,
      transform: part.transform ?? IDENTITY_PART_TRANSFORM,
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.materialRef === undefined ? {} : { materialRef: part.materialRef }),
    })),
  };
}

async function export3mf(
  document: GeometryDocument,
  limits = DEFAULT_EXPORT_LIMITS,
): Promise<WrittenDocument> {
  return exportDocument({
    snapshot: exportSnapshotOf(document, 'doc-1', 1),
    target: MeshFormatId.ThreeMf,
    write: testWriteContextWithDeflate({ limits }),
    read: testExportReadContext(),
  });
}

async function expectRefusal(
  run: () => Promise<unknown>,
  code: AppErrorCode,
  reason: ExportRefusal,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (cause) {
    caught = cause;
  }
  expect(isAppError(caught), 'expected a typed AppError').toBe(true);
  if (!isAppError(caught)) return;
  expect(caught.code).toBe(code);
  expect(exportRefusalOf(caught)).toBe(reason);
}

/* --------------------------------------------------------------- cases -- */

describe('MF-W01/MF-W02: the simplest documents, and units', () => {
  it('MF-W01: writes and reads back a single triangle', async () => {
    const written = await export3mf(documentOf([{ mesh: TRIANGLE }], LengthUnit.Millimeter));
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts).toHaveLength(1);
    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(1);
    expect(written.metadata.formatId).toBe(MeshFormatId.ThreeMf);
    expect((await inspect3mf(written.bytes)).problems).toEqual([]);
  });

  it.each(THREE_MF_UNITS)('MF-W02: preserves %s and rescales nothing', async (unit) => {
    const written = await export3mf(documentOf([{ mesh: TRIANGLE }], unit as LengthUnit));
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.unit).toBe(unit);
    // THE UNIT SAYS WHAT THE NUMBERS MEAN, not what they are.
    expect([...(parsed.document.parts[0]?.mesh.positions ?? [])]).toEqual([...TRIANGLE.positions]);
    expect(written.metadata.observations).toContain(ExportObservation.UnitPreserved);
  });
});

describe('MF-W03/MF-W04/MF-W07: parts and shared meshes', () => {
  it('MF-W03: writes two independent parts as two objects', async () => {
    const written = await export3mf(
      documentOf(
        [
          { mesh: tetrahedron(), name: 'Left' },
          { mesh: tetrahedron(6), name: 'Right' },
        ],
        LengthUnit.Millimeter,
      ),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Left', 'Right']);
    expect(distinctMeshes(parsed.document)).toHaveLength(2);
  });

  it('MF-W04: writes ONE object for two placements of one mesh', async () => {
    const shared = tetrahedron();
    const written = await export3mf(
      documentOf(
        [{ mesh: shared }, { mesh: shared, transform: translation(40) }],
        LengthUnit.Millimeter,
      ),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const inspected = await inspect3mf(written.bytes);

    expect(inspected.problems).toEqual([]);
    // ONE `<object>` AND TWO `<item>`s, verified in the XML itself rather than
    // inferred from the reader's opinion of it.
    expect((inspected.modelXml ?? '').match(/<object /g)).toHaveLength(1);
    expect((inspected.modelXml ?? '').match(/<item /g)).toHaveLength(2);

    expect(parsed.document.parts).toHaveLength(2);
    expect(distinctMeshes(parsed.document)).toHaveLength(1);
    expect(written.metadata.observations).toContain(ExportObservation.SharingPreserved);
  });

  it('splits a shared mesh when the parts disagree about its name', async () => {
    /*
     * 3MF PUTS THE NAME ON THE `<object>`, not on the `<item>` that places it.
     * So two placements of one mesh under two different names are, in 3MF's own
     * model, two objects. The geometry is written twice and the names are kept,
     * because dropping a name the user gave is the larger loss — and the fact
     * is recorded rather than hidden.
     */
    const shared = tetrahedron();
    const written = await export3mf(
      documentOf(
        [
          { mesh: shared, name: 'A' },
          { mesh: shared, transform: translation(40), name: 'B' },
        ],
        LengthUnit.Millimeter,
      ),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts.map((part) => part.name)).toEqual(['A', 'B']);
    expect(distinctMeshes(parsed.document)).toHaveLength(2);
    expect(written.metadata.observations).toContain(ExportObservation.SharingSplitByMetadata);
    expect(written.metadata.observations).not.toContain(ExportObservation.SharingPreserved);
  });

  it('MF-W07: writes 1,000 placements without writing the geometry 1,000 times', async () => {
    const shared = tetrahedron();
    const parts = Array.from({ length: 1_000 }, (_part, index) => ({
      mesh: shared,
      transform: translation(index * 20),
    }));

    const written = await export3mf(documentOf(parts, LengthUnit.Millimeter));
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const inspected = await inspect3mf(written.bytes);

    expect(inspected.problems).toEqual([]);
    expect((inspected.modelXml ?? '').match(/<vertex /g)).toHaveLength(4);
    expect((inspected.modelXml ?? '').match(/<item /g)).toHaveLength(1_000);

    expect(parsed.document.parts).toHaveLength(1_000);
    expect(distinctMeshes(parsed.document)).toHaveLength(1);
    // A thousand placements of a four-triangle solid, in a few tens of
    // kilobytes. This is the property OBJ cannot have.
    expect(written.bytes.byteLength).toBeLessThan(64 * 1024);
  });
});

describe('MF-W05/MF-W06/MF-W13: transforms', () => {
  it('MF-W05: writes a translation as a placement, not as moved coordinates', async () => {
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, transform: translation(40, 5, -2) }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect([...(parsed.document.parts[0]?.transform ?? [])]).toEqual([...translation(40, 5, -2)]);
    // NOTHING WAS BAKED. The coordinates are the document's own.
    expect([...(parsed.document.parts[0]?.mesh.positions ?? [])]).toEqual([...TRIANGLE.positions]);
    expect(written.metadata.observations).toContain(ExportObservation.TransformsPreserved);
    expect(written.metadata.observations).not.toContain(ExportObservation.TransformsBaked);
  });

  it('MF-W06: preserves a rotation and scale value for value', async () => {
    const transform: PartTransform = [0, 2, 0, -2, 0, 0, 0, 0, 2, 1.5, -0.25, 3];
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, transform }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect([...(parsed.document.parts[0]?.transform ?? [])]).toEqual([...transform]);
  });

  it('MF-W13: round-trips a deterministic Float64 transform corpus exactly', async () => {
    /*
     * TRANSFORMS ARE FLOAT64 AND STAY FLOAT64. Narrowing them to Float32 on the
     * way through text would add an error the source never had — a placement
     * read from a file as `0.1` would come back as something else — so they are
     * written with the shortest exactly-reparsable decimal form rather than the
     * nine digits a Float32 coordinate needs.
     */
    const values = float64Corpus(100_008);

    /*
     * THE WHOLE CORPUS GOES THROUGH THE CONTRACT ITSELF. A hundred thousand
     * values is more than twenty-four times the document's part ceiling, so it
     * cannot all travel as placements — and the property under test is a
     * property of the serialisation, not of the document layer.
     */
    let contractMismatches = 0;
    for (const value of values) {
      if (!Object.is(Number(writeFloat64Text(value)), value)) contractMismatches += 1;
    }
    expect(contractMismatches, 'every Float64 must survive its decimal form').toBe(0);

    // AND THROUGH THE REAL PIPELINE, as far as a document can carry: 4,000
    // placements is 48,000 of those values written into XML, compressed, read
    // back by the production reader and compared.
    const parts: PartInput[] = [];
    for (let at = 0; at + 12 <= 4_000 * 12; at += 12) {
      parts.push({
        mesh: TRIANGLE,
        transform: [...values.slice(at, at + 12)] as unknown as PartTransform,
      });
    }
    expect(parts.length).toBe(4_000);

    const snapshot = exportSnapshotOf(documentOf(parts, LengthUnit.Millimeter), 'doc-1', 1);
    const written = await write3mfDocument(snapshot, testWriteContextWithDeflate());
    const parsed = await read3mf(written.bytes, testExportReadContext());

    /*
     * A PLACEMENT THAT MIRRORS THE PART DOES NOT COME BACK AS ITSELF (Stage C03-D2), and the difference is the point: a 3MF build item
     * whose transform has a negative determinant is a defect to a 3MF consumer, so the part is written as its mesh mirrored in x with
     * the placement's FIRST basis row negated (a zero stays +0). Every other value, and every placement that does not mirror, returns
     * bit for bit. The corpus is random, so about half of its placements mirror: both halves of this are exercised thousands of times.
     */
    let mismatches = 0;
    let mirroredPlacements = 0;
    for (const [index, part] of parts.entries()) {
      const actual = parsed.document.parts[index]?.transform ?? [];
      const source = part.transform ?? [];
      const mirrored = placementLinearDeterminant(source) < 0;
      if (mirrored) mirroredPlacements += 1;
      for (let at = 0; at < 12; at += 1) {
        const value = source[at] ?? Number.NaN;
        const wanted = mirrored && at < 3 ? (value === 0 ? 0 : -value) : value;
        if (!Object.is(actual[at], wanted)) mismatches += 1;
      }
    }
    expect(mirroredPlacements, 'the corpus must exercise the mirrored half').toBeGreaterThan(100);
    expect(mismatches, 'every Float64 transform value must return exactly').toBe(0);
  });
});

describe('MF-W08/MF-W09/MF-W10: names, materials and hostile strings', () => {
  it('MF-W08: preserves part names, including on parts that share a mesh', async () => {
    const shared = tetrahedron();
    const written = await export3mf(
      documentOf(
        [
          { mesh: shared, name: 'Left bracket' },
          { mesh: shared, transform: translation(40), name: 'Right bracket' },
        ],
        LengthUnit.Millimeter,
      ),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    /*
     * THE NAMES DIFFER AND THE SOURCE MESH IS SHARED. 3MF carries a name on the
     * `<object>`, so keeping both names costs the sharing — and that is the
     * right trade: a name the user gave is information, and the duplicated
     * geometry is recorded as an observation rather than passed off as free.
     */
    expect(parsed.document.parts.map((part) => part.name)).toEqual([
      'Left bracket',
      'Right bracket',
    ]);
    // Two objects, because the names differ — see the split test above. The
    // NAMES are what this case is about, and they survived intact.
    expect(distinctMeshes(parsed.document)).toHaveLength(2);
  });

  it('keeps sharing when the parts that share a mesh agree about its name', async () => {
    const shared = tetrahedron();
    const written = await export3mf(
      documentOf(
        [
          { mesh: shared, name: 'Bracket' },
          { mesh: shared, transform: translation(40), name: 'Bracket' },
        ],
        LengthUnit.Millimeter,
      ),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());

    expect(parsed.document.parts.map((part) => part.name)).toEqual(['Bracket', 'Bracket']);
    expect(distinctMeshes(parsed.document)).toHaveLength(1);
    expect(written.metadata.observations).toContain(ExportObservation.SharingPreserved);
  });

  /*
   * MF-W09 ASSERTED THE OPPOSITE UNTIL THE PROPERTY-REFERENCE FIX, and the
   * change is a correction rather than a relaxation.
   *
   * It used to require that a material reference round-tripped. It did — through
   * an `object@pid` pointing at a property-group resource this writer never
   * emits. Our reader accepted the dangling reference, so the round trip
   * "passed" on a file no conforming consumer would accept. 3MF core defines
   * `object@pid` as an `ST_ResourceID` naming a resource that must exist.
   *
   * The contract is now: geometry, placement and name are written; the opaque
   * material reference is DROPPED and reported. See PR01–PR03 below.
   */
  it('MF-W09: drops a material reference rather than writing a dangling pid', async () => {
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, materialRef: 'mat-7' }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const inspected = await inspect3mf(written.bytes);

    expect(parsed.document.parts[0]?.materialRef).toBeUndefined();
    expect(inspected.modelXml).not.toContain('pid=');
    expect(inspected.problems).toEqual([]);
    expect(written.metadata.observations).toContain(ExportObservation.MaterialReferencesOmitted);
    expect(written.metadata.observations).not.toContain(
      ExportObservation.MaterialReferencesPreserved,
    );
  });

  it.each([
    ['angle brackets', '<script>alert(1)</script>'],
    ['an ampersand', 'Bolt & Nut'],
    ['a double quote', 'say "hello"'],
    ['a single quote', "it's mine"],
    ['a traversal path', '../../etc/passwd'],
    ['a backslash path', '..\\..\\windows\\system32'],
    ['a URL', 'https://evil.test/steal?x=1'],
    ['unicode', 'Brücke — 部品 🧩'],
    ['an entity that is not one', '&notanentity;'],
  ])('MF-W10: writes %s as data and reads it back unchanged', async (_label, name) => {
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, name, materialRef: name }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const inspected = await inspect3mf(written.bytes);

    // WELL FORMED, ESCAPED, AND NOT A PATH. The oracle checks the XML itself.
    expect(inspected.problems).toEqual([]);
    expect(inspected.entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
    ]);
    expect(parsed.document.parts[0]?.name).toBe(name);
    /*
     * THE MATERIAL REFERENCE IS NOT WRITTEN AT ALL, so a hostile one cannot
     * reach the file in any form. The NAME is what this case is really about —
     * it IS written, and has to survive escaping intact.
     */
    expect(parsed.document.parts[0]?.materialRef).toBeUndefined();
    expect(inspected.modelXml).not.toContain('pid=');
  });

  it('drops control characters rather than writing XML that is not well formed', async () => {
    // XML 1.0 cannot represent most control characters at all, not even as a
    // numeric reference — so a writer that "escaped" them would produce a file
    // our own reader would refuse.
    const withBackspace = `a${String.fromCharCode(8)}bc`;
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, name: withBackspace }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(parsed.document.parts[0]?.name).toBe('abc');
    expect((await inspect3mf(written.bytes)).problems).toEqual([]);
  });
});

describe('MF-W11/MF-W12: numeric fidelity', () => {
  it('MF-W11: preserves negative-zero coordinates', async () => {
    const negativeZero = mesh([-0, 0, 0, 1, -0, 0, 0, 1, -0], [0, 1, 2]);
    const written = await export3mf(documentOf([{ mesh: negativeZero }], LengthUnit.Millimeter));
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const positions = parsed.document.parts[0]?.mesh.positions ?? new Float32Array(0);

    expect(Object.is(positions[0], -0)).toBe(true);
    expect(Object.is(positions[4], -0)).toBe(true);
    expect(Object.is(positions[8], -0)).toBe(true);
  });

  it('preserves a negative-zero transform value', async () => {
    const transform: PartTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1, -0, 0, 0];
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, transform }], LengthUnit.Millimeter),
    );
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(Object.is(parsed.document.parts[0]?.transform[9], -0)).toBe(true);
  });

  it('MF-W12: round-trips a deterministic Float32 corpus bit-exactly', async () => {
    const values = float32Corpus(60_000);
    const positions = createPositionArray(values.length * 3);
    const indices = createIndexArray(values.length * 3);
    for (const [at, value] of values.entries()) {
      positions[at * 3] = value;
      positions[at * 3 + 1] = value;
      positions[at * 3 + 2] = value;
      indices[at * 3] = at;
      indices[at * 3 + 1] = at;
      indices[at * 3 + 2] = at;
    }

    const snapshot = exportSnapshotOf(
      documentOf(
        [{ mesh: { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } } }],
        LengthUnit.Millimeter,
      ),
      'doc-1',
      1,
    );
    const written = await write3mfDocument(snapshot, testWriteContextWithDeflate());
    const parsed = await read3mf(written.bytes, testExportReadContext());
    const back = parsed.document.parts[0]?.mesh.positions ?? new Float32Array(0);

    let mismatches = 0;
    for (const [at, value] of values.entries()) {
      if (!Object.is(back[at * 3], value)) mismatches += 1;
    }
    expect(mismatches, 'every Float32 must return bit-identical').toBe(0);
  });
});

describe('MF-W14: the unit requirement', () => {
  it('BLOCKS an export when the document states no unit', async () => {
    await expectRefusal(
      async () => export3mf(documentOf([{ mesh: TRIANGLE }])),
      AppErrorCode.InvalidState,
      ExportRefusal.UnitRequired,
    );
  });

  it('does not silently write millimetres', async () => {
    /*
     * THE DISTINCTION THIS PINS. Importing a 3MF with no `unit` attribute
     * correctly yields millimetres, because the specification defines what an
     * absent attribute MEANS. A document derived from an STL or an OBJ has no
     * such assertion behind it — nothing anywhere said millimetres — so writing
     * one would be CAD Fixer inventing a physical fact about the user's model.
     */
    let caught: unknown;
    try {
      await export3mf(documentOf([{ mesh: TRIANGLE }]));
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught)).toBe(true);
    if (isAppError(caught)) {
      expect(caught.message).toMatch(/will not choose a unit/i);
      expect(caught.message).not.toMatch(/millimet/i);
    }
  });

  it('exports the same document once a unit is known', async () => {
    const written = await export3mf(documentOf([{ mesh: TRIANGLE }], LengthUnit.Inch));
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(parsed.document.unit).toBe(LengthUnit.Inch);
  });
});

describe('MF-W15/MF-W16: size', () => {
  it('MF-W15: exports a large single-part document', async () => {
    const written = await export3mf(documentOf([{ mesh: grid(120) }], LengthUnit.Millimeter));
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(triangleCount(parsed.document.parts[0]?.mesh as never)).toBe(120 * 120 * 2);
    expect((await inspect3mf(written.bytes)).problems).toEqual([]);
  });

  it('MF-W16: refuses when the model XML would exceed the serialised ceiling', async () => {
    await expectRefusal(
      async () =>
        export3mf(documentOf([{ mesh: grid(80) }], LengthUnit.Millimeter), {
          maxOutputBytes: DEFAULT_EXPORT_LIMITS.maxOutputBytes,
          maxSerialisedBytes: 256 * 1024,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ExportRefusal.SerialisedTooLarge,
    );
  });

  it('refuses when the compressed archive would exceed the output ceiling', async () => {
    await expectRefusal(
      async () =>
        export3mf(documentOf([{ mesh: grid(120) }], LengthUnit.Millimeter), {
          maxOutputBytes: 8 * 1024,
          maxSerialisedBytes: DEFAULT_EXPORT_LIMITS.maxSerialisedBytes,
        }),
      AppErrorCode.ResourceLimitExceeded,
      ExportRefusal.OutputTooLarge,
    );
  });
});

describe('MF-W17/MF-W19: cancellation and failure', () => {
  it('MF-W17: abandons a large export when the token is cancelled', async () => {
    const source = new CancellationSource();
    let yields = 0;

    await expect(
      write3mfDocument(
        exportSnapshotOf(documentOf([{ mesh: grid(200) }], LengthUnit.Millimeter), 'doc-1', 1),
        testWriteContextWithDeflate({
          cancellation: source.token,
          yieldToEventLoop: async () => {
            yields += 1;
            if (yields === 2) source.cancel();
            await Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow();
    expect(yields).toBeGreaterThan(1);
  });

  it('MF-W19: reports a missing compressor as OUR fault, not the model’s', async () => {
    /*
     * A DISPATCH MISTAKE IS NOT A BAD DOCUMENT. Telling a user their model is
     * at fault because CAD Fixer forgot to supply a compressor would send them
     * looking for a problem that is not there.
     */
    await expectRefusal(
      async () =>
        write3mfDocument(
          exportSnapshotOf(documentOf([{ mesh: TRIANGLE }], LengthUnit.Millimeter), 'doc-1', 1),
          testWriteContextWithDeflate({ withDeflater: false }),
        ),
      AppErrorCode.Internal,
      ExportRefusal.MalformedSnapshot,
    );
  });

  it('leaves the source document untouched after a cancellation', async () => {
    const document = documentOf([{ mesh: grid(100) }], LengthUnit.Millimeter);
    const before = [...(document.parts[0]?.mesh.positions ?? [])];
    const source = new CancellationSource();
    source.cancel();

    await expect(
      write3mfDocument(
        exportSnapshotOf(document, 'doc-1', 1),
        testWriteContextWithDeflate({ cancellation: source.token }),
      ),
    ).rejects.toThrow();
    expect([...(document.parts[0]?.mesh.positions ?? [])]).toEqual(before);
  });
});

describe('MF-W20: the independent archive and XML oracle', () => {
  it('verifies CRCs, sizes, directory offsets and required entries', async () => {
    const written = await export3mf(
      documentOf(
        [
          { mesh: tetrahedron(), name: 'A', materialRef: 'm1' },
          { mesh: tetrahedron(6), transform: translation(30), name: 'B' },
        ],
        LengthUnit.Centimeter,
      ),
    );
    const inspected = await inspect3mf(written.bytes);

    expect(inspected.problems).toEqual([]);
    for (const entry of inspected.entries) {
      expect(entry.actualCrc).toBe(entry.declaredCrc);
      expect(entry.actualUncompressed).toBe(entry.declaredUncompressed);
      // Deflate only, never stored, never encrypted, no data descriptor.
      expect(entry.method).toBe(8);
      expect(entry.flags).toBe(0);
    }
  });

  it('emits no DOCTYPE, entity, external identifier or remote reference', async () => {
    const written = await export3mf(
      documentOf([{ mesh: TRIANGLE, name: 'SYSTEM "x"' }], LengthUnit.Meter),
    );
    const inspected = await inspect3mf(written.bytes);
    expect(checkModelXml(inspected.modelXml ?? '')).toEqual([]);

    // AND OUR OWN READER ACCEPTS IT, under the same security rules an imported
    // file faces. A writer whose output the reader refuses has written a file
    // the user cannot open.
    const parsed = await read3mf(written.bytes, testExportReadContext());
    expect(parsed.document.parts[0]?.name).toBe('SYSTEM "x"');
  });

  it('notices a corrupted CRC, so the oracle is not vacuous', async () => {
    const written = await export3mf(documentOf([{ mesh: TRIANGLE }], LengthUnit.Millimeter));
    const damaged = new Uint8Array(written.bytes);
    // Flip a byte inside the first local header's CRC field.
    damaged[14] = (damaged[14] ?? 0) ^ 0xff;

    const inspected = await inspect3mf(damaged);
    expect(inspected.problems.length).toBeGreaterThan(0);
  });
});

describe('malformed export requests', () => {
  it('refuses a snapshot whose part names geometry that is not present', async () => {
    const snapshot = exportSnapshotOf(
      documentOf([{ mesh: TRIANGLE }], LengthUnit.Millimeter),
      'doc-1',
      1,
    );
    const first = snapshot.parts[0];
    if (first === undefined) throw new Error('missing part');
    const broken: ExportDocumentSnapshot = {
      ...snapshot,
      parts: [{ ...first, meshResourceIndex: 9 }],
    };

    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: broken,
          target: MeshFormatId.ThreeMf,
          write: testWriteContextWithDeflate(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.MissingMeshResource,
    );
  });

  it('refuses a snapshot whose triangle names a vertex that does not exist', async () => {
    const snapshot = exportSnapshotOf(
      documentOf([{ mesh: TRIANGLE }], LengthUnit.Millimeter),
      'doc-1',
      1,
    );
    const meshResource = snapshot.meshes[0];
    if (meshResource === undefined) throw new Error('missing mesh');
    const broken: ExportDocumentSnapshot = {
      ...snapshot,
      meshes: [{ ...meshResource, indices: new Uint32Array([0, 1, 99]) }],
    };

    await expectRefusal(
      async () =>
        exportDocument({
          snapshot: broken,
          target: MeshFormatId.ThreeMf,
          write: testWriteContextWithDeflate(),
          read: testExportReadContext(),
        }),
      AppErrorCode.InvalidState,
      ExportRefusal.MalformedSnapshot,
    );
  });
});

/* ------------------------------------------------------------- helpers -- */

function grid(side: number): CanonicalMesh {
  const positions = createPositionArray((side + 1) * (side + 1) * 3);
  let at = 0;
  for (let row = 0; row <= side; row += 1) {
    for (let column = 0; column <= side; column += 1) {
      positions[at] = column;
      positions[at + 1] = row;
      positions[at + 2] = ((column * 7 + row * 13) % 17) * 0.01;
      at += 3;
    }
  }

  const indices = createIndexArray(side * side * 6);
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
  return { positions, indices, metadata: { sourceFormat: MeshFormatId.ThreeMf } };
}

/** Deterministic finite Float64 values from the transform domain. */
function float64Corpus(count: number): Float64Array {
  const named = [
    0,
    -0,
    1,
    -1,
    0.1,
    -0.1,
    1 / 3,
    Math.PI,
    Math.E,
    1e-300,
    1e300,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    -Number.MAX_SAFE_INTEGER,
    5e-324,
    1.7976931348623157e308,
  ];
  const out = new Float64Array(count);
  const view = new Float64Array(1);
  const bits = new Uint32Array(view.buffer);

  for (const [at, value] of named.entries()) {
    if (at < count) out[at] = value;
  }

  let seed = 0x51ee;
  const next = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };

  for (let at = named.length; at < count;) {
    bits[0] = next();
    bits[1] = next();
    if (!Number.isFinite(view[0])) continue;
    out[at] = view[0] ?? 0;
    at += 1;
  }
  return out;
}
