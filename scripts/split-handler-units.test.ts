import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAppError,
  operationCancelled,
  uncancellable,
  type CancellationToken,
} from '@cadfixer/shared';
import { modelXml, valid3mf } from '@cadfixer/file-formats/threemf-fixtures';
import type {
  DocumentHandle,
  OperationContext,
  ProductConnectorRequest,
  SplitCreateResult,
} from '@cadfixer/geometry-runtime';
import {
  booleanOperations,
  modelImportHandler,
  repairHistory,
  residentDocuments,
  splitCandidates,
} from '../apps/web/src/workers/stl-handlers';
import { splitCreateHandler } from '../apps/web/src/workers/split-handlers';
import { createManifoldBooleanBackend } from '../apps/web/src/workers/manifold-boolean-backend';

/*
 * Release 2, Stage C03-C2 — THE PRODUCTION WORKER PATH, FROM FILE BYTES TO A CONNECTOR OR A REFUSAL.
 *
 * The real import handler reads real STL, OBJ and 3MF bytes into the resident store, and the real `split/create` handler reads the
 * document back — its unit, and the placement the part really has — and builds the split. The ONLY seam is the Boolean pool, which
 * needs browser workers: it is made to delegate to the real Manifold kernel, and it counts the Booleans it was asked for so "no
 * Boolean ran" is something this file measures, not assumes.
 *
 * Sizes are physical millimetres. Each accepted connector is checked with an independent equation (written out here): local length
 * × millimetres per unit × placement scale = the millimetres that were asked for.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const MM_PER_UNIT: Readonly<Record<string, number>> = {
  millimeter: 1,
  meter: 1000,
  micron: 0.001,
  inch: 25.4,
};
const PLANE = { origin: [0, 0, 0], normal: [0, 0, 1] } as const;

function context(cancellation: CancellationToken = uncancellable): OperationContext {
  return {
    cancellation,
    interruptible: true,
    reportProgress: (): void => undefined,
    throwIfCancelled: (): void => {
      if (cancellation.isCancelled) throw operationCancelled();
    },
  };
}
const toBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const CORNERS = (h: number): [number, number, number][] => [
  [-h, -h, -h],
  [h, -h, -h],
  [-h, h, -h],
  [h, h, -h],
  [-h, -h, h],
  [h, -h, h],
  [-h, h, h],
  [h, h, h],
];
const FACES: readonly (readonly [number, number, number])[] = [
  [0, 2, 3],
  [0, 3, 1],
  [4, 5, 7],
  [4, 7, 6],
  [0, 1, 5],
  [0, 5, 4],
  [2, 6, 7],
  [2, 7, 3],
  [0, 4, 6],
  [0, 6, 2],
  [1, 3, 7],
  [1, 7, 5],
];
/** A binary STL: a cube of the given edge, the way a slicer or a CAD export writes one — no unit anywhere in it. */
function binaryStl(edge: number): Uint8Array {
  const corners = CORNERS(edge / 2);
  const bytes = new Uint8Array(84 + FACES.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, FACES.length, true);
  FACES.forEach((face, i) => {
    const base = 84 + i * 50 + 12;
    face.forEach((index, corner) => {
      const point = corners[index] ?? [0, 0, 0];
      point.forEach((value, axis) => {
        view.setFloat32(base + corner * 12 + axis * 4, value, true);
      });
    });
  });
  return bytes;
}
/** An OBJ: the same cube as text. OBJ has no unit either. */
function obj(edge: number): Uint8Array {
  const lines = [
    '# cube',
    ...CORNERS(edge / 2).map(([x, y, z]) => `v ${String(x)} ${String(y)} ${String(z)}`),
    ...FACES.map(([a, b, c]) => `f ${String(a + 1)} ${String(b + 1)} ${String(c + 1)}`),
  ];
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}
async function threeMf(unit: string, edge: number, transform: string): Promise<Uint8Array> {
  const corners = CORNERS(edge / 2);
  const mesh =
    `<mesh><vertices>${corners
      .map(([x, y, z]) => `<vertex x="${String(x)}" y="${String(y)}" z="${String(z)}"/>`)
      .join('')}</vertices>` +
    `<triangles>${FACES.map(
      ([a, b, c]) => `<triangle v1="${String(a)}" v2="${String(b)}" v3="${String(c)}"/>`,
    ).join('')}</triangles></mesh>`;
  return valid3mf(
    modelXml({
      unit,
      resources: `<object id="1" type="model">${mesh}</object>`,
      build: `<item objectid="1" transform="${transform}"/>`,
    }),
  );
}

async function importFile(
  fileName: string,
  bytes: Uint8Array,
): Promise<{ handle: DocumentHandle; partId: string; unit: string | undefined }> {
  const outcome = await modelImportHandler({ bytes: toBuffer(bytes), fileName }, context());
  const result = outcome.value;
  const partId = result.parts[0]?.partId;
  if (partId === undefined) throw new Error('the import made no part');
  return { handle: result.handle, partId, unit: result.unit };
}

/** What the shared worker stores hold, so "nothing was published" is a before/after fact and not an assumption about other tests. */
function workerState(documentId: DocumentHandle['documentId']): {
  readonly candidates: number;
  readonly transactions: ReturnType<typeof splitCandidates.commitTransactionStats>;
  readonly revision: unknown;
  readonly undoable: unknown;
} {
  return {
    candidates: splitCandidates.stats().candidateCount,
    transactions: splitCandidates.commitTransactionStats(),
    revision: residentDocuments.revisionOf(documentId),
    undoable: repairHistory.undoableFor(documentId),
  };
}

/** The real Boolean pool, replaced by the real kernel, counting what it was asked. */
async function countingKernel(): Promise<{ readonly calls: string[] }> {
  const kernel = await createManifoldBooleanBackend(binary);
  const calls: string[] = [];
  vi.spyOn(booleanOperations, 'run').mockImplementation((kind, a, b, cancellation) => {
    calls.push(kind);
    return kernel.operate(kind, a, b, cancellation);
  });
  return { calls };
}
afterEach(() => {
  vi.restoreAllMocks();
});

async function split(
  imported: { handle: DocumentHandle; partId: string },
  connector: ProductConnectorRequest,
): Promise<SplitCreateResult> {
  const outcome = await splitCreateHandler(
    {
      source: imported.handle,
      partId: imported.partId,
      request: { plane: PLANE, connector },
    },
    context(),
  );
  return outcome.value;
}
async function refusal(
  imported: { handle: DocumentHandle; partId: string },
  connector: unknown,
): Promise<{ code: unknown; refusal: unknown; reason: unknown; message: string }> {
  try {
    await split(imported, connector as ProductConnectorRequest);
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      code: error.details.code,
      refusal: error.details.refusal,
      reason: error.details.transformReason,
      message: error.message,
    };
  }
  throw new Error('the split was not refused');
}
const physicalPin = (unit: string | undefined): ProductConnectorRequest => ({
  kind: 'physical-pin',
  unit,
  count: 1,
  diameterMm: 4,
  depthMm: 6,
  clearanceMm: 0.2,
  maleSide: 'A',
});
/** The physical diameter, depth and clearance of the connector the handler returned, from the independent equation. */
function physicalOf(
  result: SplitCreateResult,
  mmPerUnit: number,
  scale: number,
): { diameter: number; depth: number; clearance: number } {
  const c = result.connector;
  if (c.kind !== 'pin') throw new Error('no pin');
  const mm = mmPerUnit * scale;
  return { diameter: c.diameter * mm, depth: c.depth * mm, clearance: c.clearance * mm };
}
const near = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * Math.abs(expected));
};
const UNKNOWN_UNIT_SENTENCE =
  'This model has no physical units. Set the model units before adding a physical connector.';

describe('a model that states a unit: the handler sizes the connector from the document, not from the page', () => {
  it('a 3MF in millimetres, placed at ×2: Ø4 mm is 4 mm on the build plate', async () => {
    const { calls } = await countingKernel();
    const imported = await importFile(
      'cube.3mf',
      await threeMf('millimeter', 15, '2 0 0 0 2 0 0 0 2 0 0 0'),
    );
    expect(imported.unit).toBe('millimeter');
    const result = await split(imported, physicalPin('millimeter'));
    const physical = physicalOf(result, 1, 2);
    near(physical.diameter, 4);
    near(physical.depth, 6);
    near(physical.clearance, 0.2);
    expect(calls.length).toBeGreaterThan(0);
  });
  it('a 3MF in inches, mirrored and scaled: the size is the same 4 mm — a reflection changes no length', async () => {
    await countingKernel();
    const edge = 30 / (25.4 * 2);
    const plain = await split(
      await importFile('a.3mf', await threeMf('inch', edge, '2 0 0 0 2 0 0 0 2 0 0 0')),
      physicalPin('inch'),
    );
    const mirrored = await split(
      await importFile('b.3mf', await threeMf('inch', edge, '-2 0 0 0 2 0 0 0 2 0 0 0')),
      physicalPin('inch'),
    );
    for (const result of [plain, mirrored]) near(physicalOf(result, 25.4, 2).diameter, 4);
    expect(mirrored.connector).toEqual(plain.connector);
  });
  it('the unit the FILE states wins over the one the request names: a stale page cannot size a connector in the wrong unit', async () => {
    await countingKernel();
    const imported = await importFile(
      'cube.3mf',
      await threeMf('millimeter', 30, '1 0 0 0 1 0 0 0 1 0 0 0'),
    );
    // the request says inches; the file says millimetres: 4 mm is 4 local units, not 4 / 25.4
    const result = await split(imported, physicalPin('inch'));
    near(physicalOf(result, 1, 1).diameter, 4);
    expect(result.connector).toMatchObject({ diameter: 4 });
    // and a request that names no unit is sized in the file's
    const named = await split(imported, physicalPin(undefined));
    near(physicalOf(named, 1, 1).diameter, 4);
  });
});

describe('an STL or OBJ states no unit: the unit is the one the user assigned, and without one there is no connector', () => {
  for (const [name, bytes] of [
    ['cube.stl', (e: number): Uint8Array => binaryStl(e)],
    ['cube.obj', (e: number): Uint8Array => obj(e)],
  ] as const) {
    it(`${name}: imported with NO unit — and not given one by the import`, async () => {
      const imported = await importFile(name, bytes(30));
      expect(imported.unit).toBeUndefined();
      // the resident DOCUMENT states none either, so nothing can default it
      const document = residentDocuments.resolve(imported.handle);
      if (isAppError(document)) throw document;
      expect(document.parts.length).toBe(1);
      expect(document.unit).toBeUndefined();
    });
    for (const [label, unit] of [
      ['no unit at all', undefined],
      ['a token that is not a unit', 'furlong'],
      ['an object-table name', 'constructor'],
    ] as const)
      it(`${name}, ${label}: a physical pin is refused with the typed unit refusal, before anything is built`, async () => {
        const { calls } = await countingKernel();
        const imported = await importFile(name, bytes(30));
        const before = workerState(imported.handle.documentId);
        const refused = await refusal(imported, physicalPin(unit));
        expect(refused).toEqual({
          code: 'UNKNOWN_UNITS',
          refusal: 'UNIT_UNKNOWN',
          reason: undefined,
          message: UNKNOWN_UNIT_SENTENCE,
        });
        // no Boolean ran, nothing was published, the document did not move
        expect(calls).toEqual([]);
        expect(workerState(imported.handle.documentId)).toEqual(before);
        expect(before.undoable).toBeUndefined();
      });
    it(`${name}, automatic with no unit: the same refusal — never millimetres, never "no safe site"`, async () => {
      const { calls } = await countingKernel();
      const imported = await importFile(name, bytes(30));
      for (const unit of [undefined, 'furlong']) {
        const refused = await refusal(imported, { kind: 'automatic', unit });
        expect(refused).toMatchObject({
          code: 'UNKNOWN_UNITS',
          refusal: 'UNIT_UNKNOWN',
          message: UNKNOWN_UNIT_SENTENCE,
        });
        expect(refused.code).not.toBe('NO_SAFE_SITE');
      }
      expect(calls).toEqual([]);
    });
    it(`${name}: once the user says how to read it, the same file takes the connector — and the unit is the assignment, not the size of the model`, async () => {
      await countingKernel();
      for (const [unit, edge] of [
        ['inch', 30 / 25.4],
        ['meter', 0.03],
        ['micron', 30000],
      ] as const) {
        const imported = await importFile(name, bytes(edge));
        const result = await split(imported, physicalPin(unit));
        near(physicalOf(result, MM_PER_UNIT[unit] ?? Number.NaN, 1).diameter, 4);
        near(physicalOf(result, MM_PER_UNIT[unit] ?? Number.NaN, 1).depth, 6);
      }
    });
  }
});

describe('the other refusals of the unit and placement policy are unchanged, and are reached through the same handler', () => {
  it('a pin in raw coordinates is not a request the worker accepts: it would route around the unit policy', async () => {
    const { calls } = await countingKernel();
    const imported = await importFile('cube.stl', binaryStl(30));
    const before = workerState(imported.handle.documentId);
    const refused = await refusal(imported, {
      kind: 'pin',
      count: 1,
      diameter: 4,
      depth: 6,
      clearance: 0.2,
      maleSide: 'A',
    });
    expect(refused).toMatchObject({
      code: 'CONNECTOR_REQUEST_NOT_PHYSICAL',
      refusal: 'REQUEST_NOT_PHYSICAL',
      message: 'Connector sizes must be requested in millimetres.',
    });
    expect(calls).toEqual([]);
    expect(workerState(imported.handle.documentId)).toEqual(before);
  });
  it('a non-uniform placement is refused with its reason, no Boolean, nothing published (Stage C03-B, through the handler)', async () => {
    const { calls } = await countingKernel();
    const imported = await importFile(
      'skewed.3mf',
      await threeMf('millimeter', 30, '2 0 0 0 1 0 0 0 1 0 0 0'),
    );
    const before = workerState(imported.handle.documentId);
    const refused = await refusal(imported, physicalPin('millimeter'));
    expect(refused).toEqual({
      code: 'CONNECTOR_UNSUPPORTED_TRANSFORM',
      refusal: 'UNSUPPORTED_TRANSFORM',
      reason: 'NON_UNIFORM_SCALE',
      message: 'Connectors require uniform model scale.',
    });
    expect(calls).toEqual([]);
    expect(workerState(imported.handle.documentId)).toEqual(before);
  });
  it('a size outside the physical range is refused in millimetres, whatever the unit, before any Boolean', async () => {
    const { calls } = await countingKernel();
    const imported = await importFile('cube.stl', binaryStl(0.03));
    const refused = await refusal(imported, {
      ...(physicalPin('meter') as object),
      diameterMm: 0.001,
    });
    expect(refused).toMatchObject({
      code: 'CONNECTOR_DIMENSION_OUT_OF_POLICY',
      refusal: 'DIMENSION_OUT_OF_POLICY',
      message: 'Pin diameter of 0.001 mm is outside the range Pybrix can place (0.01–1000 mm).',
    });
    expect(calls).toEqual([]);
  });
});
