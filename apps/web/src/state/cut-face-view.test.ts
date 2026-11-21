import { describe, expect, it } from 'vitest';
import { cutView, outlinePath, pointerToCut, radiusInCut, toViewY } from './cut-face-view';

const bounds = { minU: -10, maxU: 10, minV: -5, maxV: 5 };

describe('the view onto a cut', () => {
  it('holds the bounds with a margin, with v drawn upwards', () => {
    const view = cutView(bounds);
    // larger span 20, margin 2.4
    expect(view.x).toBeCloseTo(-12.4, 10);
    expect(view.width).toBeCloseTo(24.8, 10);
    expect(view.y).toBeCloseTo(-7.4, 10);
    expect(view.height).toBeCloseTo(14.8, 10);
    expect(toViewY(5)).toBe(-5);
  });

  it('is never empty, even for a cut with no extent', () => {
    const view = cutView({ minU: 3, maxU: 3, minV: 3, maxV: 3 });
    expect(view.width).toBeGreaterThan(0);
    expect(view.height).toBeGreaterThan(0);
  });
});

describe('the point of the cut under a pointer', () => {
  const view = cutView(bounds);

  it('maps the corners and the centre of an element that matches the view exactly', () => {
    const rect = { left: 100, top: 50, width: view.width * 10, height: view.height * 10 };
    const centre = pointerToCut(view, rect, 100 + rect.width / 2, 50 + rect.height / 2);
    expect(centre?.u).toBeCloseTo(0, 9);
    expect(centre?.v).toBeCloseTo(0, 9);
    // the top left of the element is the least u and the GREATEST v
    const topLeft = pointerToCut(view, rect, 100, 50);
    expect(topLeft?.u).toBeCloseTo(view.x, 9);
    expect(topLeft?.v).toBeCloseTo(bounds.maxV + 2.4, 9);
  });

  it('allows for the empty bands an element wider or taller than the view leaves', () => {
    const wide = { left: 0, top: 0, width: view.width * 10 + 200, height: view.height * 10 };
    const wideCentre = pointerToCut(view, wide, wide.width / 2, wide.height / 2);
    expect(wideCentre?.u).toBeCloseTo(0, 9);
    expect(wideCentre?.v).toBeCloseTo(0, 9);
    // 100 pixels of band on the left: the view's left edge is at x = 100
    const edge = pointerToCut(view, wide, 100, wide.height / 2);
    expect(edge?.u).toBeCloseTo(view.x, 9);
    const tall = { left: 0, top: 0, width: view.width * 10, height: view.height * 10 + 80 };
    const tallEdge = pointerToCut(view, tall, tall.width / 2, 40);
    expect(tallEdge?.v).toBeCloseTo(bounds.maxV + 2.4, 9);
  });

  it('answers nothing for an element with no size', () => {
    expect(pointerToCut(view, { left: 0, top: 0, width: 0, height: 10 }, 1, 1)).toBeUndefined();
  });
});

describe('the outline path', () => {
  it('writes each loop closed, with v negated for the picture', () => {
    const d = outlinePath({
      bounds,
      loops: [
        { role: 'OUTER', points: [0, 0, 4, 0, 4, 2] },
        { role: 'HOLE', points: [1, 1, 2, 1, 2, 0.5] },
      ],
    });
    expect(d).toBe('M0 0 L4 0 L4 -2 Z M1 -1 L2 -1 L2 -0.5 Z');
  });
});

describe('a radius in the cut units', () => {
  it('divides millimetres by the size of a unit', () => {
    expect(radiusInCut(2, 0.5)).toBe(4);
    expect(radiusInCut(2, 1)).toBe(2);
  });
});
