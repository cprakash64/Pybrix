import { describe, expect, it } from 'vitest';
import { dovetailFemaleDimensions, roundSocketRadius } from '@cadfixer/geometry-runtime';
import { deriveSplitPartExportName } from '../runtime/download';
import {
  CONNECTOR_OPTIONS,
  MAX_SPLIT_TILT_DEGREES,
  SPLIT_COPY,
  clampOffset,
  clampTilt,
  connectorsAvailable,
  describeCut,
  describeExportParts,
  describeOutlines,
  describePlaneName,
  describeSection,
  dovetailSlot,
  formatArea,
  formatLength,
  isValidDimension,
  offsetAfterNormalDrag,
  socketDiameter,
  splitPlaneFor,
  splitRange,
  tiltAxisOf,
} from './split-presentation';
import { LengthUnit } from '@cadfixer/shared';
import {
  connectorProblemOf,
  connectorRequest,
  DEFAULT_CONNECTOR,
  type ConnectorSettings,
} from './use-split-workflow';

/**
 * UI-04: the Split & Connect workspace's arithmetic and wording.
 *
 * The plane every surface shows is `splitPlaneFor` of one settings object, so
 * these tests are what keep the slider, the number field, the viewport arrow
 * and the worker request describing ONE cut.
 */

const BOUNDS = {
  min: [-10, -20, 0] as const,
  max: [30, 20, 104] as const,
  center: [10, 0, 52] as const,
};

describe('the plane', () => {
  it('names each plane by the two axes it contains', () => {
    expect(describePlaneName('Z')).toBe('XY');
    expect(describePlaneName('Y')).toBe('XZ');
    expect(describePlaneName('X')).toBe('YZ');
  });

  it('derives the position range from the part’s own extent on the axis', () => {
    expect(splitRange('Z', BOUNDS)).toEqual({ min: 0, max: 104, center: 52 });
    expect(splitRange('X', BOUNDS)).toEqual({ min: -10, max: 30, center: 10 });
  });

  it('starts at the centre, and places the origin on the axis at the offset', () => {
    const centred = splitPlaneFor({ axis: 'Z', offset: undefined, tilt: 0 }, BOUNDS);
    expect(centred.origin).toEqual([10, 0, 52]);
    expect(centred.normal).toEqual([0, 0, 1]);
    const moved = splitPlaneFor({ axis: 'Z', offset: 54, tilt: 0 }, BOUNDS);
    expect(moved.origin).toEqual([10, 0, 54]);
  });

  it('tilts about the axis the Stage 7B plane tilts about, keeping a unit normal', () => {
    for (const axis of ['X', 'Y', 'Z'] as const) {
      const { normal } = splitPlaneFor({ axis, offset: undefined, tilt: 30 }, BOUNDS);
      expect(Math.hypot(...normal)).toBeCloseTo(1, 12);
      // The tilt axis itself is untouched by the rotation.
      const tiltIndex = { X: 0, Y: 1, Z: 2 }[tiltAxisOf(axis)];
      expect(normal[tiltIndex]).toBeCloseTo(0, 12);
    }
  });

  it('holds a typed position inside the part and ignores a non-number', () => {
    const range = splitRange('Z', BOUNDS);
    expect(clampOffset(500, range, 52)).toBe(104);
    expect(clampOffset(-3, range, 52)).toBe(0);
    expect(clampOffset(Number.NaN, range, 52)).toBe(52);
    expect(clampTilt(120, 0)).toBe(MAX_SPLIT_TILT_DEGREES);
    expect(clampTilt(Number.NaN, 12)).toBe(12);
  });

  it('turns a drag along the normal into the same position the slider would set', () => {
    const range = splitRange('Z', BOUNDS);
    const flat = splitPlaneFor({ axis: 'Z', offset: 52, tilt: 0 }, BOUNDS);
    expect(offsetAfterNormalDrag(52, 10, flat, 'Z', range)).toBeCloseTo(62, 12);
    // Tilted by 60°, moving the plane 10 along its normal moves its crossing
    // with the Z axis by 10 / cos 60° = 20.
    const tilted = splitPlaneFor({ axis: 'Z', offset: 52, tilt: 60 }, BOUNDS);
    expect(offsetAfterNormalDrag(52, 10, tilted, 'Z', range)).toBeCloseTo(72, 9);
    // And it is held inside the part like a typed value.
    expect(offsetAfterNormalDrag(52, 1000, flat, 'Z', range)).toBe(104);
  });

  it('describes the cut in the document’s own unit, and invents none', () => {
    expect(describeCut({ axis: 'Z', offset: 54, tilt: 0 }, 54, 'millimeter')).toBe(
      'XY · Z = 54.0 mm',
    );
    expect(describeCut({ axis: 'Z', offset: 54, tilt: 15 }, 54, undefined)).toBe(
      'XY · Z = 54.0 · tilted 15.0°',
    );
    expect(formatLength(3.25, undefined)).toBe('3.3');
    expect(formatArea(1559.4, 'millimeter')).toBe('1,559 mm²');
    expect(formatArea(12, undefined)).toBe('12 sq. units');
  });

  it('counts outlines, not pieces', () => {
    expect(describeOutlines(1)).toBe('1 outline');
    expect(describeSection({ area: 400, loopCount: 2 }, 'millimeter')).toBe(
      'Cut face 400 mm² · 2 outlines',
    );
    // An applied split's figures are labelled as the last split's.
    expect(describeSection({ area: 400, loopCount: 1 }, 'millimeter', true)).toBe(
      'Last split: cut face 400 mm² · 1 outline',
    );
  });
});

describe('connectors', () => {
  it('offers exactly the connector kinds the engine builds', () => {
    expect(CONNECTOR_OPTIONS.map((option) => option.kind)).toEqual(['none', 'pin', 'dovetail']);
    const names = CONNECTOR_OPTIONS.map((option) => option.name.toLowerCase()).join(' ');
    for (const absent of ['snap', 'thread', 'magnet', 'puzzle', 'screw', 'keyed', 'taper'])
      expect(names).not.toContain(absent);
  });

  it('applies pin clearance radially — the socket diameter grows by twice it', () => {
    expect(socketDiameter(5, 0.2)).toBeCloseTo(5.4, 12);
    // The mirror agrees with the engine for every clearance it accepts.
    for (const clearance of [0, 0.05, 0.2, 1]) {
      expect(socketDiameter(4, clearance)).toBeCloseTo(roundSocketRadius(4, clearance) * 2, 12);
    }
  });

  it('applies dovetail clearance per side — width and length each grow by twice it', () => {
    expect(dovetailSlot(8, 12, 0.2)).toEqual(dovetailFemaleDimensions(8, 12, 0.2));
    expect(dovetailSlot(8, 12, 0.2).width).toBeCloseTo(8.4, 12);
  });

  it('accepts exactly the dimensions the engine accepts', () => {
    expect(isValidDimension(0.01)).toBe(true);
    expect(isValidDimension(0.009)).toBe(false);
    expect(isValidDimension(1000)).toBe(true);
    expect(isValidDimension(1000.1)).toBe(false);
    expect(isValidDimension(0)).toBe(false);
    expect(isValidDimension(0, true)).toBe(true);
    expect(isValidDimension(Number.NaN)).toBe(false);
  });

  it('names the parameter the engine would refuse, before any work starts', () => {
    expect(connectorProblemOf(DEFAULT_CONNECTOR)).toBeUndefined();
    expect(connectorProblemOf({ ...DEFAULT_CONNECTOR, kind: 'pin' })).toBeUndefined();
    expect(connectorProblemOf({ ...DEFAULT_CONNECTOR, kind: 'pin', diameter: 0 })).toMatch(
      /Pin diameter/,
    );
    expect(connectorProblemOf({ ...DEFAULT_CONNECTOR, kind: 'dovetail', clearance: -1 })).toMatch(
      /Clearance/,
    );
  });

  it('allows connectors for any known physical unit, and never for an unknown one', () => {
    expect(connectorsAvailable('millimeter')).toBe(true);
    expect(connectorsAvailable('inch')).toBe(true);
    expect(connectorsAvailable(undefined)).toBe(false);
    expect(connectorsAvailable('furlong')).toBe(false);
  });
});

describe('export and wording', () => {
  it('names split pieces deterministically, without collisions or doubled extensions', () => {
    expect(deriveSplitPartExportName('bracket.stl', 'A')).toBe('bracket_part_A.stl');
    expect(deriveSplitPartExportName('bracket.stl', 'B')).toBe('bracket_part_B.stl');
    expect(deriveSplitPartExportName('a.b.3mf', 'A')).toBe('a.b_part_A.stl');
    expect(deriveSplitPartExportName('../x<y>.obj', 'B')).toBe('xy_part_B.stl');
  });

  it('counts the parts it exports', () => {
    expect(describeExportParts(2)).toBe('Export 2 parts');
    expect(describeExportParts(1)).toBe('Export 1 part');
  });

  it('claims no printability, fit or capability CAD Fixer lacks', () => {
    const text = Object.values(SPLIT_COPY).join(' ').toLowerCase();
    for (const banned of ['printable', 'watertight', 'guaranteed fit', 'fits bed', 'add cut'])
      expect(text).not.toContain(banned);
  });
});

describe('connector sizes are physical, whatever the model’s unit', () => {
  const pin: ConnectorSettings = {
    kind: 'pin',
    count: 1,
    diameter: 5.08,
    depth: 10.16,
    clearance: 0.254,
    maleSide: 'A',
    dovetailWidth: 12.7,
    dovetailLength: 25.4,
    dovetailAngle: 0,
  };

  it('leaves millimetre sizes unchanged for a millimetre model', () => {
    expect(connectorRequest(pin, LengthUnit.Millimeter)).toMatchObject({
      diameter: 5.08,
      depth: 10.16,
      clearance: 0.254,
    });
  });

  it('converts them into inches for a model read as inches', () => {
    const request = connectorRequest(pin, LengthUnit.Inch);
    if (request.kind !== 'pin') throw new Error('expected a pin');
    expect(request.diameter).toBeCloseTo(0.2, 12);
    expect(request.depth).toBeCloseTo(0.4, 12);
    expect(request.clearance).toBeCloseTo(0.01, 12);
  });

  it('refuses a size the engine could not build in the model’s units', () => {
    // 0.1 mm is 0.0039 in: below the engine's 0.01 coordinate-unit floor.
    const tiny: ConnectorSettings = { ...pin, diameter: 0.1 };
    expect(connectorProblemOf(tiny, LengthUnit.Millimeter)).toBeUndefined();
    expect(connectorProblemOf(tiny, LengthUnit.Inch)).toMatch(/outside the range/);
  });
});
