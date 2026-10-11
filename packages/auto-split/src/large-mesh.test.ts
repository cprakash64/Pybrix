import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { CancellationSource } from '@cadfixer/shared';
import { validateHuman } from '@cadfixer/auto-split-contract';
import {
  validateVehicle,
  VIEW_NAMES,
  type Box4,
  type VehicleAnswer,
  type ViewBox,
} from '@cadfixer/auto-split-contract';
import { evaluateCabBedPlane, proposeCabBedPlane } from './cab-bed';
import { CHECKPOINT_MASK, CHECKPOINT_STRIDE } from './checkpoint';
import { componentPieces, extractFaces } from './extract';
import {
  carMultipart,
  denseTruck,
  humanFigure,
  manyShellTruck,
  referenceComponentPieces,
  referenceEvaluateCabBedPlane,
  referenceExtractFaces,
  referenceLabelComponents,
  referenceProposeCabBedPlane,
  scenarioAnswer,
  truckFused,
  voxelUnion,
} from './fixtures';
import { faceFacts, normalizeGeometry } from './geometry';
import { labelComponents } from './components';
import { suggestFor } from './suggest';
import { rasteriseView } from './raster';

/**
 * AUTO-SPLIT-LARGE-MESH-02: the three changes made to the engine for the 2,000,000-triangle ceiling
 * — compact region lists in the cab/bed scorer, typed-array component extraction and labelling, and
 * safe boundaries inside the long passes — change NO RESULT. Each is held to a frozen copy of what it
 * replaced (`fixtures/reference-*.ts`) on the same inputs, bit for bit.
 */

const bytesOf = (a: ArrayBufferView): Uint8Array =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const left = bytesOf(a);
  const right = bytesOf(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function sameMesh(a: CanonicalMesh, b: CanonicalMesh): void {
  expect(a.positions.length).toBe(b.positions.length);
  expect(a.indices.length).toBe(b.indices.length);
  expect(sameBytes(a.positions, b.positions)).toBe(true);
  expect(sameBytes(a.indices, b.indices)).toBe(true);
}

/** mulberry32: a tiny seeded generator so every "random" case is the same case on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed, INDEXED UV sphere: shared corners, unlike every STL-style fixture. */
function indexedSphere(rings: number): CanonicalMesh {
  const segments = rings * 2;
  const vertexTotal = 2 + (rings - 1) * segments;
  const positions = createPositionArray(vertexTotal * 3);
  const indices: number[] = [];
  positions.set([0, 0, 5], 0);
  let p = 3;
  for (let ring = 1; ring < rings; ring += 1) {
    const phi = (ring / rings) * Math.PI;
    for (let seg = 0; seg < segments; seg += 1) {
      const theta = (seg / segments) * Math.PI * 2;
      positions.set(
        [
          Math.cos(theta) * Math.sin(phi) * 5,
          Math.sin(theta) * Math.sin(phi) * 5,
          Math.cos(phi) * 5,
        ],
        p,
      );
      p += 3;
    }
  }
  positions.set([0, 0, -5], (vertexTotal - 1) * 3);
  for (let seg = 0; seg < segments; seg += 1) indices.push(0, 1 + seg, 1 + ((seg + 1) % segments));
  for (let ring = 0; ring < rings - 2; ring += 1)
    for (let seg = 0; seg < segments; seg += 1) {
      const a = 1 + ring * segments + seg;
      const b = 1 + ring * segments + ((seg + 1) % segments);
      indices.push(a, a + segments, b, b, a + segments, b + segments);
    }
  const last = vertexTotal - 1;
  const base = 1 + (rings - 2) * segments;
  for (let seg = 0; seg < segments; seg += 1)
    indices.push(last, base + ((seg + 1) % segments), base + seg);
  const out = createIndexArray(indices.length);
  out.set(indices);
  return { positions, indices: out, metadata: {} };
}

/** The mesh with a rotation about Z then X applied in double precision and rounded to Float32 once. */
function rotated(mesh: CanonicalMesh, zDegrees: number, xDegrees: number): CanonicalMesh {
  const [cz, sz] = [Math.cos((zDegrees * Math.PI) / 180), Math.sin((zDegrees * Math.PI) / 180)];
  const [cx, sx] = [Math.cos((xDegrees * Math.PI) / 180), Math.sin((xDegrees * Math.PI) / 180)];
  const positions = createPositionArray(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i] ?? 0;
    const y = mesh.positions[i + 1] ?? 0;
    const z = mesh.positions[i + 2] ?? 0;
    const x1 = x * cz - y * sz;
    const y1 = x * sz + y * cz;
    positions[i] = x1;
    positions[i + 1] = y1 * cx - z * sx;
    positions[i + 2] = y1 * sx + z * cx;
  }
  return { positions, indices: mesh.indices, metadata: {} };
}

/** An asymmetric vehicle: the cab is shifted to one side and the bed is lower on the other. */
function asymmetricTruck(): CanonicalMesh {
  return voxelUnion([
    { lo: [-30, -8, 4], hi: [30, 8, 12] },
    { lo: [-30, 0, 12], hi: [0, 8, 16] },
    { lo: [8, -8, 12], hi: [30, 2, 26] },
  ]);
}

const FIXTURES: readonly { readonly name: string; readonly mesh: CanonicalMesh }[] = [
  { name: 'truck', mesh: truckFused().mesh },
  { name: 'car (five shells)', mesh: carMultipart().mesh },
  { name: 'figure (one shell)', mesh: humanFigure().mesh },
  { name: 'asymmetric truck', mesh: asymmetricTruck() },
  { name: 'rotated truck', mesh: rotated(truckFused().mesh, 31, 12) },
  { name: 'indexed sphere', mesh: indexedSphere(24) },
  { name: 'dense truck (12k)', mesh: denseTruck(12_000).mesh },
  { name: 'many-shell truck (100 shells)', mesh: manyShellTruck(12_000, 100).mesh },
];

describe('the dense fixtures reach the counts they claim', () => {
  it('lands on an even count exactly and the mesh is a closed solid', () => {
    const { mesh } = denseTruck(50_000);
    expect(mesh.indices.length / 3).toBe(50_000);
    const { report } = analyseTopology(mesh, {
      documentId: 'dense',
      documentRevision: 0,
      partId: 'p',
      sampleLimit: 0,
      componentSummaryLimit: 8,
      cancellation: new CancellationSource().token,
    });
    expect(report.boundaryEdgeCount).toBe(0);
    expect(report.nonManifoldEdgeCount).toBe(0);
    expect(report.windingConflictEdgeCount).toBe(0);
    expect(report.zeroAreaFaceCount).toBe(0);
  });

  it('lands on an odd count exactly, by one detached triangle', () => {
    expect(denseTruck(50_001).mesh.indices.length / 3).toBe(50_001);
  });

  it('is deterministic: the same target is the same bytes', () => {
    const a = denseTruck(30_000).mesh;
    const b = denseTruck(30_000).mesh;
    expect(sameBytes(a.positions, b.positions)).toBe(true);
  });

  it('adds exactly the requested number of shells', () => {
    const { mesh } = manyShellTruck(12_000, 100);
    const labelling = labelComponents(
      mesh,
      faceFacts(normalizeGeometry(mesh.positions, mesh.indices)),
    );
    expect(labelling.count).toBe(5 + 100);
  });
});

describe('component labelling: typed ranking equals the boxed one', () => {
  for (const { name, mesh } of FIXTURES)
    it(`ranks ${name} identically`, () => {
      const facts = faceFacts(normalizeGeometry(mesh.positions, mesh.indices));
      const live = labelComponents(mesh, facts);
      const old = referenceLabelComponents(mesh, facts);
      expect(live.count).toBe(old.count);
      expect(sameBytes(live.faceRank, old.faceRank)).toBe(true);
    });

  it('breaks an exact tie in area by the lower first face, as before', () => {
    // Forty identical boxes: every component has the same area, so only the tie-break orders them.
    const boxes = Array.from({ length: 40 }, (_, i) => ({
      lo: [i * 3, 0, 0] as const,
      hi: [i * 3 + 2, 2, 2] as const,
    }));
    const mesh = voxelUnion(boxes);
    const facts = faceFacts(normalizeGeometry(mesh.positions, mesh.indices));
    const live = labelComponents(mesh, facts);
    expect(live.count).toBe(40);
    expect(sameBytes(live.faceRank, referenceLabelComponents(mesh, facts).faceRank)).toBe(true);
  });
});

describe('component extraction: typed renumbering equals the Map', () => {
  /** Every selection shape: one rank, a subset, all but one, repeats, and ranks that are not ranks. */
  function selections(count: number): readonly (readonly number[])[] {
    const out: number[][] = [[0], [count - 1]];
    if (count > 2)
      out.push(
        [0, 1],
        [1, count - 1],
        Array.from({ length: count - 1 }, (_, i) => i),
      );
    out.push([0, 0, 0], [0, -1, 99, 1.5, Number.NaN]);
    return out;
  }

  for (const { name, mesh } of FIXTURES)
    it(`extracts ${name} byte for byte`, () => {
      const facts = faceFacts(normalizeGeometry(mesh.positions, mesh.indices));
      const labelling = labelComponents(mesh, facts);
      if (labelling.count < 2) return;
      for (const ranks of selections(labelling.count)) {
        let live: ReturnType<typeof componentPieces> | undefined;
        let old: ReturnType<typeof referenceComponentPieces> | undefined;
        let liveError: unknown;
        let oldError: unknown;
        try {
          live = componentPieces(mesh, labelling, ranks);
        } catch (error: unknown) {
          liveError = error;
        }
        try {
          old = referenceComponentPieces(mesh, labelling, ranks);
        } catch (error: unknown) {
          oldError = error;
        }
        // A refused selection is refused with the same sentence; an accepted one is the same bytes.
        expect(liveError === undefined).toBe(oldError === undefined);
        if (liveError instanceof Error && oldError instanceof Error)
          expect(liveError.message).toBe(oldError.message);
        if (live !== undefined && old !== undefined) {
          sameMesh(live.selected, old.selected);
          sameMesh(live.rest, old.rest);
          expect(live.selectedFaces).toBe(old.selectedFaces);
          expect(live.restFaces).toBe(old.restFaces);
        }
      }
    });

  it('keeps every coordinate exactly, including negative zero, and numbers by first use', () => {
    const mesh = voxelUnion([
      { lo: [0, 0, 0], hi: [2, 2, 2] },
      { lo: [5, 0, 0], hi: [7, 2, 2] },
    ]);
    // A -0 must survive the copy, not be normalised to +0.
    mesh.positions[0] = -0;
    const faces = mesh.indices.length / 3;
    const keep = (f: number): boolean => f % 3 !== 1 && f < faces;
    const live = extractFaces(mesh, keep);
    const old = referenceExtractFaces(mesh, keep);
    sameMesh(live, old);
    expect(Object.is(live.positions[0], -0)).toBe(true);
    // First use: the first kept face's first corner is vertex 0.
    expect(live.indices[0]).toBe(0);
  });

  it('extracts an indexed mesh over its own shared vertices, never expanding them', () => {
    const mesh = indexedSphere(12);
    const keep = (f: number): boolean => f % 2 === 0;
    const live = extractFaces(mesh, keep);
    sameMesh(live, referenceExtractFaces(mesh, keep));
    // The kept faces share corners: far fewer vertices than three per face.
    expect(live.positions.length / 3).toBeLessThan(live.indices.length);
  });

  it('keeps nothing and keeps everything', () => {
    const mesh = truckFused().mesh;
    sameMesh(
      extractFaces(mesh, () => false),
      referenceExtractFaces(mesh, () => false),
    );
    sameMesh(
      extractFaces(mesh, () => true),
      referenceExtractFaces(mesh, () => true),
    );
  });
});

/** Boxes and a plane the way a provider might say them, perturbed deterministically from a valid answer. */
function perturbed(base: VehicleAnswer, rng: () => number, scale: number): VehicleAnswer {
  const jitter = (box: Box4): Box4 => {
    const j = (v: number): number => Math.min(1, Math.max(0, v + (rng() - 0.5) * scale));
    const [a, b, c, d] = [j(box[0]), j(box[1]), j(box[2]), j(box[3])];
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c) + 1e-3, Math.max(b, d) + 1e-3];
  };
  const views = (list: readonly ViewBox[]): readonly ViewBox[] =>
    list.map((v) => (v.box === null ? v : { ...v, box: jitter(v.box) }));
  const normal = base.boundary.planeNormal ?? [-1, 0, 0];
  return {
    ...base,
    parts: {
      ...base.parts,
      cab: { ...base.parts.cab, views: views(base.parts.cab.views) },
      cargo_or_bed: { ...base.parts.cargo_or_bed, views: views(base.parts.cargo_or_bed.views) },
    },
    boundary: {
      ...base.boundary,
      planeNormal: [
        normal[0] + (rng() - 0.5) * scale * 2,
        normal[1] + (rng() - 0.5) * scale * 2,
        normal[2] + (rng() - 0.5) * scale * 2,
      ],
      planeOffset: (base.boundary.planeOffset ?? 0) + (rng() - 0.5) * scale * 0.3,
    },
  };
}

function truckAnswer(): VehicleAnswer {
  const checked = validateVehicle(scenarioAnswer('vehicle-truck-plane'));
  if (!checked.ok) throw new Error(`scenario answer invalid: ${checked.errors.join('; ')}`);
  return checked.value;
}

describe('the cab/bed scorer: compact region lists equal the full scans', () => {
  const base = truckAnswer();

  /** Planes AND scores bit-identical: not "close", the same numbers. */
  function expectSame(
    geometry: ReturnType<typeof normalizeGeometry>,
    facts: ReturnType<typeof faceFacts>,
    answer: VehicleAnswer,
  ): 'both-null' | 'compared' {
    const live = evaluateCabBedPlane(geometry, facts, answer);
    const old = referenceEvaluateCabBedPlane(geometry, facts, answer);
    expect(live === null).toBe(old === null);
    if (live === null || old === null) return 'both-null';
    expect(live).toStrictEqual(old);
    // And the decision built on them is the same decision.
    expect(proposeCabBedPlane(geometry, facts, answer)).toStrictEqual(
      referenceProposeCabBedPlane(geometry, facts, answer),
    );
    return 'compared';
  }

  const counts = new Map<string, number>();
  for (const { name, mesh } of FIXTURES) {
    it(`selects the same plane with the same score on ${name}`, () => {
      const geometry = normalizeGeometry(mesh.positions, mesh.indices);
      const facts = faceFacts(geometry);
      const rng = prng(0x5eed + name.length);
      let compared = 0;
      if (expectSame(geometry, facts, base) === 'compared') compared += 1;
      for (let i = 0; i < 40; i += 1) {
        const answer = perturbed(base, rng, [0.02, 0.05, 0.1, 0.25][i % 4] ?? 0.1);
        if (expectSame(geometry, facts, answer) === 'compared') compared += 1;
      }
      counts.set(name, compared);
    }, 120_000);
  }

  it('actually compared scores on the truck-shaped models, not "both null" throughout', () => {
    for (const name of ['truck', 'dense truck (12k)', 'rotated truck', 'asymmetric truck'])
      expect(counts.get(name) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('agrees at the boundaries: absent slots, no boundary plane, identical regions, no seed pair', () => {
    const mesh = truckFused().mesh;
    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const facts = faceFacts(geometry);
    const cases: VehicleAnswer[] = [
      { ...base, parts: { ...base.parts, cab: { ...base.parts.cab, status: 'ABSENT' } } },
      {
        ...base,
        parts: { ...base.parts, cargo_or_bed: { ...base.parts.cargo_or_bed, status: 'ABSENT' } },
      },
      { ...base, boundary: { ...base.boundary, status: 'ABSENT' } },
      { ...base, boundary: { ...base.boundary, planeNormal: null, planeOffset: null } },
      { ...base, boundary: { ...base.boundary, planeNormal: [0, 0, 0], planeOffset: 0 } },
      // Cab and bed are the same boxes: every face is in both regions.
      { ...base, parts: { ...base.parts, cargo_or_bed: base.parts.cab } },
      // No visible views for the bed at all: an empty region.
      {
        ...base,
        parts: {
          ...base.parts,
          cargo_or_bed: {
            ...base.parts.cargo_or_bed,
            views: VIEW_NAMES.map((view) => ({
              view,
              visibility: 'not_visible' as const,
              box: null,
            })),
          },
        },
      },
      // The seed plane points the wrong way and must be flipped.
      { ...base, boundary: { ...base.boundary, planeNormal: [1, 0, 0], planeOffset: 0.2 } },
    ];
    for (const answer of cases) expectSame(geometry, facts, answer);
  });
});

/** A box a provider might draw: random, wide, and wholly inside the image. */
function randomBox(rng: () => number): Box4 {
  const x0 = rng() * 0.5;
  const y0 = rng() * 0.5;
  return [x0, y0, x0 + 0.2 + rng() * (0.95 - x0 - 0.2), y0 + 0.2 + rng() * (0.95 - y0 - 0.2)];
}

/** A vehicle answer with random cab and bed boxes in every view and a random seed plane. */
function randomAnswer(base: VehicleAnswer, rng: () => number): VehicleAnswer {
  const views = (): readonly ViewBox[] =>
    VIEW_NAMES.map((view) => ({ view, visibility: 'visible' as const, box: randomBox(rng) }));
  return {
    ...base,
    parts: {
      ...base.parts,
      cab: { ...base.parts.cab, status: 'PRESENT', views: views() },
      cargo_or_bed: { ...base.parts.cargo_or_bed, status: 'PRESENT', views: views() },
    },
    boundary: {
      ...base.boundary,
      status: 'PRESENT',
      planeNormal: [rng() - 0.5, rng() - 0.5, rng() - 0.5],
      planeOffset: (rng() - 0.5) * 0.4,
    },
  };
}

describe('the screened search selects what the full search selects, on arbitrary input', () => {
  /** Random triangle soup with random areas: scores spread over the whole range, with near-ties. */
  function randomSoup(rng: () => number, triangles: number): CanonicalMesh {
    const positions = createPositionArray(triangles * 9);
    const indices = createIndexArray(triangles * 3);
    for (let t = 0; t < triangles; t += 1) {
      const cx = (rng() - 0.5) * 2;
      const cy = (rng() - 0.5) * 2;
      const cz = (rng() - 0.5) * 2;
      const size = 0.002 + rng() * rng() * 0.08;
      for (let k = 0; k < 3; k += 1) {
        positions[t * 9 + k * 3] = cx + (rng() - 0.5) * size;
        positions[t * 9 + k * 3 + 1] = cy + (rng() - 0.5) * size;
        positions[t * 9 + k * 3 + 2] = cz + (rng() - 0.5) * size;
        indices[t * 3 + k] = t * 3 + k;
      }
    }
    return { positions, indices, metadata: {} };
  }

  it('returns the same planes and the same bits on random meshes and random answers', () => {
    const base = truckAnswer();
    const rng = prng(0xc0ffee);
    let compared = 0;
    for (let c = 0; c < 40; c += 1) {
      const mesh = randomSoup(rng, 2_500);
      const geometry = normalizeGeometry(mesh.positions, mesh.indices);
      const facts = faceFacts(geometry);
      // Wide random boxes so both regions are populated and the two seeds compete.
      const answer = randomAnswer(base, rng);
      const live = evaluateCabBedPlane(geometry, facts, answer);
      const old = referenceEvaluateCabBedPlane(geometry, facts, answer);
      expect(live === null).toBe(old === null);
      if (live === null || old === null) continue;
      compared += 1;
      expect(live).toStrictEqual(old);
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('returns the same plane on a plateau: every slide in a gap scores exactly 1', () => {
    // Two boxes with a wide gap between them: perfectly separable, so many candidates tie at 1.
    const mesh = voxelUnion([
      { lo: [0, 0, 0], hi: [10, 6, 6] },
      { lo: [20, 0, 0], hi: [30, 6, 6] },
      { lo: [10, 2, 2], hi: [20, 4, 4] },
    ]);
    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const facts = faceFacts(geometry);
    const live = evaluateCabBedPlane(geometry, facts, truckAnswer());
    const old = referenceEvaluateCabBedPlane(geometry, facts, truckAnswer());
    expect(live === null).toBe(old === null);
    if (live !== null && old !== null) expect(live).toStrictEqual(old);
  });

  it('abandons a hopeless seed, and only a hopeless one', () => {
    const base = truckAnswer();
    const rng = prng(7);
    for (let c = 0; c < 20; c += 1) {
      const mesh = randomSoup(rng, 1_500);
      const geometry = normalizeGeometry(mesh.positions, mesh.indices);
      const facts = faceFacts(geometry);
      const answer = randomAnswer(base, rng);
      // The decision is the same decision the full search would have reached.
      const decided = proposeCabBedPlane(geometry, facts, answer);
      const old = referenceProposeCabBedPlane(geometry, facts, answer);
      expect(decided).toStrictEqual(old);
    }
  }, 120_000);
});

describe('safe boundaries change no result and can stop every long pass', () => {
  it('uses a power-of-two stride, so every loop tests a mask and not a division', () => {
    expect(CHECKPOINT_STRIDE & (CHECKPOINT_STRIDE - 1)).toBe(0);
    expect(CHECKPOINT_MASK).toBe(CHECKPOINT_STRIDE - 1);
  });

  it('suggestFor returns the same suggestions with a counting checkpoint as without', () => {
    const mesh = denseTruck(20_000).mesh;
    const answer = { mode: 'vehicle' as const, vehicle: truckAnswer() };
    let calls = 0;
    const counted = suggestFor(mesh, answer, {
      checkpoint: () => {
        calls += 1;
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(counted).toStrictEqual(suggestFor(mesh, answer));
  });

  it('the human path is the same too', () => {
    const mesh = humanFigure().mesh;
    const checked = validateHuman(scenarioAnswer('human-ok'));
    if (!checked.ok) throw new Error('scenario answer invalid');
    const human = { mode: 'human' as const, human: checked.value };
    expect(suggestFor(mesh, human, { checkpoint: () => undefined })).toStrictEqual(
      suggestFor(mesh, human),
    );
  });

  it('a checkpoint that throws stops each long pass within one stride of its start', () => {
    const mesh = denseTruck(2 * CHECKPOINT_STRIDE + 40_000).mesh;
    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const facts = faceFacts(geometry);
    const stop = (): never => {
      throw new Error('stop');
    };
    const afterOne = (): (() => void) => {
      let n = 0;
      return () => {
        n += 1;
        if (n > 1) stop();
      };
    };
    expect(() => normalizeGeometry(mesh.positions, mesh.indices, afterOne())).toThrow('stop');
    expect(() => faceFacts(geometry, afterOne())).toThrow('stop');
    expect(() => rasteriseView(geometry, VIEW_NAMES[0], afterOne())).toThrow('stop');
    expect(() => labelComponents(mesh, facts, afterOne())).toThrow('stop');
    const answer = { mode: 'vehicle' as const, vehicle: truckAnswer() };
    expect(() => suggestFor(mesh, answer, { checkpoint: afterOne() })).toThrow('stop');
  });
});
