import { MAX_SUPPORTED_SPLIT_TRIANGLES, type CanonicalMesh } from '@cadfixer/mesh-core';
import { MAX_TEXTURE_PRIMITIVE_TRIANGLES } from './surface-texture';

/**
 * THE MANIFOLD INPUT BUDGET, DERIVED FROM THE SPLIT CEILING AND THE REAL ESTIMATOR.
 *
 * The kernel receives each operand as Float64 positions plus Uint32 indices (the worker widens the
 * canonical Float32 positions, and recovers exact-coordinate sharing without welding). That copy is
 * what this budget bounds, and `booleanKernelInputBytes` is the SAME expression the backend used when
 * the budget was a flat 128 MiB: `(positions) * 8 + (index bytes)`, over both operands.
 *
 * Per triangle of an unshared (STL-soup) operand that is 9 Float64 corner coordinates + 3 Uint32
 * indices = 84 bytes. An indexed operand costs less, never more.
 *
 * `MAX_BOOLEAN_INPUT_BYTES` is therefore not a number someone chose; it is
 *
 *     (MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES) * 84
 *
 * — the biggest operand a split may hand the kernel, plus the biggest TOOL any caller pairs it with.
 * The tool term is not slack: a plane split intersects the part with a 12-triangle half-space, so a
 * budget of exactly `2,000,000 * 84` would refuse the very part the ceiling admits. The largest tool
 * any caller builds is a surface-texture primitive set.
 *
 * What this does NOT do: raise the per-input TRIANGLE ceiling (the adapter still refuses an operand
 * above `MAX_SUPPORTED_SPLIT_TRIANGLES`), the topology-workspace limit, the output-triangle limit or
 * the canonical-byte limit. Each of those fires independently.
 */
export const BOOLEAN_KERNEL_BYTES_PER_TRIANGLE = 3 * 3 * 8 + 3 * 4;

/** The largest tool operand any caller pairs with a part: a surface-texture primitive set. */
export const MAX_BOOLEAN_TOOL_TRIANGLES = MAX_TEXTURE_PRIMITIVE_TRIANGLES;

export const MAX_BOOLEAN_INPUT_BYTES =
  (MAX_SUPPORTED_SPLIT_TRIANGLES + MAX_BOOLEAN_TOOL_TRIANGLES) * BOOLEAN_KERNEL_BYTES_PER_TRIANGLE;

/** Bytes the kernel's input copy of both operands occupies. The backend's own estimator, unchanged. */
export function booleanKernelInputBytes(
  a: Pick<CanonicalMesh, 'positions' | 'indices'>,
  b: Pick<CanonicalMesh, 'positions' | 'indices'>,
): number {
  return (
    (a.positions.length + b.positions.length) * 8 + a.indices.byteLength + b.indices.byteLength
  );
}
