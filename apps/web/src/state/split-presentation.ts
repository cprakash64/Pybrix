import type { SplitPlane } from '@cadfixer/geometry-runtime';
import { isLengthUnit } from '@cadfixer/shared';

/**
 * THE SPLIT & CONNECT WORKSPACE, decided once: its plane arithmetic, its
 * connector catalogue and every sentence it shows.
 *
 * FRAMEWORK-FREE, like the other presentation modules. The plane a user sees,
 * the plane the viewport draws and the plane the worker cuts with are all
 * `splitPlaneFor(...)` of ONE settings object, so a slider, a number field and
 * the viewport arrow cannot describe three different cuts.
 *
 * WHAT THE ENGINE CAN DO, and therefore all this may offer (Stage 7B): ONE flat
 * plane per split, normal to X, Y or Z and tilted by one bounded angle; a
 * closed, manifold, consistently wound part; automatic connector placement
 * only; round pins (one to four) or one straight dovetail; connectors only for
 * a document that states millimetres. Nothing here offers a second cut, a
 * custom normal, align-to-face, three-point planes, snap-fits, threads,
 * magnets, manual placement, a margin control, bed fitting or orientation.
 */

/** Which piece(s) of a preview are drawn. Presentation only; nothing about the split changes. */
export type SplitPieceView = 'both' | 'a' | 'b';

/* ------------------------------------------------------------- plane -- */

/** The axis the plane's NORMAL starts along. The plane is named by the other two. */
export type SplitAxis = 'X' | 'Y' | 'Z';

export const SPLIT_AXES: readonly SplitAxis[] = Object.freeze(['Z', 'Y', 'X']);

export interface SplitPlaneSettings {
  readonly axis: SplitAxis;
  /** Where the plane crosses the axis through the part's centre; undefined means the centre. */
  readonly offset: number | undefined;
  /** Degrees, within ±`MAX_SPLIT_TILT_DEGREES`. */
  readonly tilt: number;
  /**
   * A second rotation, about the remaining axis (PYBRIX-08A), so the plane's
   * orientation is not limited to leaning in one direction. Degrees, within the
   * same bound. Zero leaves the plane exactly as the single tilt made it.
   */
  readonly roll: number;
  /**
   * Reverses the plane's normal, which swaps Piece A and Piece B. The plane in
   * space is the same; only which side is called A changes.
   */
  readonly flipped: boolean;
}

/** The plane exactly as a fresh cut starts: along the axis, level, unflipped. */
export function resetPlaneSettings(axis: SplitAxis): SplitPlaneSettings {
  return { axis, offset: undefined, tilt: 0, roll: 0, flipped: false };
}

/** The engine's own bound on the rotation control (Stage 7B). */
export const MAX_SPLIT_TILT_DEGREES = 89;

export interface PartBoundsLike {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly center: readonly [number, number, number];
}

export function axisIndex(axis: SplitAxis): 0 | 1 | 2 {
  return axis === 'X' ? 0 : axis === 'Y' ? 1 : 2;
}

/** "XY" for a Z-normal plane, and so on — the reference's naming. */
export function describePlaneName(axis: SplitAxis): string {
  return axis === 'Z' ? 'XY' : axis === 'Y' ? 'XZ' : 'YZ';
}

/**
 * The axis the tilt turns the normal ABOUT, as the Stage 7B plane builds it:
 * an X plane leans towards Y (about Z), a Y plane towards Z (about X), a Z
 * plane towards X (about Y).
 */
export function tiltAxisOf(axis: SplitAxis): SplitAxis {
  return axis === 'X' ? 'Z' : axis === 'Y' ? 'X' : 'Y';
}

/**
 * The axis the ROLL turns the normal about: the one axis neither the plane's
 * own axis nor its tilt axis. X plane: tilt about Z, roll about Y. Y plane: tilt
 * about X, roll about Z. Z plane: tilt about Y, roll about X.
 */
export function rollAxisOf(axis: SplitAxis): SplitAxis {
  return axis === 'X' ? 'Y' : axis === 'Y' ? 'Z' : 'X';
}

export interface SplitRange {
  readonly min: number;
  readonly max: number;
  readonly center: number;
}

/** The position range along the axis: the part's own extent on it. */
export function splitRange(axis: SplitAxis, bounds: PartBoundsLike | undefined): SplitRange {
  if (bounds === undefined) return { min: -1, max: 1, center: 0 };
  const index = axisIndex(axis);
  const min = bounds.min[index];
  const max = bounds.max[index];
  return { min, max, center: (min + max) / 2 };
}

/** A typed position, held inside the part's extent. A non-number keeps the old value. */
export function clampOffset(value: number, range: SplitRange, previous: number): number {
  if (!Number.isFinite(value)) return previous;
  return Math.min(range.max, Math.max(range.min, value));
}

export function clampTilt(value: number, previous: number): number {
  if (!Number.isFinite(value)) return previous;
  return Math.min(MAX_SPLIT_TILT_DEGREES, Math.max(-MAX_SPLIT_TILT_DEGREES, value));
}

/** The roll shares the tilt's bound; a plane never becomes parallel to its axis. */
export const clampRoll = clampTilt;

/** `normal` turned by `radians` about the world axis `about`. */
function rotateAbout(
  normal: readonly [number, number, number],
  about: SplitAxis,
  radians: number,
): [number, number, number] {
  const c = Math.cos(radians),
    s = Math.sin(radians),
    [x, y, z] = normal;
  return about === 'X'
    ? [x, y * c - z * s, y * s + z * c]
    : about === 'Y'
      ? [x * c + z * s, y, -x * s + z * c]
      : [x * c - y * s, x * s + y * c, z];
}

/**
 * THE plane. The only function that turns settings into a normal and an
 * origin; the worker request, the viewport overlay and the HUD all read it.
 * Byte-for-byte the construction the Stage 7B panel used, so a cut previewed
 * here is the cut the engine was qualified on.
 */
export function splitPlaneFor(
  settings: SplitPlaneSettings,
  bounds: PartBoundsLike | undefined,
): SplitPlane {
  const radians = (settings.tilt * Math.PI) / 180;
  const tilted: readonly [number, number, number] =
    settings.axis === 'X'
      ? [Math.cos(radians), Math.sin(radians), 0]
      : settings.axis === 'Y'
        ? [0, Math.cos(radians), Math.sin(radians)]
        : [Math.sin(radians), 0, Math.cos(radians)];
  // A roll of zero is skipped, not applied as an identity rotation: the plane a
  // user never rolled is byte-for-byte the one the engine was qualified on.
  const rolled: readonly [number, number, number] =
    settings.roll === 0
      ? tilted
      : rotateAbout(tilted, rollAxisOf(settings.axis), (settings.roll * Math.PI) / 180);
  const normal: readonly [number, number, number] = settings.flipped
    ? [-rolled[0], -rolled[1], -rolled[2]]
    : rolled;
  const center = bounds?.center ?? [0, 0, 0];
  const origin: [number, number, number] = [center[0], center[1], center[2]];
  origin[axisIndex(settings.axis)] = settings.offset ?? splitRange(settings.axis, bounds).center;
  return { origin, normal };
}

/**
 * The offset that moves the plane `distance` along its own normal.
 *
 * The viewport arrow drags along the normal; the setting is a position on the
 * axis. Moving a plane along its normal by d moves its crossing with the axis
 * by d / nₐ, where nₐ is the normal's component on that axis — cos(tilt), never
 * below cos 89°, so this is always finite.
 */
export function offsetAfterNormalDrag(
  startOffset: number,
  distance: number,
  plane: SplitPlane,
  axis: SplitAxis,
  range: SplitRange,
): number {
  const component = plane.normal[axisIndex(axis)];
  if (!Number.isFinite(distance) || Math.abs(component) < 1e-6) return startOffset;
  return clampOffset(startOffset + distance / component, range, startOffset);
}

/* ------------------------------------------------------------ numbers -- */

/**
 * A length in the document's own terms: "54.0 mm" for a document that states
 * millimetres, the bare number for one that states nothing — an STL's numbers
 * are not millimetres just because most are.
 */
export function formatLength(value: number, unit: string | undefined): string {
  const text = formatNumber(value);
  const symbol = unitSymbol(unit);
  return symbol === undefined ? text : `${text} ${symbol}`;
}

export function formatArea(value: number, unit: string | undefined): string {
  const symbol = unitSymbol(unit);
  const text = Math.round(value).toLocaleString();
  return symbol === undefined ? `${text} sq. units` : `${text} ${symbol}²`;
}

export function formatVolume(value: number, unit: string | undefined): string {
  const symbol = unitSymbol(unit);
  const text = Math.round(value).toLocaleString();
  return symbol === undefined ? `${text} cu. units` : `${text} ${symbol}³`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return Math.round(value).toLocaleString();
  return value.toFixed(1);
}

function unitSymbol(unit: string | undefined): string | undefined {
  switch (unit) {
    case 'micron':
      return 'µm';
    case 'millimeter':
      return 'mm';
    case 'centimeter':
      return 'cm';
    case 'inch':
      return 'in';
    case 'foot':
      return 'ft';
    case 'meter':
      return 'm';
    default:
      return undefined;
  }
}

/* --------------------------------------------------------- connectors -- */

export type ConnectorKind = 'none' | 'pin' | 'dovetail';

export interface ConnectorOption {
  readonly kind: ConnectorKind;
  readonly name: string;
  readonly detail: string;
}

/**
 * EXACTLY THE CONNECTORS THE ENGINE BUILDS. The reference shows eleven; CAD
 * Fixer's Stage 7B Boolean pipeline makes round pins with sockets and one
 * straight dovetail, and "None" is a real choice — a plain cut. Snap-fits,
 * threads, magnets, puzzle keys, tapered plugs, screw holes and keyed prisms
 * have no geometry behind them and have no card.
 */
export const CONNECTOR_OPTIONS: readonly ConnectorOption[] = Object.freeze([
  { kind: 'none', name: 'None', detail: 'Plain cut' },
  { kind: 'pin', name: 'Round pin', detail: 'Pin + socket' },
  { kind: 'dovetail', name: 'Dovetail', detail: 'Straight, one' },
]);

export const PIN_COUNTS: readonly (1 | 2 | 3 | 4)[] = Object.freeze([1, 2, 3, 4]);

/**
 * CLEARANCE IS RADIAL FOR A PIN: the socket's RADIUS is the pin's plus the
 * clearance, so its diameter is the pin's plus TWICE the clearance. Mirrors
 * `roundSocketRadius` in the engine; a test holds the two together.
 */
export function socketDiameter(pinDiameter: number, radialClearance: number): number {
  return pinDiameter + 2 * radialClearance;
}

/**
 * CLEARANCE IS PER SIDE FOR A DOVETAIL: the slot's width and length each grow
 * by twice the clearance. Mirrors `dovetailFemaleDimensions`.
 */
export function dovetailSlot(
  width: number,
  length: number,
  perSideClearance: number,
): { readonly width: number; readonly length: number } {
  return { width: width + 2 * perSideClearance, length: length + 2 * perSideClearance };
}

/** The engine's accepted dimension range (Stage 7B `dimension`). */
export function isValidDimension(value: number, allowZero = false): boolean {
  return Number.isFinite(value) && value >= (allowZero ? 0 : 0.01) && value <= 1000;
}

/**
 * Connectors need a known physical unit — stated by the file or chosen by the
 * user (PYBRIX-08A). Their sizes are millimetres; the request converts them
 * into the model's coordinate units. The mesh itself is never rescaled.
 */
export function connectorsAvailable(unit: string | undefined): boolean {
  return unit !== undefined && isLengthUnit(unit);
}

/* --------------------------------------------------------------- copy -- */

export const SPLIT_COPY = Object.freeze({
  planeSection: 'Cut plane',
  planeGroup: 'Cut plane orientation',
  oneCut:
    'One flat cut per split. To cut further, select a piece after applying and split it again.',
  resetPlane: 'Reset plane',
  viewGroup: 'Show',
  piecesValidated: 'Both pieces closed; cut faces capped',
  flipPlane: 'Swap sides',
  flipHint: 'Swaps Piece A and Piece B. The cut itself does not move.',
  connectorsSection: 'Connectors',
  connectorsMeta: 'Placed automatically',
  connectorsGroup: 'Connector type',
  placementNote:
    'Placed automatically on the cut face, inside its material and away from its edges. There is no manual placement.',
  connectorsNeedMillimetres:
    'Connectors have physical sizes, so Pybrix needs to know what this model’s numbers mean. Choose its units to continue.',
  fitNote: 'Printers vary: 0.2 mm is a starting point, not a guarantee of fit.',
  resultSection: 'Result',
  noPart: 'Open a model to split it.',
  pieceA: 'Piece A',
  pieceB: 'Piece B',
  previewLabel: 'Preview — not applied',
  previewButton: 'Preview split',
  applyButton: 'Apply split',
  discardButton: 'Cancel',
  cancelButton: 'Cancel',
  undoButton: 'Undo split',
  exportMode: 'Export',
  exportStls: 'Individual STLs',
  exportThreeMf: 'One 3MF',
  exportThreeMfAction: 'Open in Convert as 3MF',
  hintDrag: 'Drag the orange arrow to move the plane',
  /*
   * WORKSPACE-UX-03: one line each for the action region. The full message is
   * an alert in the scrolling content above it.
   */
  previewReady: 'Ready to apply.',
  applying: 'Applying the split…',
  failedLine: 'No split was made — details above',
  tooDetailedHint: 'This model is too detailed for Manual Split right now.',
  exportFailedLine: 'The export did not finish — details above',
  exportSection: 'Export pieces',
});

/** "Position along Z". */
export function describePositionLabel(axis: SplitAxis): string {
  return `Position along ${axis}`;
}

/** "Tilt about Y". */
export function describeTiltLabel(axis: SplitAxis): string {
  return `Tilt about ${tiltAxisOf(axis)}`;
}

/** "Roll about X". */
export function describeRollLabel(axis: SplitAxis): string {
  return `Roll about ${rollAxisOf(axis)}`;
}

/** "XY · Z = 54.0 mm", plus the tilt when there is one. */
export function describeCut(
  settings: SplitPlaneSettings,
  offset: number,
  unit: string | undefined,
): string {
  const tilt = settings.tilt === 0 ? '' : ` · tilted ${formatNumber(settings.tilt)}°`;
  const roll = settings.roll === 0 ? '' : ` · rolled ${formatNumber(settings.roll)}°`;
  const flipped = settings.flipped ? ' · sides swapped' : '';
  return `${describePlaneName(settings.axis)} · ${settings.axis} = ${formatLength(offset, unit)}${tilt}${roll}${flipped}`;
}

/** "1 outline" / "2 outlines". A loop is an outline, not a separate piece. */
export function describeOutlines(count: number): string {
  return count === 1 ? '1 outline' : `${count.toLocaleString()} outlines`;
}

/** The primary action's label in each phase. */
export function describeExportParts(count: number): string {
  return count === 1 ? 'Export 1 part' : `Export ${count.toLocaleString()} parts`;
}

export function describeConnectorResult(kind: ConnectorKind): string {
  switch (kind) {
    case 'none':
      return 'None — plain cut';
    case 'pin':
      return 'Round pins and sockets';
    case 'dovetail':
      return 'Dovetail';
  }
}

/**
 * Area and outlines of the cut, as the engine measured them. `applied` marks
 * the figures of the split already made — after Apply the plane moves on to
 * the next possible cut, and unlabelled figures would read as that cut's.
 */
export function describeSection(
  section: { readonly area: number; readonly loopCount: number },
  unit: string | undefined,
  applied = false,
): string {
  const facts = `Cut face ${formatArea(section.area, unit)} · ${describeOutlines(section.loopCount)}`;
  return applied ? `Last split: ${facts.charAt(0).toLowerCase()}${facts.slice(1)}` : facts;
}
