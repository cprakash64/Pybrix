import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createPositionArray, createIndexArray, type CanonicalMesh } from '@cadfixer/mesh-core';
import { splitMeshSHA } from '../packages/geometry-runtime/src/split-source-identity';
it.each([0, 1, 15, 16, 17, 55, 56, 63, 64, 65, 1000])(
  'streaming mesh SHA matches independent Node SHA at %s vertices',
  (vertices) => {
    const positions = createPositionArray(vertices * 3),
      indices = createIndexArray(vertices);
    for (let i = 0; i < positions.length; i++) positions[i] = i / 7;
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    const mesh = { positions, indices, metadata: {} } as CanonicalMesh;
    const reference = createHash('sha256')
      .update(new Uint8Array(positions.buffer))
      .update(new Uint8Array(indices.buffer))
      .digest('hex');
    expect(splitMeshSHA(mesh)).toBe(reference);
  },
);
