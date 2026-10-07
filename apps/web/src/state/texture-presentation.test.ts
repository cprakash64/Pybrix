import { LengthUnit } from '@cadfixer/shared';
import { describe, expect, it } from 'vitest';
import { MAX_TEXTURE_ELEMENTS, MAX_TEXTURE_PRIMITIVE_TRIANGLES } from '@cadfixer/geometry-runtime';
import type { DocumentHandle } from '@cadfixer/geometry-runtime';
import {
  DEFAULT_TEXTURE_SETTINGS,
  PATTERN_OPTIONS,
  TEXTURE_COPY,
  TEXTURE_ELEMENT_LIMIT,
  TEXTURE_PRIMITIVE_LIMIT,
  describeCoverage,
  describeDepthLabel,
  describeFeatureLabel,
  describeSelectionArea,
  textureAvailable,
  textureSettingsProblem,
} from './texture-presentation';
import { textureRequest, type TextureSelection } from './use-texture-workflow';

/**
 * UI-05: the Surface Texture workspace's catalogue, rules and wording.
 */

const SELECTION: TextureSelection = {
  source: { documentId: 'd', revision: 1 } as DocumentHandle,
  partId: 'p',
  seedTriangle: 7,
  triangleIds: [6, 7],
  area: 400,
  partArea: 2400,
  planarity: 'PLANAR',
};

describe('the catalogue is the engine’s', () => {
  it('offers exactly the three patterns Stage 7C builds', () => {
    expect(PATTERN_OPTIONS.map((option) => option.pattern)).toEqual(['dots', 'lines', 'diamond']);
    const names = PATTERN_OPTIONS.map((option) => option.name.toLowerCase()).join(' ');
    for (const absent of ['knurl', 'carbon', 'leather', 'wood', 'hex', 'voronoi', 'brick'])
      expect(names).not.toContain(absent);
  });

  it('offers rotation only where the engine reads it', () => {
    expect(PATTERN_OPTIONS.find((option) => option.pattern === 'dots')?.rotates).toBe(false);
    expect(PATTERN_OPTIONS.filter((option) => option.rotates).map((o) => o.pattern)).toEqual([
      'lines',
      'diamond',
    ]);
  });

  it('mirrors the engine’s admission ceilings exactly', () => {
    expect(TEXTURE_ELEMENT_LIMIT).toBe(MAX_TEXTURE_ELEMENTS);
    expect(TEXTURE_PRIMITIVE_LIMIT).toBe(MAX_TEXTURE_PRIMITIVE_TRIANGLES);
  });

  it('names no selection tool, mapping or source CAD Fixer lacks', () => {
    const text = Object.values(TEXTURE_COPY).join(' ').toLowerCase();
    for (const absent of [
      'brush',
      'lasso',
      'grow',
      'shrink',
      'invert',
      'upload',
      'cylindrical',
      'spherical',
      'triplanar',
      'follow surface',
      'subdivision',
      'printable',
      'watertight',
    ])
      expect(text).not.toContain(absent);
  });
});

describe('settings are checked by the engine’s own rules', () => {
  it('accepts the defaults', () => {
    expect(textureSettingsProblem(DEFAULT_TEXTURE_SETTINGS)).toBeUndefined();
  });

  it('refuses non-positive sizes, naming the field', () => {
    expect(textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, featureSize: 0 })).toMatch(
      /Dot diameter/,
    );
    expect(
      textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, pattern: 'lines', featureSize: -1 }),
    ).toMatch(/Line width/);
    expect(textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, spacing: Number.NaN })).toMatch(
      /Spacing/,
    );
    expect(
      textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, mode: 'engrave', heightOrDepth: 0 }),
    ).toMatch(/Depth/);
  });

  it('keeps spacing centre to centre: never below the feature size', () => {
    expect(
      textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, featureSize: 3, spacing: 2 }),
    ).toMatch(/centre to centre/);
    expect(
      textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, featureSize: 3, spacing: 3 }),
    ).toBeUndefined();
  });

  it('bounds rotation to 0–180 degrees', () => {
    expect(textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, rotationDegrees: 181 })).toMatch(
      /Rotation/,
    );
    expect(
      textureSettingsProblem({ ...DEFAULT_TEXTURE_SETTINGS, rotationDegrees: 180 }),
    ).toBeUndefined();
  });

  it('needs a known physical unit, and never an unknown one', () => {
    expect(textureAvailable('millimeter')).toBe(true);
    expect(textureAvailable('inch')).toBe(true);
    expect(textureAvailable(undefined)).toBe(false);
    expect(textureAvailable('furlong')).toBe(false);
  });
});

describe('the request sent to the worker', () => {
  it('carries the selection’s seed and every setting, verbatim', () => {
    const request = textureRequest(SELECTION, {
      pattern: 'lines',
      mode: 'engrave',
      featureSize: 1.5,
      spacing: 4,
      heightOrDepth: 0.6,
      rotationDegrees: 30,
    });
    expect(request).toEqual({
      seedTriangle: 7,
      pattern: 'lines',
      mode: 'engrave',
      featureSize: 1.5,
      spacing: 4,
      heightOrDepth: 0.6,
      rotationDegrees: 30,
    });
  });

  it('expresses physical sizes in the model’s coordinate units, leaving angles alone', () => {
    const request = textureRequest(
      SELECTION,
      {
        pattern: 'lines',
        mode: 'raised',
        featureSize: 2.54,
        spacing: 25.4,
        heightOrDepth: 0.254,
        rotationDegrees: 30,
      },
      LengthUnit.Inch,
    );
    // 25.4 mm is one inch; the model is read as inches, so one coordinate unit.
    expect(request.featureSize).toBeCloseTo(0.1, 12);
    expect(request.spacing).toBeCloseTo(1, 12);
    expect(request.heightOrDepth).toBeCloseTo(0.01, 12);
    expect(request.rotationDegrees).toBe(30);
  });

  it('sends no rotation for dots, which the engine ignores', () => {
    const request = textureRequest(SELECTION, {
      ...DEFAULT_TEXTURE_SETTINGS,
      rotationDegrees: 45,
    });
    expect(request.rotationDegrees).toBe(0);
  });
});

describe('selection metrics and labels', () => {
  it('states coverage as a share of the whole part', () => {
    expect(describeCoverage(400, 2400)).toBe('17% of surface');
    expect(describeCoverage(1, 400)).toBe('0.3% of surface');
    expect(describeCoverage(1, 0)).toBeUndefined();
  });

  it('states area in the document’s unit, or none', () => {
    expect(describeSelectionArea(2400, 'millimeter')).toBe('2,400 mm²');
    expect(describeSelectionArea(2400, undefined)).toBe('2,400 sq. units');
  });

  it('labels size and depth by what they are', () => {
    expect(describeFeatureLabel('dots')).toBe('Dot diameter');
    expect(describeFeatureLabel('diamond')).toBe('Line width');
    expect(describeDepthLabel('emboss')).toBe('Height');
    expect(describeDepthLabel('engrave')).toBe('Depth');
  });
});
