import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyPartTransform,
  classifyPlacement,
  composePartTransforms,
  createIndexArray,
  createPositionArray,
  IDENTITY_PLACEMENT,
  partId,
  PlacementRefusal,
  singlePartDocument,
  type CanonicalMesh,
  type PartTransform,
  type PlacementClass,
} from '@cadfixer/mesh-core';
import { CancellationSource, isAppError, uncancellable } from '@cadfixer/shared';
import {
  GeometryEditStore,
  RepairHistoryStore,
  ResidentDocumentStore,
  SplitCandidateStore,
  splitWithConnectors,
  type SplitPlane,
  type SplitRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { describeTransformRefusal } from '../../../../../packages/geometry-runtime/src/connector-transform-refusal';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Release 2, Stage C03-B — WHY A PLACEMENT CANNOT CARRY A CONNECTOR, AND WHAT A PLACEMENT THAT CAN LOOKS LIKE.
 *
 * Every test here drives the REAL engine on the REAL Manifold backend. A refusal is held to the facts that matter to a caller: the
 * single typed code, the classifier's own reason beside it, the one sentence a person is shown, and that nothing was built, mutated
 * or published. The reflection tests are the proof the reflection policy in `placement.ts` cites.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
const Z: SplitPlane = { origin: [0, 0, 0], normal: [0, 0, 1] };

function boxAt(sx: number, sy: number, sz: number): CanonicalMesh {
  const h = [sx / 2, sy / 2, sz / 2],
    corners: number[] = [];
  for (let i = 0; i < 8; i++)
    for (let k = 0; k < 3; k++) corners.push((i & (1 << k) ? 1 : -1) * (h[k] ?? 0));
  const faces = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(corners.length),
    indices = createIndexArray(faces.length);
  positions.set(corners);
  indices.set(faces);
  return { positions, indices, metadata: {} };
}
const cube = (size: number): CanonicalMesh => boxAt(size, size, size);

type Pin = Extract<SplitRequest['connector'], { kind: 'pin' }>;
const PIN: Pin = { kind: 'pin', count: 1, diameter: 4, depth: 6, clearance: 0.2, maleSide: 'A' };
const PHYSICAL_PIN: SplitRequest['connector'] = {
  kind: 'physical-pin',
  count: 1,
  diameterMm: 4,
  depthMm: 6,
  clearanceMm: 0.2,
  maleSide: 'A',
  unit: 'millimeter',
};
const AUTO: SplitRequest['connector'] = { kind: 'automatic', unit: 'millimeter' };

interface Observed {
  readonly result?: SplitResult;
  readonly error?: unknown;
  readonly stages: string[];
  readonly booleans: string[];
}
async function observe(
  mesh: CanonicalMesh,
  connector: SplitRequest['connector'],
  placement: PlacementClass = IDENTITY_PLACEMENT,
  plane: SplitPlane = Z,
): Promise<Observed> {
  const base = await createManifoldBooleanBackend(binary),
    stages: string[] = [],
    booleans: string[] = [];
  try {
    const result = await splitWithConnectors(
      {
        operate: (kind, a, b, token) => {
          booleans.push(kind);
          return base.operate(kind, a, b, token);
        },
      },
      mesh,
      { plane, connector },
      new CancellationSource().token,
      (stage) => stages.push(stage),
      placement,
    );
    return { result, stages, booleans };
  } catch (error) {
    return { error, stages, booleans };
  }
}
/** The result of an observation that must have succeeded. */
function resultOf(observed: Observed): SplitResult {
  if (observed.result === undefined) throw new Error('the split was refused');
  return observed.result;
}
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
const messageOf = (error: unknown): string => (isAppError(error) ? error.message : '');
const sha = (mesh: CanonicalMesh): string =>
  createHash('sha256')
    .update(
      Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    )
    .update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))
    .digest('hex');
const digest = (result: SplitResult): string =>
  JSON.stringify({
    a: sha(result.pieceA),
    b: sha(result.pieceB),
    connector: result.connector,
    placements: result.placements,
    plan: result.connectorPlan,
  });

const linear = (...v: number[]): number[] => [...v, 0, 0, 0];
/** One transform per way a placement can be unusable, each with the reason the classifier must give. */
const UNSUPPORTED: readonly (readonly [string, readonly number[], PlacementRefusal])[] = [
  ['non-uniform scale', linear(2, 0, 0, 0, 1, 0, 0, 0, 1), PlacementRefusal.NonUniformScale],
  ['shear', linear(1, 0, 0, 0.5, Math.sqrt(3) / 2, 0, 0, 0, 1), PlacementRefusal.Shear],
  ['zero scale', linear(0, 0, 0, 0, 0, 0, 0, 0, 0), PlacementRefusal.Degenerate],
  ['collapsed axis', linear(1, 0, 0, 0, 0, 0, 0, 0, 1), PlacementRefusal.Degenerate],
  ['non-finite entry', linear(Number.NaN, 0, 0, 0, 1, 0, 0, 0, 1), PlacementRefusal.NonFinite],
  ['overflowing scale', linear(1.7e308, 1.7e308, 0, 0, 1, 0, 0, 0, 1), PlacementRefusal.NonFinite],
  ['malformed (nine numbers)', [1, 0, 0, 0, 1, 0, 0, 0, 1], PlacementRefusal.Malformed],
];

describe('the one mapping from a placement refusal to the sentence a person is shown', () => {
  it('has a sentence for every reason, and the four classes of cause say different things', () => {
    const sentences = Object.values(PlacementRefusal).map((reason) =>
      describeTransformRefusal(reason),
    );
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(10);
    expect(describeTransformRefusal(PlacementRefusal.NonUniformScale)).toBe(
      'Connectors require uniform model scale.',
    );
    expect(describeTransformRefusal(PlacementRefusal.Shear)).toBe(
      "Connectors aren't supported on sheared model placements.",
    );
    expect(describeTransformRefusal(PlacementRefusal.Degenerate)).toBe(
      'This model placement has an invalid scale.',
    );
    // a malformed placement and a non-finite one send a person to the same place: one sentence
    expect(describeTransformRefusal(PlacementRefusal.Malformed)).toBe(
      describeTransformRefusal(PlacementRefusal.NonFinite),
    );
    expect(describeTransformRefusal(PlacementRefusal.Malformed)).toBe(
      'This model placement is invalid.',
    );
    expect(new Set(sentences).size).toBe(4);
  });
  it('shows no internal vocabulary: no determinant, residual, tolerance, matrix, classifier or product claim', () => {
    for (const reason of Object.values(PlacementRefusal))
      expect(describeTransformRefusal(reason)).not.toMatch(
        /determinant|residual|epsilon|tolerance|matrix|classif|1e-|printable|watertight|hole/i,
      );
  });
});

describe('a refused placement reaches the caller with its reason (manual, physical, automatic)', () => {
  for (const [name, transform, reason] of UNSUPPORTED) {
    const placement = classifyPlacement(transform);
    it(`${name}: classifier says ${reason}`, () => {
      expect(placement).toEqual({ kind: 'UNSUPPORTED', reason });
    });
    for (const [label, connector] of [
      ['manual pin', PIN],
      ['physical pin', PHYSICAL_PIN],
    ] as const)
      it(`${name}, ${label}: one code, the reason beside it, its own sentence, and nothing built`, async () => {
        const mesh = cube(40),
          before = sha(mesh),
          observed = await observe(mesh, connector, placement);
        expect(observed.result).toBeUndefined();
        expect(details(observed.error)).toEqual({
          code: 'CONNECTOR_UNSUPPORTED_TRANSFORM',
          refusal: 'UNSUPPORTED_TRANSFORM',
          transformReason: reason,
        });
        expect(messageOf(observed.error)).toBe(describeTransformRefusal(reason));
        // refused before any work: not even the cut was started, and no Boolean ran
        expect(observed.stages).toEqual(['preparing-cut']);
        expect(observed.booleans).toEqual([]);
        expect(sha(mesh)).toBe(before);
      });
    it(`${name}, automatic: an unavailable connector whose diagnostics carry ${reason}, and the plain split is intact`, async () => {
      const observed = await observe(cube(30), AUTO, placement);
      expect(observed.result?.automaticConnector).toBe('unavailable');
      expect(observed.result?.automaticConnectorDiagnostics?.reason).toBe('UNSUPPORTED_TRANSFORM');
      expect(observed.result?.automaticConnectorDiagnostics?.transformReason).toBe(reason);
      expect(observed.result?.connector).toEqual({ kind: 'none' });
      expect(observed.result?.placements).toEqual([]);
      expect(observed.result?.connectorPlan).toBeUndefined();
      expect(observed.booleans).toEqual([]);
    });
  }
  it('an automatic refusal for any OTHER reason carries no transform reason', async () => {
    const thin = await observe(cube(4), AUTO);
    expect(thin.result?.automaticConnectorDiagnostics?.reason).toBe('INSUFFICIENT_CLEARANCE');
    expect(thin.result?.automaticConnectorDiagnostics).not.toHaveProperty('transformReason');
    const applied = await observe(cube(30), AUTO);
    expect(applied.result?.automaticConnector).toBe('applied');
    expect(applied.result?.automaticConnectorDiagnostics).not.toHaveProperty('transformReason');
  });
  it('a plain cut is not refused for its placement: only a connector depends on it', async () => {
    for (const [, transform] of UNSUPPORTED) {
      const observed = await observe(cube(30), { kind: 'none' }, classifyPlacement(transform));
      expect(observed.result?.connector.kind).toBe('none');
    }
  });
});

describe('refusal precedence is the order the engine has always had (pinned, not changed)', () => {
  const NON_UNIFORM = classifyPlacement(linear(2, 0, 0, 0, 1, 0, 0, 0, 1));
  it('an open surface refuses a manual connector as OPEN_SPLIT_CONNECTOR_UNSUPPORTED before the placement is judged', async () => {
    const open = boxAt(20, 20, 20);
    // drop the two top faces: an open surface
    const kept = Array.from(open.indices).slice(0, 24);
    const mesh: CanonicalMesh = {
      positions: open.positions,
      indices: createIndexArray(kept.length),
      metadata: {},
    };
    mesh.indices.set(kept);
    const observed = await observe(mesh, PIN, NON_UNIFORM);
    expect(details(observed.error).code).toBe('OPEN_SPLIT_CONNECTOR_UNSUPPORTED');
  });
  it('an unknown unit is refused before the placement is judged: UNKNOWN_UNITS for automatic and for a physical pin', async () => {
    const auto = await observe(cube(30), { kind: 'automatic', unit: 'furlong' }, NON_UNIFORM);
    expect(details(auto.error).code).toBe('UNKNOWN_UNITS');
    const physical = await observe(
      cube(40),
      { ...(PHYSICAL_PIN as object), unit: 'furlong' } as SplitRequest['connector'],
      NON_UNIFORM,
    );
    expect(details(physical.error).code).toBe('UNKNOWN_UNITS');
  });
  it('the placement is judged before the cut and before the pin size: an unusable placement wins over a plane that misses the part and over an invalid diameter', async () => {
    const misses = await observe(cube(20), PIN, NON_UNIFORM, {
      origin: [0, 0, 30],
      normal: [0, 0, 1],
    });
    expect(details(misses.error).code).toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
    const badDiameter = await observe(cube(40), { ...PIN, diameter: 0.001 }, NON_UNIFORM);
    expect(details(badDiameter.error).code).toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
    // and with a usable placement the same requests keep their own refusals
    const plain = await observe(cube(20), PIN, IDENTITY_PLACEMENT, {
      origin: [0, 0, 30],
      normal: [0, 0, 1],
    });
    expect(details(plain.error).code).toBe('CUT_NOT_SAFE');
    const bad = await observe(cube(40), { ...PIN, diameter: 0.001 }, IDENTITY_PLACEMENT);
    expect(isAppError(bad.error)).toBe(true);
    expect(details(bad.error).code).not.toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
  });
});

describe('every placement that was valid before is still valid and builds the same connector', () => {
  const VALID: readonly (readonly [string, readonly number[]])[] = [
    ['identity', [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],
    ['translation', [1, 0, 0, 0, 1, 0, 0, 0, 1, 40, -20, 5]],
    ['rotation about X', [1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0]],
    ['oblique rotation', [0.8, 0, -0.6, 0, 1, 0, 0.6, 0, 0.8, 7, 8, 9]],
    ['reflection', [-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]],
    ['point inversion', [-1, 0, 0, 0, -1, 0, 0, 0, -1, 0, 0, 0]],
  ];
  it('a manual pin is byte-identical across every rigid or mirrored placement (the engine works in the part’s own coordinates)', async () => {
    const reference = await observe(cube(40), PIN, IDENTITY_PLACEMENT);
    if (reference.result === undefined) throw new Error('reference refused');
    const expected = digest(reference.result);
    for (const [name, transform] of VALID) {
      const placement = classifyPlacement(transform);
      expect(placement.kind, name).toBe('SIMILARITY');
      const observed = await observe(cube(40), PIN, placement);
      expect(observed.result, name).toBeDefined();
      expect(digest(resultOf(observed)), name).toBe(expected);
      expect(observed.booleans, name).toEqual(reference.booleans);
    }
  });
  it('an automatic connector is byte-identical across every rigid or mirrored placement', async () => {
    const reference = await observe(cube(30), AUTO, IDENTITY_PLACEMENT);
    if (reference.result === undefined) throw new Error('reference refused');
    expect(reference.result.automaticConnector).toBe('applied');
    for (const [name, transform] of VALID) {
      const observed = await observe(cube(30), AUTO, classifyPlacement(transform));
      expect(observed.result?.automaticConnector, name).toBe('applied');
      expect(digest(resultOf(observed)), name).toBe(digest(reference.result));
    }
  });
  it('uniform scale reaches only the automatic path, as it did before (the manual size is still the legacy one)', async () => {
    const scaled = classifyPlacement([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]);
    const manualAtOne = await observe(cube(40), PIN, IDENTITY_PLACEMENT);
    const manualAtTwo = await observe(cube(40), PIN, scaled);
    expect(digest(resultOf(manualAtTwo))).toBe(digest(resultOf(manualAtOne)));
    const autoAtOne = await observe(cube(30), AUTO, IDENTITY_PLACEMENT);
    const autoAtTwo = await observe(cube(30), AUTO, scaled);
    expect(digest(resultOf(autoAtTwo))).not.toBe(digest(resultOf(autoAtOne)));
  });
});

describe('REFLECTION: a mirrored part carries a connector, and the pieces stay one world-space pair', () => {
  const part = partId('part-1');
  /** A mirrored, scaled, rotated and translated placement: the hardest valid one. */
  const MIRRORED: PartTransform = [-0.8, 0, 0.6, 0, 1, 0, 0.6, 0, 0.8, 10, 20, 30];
  it('is reported as mirrored, with the scale of its unmirrored twin', () => {
    const mirrored = classifyPlacement(MIRRORED);
    const twin = classifyPlacement([0.8, 0, 0.6, 0, 1, 0, -0.6, 0, 0.8, 10, 20, 30]);
    expect(mirrored).toEqual({ kind: 'SIMILARITY', scale: 1, mirrored: true });
    expect(twin).toEqual({ kind: 'SIMILARITY', scale: 1, mirrored: false });
  });
  it('both pieces carry the SAME placement, so a pin and its socket map to the same world point whatever the handedness', async () => {
    const mesh = cube(40);
    const base = singlePartDocument(mesh);
    const resident = new ResidentDocumentStore(),
      history = new RepairHistoryStore();
    const store = new SplitCandidateStore(
      resident,
      history,
      new GeometryEditStore(resident, history),
    );
    const document = { ...base, parts: base.parts.map((p) => ({ ...p, transform: MIRRORED })) };
    const source = resident.commit(document);
    const ticket = store.begin(source, part);
    const prepared = store.preparePlaneSource(ticket, Z, uncancellable);
    const placement = classifyPlacement(MIRRORED);
    expect(placement.kind === 'SIMILARITY' && placement.mirrored).toBe(true);
    const backend = await createManifoldBooleanBackend(binary);
    const result = await splitWithConnectors(
      backend,
      mesh,
      { plane: Z, connector: PIN },
      uncancellable,
      undefined,
      placement,
      prepared,
    );
    expect(result.connector.kind).toBe('pin');
    const clip = result.closedPlaneClip;
    if (clip === undefined) throw new Error('no closed plane clip');
    const summary = store.resolve(ticket, result, uncancellable);
    const preview = store.preview(summary.candidate, (value) => value);
    const expectedPlacement = composePartTransforms(MIRRORED, [
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      ...clip.outputAnchor,
    ]);
    const [a, b] = preview.parts;
    expect(a?.transform).toEqual(expectedPlacement);
    expect(b?.transform).toEqual(expectedPlacement);
    // the pin's centre, in the source's own frame, and in each piece's frame: one world point for the original and for both pieces
    const site = result.placements[0];
    if (site === undefined || a === undefined || b === undefined) throw new Error('no pair');
    const world = applyPartTransform(MIRRORED, ...site);
    const local: [number, number, number] = [
      site[0] - clip.outputAnchor[0],
      site[1] - clip.outputAnchor[1],
      site[2] - clip.outputAnchor[2],
    ];
    for (const piece of [a, b]) {
      const mapped = applyPartTransform(piece.transform, ...local);
      for (let axis = 0; axis < 3; axis++) expect(mapped[axis]).toBeCloseTo(world[axis] ?? 0, 9);
    }
    // the placement is a reflection: it reverses orientation, and that is the same for both pieces
    const det = (t: PartTransform): number =>
      t[0] * (t[4] * t[8] - t[5] * t[7]) -
      t[1] * (t[3] * t[8] - t[5] * t[6]) +
      t[2] * (t[3] * t[7] - t[4] * t[6]);
    expect(det(a.transform)).toBeLessThan(0);
    expect(det(b.transform)).toBeLessThan(0);
  });
});

describe('a refused placement leaves the workspace exactly as it was (no mutation, no transaction, no history)', () => {
  it('publishes no candidate, no transaction and no history entry, and the resident part is the same object at the same revision', async () => {
    const part = partId('part-1');
    const mesh = cube(40);
    const transform: PartTransform = [2, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5];
    const base = singlePartDocument(mesh);
    const resident = new ResidentDocumentStore(),
      history = new RepairHistoryStore(),
      store = new SplitCandidateStore(resident, history, new GeometryEditStore(resident, history));
    const source = resident.commit({
      ...base,
      parts: base.parts.map((p) => ({ ...p, transform })),
    });
    const ticket = store.begin(source, part);
    let error: unknown;
    try {
      await splitWithConnectors(
        await createManifoldBooleanBackend(binary),
        mesh,
        { plane: Z, connector: PIN },
        new CancellationSource().token,
        undefined,
        classifyPlacement(transform),
      );
    } catch (caught) {
      error = caught;
      store.fail(ticket);
    }
    expect(details(error).transformReason).toBe(PlacementRefusal.NonUniformScale);
    expect(resident.revisionOf(source.documentId)).toBe(source.revision);
    const resolved = resident.resolvePart(source, part);
    expect(isAppError(resolved)).toBe(false);
    if (!isAppError(resolved)) {
      expect(resolved.mesh).toBe(mesh);
      expect(resolved.transform).toBe(transform);
    }
    expect(store.stats().candidateCount).toBe(0);
    expect(store.commitTransactionStats()).toMatchObject({ pending: 0, receipts: 0 });
    expect(history.undoableFor(source.documentId)).toBeUndefined();
  });
});
