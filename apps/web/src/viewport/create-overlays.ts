import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
} from 'three';

/**
 * Diagnostic overlays, built from the worker's BOUNDED sample buffers.
 *
 * ARCHITECTURE. The worker already returned every coordinate needed to draw
 * these. Nothing here asks for canonical geometry again, and nothing here
 * recomputes topology — that would put whole-mesh work on the UI thread, which
 * is the one thing this project does not do.
 *
 * BATCHING. One `LineSegments` per edge category and one `Mesh` for degenerate
 * faces. An `Object3D` per edge would mean fifty thousand objects, fifty
 * thousand draw calls, and a scene graph the renderer walks every frame; a
 * single interleaved buffer per category is one draw call regardless of count.
 *
 * COORDINATES ARE NOT TOUCHED. Sample positions are model coordinates, and they
 * are uploaded exactly as the worker produced them. Display centring lives on
 * the parent group's transform — the same group the model mesh is in — so the
 * overlay and the surface stay registered through fit, orbit, zoom, pan, and
 * resize without anyone rewriting a coordinate.
 */

export interface OverlaySamples {
  /** Vertex-id pairs, two per edge. */
  readonly boundaryEdges: Uint32Array;
  readonly nonManifoldEdges: Uint32Array;
  readonly windingConflictEdges: Uint32Array;
  /** Face indices into the render snapshot. */
  readonly degenerateFaces: Uint32Array;
  /** Ascending, unique vertex ids the edge samples reference. */
  readonly sampleVertexIds: Uint32Array;
  /** Positions aligned with `sampleVertexIds`, three floats per entry. */
  readonly sampleVertexPositions: Float32Array;
}

export interface OverlayVisibility {
  readonly boundaryEdges: boolean;
  readonly nonManifoldEdges: boolean;
  readonly windingConflictEdges: boolean;
  readonly degenerateFaces: boolean;
}

export type OverlayKey = keyof OverlayVisibility;

/**
 * Colours chosen to read against the grey model and the dark background.
 *
 * Colour is never the ONLY signal — the Mesh Health panel names every category
 * and gives its count — so these are an aid, not the information itself.
 */
const OVERLAY_COLORS: Readonly<Record<OverlayKey, Color>> = {
  boundaryEdges: new Color('#ffb020'),
  nonManifoldEdges: new Color('#ff4d4d'),
  windingConflictEdges: new Color('#3fa9ff'),
  degenerateFaces: new Color('#ff59d6'),
};

export interface OverlayHandle {
  readonly group: Group;
  /**
   * Replaces the overlay data. Passing `undefined` clears everything.
   *
   * `renderPositions` is the non-indexed render snapshot, used to place
   * degenerate-face triangles: a face index maps directly to corners 3f, 3f+1,
   * 3f+2 there, because the snapshot is drawn non-indexed by construction.
   */
  setSamples(samples: OverlaySamples | undefined, renderPositions: Float32Array | undefined): void;
  setVisibility(visibility: OverlayVisibility): void;
  /** Stages complete diagnostic data; returns whether the visible scene needs a frame. */
  update(
    samples: OverlaySamples | undefined,
    renderPositions: Float32Array | undefined,
    visibility?: OverlayVisibility,
  ): boolean;
  /** Objects currently in the overlay group. For leak tests. */
  readonly objectCount: number;
  dispose(): void;
}

export function createOverlays(): OverlayHandle {
  const group = new Group();
  // Drawn after the surface so the depth policy below behaves predictably.
  group.renderOrder = 1;

  const built = new Map<OverlayKey, LineSegments | Mesh>();
  let visibility: OverlayVisibility = {
    boundaryEdges: false,
    nonManifoldEdges: false,
    windingConflictEdges: false,
    degenerateFaces: false,
  };

  /**
   * Releases one category's GPU resources.
   *
   * Geometry AND material, both owned here. Without this, toggling an overlay
   * twenty times leaks twenty buffers — and the leak is invisible until a large
   * model runs the tab out of GPU memory.
   */
  const disposeKey = (key: OverlayKey): void => {
    const object = built.get(key);
    if (object === undefined) return;
    group.remove(object);
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
    built.delete(key);
  };

  const disposeAll = (): void => {
    for (const key of [...built.keys()]) disposeKey(key);
  };

  /**
   * Expands vertex-id pairs into a flat line-segment position buffer.
   *
   * Ids are looked up through `sampleVertexIds`, which the worker emits in
   * ascending order — so a binary search resolves each one without building a
   * `Map` of hundreds of thousands of entries on the UI thread.
   */
  const buildEdgePositions = (
    pairs: Uint32Array,
    ids: Uint32Array,
    positions: Float32Array,
  ): Float32Array => {
    const out = new Float32Array(pairs.length * 3);
    let write = 0;
    for (const vertexId of pairs) {
      const slot = indexOfVertex(ids, vertexId);
      if (slot < 0) {
        // Should not happen: the worker emits ids for exactly the vertices its
        // samples name. Writing the origin rather than throwing keeps a
        // diagnostic overlay from taking down the viewport, and the missing
        // segment is visible rather than silent.
        write += 3;
        continue;
      }
      out[write] = positions[slot * 3] ?? 0;
      out[write + 1] = positions[slot * 3 + 1] ?? 0;
      out[write + 2] = positions[slot * 3 + 2] ?? 0;
      write += 3;
    }
    return out;
  };

  const buildFacePositions = (faces: Uint32Array, renderPositions: Float32Array): Float32Array => {
    const out = new Float32Array(faces.length * 9);
    let write = 0;
    for (const face of faces) {
      const base = face * 9;
      for (let i = 0; i < 9; i += 1) out[write + i] = renderPositions[base + i] ?? 0;
      write += 9;
    }
    return out;
  };

  const rebuild = (
    samples: OverlaySamples | undefined,
    renderPositions: Float32Array | undefined,
  ): void => {
    disposeAll();
    if (samples === undefined) return;

    const edgeCategories: readonly (readonly [OverlayKey, Uint32Array])[] = [
      ['boundaryEdges', samples.boundaryEdges],
      ['nonManifoldEdges', samples.nonManifoldEdges],
      ['windingConflictEdges', samples.windingConflictEdges],
    ];

    for (const [key, pairs] of edgeCategories) {
      // An empty category allocates nothing at all. A zero-length buffer would
      // still be a GPU resource and a scene-graph node for something with
      // nothing to draw.
      if (pairs.length === 0) continue;

      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(
          buildEdgePositions(pairs, samples.sampleVertexIds, samples.sampleVertexPositions),
          3,
        ),
      );
      const material = new LineBasicMaterial({
        color: OVERLAY_COLORS[key],
        // DEPTH POLICY — a view concern, never a geometry one.
        //
        // These lines lie exactly on the surface they describe, so with normal
        // depth testing they z-fight and disappear at most angles. Depth
        // testing is disabled for overlays instead, which draws them through
        // the model. That is the right trade for a diagnostic: an edge hidden
        // behind the surface is an edge the user cannot find, and the whole
        // point is to locate defects. `depthWrite` stays off so the overlay
        // never occludes the surface in the depth buffer.
        //
        // The alternative — nudging coordinates toward the camera — was
        // rejected: it would mean the drawn position is not the reported
        // position.
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95,
      });
      const lines = new LineSegments(geometry, material);
      lines.renderOrder = 2;
      lines.visible = visibility[key];
      group.add(lines);
      built.set(key, lines);
    }

    if (samples.degenerateFaces.length > 0 && renderPositions !== undefined) {
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(buildFacePositions(samples.degenerateFaces, renderPositions), 3),
      );
      // No normals: the material is unlit, so they would be uploaded and
      // ignored. A degenerate triangle has no meaningful normal anyway.
      const material = new MeshBasicMaterial({
        color: OVERLAY_COLORS.degenerateFaces,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = 2;
      mesh.visible = visibility.degenerateFaces;
      group.add(mesh);
      built.set('degenerateFaces', mesh);
    }
  };

  return {
    group,
    setSamples(samples, renderPositions): void {
      rebuild(samples, renderPositions);
    },
    setVisibility(next): void {
      visibility = next;
      for (const [key, object] of built) object.visible = next[key];
    },
    update(samples, renderPositions, next): boolean {
      const wasVisible = [...built.values()].some((object) => object.visible);
      if (next !== undefined) visibility = next;
      rebuild(samples, renderPositions);
      // Hidden diagnostic buffers are still complete and immediately available
      // when the user enables them. Repainting the unchanged surface here only
      // submits another full model to the GPU while topology is reporting.
      return wasVisible || [...built.values()].some((object) => object.visible);
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

/** Binary search over the worker's ascending sample vertex ids. */
function indexOfVertex(ids: Uint32Array, target: number): number {
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = ids[mid] ?? 0;
    if (value === target) return mid;
    if (value < target) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
