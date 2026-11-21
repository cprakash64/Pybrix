import { describe, expect, it, vi } from 'vitest';
import type { LineSegments } from 'three';
import { createOverlays, type OverlaySamples, type OverlayVisibility } from './create-overlays';

const hidden: OverlayVisibility = {
  boundaryEdges: false,
  nonManifoldEdges: false,
  windingConflictEdges: false,
  degenerateFaces: false,
};
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const samples = (offset = 0): OverlaySamples => ({
  boundaryEdges: new Uint32Array([0, 1]),
  nonManifoldEdges: new Uint32Array(),
  windingConflictEdges: new Uint32Array(),
  degenerateFaces: new Uint32Array(),
  sampleVertexIds: new Uint32Array([0, 1]),
  sampleVertexPositions: new Float32Array([offset, 0, 0, offset + 1, 0, 0]),
});

describe('diagnostic overlay frame invalidation', () => {
  it('retains complete hidden samples without requesting an unchanged surface frame', () => {
    const overlays = createOverlays();
    const input = samples();
    const before = input.sampleVertexPositions.slice();
    expect(overlays.update(input, positions, hidden)).toBe(false);
    expect(overlays.objectCount).toBe(1);
    const line = overlays.group.children[0] as LineSegments;
    expect(line.visible).toBe(false);
    expect(Array.from(line.geometry.getAttribute('position').array)).toEqual(Array.from(before));
    expect(input.sampleVertexPositions).toEqual(before);
    overlays.dispose();
  });

  it('requests a frame when hidden samples become visible', () => {
    const overlays = createOverlays();
    overlays.update(samples(), positions, hidden);
    expect(overlays.update(samples(), positions, { ...hidden, boundaryEdges: true })).toBe(true);
    expect(overlays.group.children[0]?.visible).toBe(true);
    overlays.dispose();
  });

  it('replaces visible geometry and releases the prior buffers', () => {
    const overlays = createOverlays();
    overlays.update(samples(), positions, { ...hidden, boundaryEdges: true });
    const old = overlays.group.children[0] as LineSegments;
    const dispose = vi.spyOn(old.geometry, 'dispose');
    expect(overlays.update(samples(2), positions)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    const line = overlays.group.children[0] as LineSegments;
    expect(Array.from(line.geometry.getAttribute('position').array)).toEqual([2, 0, 0, 3, 0, 0]);
    expect(overlays.objectCount).toBe(1);
    overlays.dispose();
  });

  it('requests the clearing frame when visible diagnostics are hidden', () => {
    const overlays = createOverlays();
    overlays.update(samples(), positions, { ...hidden, boundaryEdges: true });
    expect(overlays.update(samples(), positions, hidden)).toBe(true);
    expect(overlays.group.children[0]?.visible).toBe(false);
    expect(overlays.update(samples(), positions, hidden)).toBe(false);
    overlays.dispose();
  });

  it('clears visible diagnostics once and retains the chosen visibility for later samples', () => {
    const overlays = createOverlays();
    overlays.update(samples(), positions, { ...hidden, boundaryEdges: true });
    expect(overlays.update(undefined, undefined)).toBe(true);
    expect(overlays.objectCount).toBe(0);
    expect(overlays.update(undefined, undefined)).toBe(false);
    expect(overlays.update(samples(), positions)).toBe(true);
    expect(overlays.group.children[0]?.visible).toBe(true);
    overlays.dispose();
  });

  it('keeps hidden replacements bounded and disposes their complete resources', () => {
    const overlays = createOverlays();
    for (let i = 0; i < 20; i++) {
      const old = overlays.group.children[0] as LineSegments | undefined;
      const dispose = old === undefined ? undefined : vi.spyOn(old.geometry, 'dispose');
      expect(overlays.update(samples(i), positions, hidden)).toBe(false);
      expect(overlays.objectCount).toBe(1);
      if (dispose !== undefined) expect(dispose).toHaveBeenCalledOnce();
    }
    overlays.dispose();
    expect(overlays.objectCount).toBe(0);
  });

  it.each([
    'boundaryEdges',
    'nonManifoldEdges',
    'windingConflictEdges',
    'degenerateFaces',
  ] as const)('invalidates visible %s without dropping another diagnostic category', (key) => {
    const overlays = createOverlays();
    const input: OverlaySamples = {
      ...samples(),
      nonManifoldEdges: new Uint32Array([0, 1]),
      windingConflictEdges: new Uint32Array([0, 1]),
      degenerateFaces: new Uint32Array([0]),
    };
    expect(overlays.update(input, positions, hidden)).toBe(false);
    expect(overlays.objectCount).toBe(4);
    expect(overlays.update(input, positions, { ...hidden, [key]: true })).toBe(true);
    expect(overlays.group.children.filter((object) => object.visible)).toHaveLength(1);
    expect(overlays.objectCount).toBe(4);
    overlays.dispose();
  });
});
