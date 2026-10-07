import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from 'three';

/**
 * Repair change overlays, built from the engine's BOUNDED change samples.
 *
 * WHAT THESE ARE. Four categories of proposed change, drawn over the model so a
 * user can see WHERE a repair acts before deciding whether to apply it. Every
 * sample is a SOURCE face index — that is what `RepairChangeSamples` contains,
 * for all four categories including flips — so all of them index the source
 * render snapshot the main thread already holds. Nothing here asks the worker
 * for geometry again and nothing here walks a candidate mesh.
 *
 * BATCHING, for the same reason as the diagnostic overlays. One `Mesh` per
 * removal category and two `LineSegments` for orientation indicators. An
 * `Object3D` per changed face would mean an object, a draw call and a scene-graph
 * node for every triangle a repair touches.
 *
 * BOUNDED BY CONSTRUCTION. The engine caps samples per category (256 by
 * default), so these buffers do not scale with mesh size. The exact counts are
 * reported separately and are never sampled — the panel says "showing N of M"
 * whenever the two differ.
 *
 * REMOVED FACES ONLY EXIST IN THE SOURCE. When the user is looking at the
 * proposed result they are gone, and the overlays for them are hidden rather
 * than drawn at coordinates that no longer describe anything. Flipped faces
 * occupy the SAME coordinates in both, because a flip reorders corners and never
 * moves a vertex, so those stay visible in both views.
 */

export interface ChangeOverlaySamples {
  /** Source face indices, one per sampled removed duplicate. */
  readonly removedDuplicates: Uint32Array;
  readonly removedRepeatedPosition: Uint32Array;
  readonly removedZeroArea: Uint32Array;
  /** Source face indices of triangles whose corner order was reversed. */
  readonly flippedFaces: Uint32Array;
  /**
   * REPAIR-CORE-06B. Source face indices the local repair replaces, and the positions (nine floats
   * a face) of the faces it adds. Both come from the exact S -> C patch and are bounded by the
   * worker; absent for a candidate with no local repair.
   */
  readonly localRemoved?: Uint32Array;
  readonly localAdded?: Float32Array;
}

export interface ChangeOverlayVisibility {
  readonly removedDuplicates: boolean;
  readonly removedRepeatedPosition: boolean;
  readonly removedZeroArea: boolean;
  readonly flippedFaces: boolean;
  readonly localRemoved: boolean;
  readonly localAdded: boolean;
}

export type ChangeOverlayKey = keyof ChangeOverlayVisibility;

/** Which of the two meshes the user is currently looking at. */
export type ChangeOverlayView = 'before' | 'after';

/**
 * Colours chosen to be distinguishable from the diagnostic overlays, which may
 * be on at the same time.
 *
 * Colour is never the ONLY signal: the repair panel names every category, gives
 * its exact count, and says whether the viewport is showing all of them.
 */
const CHANGE_COLORS: Readonly<Record<ChangeOverlayKey, Color>> = {
  removedDuplicates: new Color('#ff7a45'),
  removedRepeatedPosition: new Color('#c77dff'),
  removedZeroArea: new Color('#ff59d6'),
  flippedFaces: new Color('#38e8b0'),
  localRemoved: new Color('#f5c542'),
  localAdded: new Color('#4cc9f0'),
};

export interface ChangeOverlayInput {
  readonly samples: ChangeOverlaySamples;
  /** The SOURCE render snapshot: non-indexed, nine floats per face. */
  readonly sourcePositions: Float32Array;
  /**
   * Length of an orientation indicator, in model units.
   *
   * Derived from the model's own size by the caller, so a 0.1 mm part and a 3 m
   * part both get a readable marker rather than one scaled for the other.
   */
  readonly indicatorLength: number;
}

export interface ChangeOverlayHandle {
  readonly group: Group;
  /** Replaces the overlay data. `undefined` clears and disposes everything. */
  setSamples(input: ChangeOverlayInput | undefined): void;
  setVisibility(visibility: ChangeOverlayVisibility, view: ChangeOverlayView): void;
  /** Objects currently in the group. For leak tests. */
  readonly objectCount: number;
  dispose(): void;
}

/** Keys whose faces exist only in the source, so only the Before view has them. */
const SOURCE_ONLY_KEYS: readonly ChangeOverlayKey[] = [
  'removedDuplicates',
  'removedRepeatedPosition',
  'removedZeroArea',
  'localRemoved',
];

/** Keys whose faces exist only in the candidate, so only the After view has them. */
const CANDIDATE_ONLY_KEYS: readonly ChangeOverlayKey[] = ['localAdded'];

export function createChangeOverlays(): ChangeOverlayHandle {
  const group = new Group();
  // Drawn after the surface and after the diagnostic overlays, so a change
  // marker is never hidden behind a boundary-edge line describing the same area.
  group.renderOrder = 3;

  const faces = new Map<ChangeOverlayKey, Mesh>();
  /** Orientation indicators, one buffer per view — see `buildIndicators`. */
  const indicators = new Map<ChangeOverlayView, LineSegments>();

  let visibility: ChangeOverlayVisibility = {
    removedDuplicates: false,
    removedRepeatedPosition: false,
    removedZeroArea: false,
    flippedFaces: false,
    localRemoved: false,
    localAdded: false,
  };
  let view: ChangeOverlayView = 'before';

  const disposeObject = (object: Mesh | LineSegments): void => {
    group.remove(object);
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
  };

  const disposeAll = (): void => {
    for (const object of faces.values()) disposeObject(object);
    faces.clear();
    for (const object of indicators.values()) disposeObject(object);
    indicators.clear();
  };

  const applyVisibility = (): void => {
    for (const [key, object] of faces) {
      const availableInView =
        view === 'before' ? !CANDIDATE_ONLY_KEYS.includes(key) : !SOURCE_ONLY_KEYS.includes(key);
      object.visible = visibility[key] && availableInView;
    }
    for (const [indicatorView, object] of indicators) {
      object.visible = visibility.flippedFaces && indicatorView === view;
    }
  };

  const rebuild = (input: ChangeOverlayInput | undefined): void => {
    disposeAll();
    if (input === undefined) return;

    const categories: readonly (readonly [ChangeOverlayKey, Float32Array])[] = [
      [
        'removedDuplicates',
        buildFacePositions(input.samples.removedDuplicates, input.sourcePositions),
      ],
      [
        'removedRepeatedPosition',
        buildFacePositions(input.samples.removedRepeatedPosition, input.sourcePositions),
      ],
      ['removedZeroArea', buildFacePositions(input.samples.removedZeroArea, input.sourcePositions)],
      ['flippedFaces', buildFacePositions(input.samples.flippedFaces, input.sourcePositions)],
      [
        'localRemoved',
        buildFacePositions(input.samples.localRemoved ?? new Uint32Array(0), input.sourcePositions),
      ],
      // Added faces carry their own positions: they exist only in the candidate.
      ['localAdded', input.samples.localAdded ?? new Float32Array(0)],
    ];

    for (const [key, positions] of categories) {
      // An empty category allocates nothing at all: a zero-length buffer would
      // still be a GPU resource and a scene-graph node for something with
      // nothing to draw.
      if (positions.length === 0) continue;

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      const material = new MeshBasicMaterial({
        color: CHANGE_COLORS[key],
        side: DoubleSide,
        // DEPTH POLICY, identical to the diagnostic overlays and for the same
        // reason: a marker lying exactly on the surface it describes z-fights
        // and disappears at most angles. Drawing through the model is the right
        // trade for something whose entire purpose is to be findable.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.75,
      });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = 4;
      group.add(mesh);
      faces.set(key, mesh);
    }

    /*
     * ORIENTATION INDICATORS. A filled highlight cannot show that a triangle was
     * REVERSED — its coordinates are identical before and after — so the
     * direction is drawn explicitly.
     *
     * DERIVED FROM CORNER ORDER, never from the file's stored normals. STL
     * normals are advisory, are frequently wrong, and are precisely what this
     * repair refuses to treat as truth (ADR 0010). The `before` direction is the
     * cross product of the source corner order; the `after` direction is its
     * negation, because reversing a triangle negates its geometric normal
     * exactly.
     */
    if (input.samples.flippedFaces.length > 0) {
      for (const indicatorView of ['before', 'after'] as const) {
        const positions = buildIndicators(
          input.samples.flippedFaces,
          input.sourcePositions,
          input.indicatorLength,
          indicatorView === 'after' ? -1 : 1,
        );
        if (positions.length === 0) continue;

        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(positions, 3));
        const material = new LineBasicMaterial({
          color: CHANGE_COLORS.flippedFaces,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.95,
        });
        const lines = new LineSegments(geometry, material);
        lines.renderOrder = 4;
        group.add(lines);
        indicators.set(indicatorView, lines);
      }
    }

    applyVisibility();
  };

  return {
    group,
    setSamples(input): void {
      rebuild(input);
    },
    setVisibility(next, nextView): void {
      visibility = next;
      view = nextView;
      applyVisibility();
    },
    get objectCount(): number {
      return group.children.length;
    },
    dispose(): void {
      disposeAll();
      group.removeFromParent();
    },
  };
}

/**
 * Expands sampled face indices into a flat triangle buffer.
 *
 * A face index maps directly to corners 3f, 3f+1, 3f+2 of the render snapshot,
 * because the snapshot is drawn NON-INDEXED by construction — see
 * `RenderSnapshot`. An out-of-range index writes zeros rather than throwing: a
 * diagnostic overlay must never be able to take down the viewport, and a
 * collapsed marker is visible rather than silent.
 */
function buildFacePositions(sampled: Uint32Array, sourcePositions: Float32Array): Float32Array {
  const out = new Float32Array(sampled.length * 9);
  let write = 0;
  for (const face of sampled) {
    const base = face * 9;
    for (let i = 0; i < 9; i += 1) out[write + i] = sourcePositions[base + i] ?? 0;
    write += 9;
  }
  return out;
}

/**
 * Builds one line segment per flipped face, from its centroid along its normal.
 *
 * `sign` is +1 for the source orientation and −1 for the proposed one. Faces
 * whose normal has zero length — a degenerate triangle that is being flipped
 * because it was not also selected for removal — contribute no segment, because
 * they have no direction to show and a zero-length line would be a lie about
 * having one. The buffer is therefore trimmed to what was actually written.
 */
function buildIndicators(
  flipped: Uint32Array,
  sourcePositions: Float32Array,
  length: number,
  sign: number,
): Float32Array {
  const out = new Float32Array(flipped.length * 6);
  let write = 0;

  for (const face of flipped) {
    const base = face * 9;
    const ax = sourcePositions[base] ?? 0;
    const ay = sourcePositions[base + 1] ?? 0;
    const az = sourcePositions[base + 2] ?? 0;
    const bx = sourcePositions[base + 3] ?? 0;
    const by = sourcePositions[base + 4] ?? 0;
    const bz = sourcePositions[base + 5] ?? 0;
    const cx = sourcePositions[base + 6] ?? 0;
    const cy = sourcePositions[base + 7] ?? 0;
    const cz = sourcePositions[base + 8] ?? 0;

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const magnitude = Math.hypot(nx, ny, nz);
    if (magnitude === 0 || !Number.isFinite(magnitude)) continue;
    nx = (nx / magnitude) * length * sign;
    ny = (ny / magnitude) * length * sign;
    nz = (nz / magnitude) * length * sign;

    const centroidX = (ax + bx + cx) / 3;
    const centroidY = (ay + by + cy) / 3;
    const centroidZ = (az + bz + cz) / 3;

    out[write] = centroidX;
    out[write + 1] = centroidY;
    out[write + 2] = centroidZ;
    out[write + 3] = centroidX + nx;
    out[write + 4] = centroidY + ny;
    out[write + 5] = centroidZ + nz;
    write += 6;
  }

  return write === out.length ? out : out.slice(0, write);
}
