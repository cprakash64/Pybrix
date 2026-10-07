import { describe, expect, it } from 'vitest';
import { LineSegments, Mesh } from 'three';
import { createChangeOverlays, type ChangeOverlayInput } from './create-change-overlays';

/**
 * Change overlays, tested without a renderer.
 *
 * Nothing here needs WebGL: the module builds `BufferGeometry` and scene-graph
 * objects, and every property worth asserting — how many GPU objects exist, what
 * coordinates they carry, whether they were disposed — is observable from the
 * objects themselves. That is deliberate; a viewport concern that can only be
 * checked by looking at pixels is a viewport concern nobody checks.
 *
 * WHAT THESE PROTECT:
 *   - the batching rule (never one object per changed face),
 *   - the direction indicators being derived from CORNER ORDER, not from a
 *     stored normal,
 *   - removed faces disappearing when the proposed result is shown,
 *   - disposal, because a leaked preview costs as much as a leaked model.
 */

/**
 * A source render snapshot with three triangles.
 *
 * Non-indexed, nine floats per face, exactly as `RenderSnapshot` defines it — so
 * face `f` occupies `[9f, 9f+9)`.
 */
function sourcePositions(): Float32Array {
  return new Float32Array([
    // face 0: unit triangle in the XY plane, wound counter-clockwise seen from +Z
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    // face 1: the same shape, translated
    10, 0, 0, 12, 0, 0, 10, 2, 0,
    // face 2: DEGENERATE — three collinear corners, so it has no normal
    0, 0, 5, 1, 0, 5, 2, 0, 5,
  ]);
}

function input(overrides: Partial<ChangeOverlayInput> = {}): ChangeOverlayInput {
  return {
    samples: {
      removedDuplicates: new Uint32Array(),
      removedRepeatedPosition: new Uint32Array(),
      removedZeroArea: new Uint32Array(),
      flippedFaces: new Uint32Array(),
    },
    sourcePositions: sourcePositions(),
    indicatorLength: 1,
    ...overrides,
  };
}

function positionsOf(object: Mesh | LineSegments): Float32Array {
  // Narrowed rather than asserted loosely: the module always writes a
  // `Float32Array` position attribute, and reading it as anything else would
  // quietly change what these comparisons mean.
  const array = object.geometry.getAttribute('position').array;
  if (!(array instanceof Float32Array)) throw new Error('expected a Float32Array attribute');
  return array;
}

describe('batching', () => {
  it('creates ONE object per category, whatever the face count', () => {
    const overlays = createChangeOverlays();

    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([0, 1, 2]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );

    // Three changed faces, one draw call. An `Object3D` per face would mean an
    // object, a draw call and a scene-graph node for every triangle a repair
    // touches.
    expect(overlays.objectCount).toBe(1);
    const mesh = overlays.group.children[0];
    expect(mesh).toBeInstanceOf(Mesh);
    // Three triangles: nine floats each.
    expect(positionsOf(mesh as Mesh)).toHaveLength(27);
  });

  it('allocates nothing at all for an empty category', () => {
    const overlays = createChangeOverlays();

    overlays.setSamples(input());

    // A zero-length buffer would still be a GPU resource and a scene-graph node
    // for something with nothing to draw.
    expect(overlays.objectCount).toBe(0);
  });

  it('reads a face’s coordinates from the source snapshot at 9f', () => {
    const overlays = createChangeOverlays();

    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([1]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );

    expect([...positionsOf(overlays.group.children[0] as Mesh)]).toEqual([
      10, 0, 0, 12, 0, 0, 10, 2, 0,
    ]);
  });

  it('collapses an out-of-range face rather than taking down the viewport', () => {
    // A diagnostic overlay must never be able to crash the workspace, and a
    // collapsed marker is visible rather than silent.
    const overlays = createChangeOverlays();

    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([99]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );

    expect([...positionsOf(overlays.group.children[0] as Mesh)]).toEqual(new Array(9).fill(0));
  });
});

describe('winding-direction indicators', () => {
  function withFlip(): ReturnType<typeof createChangeOverlays> {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array(),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array([0]),
        },
        indicatorLength: 3,
      }),
    );
    return overlays;
  }

  it('draws the highlight plus one indicator per view', () => {
    const overlays = withFlip();

    // The face highlight, and a direction marker for each of Before and After.
    // Both are built up front so switching views costs a visibility flag rather
    // than a GPU upload.
    expect(overlays.objectCount).toBe(3);
    expect(overlays.group.children.filter((child) => child instanceof LineSegments)).toHaveLength(
      2,
    );
  });

  it('derives the direction from CORNER ORDER, and negates it for the proposed result', () => {
    /*
     * Face 0 is (0,0,0) -> (2,0,0) -> (0,2,0). Its geometric normal by the
     * right-hand rule is +Z. Reversing a triangle negates that exactly, so the
     * After marker must point at −Z.
     *
     * STL stored normals are never consulted here: they are advisory, frequently
     * wrong, and are precisely what this repair refuses to treat as truth.
     */
    const overlays = withFlip();
    const indicators = overlays.group.children.filter(
      (child): child is LineSegments => child instanceof LineSegments,
    );
    const [first, second] = indicators as [LineSegments, LineSegments];

    const beforeLine = [...positionsOf(first)];
    const afterLine = [...positionsOf(second)];

    /*
     * Compared to float32 precision, not to the exact double. The buffer IS a
     * Float32Array — that is the selected vertex-attribute representation — so
     * demanding double equality would fail a correct value for a reason that has
     * nothing to do with the direction being right.
     */
    const centroid = [2 / 3, 2 / 3, 0];
    for (const line of [beforeLine, afterLine]) {
      expect(line[0]).toBeCloseTo(centroid[0] ?? 0, 5);
      expect(line[1]).toBeCloseTo(centroid[1] ?? 0, 5);
      expect(line[2]).toBeCloseTo(0, 5);
    }

    // They point in exactly opposite directions, at the requested length: the
    // marker moves only along Z, and only its sign differs between the views.
    expect(beforeLine[3]).toBeCloseTo(centroid[0] ?? 0, 5);
    expect(beforeLine[4]).toBeCloseTo(centroid[1] ?? 0, 5);
    expect(beforeLine[5]).toBeCloseTo(3, 5);

    expect(afterLine[3]).toBeCloseTo(centroid[0] ?? 0, 5);
    expect(afterLine[4]).toBeCloseTo(centroid[1] ?? 0, 5);
    expect(afterLine[5]).toBeCloseTo(-3, 5);
  });

  it('draws no direction marker for a face that has no direction', () => {
    // A degenerate triangle that is being flipped because it was not also
    // selected for removal has a zero-length normal. A zero-length line would be
    // a lie about having a direction.
    const overlays = createChangeOverlays();

    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array(),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array([2]),
        },
      }),
    );

    // The highlight exists; the indicators do not.
    expect(overlays.objectCount).toBe(1);
    expect(overlays.group.children[0]).toBeInstanceOf(Mesh);
  });
});

describe('visibility', () => {
  function everything(): ReturnType<typeof createChangeOverlays> {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([0]),
          removedRepeatedPosition: new Uint32Array([1]),
          removedZeroArea: new Uint32Array([2]),
          flippedFaces: new Uint32Array([0]),
        },
      }),
    );
    return overlays;
  }

  const ALL_ON = {
    removedDuplicates: true,
    removedRepeatedPosition: true,
    removedZeroArea: true,
    flippedFaces: true,
    localRemoved: true,
    localAdded: true,
  };

  it('shows removed faces on Before, where they still exist', () => {
    const overlays = everything();

    overlays.setVisibility(ALL_ON, 'before');

    const visible = overlays.group.children.filter((child) => child.visible);
    // Three removal highlights, the flip highlight, and the Before indicator.
    expect(visible).toHaveLength(5);
  });

  it('HIDES removed faces on After, where they do not', () => {
    /*
     * The distinction Part G2 exists for. Those triangles are gone in the
     * proposed result; drawing them at coordinates that no longer describe
     * anything would be inventing geometry.
     */
    const overlays = everything();

    overlays.setVisibility(ALL_ON, 'after');

    const visible = overlays.group.children.filter((child) => child.visible);
    // Only the flip highlight and the After indicator: a flip moves no vertex,
    // so those triangles occupy the same coordinates in both views.
    expect(visible).toHaveLength(2);
  });

  it('honours an individual category being switched off', () => {
    const overlays = everything();

    overlays.setVisibility({ ...ALL_ON, removedDuplicates: false }, 'before');

    expect(overlays.group.children.filter((child) => child.visible)).toHaveLength(4);
  });

  it('shows exactly one indicator at a time', () => {
    const overlays = everything();

    overlays.setVisibility(ALL_ON, 'before');
    const beforeVisible = overlays.group.children.filter(
      (child) => child instanceof LineSegments && child.visible,
    );
    overlays.setVisibility(ALL_ON, 'after');
    const afterVisible = overlays.group.children.filter(
      (child) => child instanceof LineSegments && child.visible,
    );

    expect(beforeVisible).toHaveLength(1);
    expect(afterVisible).toHaveLength(1);
    expect(beforeVisible[0]).not.toBe(afterVisible[0]);
  });
});

describe('disposal', () => {
  it('releases everything when the samples are replaced', () => {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([0]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );
    const first = overlays.group.children[0] as Mesh;
    let disposed = false;
    first.geometry.addEventListener('dispose', () => {
      disposed = true;
    });

    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([1]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );

    expect(disposed).toBe(true);
    expect(overlays.objectCount).toBe(1);
  });

  it('clears everything when the candidate goes away', () => {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([0]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array([0]),
        },
      }),
    );

    overlays.setSamples(undefined);

    expect(overlays.objectCount).toBe(0);
  });

  it('detaches its group on dispose', () => {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array([0]),
          removedRepeatedPosition: new Uint32Array(),
          removedZeroArea: new Uint32Array(),
          flippedFaces: new Uint32Array(),
        },
      }),
    );

    overlays.dispose();

    expect(overlays.objectCount).toBe(0);
    expect(overlays.group.parent).toBeNull();
  });
});

describe('local repair categories — REPAIR-CORE-06B', () => {
  const withLocal = (): ReturnType<typeof createChangeOverlays> => {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array(0),
          removedRepeatedPosition: new Uint32Array(0),
          removedZeroArea: new Uint32Array(0),
          flippedFaces: new Uint32Array(0),
          localRemoved: new Uint32Array([0, 1]),
          // Two added faces, nine floats each: they exist only in the candidate.
          localAdded: new Float32Array(18).fill(0.5),
        },
      }),
    );
    return overlays;
  };
  const ON = {
    removedDuplicates: true,
    removedRepeatedPosition: true,
    removedZeroArea: true,
    flippedFaces: true,
    localRemoved: true,
    localAdded: true,
  };

  it('draws replaced faces only on Before and added faces only on After', () => {
    const overlays = withLocal();
    expect(overlays.objectCount).toBe(2);
    overlays.setVisibility(ON, 'before');
    expect(overlays.group.children.filter((child) => child.visible)).toHaveLength(1);
    overlays.setVisibility(ON, 'after');
    expect(overlays.group.children.filter((child) => child.visible)).toHaveLength(1);
  });

  it('allocates nothing for a candidate with no local repair', () => {
    const overlays = createChangeOverlays();
    overlays.setSamples(
      input({
        samples: {
          removedDuplicates: new Uint32Array(0),
          removedRepeatedPosition: new Uint32Array(0),
          removedZeroArea: new Uint32Array(0),
          flippedFaces: new Uint32Array(0),
        },
      }),
    );
    expect(overlays.objectCount).toBe(0);
  });

  it('disposes the added-face geometry with the rest', () => {
    const overlays = withLocal();
    overlays.setSamples(undefined);
    expect(overlays.objectCount).toBe(0);
  });
});
