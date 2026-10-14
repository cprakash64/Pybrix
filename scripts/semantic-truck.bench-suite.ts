import { required } from '@cadfixer/auto-split/fixtures';
import { SEMANTIC_TRUCK_ANSWER } from '@cadfixer/auto-split/fixtures';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { createPositionArray, createIndexArray } from '@cadfixer/mesh-core';
import { prepareSemanticGeometry, decomposeSemantic, rasteriseView } from '@cadfixer/auto-split';
import { VIEW_NAMES } from '@cadfixer/auto-split-contract';
it('records fresh read-only truck component, projection, request and phase evidence', async () => {
  const file = '/Users/cprakash/Downloads/Hitem3d-1785766060812.stl',
    bytes = readFileSync(file),
    sha = createHash('sha256').update(bytes).digest('hex');
  expect(sha).toBe('3b9d3aaa3523f75c8e1a079e3aa3e50086d0f2cf9c5abbf78b8790df0a143e73');
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    n = d.getUint32(80, true);
  expect(n).toBe(1988877);
  const positions = createPositionArray(n * 9),
    indices = createIndexArray(n * 3);
  for (let f = 0; f < n; f++) {
    for (let k = 0; k < 9; k++) positions[f * 9 + k] = d.getFloat32(84 + f * 50 + 12 + k * 4, true);
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = f * 3 + k;
  }
  const rssBefore = process.memoryUsage().rss;
  const prepared = await prepareSemanticGeometry({ positions, indices, metadata: {} }, (raw) =>
    Promise.resolve(new Uint8Array(deflateSync(raw))),
  );
  const root = 'artifacts/semantic-auto-decompose-01';
  const viewEquality = prepared.rasters.map((raster) => {
    const prior = rasteriseView(prepared.geometry, raster.view);
    let differences = 0;
    for (let pixel = 0; pixel < prior.face.length; pixel++)
      if (prior.face[pixel] !== raster.face[pixel]) differences++;
    return { view: raster.view, differences };
  });
  expect(viewEquality.every((v) => v.differences === 0)).toBe(true);
  writeFileSync(
    `${root}/raster-equivalence.json`,
    JSON.stringify({ viewEquality, timings: prepared.timings }, null, 2),
  );
  const decomposition = decomposeSemantic(prepared, SEMANTIC_TRUCK_ANSWER);
  writeFileSync(
    `${root}/truck-semantic.json`,
    JSON.stringify({ answer: SEMANTIC_TRUCK_ANSWER, ...decomposition }, null, 2),
  );
  expect(decomposition.suggestions.find((s) => s.id === 'bed')?.operation).toBe('PLANE');
  expect(decomposition.suggestions.find((s) => s.id === 'cabin')?.operation).toBe('PLANE');
  expect(
    decomposition.suggestions
      .filter((s) => s.id.startsWith('wheel'))
      .every((s) => s.operation === 'NONE'),
  ).toBe(true);
  prepared.pngs.forEach((b, i) => {
    writeFileSync(`${root}/truck-${String(VIEW_NAMES[i])}.png`, b);
  });
  prepared.componentPngs.forEach((b, i) => {
    writeFileSync(`${root}/truck-components-${String(VIEW_NAMES[i])}.png`, b);
  });
  const inventory = prepared.metadata.components.map((c) => {
    const rank = Number(c.id.slice(1));
    const projected = prepared.rasters.map((r) => {
      let x0 = r.size,
        y0 = r.size,
        x1 = -1,
        y1 = -1,
        pixels = 0;
      for (let i = 0; i < r.face.length; i++) {
        const f = required(r.face[i], 'r.face[i]');
        if (f < 0 || prepared.labelling.faceRank[f] !== rank) continue;
        const x = i % r.size,
          y = Math.floor(i / r.size);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        pixels++;
      }
      return {
        view: r.view,
        visiblePixels: pixels,
        box: pixels ? [x0 / r.size, y0 / r.size, (x1 + 1) / r.size, (y1 + 1) / r.size] : null,
      };
    });
    return {
      ...c,
      projected,
      association:
        rank === 0
          ? 'dominant fused body including visible cabin, rear assembly and wheels'
          : 'small residual geometry; semantic association unproven',
    };
  });
  const features = [
    {
      label: 'Front left wheel',
      samples: [
        ['left', 0.622, 0.291],
        ['top', 0.33, 0.64],
      ],
    },
    {
      label: 'Front right wheel',
      samples: [
        ['right', 0.378, 0.291],
        ['top', 0.67, 0.64],
      ],
    },
    {
      label: 'Rear left wheel',
      samples: [
        ['left', 0.622, 0.707],
        ['bottom', 0.33, 0.365],
      ],
    },
    {
      label: 'Rear right wheel',
      samples: [
        ['right', 0.378, 0.707],
        ['bottom', 0.67, 0.365],
      ],
    },
    { label: 'Left door relief', samples: [['left', 0.38, 0.339]] },
    { label: 'Right door relief', samples: [['right', 0.62, 0.339]] },
  ].map((feature) => ({
    label: feature.label,
    samples: feature.samples.map((sample) => {
      const view = sample[0] as (typeof VIEW_NAMES)[number],
        x = sample[1] as number,
        y = sample[2] as number,
        raster = required(
          prepared.rasters[VIEW_NAMES.indexOf(view)],
          'prepared.rasters[VIEW_NAMES.indexOf(view)]',
        ),
        face = required(
          raster.face[Math.floor(y * raster.size) * raster.size + Math.floor(x * raster.size)],
          'raster.face[Math.floor(y * raster.size) * raster.size + Math.flo',
        );
      expect(face, feature.label).toBeGreaterThanOrEqual(0);
      const component = required(
        prepared.labelling.faceRank[face],
        'prepared.labelling.faceRank[face]',
      );
      expect(component, feature.label).toBe(0);
      return {
        view,
        imagePoint: [x, y],
        sourceFace: face,
        componentId: required(
          prepared.metadata.components[component],
          'prepared.metadata.components[component]',
        ).id,
      };
    }),
    classification:
      'Visible feature connected to the dominant body shell; no independent component or supported local boundary',
  }));
  writeFileSync(
    `${root}/truck-feature-audit.json`,
    JSON.stringify(
      {
        sourceSha: sha,
        features,
        doorFinding:
          'Visible outlined relief on the shared cabin exterior (D-like). No independent shell/group or independent backside/thickness is established; bounded solid-door isolation is unproven, so no door candidate executes.',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    `${root}/truck-inventory.json`,
    JSON.stringify(
      {
        sourceSha: sha,
        faces: n,
        componentCount: prepared.labelling.count,
        inventory,
        cameras: prepared.cameras,
        timings: prepared.timings,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        maxRss: process.resourceUsage().maxRSS * 1024,
      },
      null,
      2,
    ),
  );
  expect(prepared.metadata.components).toHaveLength(prepared.labelling.count);
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sha);
}, 600000);
