import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createIndexArray, createPositionArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { CancellationSource } from '@cadfixer/shared';
import {
  buildSurfaceTextureLayout,
  buildSurfaceTextureOperand,
  describeTextureLayout,
  MAX_TEXTURE_ELEMENTS,
  meshSurfaceArea,
  meshVolume,
  textureSurface,
  type SurfaceTextureRequest,
} from '@cadfixer/geometry-runtime';
import { createManifoldBooleanBackend } from '../manifold-boolean-backend';

const binary = readFileSync('apps/web/src/workers/third-party/manifold/manifold-candidate.wasm');
function cube(size = 20): CanonicalMesh {
  const h = size / 2;
  const p = [-h, -h, -h, h, -h, -h, -h, h, -h, h, h, -h, -h, -h, h, h, -h, h, -h, h, h, h, h, h];
  const i = [
    0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3,
    7, 1, 7, 5,
  ];
  const positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
function planarRing(): CanonicalMesh {
  const p = [
    -10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0, -3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0,
  ];
  const i = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
function concaveL(): CanonicalMesh {
  const p = [0, 0, 0, 10, 0, 0, 10, 4, 0, 4, 4, 0, 4, 10, 0, 0, 10, 0];
  const i = [0, 1, 3, 1, 2, 3, 0, 3, 5, 3, 4, 5];
  const positions = createPositionArray(p.length),
    indices = createIndexArray(i.length);
  positions.set(p);
  indices.set(i);
  return { positions, indices, metadata: {} };
}
const request = (overrides: Partial<SurfaceTextureRequest> = {}): SurfaceTextureRequest => ({
  seedTriangle: 2,
  pattern: 'dots',
  mode: 'emboss',
  featureSize: 2,
  spacing: 5,
  heightOrDepth: 1,
  rotationDegrees: 0,
  ...overrides,
});

describe('Stage 7C surface texture', () => {
  it('7C-S01/S02/D03/D04 selects one planar face with deterministic contained dot spacing', () => {
    const token = new CancellationSource().token;
    const a = buildSurfaceTextureLayout(cube(), request(), token);
    const b = buildSurfaceTextureLayout(cube(), request(), token);
    expect(a.region.planarity.kind).toBe('PLANAR');
    expect(a.region.triangleIds).toHaveLength(2);
    expect(a.instances).toEqual(b.instances);
    expect(a.instances.length).toBeGreaterThan(1);
    const centers = new Set(a.instances.map((item) => item.localCenterU));
    const ordered = [...centers].sort((x, y) => x - y);
    expect((ordered[1] ?? NaN) - (ordered[0] ?? NaN)).toBe(5);
    expect(
      a.instances.every(
        (item) =>
          item.localCenterU >= 1 &&
          item.localCenterU <= 19 &&
          item.localCenterV >= 1 &&
          item.localCenterV <= 19,
      ),
    ).toBe(true);
  });

  it('7C-L03/XH03 proves local line and diamond rotation', () => {
    const token = new CancellationSource().token;
    const lines = buildSurfaceTextureLayout(
      cube(),
      request({ pattern: 'lines', rotationDegrees: 45 }),
      token,
    );
    expect(lines.instances.every((item) => item.orientationRadians === Math.PI / 4)).toBe(true);
    const diamond = buildSurfaceTextureLayout(
      cube(),
      request({ pattern: 'diamond', rotationDegrees: 0 }),
      token,
    );
    expect(new Set(diamond.instances.map((item) => item.orientationRadians))).toEqual(
      new Set([Math.PI / 4, -Math.PI / 4]),
    );
    expect(
      buildSurfaceTextureOperand(diamond, request({ pattern: 'diamond' }), token).indices.length,
    ).toBe(diamond.instances.length * 36);
  });

  it('7C-S04/S05/D05 contains footprints in concave material and outside holes', () => {
    const token = new CancellationSource().token;
    const ring = buildSurfaceTextureLayout(
      planarRing(),
      request({ seedTriangle: 0, featureSize: 1, spacing: 2 }),
      token,
    );
    expect(ring.region.triangleIds).toHaveLength(8);
    expect(
      ring.instances.every(
        (item) =>
          !(
            item.localCenterU > 7 &&
            item.localCenterU < 13 &&
            item.localCenterV > 7 &&
            item.localCenterV < 13
          ),
      ),
    ).toBe(true);
    const concave = buildSurfaceTextureLayout(
      concaveL(),
      request({ seedTriangle: 0, featureSize: 1, spacing: 2 }),
      token,
    );
    expect(
      concave.instances.every((item) => !(item.localCenterU > 4 && item.localCenterV > 4)),
    ).toBe(true);
  });

  it('7C-S06 truthfully refuses non-planar regions', () => {
    const bent = cube();
    bent.positions[20] = 10.1;
    expect(() =>
      buildSurfaceTextureLayout(bent, request(), new CancellationSource().token),
    ).toThrow(/flat surfaces/);
  });

  it('7C-S03 truthfully refuses a controlled near-planar region for the planar-only MVP', () => {
    const almostFlat = cube();
    // The face remains well inside the two-degree normal-growth allowance, but
    // its 5 µm departure exceeds the scale-aware coplanarity tolerance.
    almostFlat.positions[20] = 10.000005;
    expect(() =>
      buildSurfaceTextureLayout(almostFlat, request(), new CancellationSource().token),
    ).toThrow(/flat surfaces/);
  });

  it('7C-D01/D02 proves requested emboss height and engrave depth in the surface frame', () => {
    const token = new CancellationSource().token;
    for (const mode of ['emboss', 'engrave'] as const) {
      const configured = request({ mode, heightOrDepth: 1.25 });
      const layout = buildSurfaceTextureLayout(cube(), configured, token);
      const operand = buildSurfaceTextureOperand(layout, configured, token);
      const offsets: number[] = [];
      for (let at = 0; at < operand.positions.length; at += 3) {
        const relative = [
          (operand.positions[at] ?? 0) - layout.region.frame.origin[0],
          (operand.positions[at + 1] ?? 0) - layout.region.frame.origin[1],
          (operand.positions[at + 2] ?? 0) - layout.region.frame.origin[2],
        ] as const;
        offsets.push(
          relative[0] * layout.region.frame.normal[0] +
            relative[1] * layout.region.frame.normal[1] +
            relative[2] * layout.region.frame.normal[2],
        );
      }
      expect(Math.min(...offsets)).toBeCloseTo(
        mode === 'emboss' ? -layout.interfaceOverlap : -1.25,
        5,
      );
      expect(Math.max(...offsets)).toBeCloseTo(
        mode === 'emboss' ? 1.25 : layout.interfaceOverlap,
        5,
      );
    }
  });

  it('7C-R01 refuses a density bomb before primitive construction', () => {
    expect(() =>
      buildSurfaceTextureLayout(
        cube(100),
        request({ featureSize: 0.01, spacing: 0.01 }),
        new CancellationSource().token,
      ),
    ).toThrow(new RegExp(`limit is ${String(MAX_TEXTURE_ELEMENTS)}`));
  });

  it.each([
    ['dots', 'emboss'],
    ['dots', 'engrave'],
    ['lines', 'emboss'],
    ['lines', 'engrave'],
    ['diamond', 'emboss'],
    ['diamond', 'engrave'],
  ] as const)('7C real geometry: %s %s', async (pattern, mode) => {
    const source = cube();
    const backend = await createManifoldBooleanBackend(binary);
    const result = await textureSurface(
      backend,
      source,
      request({
        pattern,
        mode,
        featureSize: 2,
        spacing: 7,
        rotationDegrees: pattern === 'diamond' ? 45 : 0,
      }),
      new CancellationSource().token,
    );
    expect(result.elementCount).toBeGreaterThan(0);
    expect(result.candidateTriangleCount).toBeGreaterThan(0);
    expect(
      mode === 'emboss'
        ? meshVolume(result.mesh) > meshVolume(source)
        : meshVolume(result.mesh) < meshVolume(source),
    ).toBe(true);
  });

  it('UI-05 describes exactly the layout Apply builds, without building it', () => {
    const token = new CancellationSource().token;
    for (const pattern of ['dots', 'lines', 'diamond'] as const) {
      const r = request({ pattern, featureSize: 1.5, spacing: 4, rotationDegrees: 30 });
      const layout = buildSurfaceTextureLayout(cube(), r, token);
      const summary = describeTextureLayout(cube(), r, token);
      expect(summary.elementCount).toBe(layout.instances.length);
      expect(summary.estimatedPrimitiveTriangles).toBe(layout.estimatedPrimitiveTriangles);
      // One edge per circle segment, or four per bar, each a pair of 3-D points.
      const perElement = pattern === 'dots' ? 24 : 4;
      expect(summary.footprint.length).toBe(layout.instances.length * perElement * 6);
    }
  });

  it('UI-05 draws each footprint on the selected face, inside it', () => {
    const summary = describeTextureLayout(cube(), request(), new CancellationSource().token);
    const planeCoordinates = new Set<number>();
    for (let at = 0; at < summary.footprint.length; at += 3) {
      const point = [summary.footprint[at], summary.footprint[at + 1], summary.footprint[at + 2]];
      // Every point lies on one face of the 20 mm cube and within its extent.
      for (const value of point) expect(Math.abs(value ?? 99)).toBeLessThanOrEqual(10 + 1e-5);
      const onFace = point.findIndex((value) => Math.abs(Math.abs(value ?? 0) - 10) < 1e-5);
      expect(onFace).toBeGreaterThanOrEqual(0);
      planeCoordinates.add(onFace * 100 + Math.sign(point[onFace] ?? 0));
    }
    expect(planeCoordinates.size).toBe(1);
  });

  it('UI-05 refuses a layout with the same limits Apply enforces', () => {
    expect(() =>
      describeTextureLayout(
        cube(1000),
        request({ featureSize: 1, spacing: 1 }),
        new CancellationSource().token,
      ),
    ).toThrow(/limit is/);
  });

  it('UI-05 measures selected and whole-part area from the real faces', () => {
    const mesh = cube();
    expect(meshSurfaceArea(mesh)).toBeCloseTo(6 * 400, 9);
    const face = buildSurfaceTextureLayout(mesh, request(), new CancellationSource().token);
    expect(meshSurfaceArea(mesh, face.region.triangleIds)).toBeCloseTo(400, 9);
  });
});

/**
 * TEXTURE-FIX-01, D1. An STL import is triangle soup: no two triangles share a vertex index.
 * The layout found the selected region's boundary by index pairs, so on soup every edge looked
 * like a boundary and no element could keep its margin from it. The same solid indexed worked.
 * Connectivity here is exact stored coordinates (ADR 0009), and nothing is welded.
 */
function toSoup(mesh: CanonicalMesh, negateZeros = false): CanonicalMesh {
  const corners = mesh.indices.length;
  const positions = createPositionArray(corners * 3);
  const indices = createIndexArray(corners);
  for (let corner = 0; corner < corners; corner += 1) {
    const from = (mesh.indices[corner] ?? 0) * 3;
    positions.set(mesh.positions.subarray(from, from + 3), corner * 3);
    indices[corner] = corner;
    // Half the zero coordinates become -0: the same point, written the other way.
    if (negateZeros && corner % 2 === 0)
      for (let axis = 0; axis < 3; axis += 1)
        if (positions[corner * 3 + axis] === 0) positions[corner * 3 + axis] = -0;
  }
  return { positions, indices, metadata: {} };
}
/**
 * A closed prism over a flat surface: the surface itself (top faces first, so triangle 0 is on
 * the textured face), its mirror image below, and a wall under every boundary edge. Outward-wound.
 */
function prism(surface: CanonicalMesh, thickness: number): CanonicalMesh {
  const vertexCount = surface.positions.length / 3;
  const triangleCount = surface.indices.length / 3;
  const uses = new Map<string, { from: number; to: number; count: number }>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1)
    for (let edge = 0; edge < 3; edge += 1) {
      const from = surface.indices[triangle * 3 + edge] ?? 0;
      const to = surface.indices[triangle * 3 + ((edge + 1) % 3)] ?? 0;
      const key = from < to ? `${String(from)}:${String(to)}` : `${String(to)}:${String(from)}`;
      const seen = uses.get(key);
      if (seen) seen.count += 1;
      else uses.set(key, { from, to, count: 1 });
    }
  const corners: number[] = [];
  for (const corner of surface.indices) corners.push(corner + vertexCount);
  for (let triangle = 0; triangle < triangleCount; triangle += 1)
    corners.push(
      surface.indices[triangle * 3] ?? 0,
      surface.indices[triangle * 3 + 2] ?? 0,
      surface.indices[triangle * 3 + 1] ?? 0,
    );
  for (const { from, to, count } of uses.values())
    if (count === 1)
      corners.push(from, to, to + vertexCount, from, to + vertexCount, from + vertexCount);
  const positions = createPositionArray(vertexCount * 6);
  positions.set(surface.positions, 0);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    positions[(vertexCount + vertex) * 3] = surface.positions[vertex * 3] ?? 0;
    positions[(vertexCount + vertex) * 3 + 1] = surface.positions[vertex * 3 + 1] ?? 0;
    positions[(vertexCount + vertex) * 3 + 2] =
      (surface.positions[vertex * 3 + 2] ?? 0) + thickness;
  }
  const indices = createIndexArray(corners.length);
  indices.set(corners);
  return { positions, indices, metadata: {} };
}
const soupFixtures: readonly (readonly [
  string,
  () => CanonicalMesh,
  Partial<SurfaceTextureRequest>,
])[] = [
  ['cube face', (): CanonicalMesh => cube(), {}],
  [
    'plate with a square hole',
    (): CanonicalMesh => prism(planarRing(), 4),
    { seedTriangle: 0, featureSize: 1, spacing: 2 },
  ],
  [
    'concave L',
    (): CanonicalMesh => prism(concaveL(), 4),
    { seedTriangle: 0, featureSize: 1, spacing: 2 },
  ],
];
describe('TEXTURE-FIX-01 D1: a model with no shared vertices textures like its indexed twin', () => {
  it.each(soupFixtures)('lays out the %s identically on soup and indexed', (_name, make, over) => {
    const token = new CancellationSource().token;
    const indexed = buildSurfaceTextureLayout(make(), request(over), token);
    const soup = buildSurfaceTextureLayout(toSoup(make()), request(over), token);
    expect(indexed.instances.length).toBeGreaterThan(0);
    expect(soup.region.triangleIds).toEqual(indexed.region.triangleIds);
    expect(soup.edgeMargin).toBe(indexed.edgeMargin);
    expect(soup.instances).toEqual(indexed.instances);
  });

  it.each(soupFixtures)('describes the %s layout identically on soup', (_name, make, over) => {
    const token = new CancellationSource().token;
    expect(describeTextureLayout(toSoup(make()), request(over), token)).toEqual(
      describeTextureLayout(make(), request(over), token),
    );
  });

  it('reads -0 and +0 as one coordinate, as topology does', () => {
    const token = new CancellationSource().token;
    const over = { seedTriangle: 0, featureSize: 1, spacing: 2 };
    expect(
      buildSurfaceTextureLayout(toSoup(prism(planarRing(), 4), true), request(over), token)
        .instances,
    ).toEqual(buildSurfaceTextureLayout(prism(planarRing(), 4), request(over), token).instances);
  });

  it.each([
    ['dots', 'emboss'],
    ['dots', 'engrave'],
    ['lines', 'emboss'],
    ['diamond', 'engrave'],
  ] as const)(
    'textures a soup cube like the indexed cube: %s %s (operand, Boolean, validation)',
    async (pattern, mode) => {
      const backend = await createManifoldBooleanBackend(binary);
      const settings = request({
        pattern,
        mode,
        featureSize: 2,
        spacing: 7,
        rotationDegrees: pattern === 'diamond' ? 45 : 0,
      });
      const indexed = await textureSurface(
        backend,
        cube(),
        settings,
        new CancellationSource().token,
      );
      const soup = await textureSurface(
        backend,
        toSoup(cube()),
        settings,
        new CancellationSource().token,
      );
      expect(soup.elementCount).toBe(indexed.elementCount);
      expect(soup.candidateTriangleCount).toBe(indexed.candidateTriangleCount);
      expect(meshVolume(soup.mesh)).toBeCloseTo(meshVolume(indexed.mesh), 3);
      expect(meshSurfaceArea(soup.mesh)).toBeCloseTo(meshSurfaceArea(indexed.mesh), 3);
    },
  );
});
