import { describe, expect, it } from 'vitest';
import type { JointDescriptor } from '@cadfixer/geometry-runtime';
import {
  connectorAtPoint,
  connectorPairsOf,
  currentJoints,
  jointsFor,
  type JointsSlice,
} from './joint-presentation';

/*
 * Stage EC-4. The page holds no record of a connector: it holds what the worker listed for ONE revision, and reads anything else as
 * nothing. These tests assert the projection, the staleness rule and the pick, on descriptors written the way the worker writes them.
 */
const HANDLE = { documentId: 'doc-1', revision: 3 };

function joint(overrides: Partial<JointDescriptor> = {}): JointDescriptor {
  return {
    jointId: 'doc-1/joint/1',
    aPartId: 'a',
    bPartId: 'b',
    status: 'ATTACHED',
    pinCount: 2,
    retainedBytes: 100,
    specDigest: 'digest',
    connector: {
      maleSide: 'A',
      axis: [-1, 0, 0],
      mmPerSceneUnit: 1,
      pins: [
        {
          pinId: 'pin-1',
          u: 0,
          v: -5,
          center: [0, -5, 0],
          diameterMm: 4,
          depthMm: 6,
          clearanceMm: 0.2,
        },
        {
          pinId: 'pin-2',
          u: 0,
          v: 5,
          center: [0, 5, 0],
          diameterMm: 4,
          depthMm: 6,
          clearanceMm: 0.2,
        },
      ],
    },
    ...overrides,
  };
}
const ready = (joints: readonly JointDescriptor[], revision = 3): JointsSlice => ({
  status: 'READY',
  documentId: 'doc-1',
  revision,
  joints,
});

describe("the page reads the worker's list for the revision it holds, and nothing else", () => {
  it('returns the descriptors for the matching handle', () => {
    expect(currentJoints(ready([joint()]), HANDLE)).toHaveLength(1);
  });
  it('reads a list for another revision, another document, no model, or no list as nothing', () => {
    expect(currentJoints(ready([joint()], 2), HANDLE)).toEqual([]);
    expect(currentJoints({ ...ready([joint()]), documentId: 'other' }, HANDLE)).toEqual([]);
    expect(currentJoints(ready([joint()]), undefined)).toEqual([]);
    expect(currentJoints(undefined, HANDLE)).toEqual([]);
    expect(jointsFor(ready([joint()], 2), HANDLE)).toBeUndefined();
  });
  it('reads a list that could not be fetched as unavailable, never as "no connectors"', () => {
    const slice: JointsSlice = { status: 'UNAVAILABLE', documentId: 'doc-1', revision: 3 };
    expect(jointsFor(slice, HANDLE)?.status).toBe('UNAVAILABLE');
    expect(currentJoints(slice, HANDLE)).toEqual([]);
  });
});

describe('connectorPairsOf', () => {
  it("names each pin by its joint and its own id, in the worker's order", () => {
    const pairs = connectorPairsOf([joint()]);
    expect(pairs.map((p) => p.id)).toEqual(['doc-1/joint/1/pin-1', 'doc-1/joint/1/pin-2']);
    expect(pairs[0]).toMatchObject({
      jointId: 'doc-1/joint/1',
      pinId: 'pin-1',
      a: 'a',
      b: 'b',
      maleSide: 'A',
    });
  });
  it('turns millimetres into scene lengths with the unit the connectors were sized in', () => {
    const inches = joint({
      connector: {
        maleSide: 'B',
        axis: [1, 0, 0],
        mmPerSceneUnit: 25.4,
        pins: [
          {
            pinId: 'pin-1',
            u: 0,
            v: 0,
            center: [1, 2, 3],
            diameterMm: 25.4,
            depthMm: 50.8,
            clearanceMm: 2.54,
          },
        ],
      },
    });
    const [pair] = connectorPairsOf([inches]);
    expect(pair).toMatchObject({
      diameter: 1,
      depth: 2,
      clearance: 0.1,
      center: [1, 2, 3],
      axis: [1, 0, 0],
    });
  });
  it("guards a plane by the socket's reach, outward of the depth by a hundredth of a percent", () => {
    const [pair] = connectorPairsOf([joint()]);
    expect(pair?.guardRadiusWorld).toBeCloseTo(Math.hypot(6 * 1.0001, 2 + 0.2), 12);
  });
  it('lists no connector for a retired record or a cut with none', () => {
    expect(connectorPairsOf([joint({ status: 'RETIRED', reason: 'GEOMETRY_CHANGED' })])).toEqual(
      [],
    );
    // a cut recorded with no connectors has no `connector` at all
    const plain: JointDescriptor = {
      jointId: 'doc-1/joint/9',
      aPartId: 'a',
      bPartId: 'b',
      status: 'ATTACHED',
      pinCount: 0,
      retainedBytes: 0,
      specDigest: 'digest',
    };
    expect(connectorPairsOf([plain])).toEqual([]);
  });
});

describe('picking a connector', () => {
  const pairs = connectorPairsOf([joint()]);
  const first = pairs[0]?.id;
  it('finds a pin from a point on either piece, inside its reach', () => {
    expect(connectorAtPoint(pairs, { partId: 'a' }, [-3, -4.5, 0])).toBe(first);
    expect(connectorAtPoint(pairs, { partId: 'b' }, [-3, -5.5, 0])).toBe(first);
  });
  it('finds nothing beside it, beyond its depth, behind the cut, or on another piece', () => {
    expect(connectorAtPoint(pairs, { partId: 'a' }, [-3, 0, 0])).toBeUndefined();
    expect(connectorAtPoint(pairs, { partId: 'a' }, [-9, -5, 0])).toBeUndefined();
    expect(connectorAtPoint(pairs, { partId: 'a' }, [1, -5, 0])).toBeUndefined();
    expect(connectorAtPoint(pairs, { partId: 'c' }, [-3, -5, 0])).toBeUndefined();
  });
  it('is forgiving by three percent of the diameter at the edge of a pin, and no more', () => {
    // radius 2 + 0.2 clearance + 0.12 padding
    expect(connectorAtPoint(pairs, { partId: 'a' }, [-3, -5 + 2.3, 0])).toBe(first);
    expect(connectorAtPoint(pairs, { partId: 'a' }, [-3, -5 + 2.4, 0])).toBeUndefined();
  });
  it('names nothing when two connectors both claim the point', () => {
    const crowded = connectorPairsOf([
      joint({
        connector: {
          maleSide: 'A',
          axis: [-1, 0, 0],
          mmPerSceneUnit: 1,
          pins: [
            {
              pinId: 'pin-1',
              u: 0,
              v: 0,
              center: [0, 0, 0],
              diameterMm: 4,
              depthMm: 6,
              clearanceMm: 0.2,
            },
            {
              pinId: 'pin-2',
              u: 0,
              v: 0.5,
              center: [0, 0.5, 0],
              diameterMm: 4,
              depthMm: 6,
              clearanceMm: 0.2,
            },
          ],
        },
      }),
    ]);
    expect(connectorAtPoint(crowded, { partId: 'a' }, [-3, 0.25, 0])).toBeUndefined();
  });
});
