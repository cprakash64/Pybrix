import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';

/**
 * A DISPOSABLE HIGHLIGHT OF SOME OF THE ACTIVE PART'S FACES, for Auto Split's component suggestions.
 *
 * It is built from face INDICES and the render positions the viewport already holds for the part, so
 * nothing about the model's coordinates is recomputed or sent: the worker says WHICH faces, and this
 * copies those triangles into a second mesh drawn on top. It is display only. It cannot be exported,
 * analysed, committed or turned into a selection of geometry: nothing in the protocol accepts a render
 * buffer.
 *
 * Coordinates are part-local and uploaded as held; the part's placement and the display offset are
 * carried by the group this is added to, so a translated, rotated or reflected part is highlighted where
 * it is drawn.
 */
const HIGHLIGHT_COLOR = new Color('#5b8cff');

export interface FaceHighlightHandle {
  readonly group: Group;
  /** Highlights `faces` of `sourcePositions` (nine floats a face). `undefined` clears it. */
  setFaces(faces: Uint32Array | undefined, sourcePositions: Float32Array | undefined): void;
  /** Objects currently in the group. For leak tests. */
  readonly objectCount: number;
  dispose(): void;
}

export function createFaceHighlight(): FaceHighlightHandle {
  const group = new Group();
  group.renderOrder = 4;
  let mesh: Mesh | undefined;

  const clear = (): void => {
    if (mesh === undefined) return;
    group.remove(mesh);
    mesh.geometry.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material.dispose();
    mesh = undefined;
  };

  return {
    group,
    setFaces(faces, sourcePositions): void {
      clear();
      if (faces === undefined || sourcePositions === undefined || faces.length === 0) return;
      const available = Math.floor(sourcePositions.length / 9);
      const positions = new Float32Array(faces.length * 9);
      let written = 0;
      for (const face of faces) {
        // A face index the render buffer does not have is not drawn; it is never wrapped or clamped.
        if (face >= available) continue;
        positions.set(sourcePositions.subarray(face * 9, face * 9 + 9), written * 9);
        written += 1;
      }
      if (written === 0) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(
          written === faces.length ? positions : positions.slice(0, written * 9),
          3,
        ),
      );
      const material = new MeshBasicMaterial({
        color: HIGHLIGHT_COLOR,
        transparent: true,
        opacity: 0.62,
        side: DoubleSide,
        // On the surface it highlights: pulled toward the camera so it does not z-fight, and never
        // writing depth so it cannot hide the surface behind it.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        depthWrite: false,
      });
      mesh = new Mesh(geometry, material);
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      group.add(mesh);
    },
    get objectCount(): number {
      return mesh === undefined ? 0 : 1;
    },
    dispose(): void {
      clear();
    },
  };
}
