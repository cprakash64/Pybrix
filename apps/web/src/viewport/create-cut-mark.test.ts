import { describe, expect, it, vi } from 'vitest';
import { LineSegments, Sprite } from 'three';
import { createCutMark, type CutMarkData } from './create-cut-mark';

/*
 * The mark of a cut, tested without a renderer: what is uploaded, how many GPU-backed objects exist, and that they are disposed when the
 * mark goes. Coordinates are uploaded as given, never recomputed.
 */
const data = (overrides: Partial<CutMarkData> = {}): CutMarkData => ({
  outline: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]),
  pins: new Float32Array([0, 0, 0, 0.5, 0, 0]),
  ringSegments: 1,
  across: new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 0, 1.8, 0.2, 0]),
  along: new Float32Array([0, 0, 0, 0, 2, 0]),
  labels: [
    { position: [2.2, 0, 0], text: '+Y' },
    { position: [0, 2.2, 0], text: '+Z' },
  ],
  ...overrides,
});
const label = (): null => null;

describe('the mark of a cut', () => {
  it('uploads each kind of segment exactly as given and counts them', () => {
    const mark = createCutMark(label);
    const input = data();
    mark.setMark(input, 10);
    const lines = mark.group.children.filter((c): c is LineSegments => c instanceof LineSegments);
    expect(lines).toHaveLength(4);
    expect(Array.from(lines[0]?.geometry.getAttribute('position').array ?? [])).toEqual(
      Array.from(input.outline),
    );
    expect(mark.counts).toEqual({ outline: 2, pins: 1, arrows: 3, labels: 0 });
    expect(mark.objectCount).toBe(4);
  });

  it('reads the middle of the first ring from what is drawn', () => {
    const mark = createCutMark(label);
    // a 'ring' of two segments whose points span x 0..4 and y 2..6
    mark.setMark(
      data({ pins: new Float32Array([0, 2, 0, 4, 2, 0, 4, 6, 0, 0, 6, 0]), ringSegments: 2 }),
      10,
    );
    expect(mark.firstRingCentre).toEqual([2, 4, 0]);
    mark.setMark(data({ pins: new Float32Array(0) }), 10);
    expect(mark.firstRingCentre).toBeUndefined();
  });

  it('says whether anything changed: clearing a mark that is not drawn does not, so no frame is drawn for it', () => {
    const mark = createCutMark(label);
    expect(mark.setMark(undefined, 10)).toBe(false);
    expect(mark.setMark(undefined, 10)).toBe(false);
    expect(mark.setMark(data(), 10)).toBe(true);
    expect(mark.setMark(data(), 10)).toBe(true);
    expect(mark.setMark(undefined, 10)).toBe(true);
    expect(mark.setMark(undefined, 10)).toBe(false);
  });

  it('draws nothing for an empty kind, and clears everything for undefined', () => {
    const mark = createCutMark(label);
    mark.setMark(data({ pins: new Float32Array(0) }), 10);
    expect(mark.objectCount).toBe(3);
    mark.setMark(undefined, 10);
    expect(mark.objectCount).toBe(0);
    expect(mark.group.children).toHaveLength(0);
    expect(mark.counts).toEqual({ outline: 0, pins: 0, arrows: 0, labels: 0 });
  });

  it('disposes what it replaces, so repeated marks do not grow the scene', () => {
    const mark = createCutMark(label);
    mark.setMark(data(), 10);
    const first = mark.group.children.filter((c): c is LineSegments => c instanceof LineSegments);
    const disposed = first.map((line) => vi.spyOn(line.geometry, 'dispose'));
    mark.setMark(data(), 10);
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
    expect(mark.group.children).toHaveLength(4);
    for (let i = 0; i < 20; i += 1) mark.setMark(data(), 10);
    expect(mark.group.children).toHaveLength(4);
    mark.dispose();
    expect(mark.group.children).toHaveLength(0);
  });

  it('writes each label as a sprite at its place, sized by the model, and disposes its texture', () => {
    const disposeTexture = vi.fn();
    const mark = createCutMark(() => ({ dispose: disposeTexture }) as never);
    mark.setMark(data(), 10);
    const sprites = mark.group.children.filter((c): c is Sprite => c instanceof Sprite);
    expect(sprites).toHaveLength(2);
    expect(sprites[0]?.position.toArray()).toEqual([
      expect.closeTo(2.2, 5),
      expect.closeTo(0, 5),
      expect.closeTo(0, 5),
    ]);
    expect(sprites[0]?.scale.x).toBeCloseTo(2, 5);
    expect(mark.counts.labels).toBe(2);
    mark.setMark(undefined, 10);
    expect(disposeTexture).toHaveBeenCalledTimes(2);
  });
});
