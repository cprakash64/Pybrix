import { isAppError, isLengthUnit } from '@cadfixer/shared';
import { EditRefusal } from '@cadfixer/mesh-core';
import type { TextureMode, TexturePattern } from '@cadfixer/geometry-runtime';
import { formatArea } from './split-presentation';

/**
 * THE SURFACE TEXTURE WORKSPACE, decided once: its catalogue, its validation
 * and every sentence it shows.
 *
 * WHAT THE STAGE 7C ENGINE DOES, and therefore all this may offer: ONE
 * connected FLAT region of one part, chosen by clicking a face; Dots, Lines or
 * Diamond laid out on that face's own plane; each Raised (a Boolean union) or
 * Engraved (a difference); millimetre documents only. There is no brush,
 * lasso, angle or grow/shrink selection, no image heightmap, no curved,
 * cylindrical, spherical, triplanar or surface-following mapping, no falloff
 * and no subdivision — so none of those has a control.
 */

export interface PatternOption {
  readonly pattern: TexturePattern;
  readonly name: string;
  readonly detail: string;
  /** Whether the engine reads the rotation for this pattern. Dots ignore it. */
  readonly rotates: boolean;
}

export const PATTERN_OPTIONS: readonly PatternOption[] = Object.freeze([
  { pattern: 'dots', name: 'Dots', detail: 'Round bumps', rotates: false },
  { pattern: 'lines', name: 'Lines', detail: 'Parallel bars', rotates: true },
  { pattern: 'diamond', name: 'Diamond', detail: 'Crossed bars', rotates: true },
]);

export function patternOption(pattern: TexturePattern): PatternOption {
  for (const option of PATTERN_OPTIONS) if (option.pattern === pattern) return option;
  return { pattern, name: pattern, detail: '', rotates: false };
}

/** Mirrors of the engine's admission ceilings; a test holds them equal. */
export const TEXTURE_ELEMENT_LIMIT = 500;
export const TEXTURE_PRIMITIVE_LIMIT = 64_000;
/** The engine's region growth bound, stated where the tool is described. */
export const TEXTURE_REGION_NORMAL_DEGREES = 2;

export interface TextureSettings {
  readonly pattern: TexturePattern;
  readonly mode: TextureMode;
  /** Dot diameter, or line width, in millimetres. */
  readonly featureSize: number;
  /** Centre-to-centre pitch, in millimetres. */
  readonly spacing: number;
  /** Height above the face when raised, depth below it when engraved, in millimetres. */
  readonly heightOrDepth: number;
  /** Degrees, 0–180, measured in the face's own plane. */
  readonly rotationDegrees: number;
}

export const DEFAULT_TEXTURE_SETTINGS: TextureSettings = Object.freeze({
  pattern: 'dots',
  mode: 'emboss',
  featureSize: 2,
  spacing: 5,
  heightOrDepth: 0.8,
  rotationDegrees: 0,
});

/**
 * The first setting the engine would refuse, named — the same rules
 * `buildSurfaceTextureLayout` applies, stated before any work is asked for.
 */
export function textureSettingsProblem(settings: TextureSettings): string | undefined {
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
  if (!positive(settings.featureSize))
    return `${describeFeatureLabel(settings.pattern)} must be greater than 0 mm.`;
  if (!positive(settings.spacing)) return 'Spacing must be greater than 0 mm.';
  if (!positive(settings.heightOrDepth))
    return `${describeDepthLabel(settings.mode)} must be greater than 0 mm.`;
  if (
    !Number.isFinite(settings.rotationDegrees) ||
    settings.rotationDegrees < 0 ||
    settings.rotationDegrees > 180
  )
    return 'Rotation must be between 0° and 180°.';
  if (settings.spacing < settings.featureSize)
    return `Spacing is centre to centre, so it must be at least the ${describeFeatureLabel(settings.pattern).toLowerCase()}.`;
  return undefined;
}

/**
 * Texture sizes are physical, so a known unit is needed — stated by the file or
 * chosen by the user (PYBRIX-08A). The request converts millimetres into the
 * model's coordinate units; the mesh is not rescaled.
 */
export function textureAvailable(unit: string | undefined): boolean {
  return unit !== undefined && isLengthUnit(unit);
}

export function describeFeatureLabel(pattern: TexturePattern): string {
  return pattern === 'dots' ? 'Dot diameter' : 'Line width';
}

export function describeDepthLabel(mode: TextureMode): string {
  return mode === 'emboss' ? 'Height' : 'Depth';
}

export function describeDirection(mode: TextureMode): string {
  return mode === 'emboss' ? 'Raised — added above the face' : 'Engraved — cut into the face';
}

/** "18% of surface". Undefined when the part has no area to compare with. */
export function describeCoverage(area: number, partArea: number): string | undefined {
  if (!(partArea > 0)) return undefined;
  const percent = (area / partArea) * 100;
  return `${percent < 1 ? percent.toFixed(1) : String(Math.round(percent))}% of surface`;
}

export function describeSelectionArea(area: number, unit: string | undefined): string {
  return formatArea(area, unit);
}

export function describeTriangles(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'triangle' : 'triangles'}`;
}

/**
 * WHAT A FAILED TEXTURE STEP SAYS. A refusal the engine typed (a selection too large for one
 * selection to hold) is worded here, from its reason and its numbers, so the screen states a
 * metric and a limit instead of printing the engine's sentence; any other failure keeps the
 * message it came with, and a failure that came with none says `fallback`. Nothing here is a
 * claim about the model: a refusal changes nothing, and the alert says so beside it.
 */
export function describeTextureFailure(cause: unknown, fallback: string): string {
  if (isAppError(cause)) {
    const { reason, limit, observed } = cause.details;
    if (reason === EditRefusal.RegionTooLarge && typeof limit === 'number')
      return `That flat surface has more than ${limit.toLocaleString()} triangles, the most one selection can hold, so it was not selected.`;
    if (
      reason === EditRefusal.SourceTooLarge &&
      typeof limit === 'number' &&
      typeof observed === 'number'
    )
      return `This part has ${observed.toLocaleString()} triangles. Surface Texture can select a face on a part of up to ${limit.toLocaleString()}.`;
  }
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback;
}

export const TEXTURE_COPY = Object.freeze({
  selectionSection: 'Surface selection',
  selectionGroup: 'Selection tool',
  regionTool: 'Flat region',
  regionToolDetail: `Click a face: selects the connected faces within ${String(TEXTURE_REGION_NORMAL_DEGREES)}° of it, up to 100,000 triangles. Flat regions only.`,
  clearSelection: 'Clear',
  noSelection: 'No surface selected.',
  sourceSection: 'Texture source',
  sourceGroup: 'Pattern',
  mappingSection: 'Mapping',
  mappingProjection: 'Flat, in the selected face’s own plane',
  mappingNote:
    'Elements are laid out on the face and kept whole: any that would cross its edge margin are left out rather than cut.',
  parametersSection: 'Texture parameters',
  directionGroup: 'Direction',
  raised: 'Raised',
  engraved: 'Engraved',
  estimateSection: 'Layout',
  previewButton: 'Generate preview',
  applyButton: 'Apply texture',
  discardButton: 'Discard preview',
  resetButton: 'Reset',
  undoButton: 'Undo texture',
  noModel: 'Open a model to texture one of its flat faces.',
  needsMillimetres:
    'Texture sizes are physical, and this model does not state its units. Choose how to read its dimensions to continue.',
  hintSelect: 'Click a flat face of the model to select it',
  hintSelected: 'Click another face to replace the selection',
  previewLabel: 'Preview — not applied',
  /*
   * The viewport HUD names WHICH of the three states is on screen (UI-06):
   * layout outlines (the fast preview, nothing built), generated geometry (a
   * preview, whose banner says it is not applied), or the model itself.
   */
  hudLayout: 'Layout outlines only — no geometry built',
  hudGenerated: 'Generated texture geometry',
  fastPreviewNote:
    'Outlines show exactly where each element will be placed. No geometry has been built.',
  /*
   * WORKSPACE-UX-03: one line each for the action region, and the applied
   * result that used to be a second button row inside it.
   */
  applying: 'Applying and validating the texture…',
  failedLine: 'No texture was made — details above',
  appliedSection: 'Applied texture',
  appliedHeadline: 'Texture applied',
  appliedNote: 'The texture is part of the model. Undo restores the model as it was before it.',
});
