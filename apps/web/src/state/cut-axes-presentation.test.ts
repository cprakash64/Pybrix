import { describe, expect, it } from 'vitest';
import { cutAxesSentence, labelCutAxes, nameDirection } from './cut-axes-presentation';

const unit = (x: number, y: number, z: number): [number, number, number] => {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
};
const turned = (degrees: number): [number, number, number] => {
  const t = (degrees * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t), 0];
};

describe('naming a direction against the model axes', () => {
  it('names the six axis directions exactly', () => {
    expect(nameDirection([1, 0, 0]).short).toBe('+X');
    expect(nameDirection([-1, 0, 0]).short).toBe('−X');
    expect(nameDirection([0, 1, 0]).long).toBe('+Y');
    expect(nameDirection([0, -1, 0]).long).toBe('−Y');
    expect(nameDirection([0, 0, 1]).axis).toEqual({ name: 'Z', sign: 1 });
    expect(nameDirection([0, 0, -1]).axis).toEqual({ name: 'Z', sign: -1 });
  });

  it('does not call a direction an axis when it is a degree or more away, and says how far', () => {
    expect(nameDirection(turned(0.5)).short).toBe('+X');
    const seven = nameDirection(turned(7));
    expect(seven.short).toBe('≈+X');
    expect(seven.long).toBe('+X, turned 7° from the X axis');
    expect(seven.axis).toEqual({ name: 'X', sign: 1 });
  });

  it('gives the components when no axis is near, rather than the nearest one', () => {
    const diagonal = nameDirection(unit(1, 1, 1));
    expect(diagonal.short).toBe('tilted');
    expect(diagonal.long).toBe('(0.58, 0.58, 0.58) in X, Y, Z');
    expect(diagonal.axis).toBeUndefined();
    expect(nameDirection(turned(45)).axis).toBeUndefined();
  });

  it('never prints a negative zero', () => {
    expect(nameDirection(unit(1, 1, 1)).long).not.toMatch(/-0\b/);
    expect(nameDirection([0.3, 0, -0.95]).long).not.toMatch(/-0(?!\.)/);
  });
});

describe('the axes of a cut', () => {
  it('says which side the picture is seen from by the handedness of the three vectors', () => {
    // u = +Y, v = +Z, normal = +X: Y x Z = X, so the picture is seen from the +X side
    const a = labelCutAxes({ u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] });
    expect(a.across.short).toBe('+Y');
    expect(a.along.short).toBe('+Z');
    expect(a.seenFrom?.long).toBe('+X');
    // the same axes with the normal reversed are seen from the other side
    const b = labelCutAxes({ u: [0, 1, 0], v: [0, 0, 1], normal: [-1, 0, 0] });
    expect(b.seenFrom?.long).toBe('+X');
    expect(b.normal.long).toBe('−X');
  });

  it('says nothing about the viewer when the vectors are not a frame', () => {
    expect(
      labelCutAxes({ u: [1, 0, 0], v: [1, 0, 0], normal: [0, 0, 1] }).seenFrom,
    ).toBeUndefined();
  });

  it('words the sentence in model terms, with no claim about top, front or any use', () => {
    const sentence = cutAxesSentence(
      labelCutAxes({ u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] }),
    );
    expect(sentence).toBe(
      'Across runs toward +Y on the model, and along toward +Z. It is seen from the +X side.',
    );
    expect(sentence).not.toMatch(/\b(top|front|back|left|right|up|down)\b/i);
  });
});
