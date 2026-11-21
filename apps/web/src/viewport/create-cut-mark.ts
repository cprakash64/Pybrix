import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Sprite,
  SpriteMaterial,
} from 'three';

/**
 * A DISPOSABLE MARK OF A CUT, drawn where the cut is (Stage EC-9): its outline on each piece's face, a ring for the pin and one for its
 * socket for every connector being placed, and an arrow along each of the cut's two directions with the model axis it points along.
 *
 * Every coordinate arrives in the SCENE's own coordinates, worked out from what the worker said about where the cut is
 * (`cut-mark-presentation.ts`), and is uploaded exactly as given; this module holds no placement, no mesh and no decision. It lives in the
 * same group as the model so the display-only centring offset applies to it by construction, and it is drawn over the model so a cut
 * inside a part is still seen. Nothing is exported, picked or analysed from it.
 */
export interface CutMarkData {
  /** Pairs of scene points. */
  readonly outline: Float32Array;
  readonly pins: Float32Array;
  /** Segments in one ring of `pins`. */
  readonly ringSegments: number;
  readonly across: Float32Array;
  readonly along: Float32Array;
  readonly labels: readonly {
    readonly position: readonly [number, number, number];
    readonly text: string;
  }[];
}

export interface CutMarkHandle {
  readonly group: Group;
  /**
   * Draws `data`, replacing what was drawn; `undefined` clears it. `radius` is the model's, to size the labels. Returns whether anything
   * on screen could have changed: clearing a mark that is not drawn changes nothing, and the page asks on every render of its panel, so
   * a caller draws a frame only when this is true. (Drawing one for each ask made a heavy split's Apply miss its five-second wait.)
   */
  setMark(data: CutMarkData | undefined, radius: number): boolean;
  /** GPU-backed objects currently held. For leak tests. */
  readonly objectCount: number;
  /** The middle of the first ring drawn (the box of its points), in the scene, or `undefined` with none. Read from what is drawn. */
  readonly firstRingCentre: readonly [number, number, number] | undefined;
  /** Numbers of segments drawn, by kind. For the canvas's data attributes and tests. */
  readonly counts: {
    readonly outline: number;
    readonly pins: number;
    readonly arrows: number;
    readonly labels: number;
  };
  dispose(): void;
}

const OUTLINE_COLOR = 0x8ba2ba;
const PIN_COLOR = 0x12a0fb;
const ARROW_COLOR = 0xf2a900;

/** A text as a texture, white on transparent, the sprite's own colour tinting it. `null` where there is no 2D canvas. */
export type LabelTexture = (text: string) => CanvasTexture | null;

export function canvasLabelTexture(text: string): CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.fillStyle = '#ffffff';
  context.font = '600 40px ui-monospace, Menlo, Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 64, 34);
  return new CanvasTexture(canvas);
}

export function createCutMark(makeLabel: LabelTexture = canvasLabelTexture): CutMarkHandle {
  const group = new Group();
  group.renderOrder = 8;
  let lines: LineSegments[] = [];
  let sprites: Sprite[] = [];
  let counts = { outline: 0, pins: 0, arrows: 0, labels: 0 };
  let firstRingCentre: readonly [number, number, number] | undefined;

  const clear = (): void => {
    for (const line of lines) {
      group.remove(line);
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    }
    for (const sprite of sprites) {
      group.remove(sprite);
      const material = sprite.material;
      material.map?.dispose();
      material.dispose();
    }
    lines = [];
    sprites = [];
    counts = { outline: 0, pins: 0, arrows: 0, labels: 0 };
    firstRingCentre = undefined;
  };

  const addLines = (positions: Float32Array, color: number, opacity: number): number => {
    if (positions.length === 0) return 0;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const material = new LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
    const line = new LineSegments(geometry, material);
    line.renderOrder = 8;
    // The segments sit wherever the model does and are never culled by a bound computed once: a cut near the edge of the view is still seen.
    line.frustumCulled = false;
    group.add(line);
    lines.push(line);
    return positions.length / 6;
  };

  return {
    group,
    setMark(data, radius): boolean {
      if (data === undefined && lines.length === 0 && sprites.length === 0) return false;
      clear();
      if (data === undefined) return true;
      counts = {
        outline: addLines(data.outline, OUTLINE_COLOR, 0.95),
        pins: addLines(data.pins, PIN_COLOR, 1),
        arrows: addLines(data.across, ARROW_COLOR, 1) + addLines(data.along, ARROW_COLOR, 1),
        labels: 0,
      };
      if (data.ringSegments > 0 && data.pins.length >= data.ringSegments * 6) {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < data.ringSegments; i += 1)
          for (let k = 0; k < 3; k += 1) {
            const value = data.pins[6 * i + k] ?? 0;
            lo[k] = Math.min(lo[k] ?? value, value);
            hi[k] = Math.max(hi[k] ?? value, value);
          }
        firstRingCentre = [
          ((lo[0] ?? 0) + (hi[0] ?? 0)) / 2,
          ((lo[1] ?? 0) + (hi[1] ?? 0)) / 2,
          ((lo[2] ?? 0) + (hi[2] ?? 0)) / 2,
        ];
      }
      let labels = 0;
      for (const label of data.labels) {
        const map = makeLabel(label.text);
        if (map === null) continue;
        const material = new SpriteMaterial({
          map,
          color: ARROW_COLOR,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        });
        const sprite = new Sprite(material);
        sprite.position.set(...label.position);
        // Twice as wide as tall, as the texture is, and a small share of the model so it reads as a label and not as part of it.
        sprite.scale.set(radius * 0.2, radius * 0.1, 1);
        sprite.renderOrder = 9;
        group.add(sprite);
        sprites.push(sprite);
        labels += 1;
      }
      counts = { ...counts, labels };
      return true;
    },
    get objectCount(): number {
      return lines.length + sprites.length;
    },
    get firstRingCentre(): CutMarkHandle['firstRingCentre'] {
      return firstRingCentre;
    },
    get counts(): CutMarkHandle['counts'] {
      return counts;
    },
    dispose(): void {
      clear();
    },
  };
}
