import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createIndexArray, createPositionArray } from '@cadfixer/mesh-core';
import { VIEW_NAMES, validateVehicle } from '@cadfixer/auto-split-contract';
import { normalizeGeometry, faceFacts, rasteriseView, suggestFor } from '@cadfixer/auto-split';
it('builds a bounded, explicitly annotated mock answer for the actual truck orientation', () => {
  const b = readFileSync(
      process.env.OPEN_MESH_TRUCK_PATH ?? join(homedir(), 'Downloads', 'Hitem3d-1785766060812.stl'),
    ),
    d = new DataView(b.buffer, b.byteOffset, b.byteLength),
    n = d.getUint32(80, true),
    positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++) positions[f * 9 + k] = d.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  const mesh = { positions, indices, metadata: {} },
    geometry = normalizeGeometry(positions, indices),
    facts = faceFacts(geometry);
  const owns = (face: number, region: 'cab' | 'bed' | 'body'): boolean => {
    const y = facts.centroids[face * 3 + 1] ?? 0,
      z = facts.centroids[face * 3 + 2] ?? 0;
    return region === 'body' || (y > -0.15 && (region === 'cab' ? z > 0.05 : z < -0.05));
  };
  const rasters = VIEW_NAMES.map((view) => rasteriseView(geometry, view));
  const slot = (region: 'cab' | 'bed' | 'body'): Record<string, unknown> => ({
    status: 'PRESENT',
    center: [0, 0.05, region === 'cab' ? 0.25 : region === 'bed' ? -0.25 : 0],
    extent: [0.57, 0.59, region === 'body' ? 1 : 0.5],
    views: rasters.map((r) => {
      let x0 = r.size,
        y0 = r.size,
        x1 = -1,
        y1 = -1;
      for (let y = 0; y < r.size; y++)
        for (let x = 0; x < r.size; x++) {
          const f = r.face[y * r.size + x] ?? -1;
          if (f < 0 || !owns(f, region)) continue;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      return {
        view: r.view,
        visibility: x1 === -1 ? 'not_visible' : 'visible',
        box: x1 === -1 ? null : [x0 / r.size, y0 / r.size, (x1 + 1) / r.size, (y1 + 1) / r.size],
      };
    }),
  });
  const answer = {
    vehicle: { kind: 'truck', forward_direction: '+Z', up_direction: '+Y' },
    parts: { cab: slot('cab'), cargo_or_bed: slot('bed'), chassis_or_main_body: slot('body') },
    wheels: [],
    cab_bed_boundary: {
      status: 'PRESENT',
      segments: VIEW_NAMES.map((view) => ({ view, segment: null })),
      plane_normal: [0, 0, -1],
      plane_offset: 0,
    },
  };
  const checked = validateVehicle(answer);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw Error('answer');
  const result = suggestFor(mesh, { mode: 'vehicle', vehicle: checked.value });
  writeFileSync(
    'artifacts/open-mesh-split-01/annotated-vehicle-answer.json',
    JSON.stringify(answer, null, 2),
  );
  writeFileSync(
    'artifacts/open-mesh-split-01/annotated-vehicle-suggestions.json',
    JSON.stringify(result, null, 2),
  );
  expect(result.suggestions.some((s) => s.id === 'cab_bed')).toBe(true);
}, 600_000);
