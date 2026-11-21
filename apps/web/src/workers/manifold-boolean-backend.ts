/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await, @typescript-eslint/restrict-template-expressions */
import { createIndexArray, createPositionArray, triangleCount } from '@cadfixer/mesh-core';
import { resourceLimitExceeded, throwIfCancelled } from '@cadfixer/shared';
import {
  booleanKernelInputBytes,
  MAX_BOOLEAN_INPUT_BYTES,
  type BooleanBackend,
} from '@cadfixer/geometry-runtime';
import createManifoldCandidate from './third-party/manifold/manifold-candidate.js';
import { indexExactCoordinates } from './exact-index';

interface Module {
  HEAPF64: Float64Array;
  HEAPU32: Uint32Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _cf_boolean(
    op: number,
    ap: number,
    av: number,
    ai: number,
    at: number,
    bp: number,
    bv: number,
    bi: number,
    bt: number,
  ): number;
  _cf_vertex_count(): number;
  _cf_triangle_count(): number;
  _cf_positions(): number;
  _cf_triangles(): number;
  _cf_reset(): void;
}
const MAX_OUTPUT_TRIANGLES = 5_000_000;
/** The checked-in artifact is built from pinned Manifold 11235e6 and its Apache-2.0 license. */
export async function createManifoldBooleanBackend(
  wasmBinary?: ArrayBuffer | Uint8Array,
  hooks: {
    readonly onInitialized?: () => void;
    readonly onEnter?: () => void;
    readonly onReturn?: () => void;
  } = {},
): Promise<BooleanBackend> {
  const mod: Module = await createManifoldCandidate(wasmBinary === undefined ? {} : { wasmBinary });
  hooks.onInitialized?.();
  return {
    async operate(kind, a, b, cancellation) {
      throwIfCancelled(cancellation);
      // The budget is derived from the shared split ceiling and this very estimator: see boolean-limits.ts.
      const inputBytes = booleanKernelInputBytes(a, b);
      if (inputBytes > MAX_BOOLEAN_INPUT_BYTES)
        throw resourceLimitExceeded(
          `Manifold input bytes are ${inputBytes}; limit is ${MAX_BOOLEAN_INPUT_BYTES}.`,
          { metric: 'inputBytes', observed: inputBytes, limit: MAX_BOOLEAN_INPUT_BYTES },
        );
      // Manifold requires an indexed closed surface. STL soup uses a distinct storage index per
      // corner, so recover only EXACT stored-coordinate identity. No epsilon welding or repair.
      const ia = indexExactCoordinates(a),
        ib = indexExactCoordinates(b);
      const allocated: number[] = [];
      const pos = (values: Float64Array): number => {
        const p = mod._malloc(values.byteLength);
        if (!p) throw new Error('Manifold could not allocate position input.');
        allocated.push(p);
        mod.HEAPF64.set(values, p / 8);
        return p;
      };
      const idx = (values: Uint32Array): number => {
        const p = mod._malloc(values.byteLength);
        if (!p) throw new Error('Manifold could not allocate index input.');
        allocated.push(p);
        mod.HEAPU32.set(values, p / 4);
        return p;
      };
      try {
        const ap = pos(ia.positions),
          ai = idx(ia.indices),
          bp = pos(ib.positions),
          bi = idx(ib.indices);
        throwIfCancelled(cancellation);
        const code = kind === 'union' ? 0 : kind === 'difference' ? 1 : 2;
        hooks.onEnter?.();
        const status = mod._cf_boolean(
          code,
          ap,
          ia.positions.length / 3,
          ai,
          triangleCount(a),
          bp,
          ib.positions.length / 3,
          bi,
          triangleCount(b),
        );
        hooks.onReturn?.();
        throwIfCancelled(cancellation);
        if (status !== 0) throw new Error(`Manifold refused ${kind} with status ${status}.`);
        const vertices = mod._cf_vertex_count(),
          triangles = mod._cf_triangle_count();
        if (
          !Number.isSafeInteger(vertices) ||
          !Number.isSafeInteger(triangles) ||
          vertices < 1 ||
          triangles < 1 ||
          triangles > MAX_OUTPUT_TRIANGLES ||
          vertices > 15_000_000
        )
          throw resourceLimitExceeded(
            `Manifold output triangles are ${triangles}; limit is ${MAX_OUTPUT_TRIANGLES}.`,
            { metric: 'triangles', observed: triangles, limit: MAX_OUTPUT_TRIANGLES },
          );
        const p = mod._cf_positions(),
          i = mod._cf_triangles();
        const positions = createPositionArray(vertices * 3),
          indices = createIndexArray(triangles * 3);
        for (let at = 0; at < positions.length; at++)
          positions[at] = mod.HEAPF64[p / 8 + at] ?? NaN;
        indices.set(mod.HEAPU32.subarray(i / 4, i / 4 + indices.length));
        return { positions, indices, metadata: {} };
      } finally {
        for (const p of allocated) mod._free(p);
        mod._cf_reset();
      }
    },
  };
}
