import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyPlacement,
  createIndexArray,
  createPositionArray,
  IDENTITY_PART_TRANSFORM,
  IDENTITY_PLACEMENT,
  jointId,
  jointRetainedBytes,
  liveJoints,
  meshByteLength,
  partId,
  retiredJoints,
  validateGeometryDocument,
  withPartMesh,
  type GeometryDocument,
  type CanonicalMesh,
  type ConnectorJoint,
  type JointConnectorSpec,
  type JointPin,
  type PartTransform,
  type PlacementClass,
} from '@cadfixer/mesh-core';
import { jointedDocument } from '@cadfixer/mesh-core/fixtures';
import { AppErrorCode, CancellationSource, isAppError, type LengthUnit } from '@cadfixer/shared';
import {
  jointAuthorityOf,
  pinCutOf,
  pinCutRetainedBytes,
  ResidentDocumentStore,
  pinCutOfJoint,
  rebuildJointConnectors,
  siteOnInterface,
  splitWithConnectors,
  type BooleanBackend,
  type PhysicalPinRequest,
  type SplitResult,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

/*
 * Stage EC-2 — editing a connector is a REBUILD from the pieces the cut left before any connector, through the pin stage a first split
 * uses. Everything here runs on the real kernel, and the claim is the strong one: a joint rebuilt from its own retained cut is
 * byte-identical to the split that made it, so there is no second construction path to disagree with the first.
 */
const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size: number): CanonicalMesh {
  const h = size / 2,
    p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h],
    i = [
      0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1,
      3, 7, 1, 7, 5,
    ],
    positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
const X_PLANE = { origin: [0, 0, 0], normal: [1, 0, 0] } as const;

interface Counting {
  readonly backend: BooleanBackend;
  readonly calls: () => number;
}
async function counting(): Promise<Counting> {
  const real = await createManifoldBooleanBackend(binary);
  let n = 0;
  const operate: BooleanBackend['operate'] = (kind, a, b, cancellation) => {
    n += 1;
    return real.operate(kind, a, b, cancellation);
  };
  return { backend: { operate }, calls: () => n };
}

const pin = (
  count: 1 | 2 | 3 | 4,
  options: Partial<PhysicalPinRequest> = {},
  unit: LengthUnit = 'millimeter',
): PhysicalPinRequest => ({
  kind: 'physical-pin',
  unit,
  count,
  diameterMm: 3,
  depthMm: 4,
  clearanceMm: 0.2,
  maleSide: 'A',
  ...options,
});

async function split(
  request: PhysicalPinRequest,
  size = 20,
  placement: PlacementClass = IDENTITY_PLACEMENT,
  backend?: BooleanBackend,
): Promise<SplitResult> {
  return splitWithConnectors(
    backend ?? (await createManifoldBooleanBackend(binary)),
    cube(size),
    { plane: X_PLANE, connector: request },
    new CancellationSource().token,
    undefined,
    placement,
  );
}

/** The joint a split would leave behind, assembled by hand from its result: this stage builds no joint at split commit. */
function jointOf(result: SplitResult, request: PhysicalPinRequest): ConnectorJoint {
  const clip = result.closedPlaneClip;
  const manifest = result.connectorPlan;
  if (clip === undefined || manifest === undefined) throw new Error('expected a connector plan');
  const cut = pinCutOf(clip);
  const context = manifest.unitContext;
  if (context.mmPerUnit === undefined || context.mmPerCoordinate === undefined)
    throw new Error('expected a physical frame');
  const pins: JointPin[] = manifest.pairs.map((pair) => ({
    pinId: pair.pairId,
    site: { u: pair.site.u, v: pair.site.v, local: pair.site.local },
    diameterMm: request.diameterMm,
    depthMm: request.depthMm,
    clearanceMm: request.clearanceMm,
  }));
  return {
    kind: 'joint',
    jointId: jointId('test/joint/1'),
    a: {
      partId: partId('a'),
      baseMesh: cut.pieceA,
      builtMesh: result.pieceA,
      builtTransform: IDENTITY_PART_TRANSFORM,
    },
    b: {
      partId: partId('b'),
      baseMesh: cut.pieceB,
      builtMesh: result.pieceB,
      builtTransform: IDENTITY_PART_TRANSFORM,
    },
    frame: {
      unit: request.unit as LengthUnit,
      mmPerUnit: context.mmPerUnit,
      placementScale: context.partScale,
      mmPerCoordinate: context.mmPerCoordinate,
    },
    authority: jointAuthorityOf(cut),
    connector: { policy: 'units-v2', kind: 'pin', maleSide: request.maleSide, elements: pins },
    nextPinOrdinal: pins.length + 1,
  };
}
const specOf = (joint: ConnectorJoint): JointConnectorSpec => {
  if (joint.connector === undefined) throw new Error('expected a connector');
  return joint.connector;
};
function withPins(joint: ConnectorJoint, change: Partial<JointPin>[]): JointConnectorSpec {
  const spec = specOf(joint);
  return { ...spec, elements: spec.elements.map((p, i) => ({ ...p, ...(change[i] ?? {}) })) };
}

/** The bytes of two pieces, so two builds can be compared to the bit. */
function bytes(a: CanonicalMesh, b: CanonicalMesh): string {
  const hash = createHash('sha256');
  for (const mesh of [a, b]) {
    hash.update(
      Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength),
    );
    hash.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  }
  return hash.digest('hex');
}
const details = (error: unknown): Record<string, unknown> =>
  isAppError(error) ? error.details : {};
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}
const never = new CancellationSource().token;

describe('a joint rebuilt from its retained cut is the split that made it, to the bit', () => {
  const CASES: readonly (readonly [string, PhysicalPinRequest, LengthUnit])[] = [
    ['one pin, male A', pin(1), 'millimeter'],
    ['one pin, male B', pin(1, { maleSide: 'B' }), 'millimeter'],
    ['two pins', pin(2), 'millimeter'],
    ['three pins', pin(3, { diameterMm: 2.5, depthMm: 3 }), 'millimeter'],
    ['coordinates read as inches', pin(1, {}, 'inch'), 'inch'],
    ['coordinates read as centimetres, two pins', pin(2, {}, 'centimeter'), 'centimeter'],
  ];
  for (const [label, request, unit] of CASES)
    it(label, async () => {
      const size = unit === 'inch' ? 2 : unit === 'centimeter' ? 6 : 20;
      const built = await split(request, size);
      const joint = jointOf(built, request);
      const { backend } = await counting();
      const rebuilt = await rebuildJointConnectors(
        backend,
        joint,
        joint.connector,
        IDENTITY_PLACEMENT,
        never,
      );
      expect(bytes(rebuilt.pieceA, rebuilt.pieceB)).toBe(bytes(built.pieceA, built.pieceB));
      expect(rebuilt.connector).toEqual(built.connector);
      expect(rebuilt.manifest).toEqual(built.connectorPlan);
      expect(rebuilt.successor.a.builtMesh).toBe(rebuilt.pieceA);
      expect(unit).toBe(request.unit);
    });

  it('under a uniform placement scale, where a millimetre is a different number of coordinates', async () => {
    const placement = classifyPlacement([
      2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0,
    ] as const satisfies PartTransform);
    const request = pin(2);
    const built = await split(request, 20, placement);
    const joint = jointOf(built, request);
    expect(joint.frame.placementScale).toBe(2);
    const { backend } = await counting();
    const rebuilt = await rebuildJointConnectors(backend, joint, joint.connector, placement, never);
    expect(bytes(rebuilt.pieceA, rebuilt.pieceB)).toBe(bytes(built.pieceA, built.pieceB));
  });

  it('a plain joint is the retained pieces themselves, equal to a split with no connector, and runs no Boolean', async () => {
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const plain = await splitWithConnectors(
      await createManifoldBooleanBackend(binary),
      cube(20),
      { plane: X_PLANE, connector: { kind: 'none' } },
      never,
    );
    const { backend, calls } = await counting();
    const rebuilt = await rebuildJointConnectors(
      backend,
      joint,
      undefined,
      IDENTITY_PLACEMENT,
      never,
    );
    expect(calls()).toBe(0);
    expect(rebuilt.pieceA).toBe(joint.a.baseMesh);
    expect(rebuilt.pieceB).toBe(joint.b.baseMesh);
    expect(bytes(rebuilt.pieceA, rebuilt.pieceB)).toBe(bytes(plain.pieceA, plain.pieceB));
    expect(rebuilt.manifest).toBeUndefined();
    expect(rebuilt.successor.connector).toBeUndefined();
  });
});

describe('every rebuild starts from the same cut, so an edit never builds on an edit', () => {
  it('returns to the same bytes after a detour through other specs, and through its own successor', async () => {
    const request = pin(2);
    const built = await split(request);
    const joint = jointOf(built, request);
    const { backend } = await counting();
    const original = specOf(joint);
    const thinner = withPins(joint, [{ diameterMm: 2 }, { diameterMm: 2 }]);
    const detour = await rebuildJointConnectors(backend, joint, thinner, IDENTITY_PLACEMENT, never);
    expect(bytes(detour.pieceA, detour.pieceB)).not.toBe(bytes(built.pieceA, built.pieceB));
    const plain = await rebuildJointConnectors(
      backend,
      detour.successor,
      undefined,
      IDENTITY_PLACEMENT,
      never,
    );
    const back = await rebuildJointConnectors(
      backend,
      plain.successor,
      original,
      IDENTITY_PLACEMENT,
      never,
    );
    expect(bytes(back.pieceA, back.pieceB)).toBe(bytes(built.pieceA, built.pieceB));
    // the retained cut never moved
    expect(pinCutOfJoint(back.successor)).toBe(pinCutOfJoint(joint));
  });

  it('leaves the retained pieces untouched: an edit mutates nothing it started from', async () => {
    const request = pin(1);
    const built = await split(request);
    const joint = jointOf(built, request);
    const before = bytes(joint.a.baseMesh, joint.b.baseMesh);
    const { backend } = await counting();
    await rebuildJointConnectors(
      backend,
      joint,
      withPins(joint, [{ diameterMm: 4 }]),
      IDENTITY_PLACEMENT,
      never,
    );
    expect(bytes(joint.a.baseMesh, joint.b.baseMesh)).toBe(before);
  });
});

describe('a site is the point it names, and an edit that moves it builds there', () => {
  it('reads back through the one coordinate function', async () => {
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const cut = pinCutOfJoint(joint);
    const site = siteOnInterface(cut, 1.5, -2.25);
    const [first] = specOf(joint).elements;
    if (first === undefined) throw new Error('expected a pin');
    // the plane is x = 0 in a 20-wide cube: the point is on it, and u/v are where the engine reads it
    expect(site.local[0]).toBeCloseTo(0, 9);
    expect(site.u).toBeCloseTo(1.5, 9);
    expect(site.v).toBeCloseTo(-2.25, 9);
    const again = siteOnInterface(cut, site.u, site.v);
    expect(again.u).toBe(site.u);
    expect(again.v).toBe(site.v);
  });

  it('moves a pin: the new pieces differ, the manifest records the new site, and the solid is closed', async () => {
    const request = pin(1);
    const built = await split(request);
    const joint = jointOf(built, request);
    const cut = pinCutOfJoint(joint);
    const [first] = specOf(joint).elements;
    if (first === undefined) throw new Error('expected a pin');
    const moved = siteOnInterface(cut, first.site.u + 3, first.site.v - 2);
    const { backend } = await counting();
    const rebuilt = await rebuildJointConnectors(
      backend,
      joint,
      withPins(joint, [{ site: moved }]),
      IDENTITY_PLACEMENT,
      never,
    );
    expect(bytes(rebuilt.pieceA, rebuilt.pieceB)).not.toBe(bytes(built.pieceA, built.pieceB));
    expect(rebuilt.manifest?.pairs[0]?.site.u).toBe(moved.u);
    expect(rebuilt.manifest?.pairs[0]?.site.local).toBe(moved.local);
    expect(rebuilt.successor.connector?.elements[0]?.site).toBe(moved);
  });
});

describe('an edit is refused for exactly what a first split is refused for', () => {
  it('a socket deeper than the receiving piece: the same code as the split', async () => {
    const deep = pin(1, { depthMm: 15 });
    const expected = details(await refusal(split(deep))).code;
    expect(expected).toBe('CONNECTOR_SOCKET_BREAKTHROUGH');
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const { backend, calls } = await counting();
    const error = await refusal(
      rebuildJointConnectors(
        backend,
        joint,
        withPins(joint, [{ depthMm: 15 }]),
        IDENTITY_PLACEMENT,
        never,
      ),
    );
    expect(details(error).code).toBe(expected);
    expect(calls()).toBe(0);
  });

  it('a diameter outside the physical range: the same code as the split', async () => {
    const tiny = pin(1, { diameterMm: 0.001 });
    const expected = details(await refusal(split(tiny))).code;
    expect(expected).toBe('CONNECTOR_DIMENSION_OUT_OF_POLICY');
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const { backend, calls } = await counting();
    const error = await refusal(
      rebuildJointConnectors(
        backend,
        joint,
        withPins(joint, [{ diameterMm: 0.001 }]),
        IDENTITY_PLACEMENT,
        never,
      ),
    );
    expect(details(error).code).toBe(expected);
    expect(calls()).toBe(0);
  });

  it('a placement that is not a similarity: the same code as the split', async () => {
    const shear = classifyPlacement([
      1, 0, 0, 0.4, 1, 0, 0, 0, 1, 0, 0, 0,
    ] as const satisfies PartTransform);
    const expected = details(await refusal(split(pin(1), 20, shear))).code;
    expect(expected).toBe('CONNECTOR_UNSUPPORTED_TRANSFORM');
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const { backend, calls } = await counting();
    const error = await refusal(
      rebuildJointConnectors(backend, joint, joint.connector, shear, never),
    );
    expect(details(error).code).toBe(expected);
    expect(calls()).toBe(0);
  });

  it('a site outside the cut, and one in the margin the cut requires: refused before any Boolean', async () => {
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const cut = pinCutOfJoint(joint);
    const { backend, calls } = await counting();
    const outside = await refusal(
      rebuildJointConnectors(
        backend,
        joint,
        withPins(joint, [{ site: siteOnInterface(cut, 500, 0) }]),
        IDENTITY_PLACEMENT,
        never,
      ),
    );
    expect(details(outside).code).toBe('CONNECTOR_FOOTPRINT_OUTSIDE_INTERFACE');
    const rim = await refusal(
      rebuildJointConnectors(
        backend,
        joint,
        withPins(joint, [{ site: siteOnInterface(cut, 7.9, 0) }]),
        IDENTITY_PLACEMENT,
        never,
      ),
    );
    // the footprint is contained, and the material around the socket is thinner than the margin a cut face is held to
    expect(details(rim).code).toBe('CONNECTOR_SOCKET_SUPPORT_INSUFFICIENT');
    expect(calls()).toBe(0);
  });

  it('two pins on the same spot, which the resolver would never place: refused before any Boolean', async () => {
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const [first] = specOf(joint).elements;
    if (first === undefined) throw new Error('expected a pin');
    const twin: JointConnectorSpec = {
      ...specOf(joint),
      elements: [first, { ...first, pinId: 'pin-2' }],
    };
    const { backend, calls } = await counting();
    const error = await refusal(
      rebuildJointConnectors(backend, joint, twin, IDENTITY_PLACEMENT, never),
    );
    expect(details(error).code).toBe('CONNECTOR_DOES_NOT_FIT');
    expect(calls()).toBe(0);
  });
});

describe('a plan that contradicts what the joint was built from is refused as INVALID_PLAN', () => {
  async function fixture(): Promise<{
    joint: ConnectorJoint;
    backend: BooleanBackend;
    calls: () => number;
  }> {
    const request = pin(2);
    const joint = jointOf(await split(request), request);
    return { joint, ...(await counting()) };
  }
  const code = (error: unknown): unknown => details(error).code;

  it('pins that do not share one size, a repeated or empty id, no pins, too many pins', async () => {
    const { joint, backend, calls } = await fixture();
    const spec = specOf(joint);
    const [a, b] = spec.elements;
    if (a === undefined || b === undefined) throw new Error('expected two pins');
    for (const elements of [
      [a, { ...b, diameterMm: 4 }],
      [a, { ...b, pinId: a.pinId }],
      [a, { ...b, pinId: '' }],
      [],
      Array.from({ length: 5 }, (_, i) => ({ ...a, pinId: `pin-${String(i)}` })),
    ])
      expect(
        code(
          await refusal(
            rebuildJointConnectors(
              backend,
              joint,
              { ...spec, elements },
              IDENTITY_PLACEMENT,
              never,
            ),
          ),
        ),
      ).toBe('INVALID_PLAN');
    expect(calls()).toBe(0);
  });

  it('a site whose u and v are not where its point is', async () => {
    const { joint, backend, calls } = await fixture();
    const [a] = specOf(joint).elements;
    if (a === undefined) throw new Error('expected a pin');
    const error = await refusal(
      rebuildJointConnectors(
        backend,
        joint,
        withPins(joint, [{ site: { ...a.site, u: a.site.u + 1 } }]),
        IDENTITY_PLACEMENT,
        never,
      ),
    );
    expect(code(error)).toBe('INVALID_PLAN');
    expect(calls()).toBe(0);
  });

  it('a placement or unit that is not the one the joint was built under', async () => {
    const { joint, backend, calls } = await fixture();
    const doubled = classifyPlacement([
      2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0,
    ] as const satisfies PartTransform);
    expect(
      code(await refusal(rebuildJointConnectors(backend, joint, joint.connector, doubled, never))),
    ).toBe('INVALID_PLAN');
    const inches: ConnectorJoint = { ...joint, frame: { ...joint.frame, unit: 'inch' } };
    expect(
      code(
        await refusal(
          rebuildJointConnectors(backend, inches, inches.connector, IDENTITY_PLACEMENT, never),
        ),
      ),
    ).toBe('INVALID_PLAN');
    expect(calls()).toBe(0);
  });

  it("an authority this engine did not make, and one whose pieces are not the joint's bases", async () => {
    const { joint, backend } = await fixture();
    const foreign = jointedDocument().joint;
    expect(
      code(
        await refusal(
          rebuildJointConnectors(backend, foreign, foreign.connector, IDENTITY_PLACEMENT, never),
        ),
      ),
    ).toBe('INVALID_PLAN');
    const swapped: ConnectorJoint = { ...joint, a: { ...joint.a, baseMesh: joint.b.baseMesh } };
    expect(
      code(
        await refusal(
          rebuildJointConnectors(backend, swapped, swapped.connector, IDENTITY_PLACEMENT, never),
        ),
      ),
    ).toBe('INVALID_PLAN');
  });
});

describe('cancellation', () => {
  it('a cancelled rebuild stops before it builds anything', async () => {
    const request = pin(1);
    const joint = jointOf(await split(request), request);
    const { backend, calls } = await counting();
    const source = new CancellationSource();
    source.cancel();
    const error = await refusal(
      rebuildJointConnectors(backend, joint, joint.connector, IDENTITY_PLACEMENT, source.token),
    );
    expect(isAppError(error) && error.code).toBe(AppErrorCode.OperationCancelled);
    expect(calls()).toBe(0);
  });
});

describe('an automatic connector rebuilds to the same bytes too, in every unit', () => {
  /*
   * The automatic planner states its sizes in millimetres and the engine turns them into coordinates, so a rebuild is handed the
   * coordinates read back as millimetres. They resolve to the same coordinates to the bit — that is what this holds — though the
   * millimetre figure read back need not be the round one the planner proposed (4.799999892711639 for 4.8 in metres), which is why the
   * stage that records a joint at split commit should record the planner's own figure for display.
   */
  for (const [unit, size] of [
    ['millimeter', 40],
    ['inch', 2],
    ['centimeter', 4],
    ['meter', 0.04],
  ] as const)
    it(unit, async () => {
      const backend = await createManifoldBooleanBackend(binary);
      const built = await splitWithConnectors(
        backend,
        cube(size),
        { plane: X_PLANE, connector: { kind: 'automatic', unit } },
        never,
      );
      const manifest = built.connectorPlan;
      const clip = built.closedPlaneClip;
      const c = built.connector;
      if (manifest === undefined || clip === undefined || c.kind !== 'pin')
        throw new Error('expected an applied automatic connector');
      const k = manifest.unitContext.mmPerCoordinate;
      const mmPerUnit = manifest.unitContext.mmPerUnit;
      if (k === undefined || mmPerUnit === undefined) throw new Error('expected a physical frame');
      const cut = pinCutOf(clip);
      const joint: ConnectorJoint = {
        kind: 'joint',
        jointId: jointId('test/joint/auto'),
        a: {
          partId: partId('a'),
          baseMesh: cut.pieceA,
          builtMesh: built.pieceA,
          builtTransform: IDENTITY_PART_TRANSFORM,
        },
        b: {
          partId: partId('b'),
          baseMesh: cut.pieceB,
          builtMesh: built.pieceB,
          builtTransform: IDENTITY_PART_TRANSFORM,
        },
        frame: {
          unit,
          mmPerUnit,
          placementScale: manifest.unitContext.partScale,
          mmPerCoordinate: k,
        },
        authority: jointAuthorityOf(cut),
        connector: undefined,
        nextPinOrdinal: 1,
      };
      const spec: JointConnectorSpec = {
        policy: 'units-v2',
        kind: 'pin',
        maleSide: c.maleSide,
        elements: manifest.pairs.map((pair) => ({
          pinId: pair.pairId,
          site: pair.site,
          diameterMm: c.diameter * k,
          depthMm: c.depth * k,
          clearanceMm: c.clearance * k,
        })),
      };
      const rebuilt = await rebuildJointConnectors(backend, joint, spec, IDENTITY_PLACEMENT, never);
      expect(bytes(rebuilt.pieceA, rebuilt.pieceB)).toBe(bytes(built.pieceA, built.pieceB));
    });
});

describe('a real joint satisfies the document model and the resident store', () => {
  async function documentOf(): Promise<{ document: GeometryDocument; joint: ConnectorJoint }> {
    const request = pin(2);
    const joint = jointOf(await split(request), request);
    return {
      joint,
      document: {
        unit: 'millimeter',
        parts: [
          { id: joint.a.partId, mesh: joint.a.builtMesh, transform: IDENTITY_PART_TRANSFORM },
          { id: joint.b.partId, mesh: joint.b.builtMesh, transform: IDENTITY_PART_TRANSFORM },
        ],
        joints: [joint],
      },
    };
  }

  it('passes the document gate, meshes included, and its retained bytes are the bases plus what the engine kept', async () => {
    const { document, joint } = await documentOf();
    expect(validateGeometryDocument(document).issues).toEqual([]);
    expect(joint.authority.retainedBytes).toBe(pinCutOfRetained(joint));
    expect(joint.authority.retainedBytes).toBeGreaterThan(0);
    expect(jointRetainedBytes(document)).toBe(
      meshByteLength(joint.a.baseMesh) +
        meshByteLength(joint.b.baseMesh) +
        joint.authority.retainedBytes,
    );
  });

  it('the provenance identity is a function of the provenance arrays, and of nothing else', async () => {
    const request = pin(1);
    const first = jointOf(await split(request), request);
    const second = jointOf(await split(request), request);
    expect(first.authority.provenanceSHA).toBe(second.authority.provenanceSHA);
    // It names the per-face provenance and not the geometry: a cube of another size has the same one. A cut with one entry changed does not.
    const cut = pinCutOfJoint(first);
    const edited = Int32Array.from(cut.provenanceA);
    edited[0] = (edited[0] ?? 0) + 1;
    expect(jointAuthorityOf({ ...cut, provenanceA: edited }).provenanceSHA).not.toBe(
      first.authority.provenanceSHA,
    );
  });

  it('is installed attached, and a repair-shaped change retires it and releases what it held', async () => {
    const { document, joint } = await documentOf();
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const resolved = store.resolve(first);
    if (isAppError(resolved)) throw resolved;
    expect(liveJoints(resolved)).toEqual([joint]);
    const changed = withPartMesh(resolved, joint.a.partId, cube(20));
    if (changed === undefined) throw new Error('part missing');
    const second = store.replace(first, changed);
    if (isAppError(second)) throw second;
    const installed = store.resolve(second);
    if (isAppError(installed)) throw installed;
    expect(liveJoints(installed)).toEqual([]);
    expect(retiredJoints(installed)[0]?.reason).toBe('GEOMETRY_CHANGED');
    expect(jointRetainedBytes(installed)).toBe(0);
  });

  it('a rebuilt candidate, installed, is attached to the parts that hold its meshes', async () => {
    const { document, joint } = await documentOf();
    const { backend } = await counting();
    const rebuilt = await rebuildJointConnectors(
      backend,
      joint,
      withPins(joint, [{ diameterMm: 2 }, { diameterMm: 2 }]),
      IDENTITY_PLACEMENT,
      never,
    );
    const store = new ResidentDocumentStore();
    const first = store.commit(document);
    const successor: GeometryDocument = {
      ...document,
      parts: [
        { id: joint.a.partId, mesh: rebuilt.pieceA, transform: IDENTITY_PART_TRANSFORM },
        { id: joint.b.partId, mesh: rebuilt.pieceB, transform: IDENTITY_PART_TRANSFORM },
      ],
      joints: [rebuilt.successor],
    };
    expect(validateGeometryDocument(successor).issues).toEqual([]);
    const second = store.replace(first, successor);
    if (isAppError(second)) throw second;
    const installed = store.resolve(second);
    if (isAppError(installed)) throw installed;
    expect(liveJoints(installed)).toEqual([rebuilt.successor]);
  });
});

function pinCutOfRetained(joint: ConnectorJoint): number {
  return pinCutRetainedBytes(pinCutOfJoint(joint));
}
