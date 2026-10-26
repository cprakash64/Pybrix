import type { SourceInterfacePlaneInventory } from './semantic-ownership-completeness';
import { it, expect } from 'vitest';
import type { NormalizedGeometry } from './geometry';
import {
  inventorySourceInterfacePlanes,
  ownershipCompleteness,
  resolveOwnershipInterface,
  exhaustiveOwnershipPublication,
  type OwnershipInterfaceResolution,
} from './semantic-ownership-completeness';
const row = (
  offset: number,
  resolution: OwnershipInterfaceResolution['resolution'],
): OwnershipInterfaceResolution => ({ offset, faces: 1, resolution });
const geometry = (offsets: readonly number[]): NormalizedGeometry => ({
  positions: Float32Array.from(offsets.flatMap((x) => [x, 0, 0, x, 0, 1, x, 1, 0])),
  indices: Uint32Array.from({ length: offsets.length * 3 }, (_, i) => i),
  faceCount: offsets.length,
  center: [0, 0, 0],
  scale: 1,
  radius: 30,
  extents: [60, 1, 1],
});
const inventory = (
  offsets: readonly number[],
  ranks = offsets.map(() => 0),
): SourceInterfacePlaneInventory =>
  inventorySourceInterfacePlanes(
    geometry(offsets),
    [1, 0, 0],
    -1,
    ranks,
    0,
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
it('one represented unresolved dimension can authorize two exhaustive classes', () => {
  const i = inventory([-3, 0, 3]);
  expect(i.groups.map((r) => r.offset)).toEqual([0]);
  const c = ownershipCompleteness([
    row(0, resolveOwnershipInterface('AMBIGUOUS', false, false, true, true)),
  ]);
  expect(c).toMatchObject({
    state: 'INCOMPLETE_UNRESOLVED',
    inventoryComplete: true,
    semanticComplete: false,
    representedUnresolved: 1,
  });
  expect(exhaustiveOwnershipPublication(c, 2, false)).toBe(true);
});
it('upstream unknown remains inventoried even when every cut excludes it', () => {
  expect(inventory([-3, -1, 1, 3]).groups.map((r) => r.offset)).toEqual([-1, 1]);
  const c = ownershipCompleteness([
    row(-1, resolveOwnershipInterface('AMBIGUOUS', false, false, false, true)),
    row(1, 'REPRESENTED_UNRESOLVED'),
  ]);
  expect(c.state).toBe('INCOMPLETE_UNRESOLVED');
  expect(c.unrepresentedUnresolved).toBe(1);
});
it('two invariant upstream unknown dimensions both block completeness', () => {
  const c = ownershipCompleteness([
    row(-2, 'UNREPRESENTED_UNRESOLVED'),
    row(-1, 'UNREPRESENTED_UNRESOLVED'),
    row(1, 'REPRESENTED_UNRESOLVED'),
  ]);
  expect(c.inventoried).toBe(3);
  expect(c.unrepresentedUnresolved).toBe(2);
  expect(c.state).toBe('INCOMPLETE_UNRESOLVED');
});
it('downstream invariance alone is insufficient but established positive irrelevance is accepted', () => {
  expect(resolveOwnershipInterface('AMBIGUOUS', false, false, true, false)).toBe(
    'UNREPRESENTED_UNRESOLVED',
  );
  const c = ownershipCompleteness([
    row(0, 'REPRESENTED_UNRESOLVED'),
    row(1, resolveOwnershipInterface('AMBIGUOUS', false, true, true, false)),
  ]);
  expect(c.provenIrrelevant).toBe(1);
  expect(c).toMatchObject({
    state: 'INCOMPLETE_UNRESOLVED',
    inventoryComplete: true,
    semanticComplete: false,
    representedUnresolved: 1,
  });
});
it('positive target evidence resolves an invariant relevant row', () => {
  const c = ownershipCompleteness([
    row(0, resolveOwnershipInterface('TARGET_SIDE', false, false, true, false)),
  ]);
  expect(c.resolvedTarget).toBe(1);
  expect(exhaustiveOwnershipPublication(c, 1, true)).toBe(true);
});
it('positive body evidence resolves a row while absent observation does not', () => {
  expect(resolveOwnershipInterface('AMBIGUOUS', false, false, false, true)).toBe(
    'UNREPRESENTED_UNRESOLVED',
  );
  const c = ownershipCompleteness([
    row(0, resolveOwnershipInterface('BODY_SIDE', false, false, false, true)),
  ]);
  expect(c.resolvedBody).toBe(1);
  expect(c.state).toBe('COMPLETE');
});
it('disconnected coplanar unrelated source component cannot add an inventory row', () => {
  const i = inventory([-3, 0, 1, 3], [0, 0, 1, 0]);
  expect(i.valid).toBe(true);
  expect(i.groups.map((r) => r.offset)).toEqual([0]);
});
it('true nonplanar crease cannot be certified as a same-plane interface', () => {
  const g = geometry([-3, 0, 3]);
  g.positions[12] = 0.01;
  const i = inventorySourceInterfacePlanes(
    g,
    [1, 0, 0],
    -1,
    [0, 0, 0],
    0,
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
    (): void => {
      // Intentionally empty hook; preserve the undefined return value.
    },
  );
  expect(i.valid).toBe(false);
  expect(i.reason).toBe('NONPLANAR_SOURCE_INTERFACE');
  expect(ownershipCompleteness([], i.reason).state).toBe('INCOMPLETE_UNRESOLVED');
});
it('inventory exhaustion refuses at the existing sixteen-plane bound', () => {
  const i = inventory([-20, ...Array.from({ length: 17 }, (_, i) => i - 8), 20]);
  expect(i.valid).toBe(false);
  expect(i.groups).toHaveLength(16);
  const c = ownershipCompleteness([], i.reason);
  expect(c.reason).toBe('INTERFACE_FEATURE_CAP');
  expect(exhaustiveOwnershipPublication(c, 2, false)).toBe(false);
});
it('inventory cancellation aborts with original source byte-identical', () => {
  const g = geometry([-3, 0, 3]),
    positions = g.positions.slice(),
    indices = g.indices.slice();
  let calls = 0;
  expect(() =>
    inventorySourceInterfacePlanes(
      g,
      [1, 0, 0],
      -1,
      [0, 0, 0],
      0,
      () => {
        if (++calls === 2) throw Error('cancelled');
      },
      (): void => {
        // Intentionally empty hook; preserve the undefined return value.
      },
    ),
  ).toThrow('cancelled');
  expect(g.positions).toEqual(positions);
  expect(g.indices).toEqual(indices);
});
it('two discovered keys cannot authorize confirmation with another unresolved dimension', () => {
  const c = ownershipCompleteness([
    row(0, 'REPRESENTED_UNRESOLVED'),
    row(-1, 'UNREPRESENTED_UNRESOLVED'),
  ]);
  expect(exhaustiveOwnershipPublication(c, 2, false)).toBe(false);
});
it('one identified key cannot authorize AUTO with another unresolved dimension or conflict', () => {
  const c = ownershipCompleteness([
    row(0, 'POSITIVELY_TARGET_OWNED'),
    row(-1, 'UNREPRESENTED_UNRESOLVED'),
  ]);
  expect(exhaustiveOwnershipPublication(c, 1, true)).toBe(false);
  const conflict = ownershipCompleteness([
    row(0, resolveOwnershipInterface('AMBIGUOUS', true, true, true, true)),
  ]);
  expect(conflict.state).toBe('INCOMPLETE_CONFLICTED');
  expect(exhaustiveOwnershipPublication(conflict, 1, true)).toBe(false);
});
