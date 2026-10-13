import { VIEW_NAMES, type Box4, type Vec3, type ViewName } from '@cadfixer/auto-split-contract';
import type { CanonicalMesh } from '@cadfixer/mesh-core';
import { faceFacts, normalizeGeometry, type FaceFacts, type NormalizedGeometry } from '../index';
import { rasteriseView, type Raster } from '../raster';
import {
  CAR,
  CAR_FRAME,
  CAR_FUSED,
  carFused,
  carMultipart,
  FIGURE_CELLS,
  FIGURE_FRAME,
  TRUCK,
  TRUCK_FRAME,
  truckFused,
  humanFigure,
} from './models';
import { OPEN_TRUCK_ANSWER } from './open-truck-answer';
import { required } from '../required';

/**
 * SYNTHETIC SEMANTIC ANSWERS for the test models: what a provider would say about each, built from the
 * model's own geometry (its visible boxes in the same six renders a provider would read) and from the
 * truth recorded beside each model. A scenario is a PROVIDER FIXTURE: it makes the product's behaviour
 * deterministic and says nothing whatever about how accurate a real provider is.
 *
 * Answers are returned in the provider's schema shape (snake_case), exactly what the service validates.
 */
export const SCENARIOS = [
  'human-ok',
  'human-missing-arm',
  'human-unsupported',
  'vehicle-component',
  'vehicle-ambiguous-wheel',
  'vehicle-truck-plane',
  'vehicle-open-truck',
  'vehicle-wheels-fused',
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export const SCENARIO_MODE: Readonly<Record<ScenarioName, 'human' | 'vehicle'>> = {
  'human-ok': 'human',
  'human-missing-arm': 'human',
  'human-unsupported': 'human',
  'vehicle-component': 'vehicle',
  'vehicle-ambiguous-wheel': 'vehicle',
  'vehicle-truck-plane': 'vehicle',
  'vehicle-open-truck': 'vehicle',
  'vehicle-wheels-fused': 'vehicle',
};

const normPoint = (p: Vec3, frame: { center: readonly number[]; scale: number }): Vec3 => [
  (p[0] - (frame.center[0] ?? 0)) / frame.scale,
  (p[1] - (frame.center[1] ?? 0)) / frame.scale,
  (p[2] - (frame.center[2] ?? 0)) / frame.scale,
];

interface Region {
  readonly lo: Vec3;
  readonly hi: Vec3;
}

const centreOf = (r: Region, frame: { center: readonly number[]; scale: number }): Vec3 =>
  normPoint([(r.lo[0] + r.hi[0]) / 2, (r.lo[1] + r.hi[1]) / 2, (r.lo[2] + r.hi[2]) / 2], frame);
const extentOf = (r: Region, scale: number): Vec3 => [
  (r.hi[0] - r.lo[0]) / scale,
  (r.hi[1] - r.lo[1]) / scale,
  (r.hi[2] - r.lo[2]) / scale,
];

// ---- human -------------------------------------------------------------------------------

function humanPart(
  status: 'PRESENT' | 'UNCERTAIN' | 'ABSENT',
  region: Region | null,
  normal: Vec3 | null,
  offsetCells: number | null,
  frameScale: number,
  frame: { center: readonly number[]; scale: number },
): Record<string, unknown> {
  return {
    status,
    center: region === null ? null : centreOf(region, frame),
    extent: region === null ? null : extentOf(region, frameScale),
    plane_normal: normal,
    plane_offset: offsetCells === null ? null : offsetCells / frameScale,
  };
}

/** The model's answer for the blocky figure. The planes are a little off on purpose: the model estimates. */
export function humanScenario(
  name: 'human-ok' | 'human-missing-arm' | 'human-unsupported',
): Record<string, unknown> {
  const frame = FIGURE_FRAME;
  const f = FIGURE_CELLS;
  if (name === 'human-unsupported')
    return {
      figure: { kind: 'other_object' },
      parts: {
        head: humanPart('ABSENT', null, null, null, frame.scale, frame),
        left_arm: humanPart('ABSENT', null, null, null, frame.scale, frame),
        right_arm: humanPart('ABSENT', null, null, null, frame.scale, frame),
      },
    };
  return {
    figure: { kind: 'humanoid_figure' },
    parts: {
      // The neck is at z 24..26; the model puts the plane at z = 25.3 (half a cell off) and slightly leaning.
      head: humanPart(
        'PRESENT',
        f.head,
        [0, 0.03, 0.9995],
        (25.3 - frame.center[2]) * 0.9995,
        frame.scale,
        frame,
      ),
      left_arm: humanPart('UNCERTAIN', f.leftArm, [1, 0, 0], 6.2, frame.scale, frame),
      right_arm:
        name === 'human-missing-arm'
          ? humanPart('ABSENT', null, null, null, frame.scale, frame)
          : humanPart('PRESENT', f.rightArm, [-1, 0, 0], 6.2, frame.scale, frame),
    },
  };
}

// ---- vehicles ----------------------------------------------------------------------------

interface Rendered {
  readonly geometry: NormalizedGeometry;
  readonly facts: FaceFacts;
  readonly rasters: ReadonlyMap<ViewName, Raster>;
}

function render(mesh: CanonicalMesh): Rendered {
  const geometry = normalizeGeometry(mesh.positions, mesh.indices);
  return {
    geometry,
    facts: faceFacts(geometry),
    rasters: new Map(VIEW_NAMES.map((v) => [v, rasteriseView(geometry, v)] as const)),
  };
}

/** The bounding box of the pixels a face set owns in one view, normalized, or null when it is barely seen. */
function visibleBox(raster: Raster, owns: (face: number) => boolean): Box4 | null {
  const { size, face } = raster;
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const t = face[y * size + x] ?? -1;
      if (t < 0 || !owns(t)) continue;
      count += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return count < 80 ? null : [x0 / size, y0 / size, (x1 + 1) / size, (y1 + 1) / size];
}

function grow(box: Box4, share: number): Box4 {
  const g = share * Math.hypot(box[2] - box[0], box[3] - box[1]);
  return [
    Math.max(0, box[0] - g),
    Math.max(0, box[1] - g),
    Math.min(1, box[2] + g),
    Math.min(1, box[3] + g),
  ];
}

function viewList(
  rendered: Rendered,
  owns: (face: number) => boolean,
  inflate = 0,
): { view: ViewName; visibility: 'visible' | 'not_visible'; box: Box4 | null }[] {
  return VIEW_NAMES.map((view) => {
    const raster = required(rendered.rasters.get(view), 'raster');
    const box = visibleBox(raster, owns);
    return box === null
      ? { view, visibility: 'not_visible' as const, box: null }
      : { view, visibility: 'visible' as const, box: inflate > 0 ? grow(box, inflate) : box };
  });
}

function absentViews(): { view: ViewName; visibility: 'not_visible'; box: null }[] {
  return VIEW_NAMES.map((view) => ({ view, visibility: 'not_visible' as const, box: null }));
}

function slot(
  status: 'PRESENT' | 'ABSENT',
  region: Region | null,
  frame: { center: readonly number[]; scale: number },
  views: ReturnType<typeof viewList> | ReturnType<typeof absentViews>,
): Record<string, unknown> {
  return {
    status,
    center: region === null ? null : centreOf(region, frame),
    extent: region === null ? null : extentOf(region, frame.scale),
    views,
  };
}

function wheelEntry(
  id: number,
  region: Region,
  frame: { center: readonly number[]; scale: number },
  views: ReturnType<typeof viewList>,
  side: 'subject_left' | 'subject_right',
  longitudinal: 'front' | 'rear',
): Record<string, unknown> {
  return {
    semantic_id: `wheel_${String(id)}`,
    grouping: 'single_wheel',
    side,
    longitudinal,
    center: centreOf(region, frame),
    extent: extentOf(region, frame.scale),
    views,
  };
}

const wheelRegion = (cx: number, y0: number, y1: number, r: number, cz: number): Region => ({
  lo: [cx - r, y0, cz - r],
  hi: [cx + r, y1, cz + r],
});

const inRegion =
  (rendered: Rendered, r: Region, margin = 0.01) =>
  (face: number): boolean => {
    const c = rendered.facts.centroids;
    const s = rendered.geometry.scale;
    const x = (c[face * 3] ?? 0) * s + rendered.geometry.center[0];
    const y = (c[face * 3 + 1] ?? 0) * s + rendered.geometry.center[1];
    const z = (c[face * 3 + 2] ?? 0) * s + rendered.geometry.center[2];
    return (
      x >= r.lo[0] - margin &&
      x <= r.hi[0] + margin &&
      y >= r.lo[1] - margin &&
      y <= r.hi[1] + margin &&
      z >= r.lo[2] - margin &&
      z <= r.hi[2] + margin
    );
  };

/** The model's answer for the car: a body and four separate wheels. */
export function carScenario(inflate = 0): Record<string, unknown> {
  const rendered = render(carMultipart().mesh);
  const frame = CAR_FRAME;
  const bodyRegion: Region = CAR.body;
  const bodyOwns = (f: number): boolean =>
    !CAR.wheels.some((w) =>
      inRegion(rendered, wheelRegion(w.cx, w.y0, w.y1, CAR.radius, CAR.centreZ), 0.02)(f),
    );
  const wheels = CAR.wheels.map((w, i) => {
    const region = wheelRegion(w.cx, w.y0, w.y1, CAR.radius, CAR.centreZ);
    return wheelEntry(
      i + 1,
      region,
      frame,
      viewList(rendered, inRegion(rendered, region, 0.02), inflate),
      w.name.endsWith('left') ? 'subject_left' : 'subject_right',
      w.name.startsWith('front') ? 'front' : 'rear',
    );
  });
  return {
    vehicle: { kind: 'car', forward_direction: '+X', up_direction: '+Z' },
    parts: {
      cab: slot('ABSENT', null, frame, absentViews()),
      cargo_or_bed: slot('ABSENT', null, frame, absentViews()),
      chassis_or_main_body: slot(
        'PRESENT',
        bodyRegion,
        frame,
        viewList(rendered, bodyOwns, inflate),
      ),
    },
    wheels,
    cab_bed_boundary: {
      status: 'ABSENT',
      segments: VIEW_NAMES.map((view) => ({ view, segment: null })),
      plane_normal: null,
      plane_offset: null,
    },
  };
}

/** The model's answer for the fused truck: cab, bed and body in one shell, and four separate wheels. */
export function truckScenario(withWheels = true): Record<string, unknown> {
  const rendered = render(truckFused().mesh);
  const frame = TRUCK_FRAME;
  const wheelRegions = TRUCK.wheels.map((w) =>
    wheelRegion(w.cx, w.y0, w.y1, TRUCK.radius, TRUCK.centreZ),
  );
  const isWheel = (f: number): boolean => wheelRegions.some((r) => inRegion(rendered, r, 0.02)(f));
  const cabRegion: Region = TRUCK.cab;
  const bedRegion: Region = { lo: [-30, -8, 4], hi: [TRUCK.joinX, 8, 14] };
  const cabOwns = (f: number): boolean =>
    !isWheel(f) &&
    inRegion(rendered, cabRegion, 0.01)(f) &&
    (rendered.facts.centroids[f * 3 + 2] ?? 0) * rendered.geometry.scale +
      rendered.geometry.center[2] >=
      14 - 0.01;
  const bedOwns = (f: number): boolean => {
    if (isWheel(f)) return false;
    const x =
      (rendered.facts.centroids[f * 3] ?? 0) * rendered.geometry.scale +
      rendered.geometry.center[0];
    return x < TRUCK.joinX;
  };
  const bodyOwns = (f: number): boolean => !isWheel(f);
  const wheels = withWheels
    ? TRUCK.wheels.map((w, i) =>
        wheelEntry(
          i + 1,
          required(wheelRegions[i], 'wheel region'),
          frame,
          viewList(rendered, inRegion(rendered, required(wheelRegions[i], 'wheel region'), 0.02)),
          w.name.endsWith('left') ? 'subject_left' : 'subject_right',
          w.name.startsWith('front') ? 'front' : 'rear',
        ),
      )
    : [];
  return {
    vehicle: { kind: 'truck', forward_direction: '+X', up_direction: '+Z' },
    parts: {
      cab: slot('PRESENT', cabRegion, frame, viewList(rendered, cabOwns)),
      cargo_or_bed: slot('PRESENT', bedRegion, frame, viewList(rendered, bedOwns)),
      chassis_or_main_body: slot(
        'PRESENT',
        { lo: [-30, -8, 4], hi: [30, 8, 26] },
        frame,
        viewList(rendered, bodyOwns),
      ),
    },
    wheels,
    cab_bed_boundary: {
      status: 'PRESENT',
      segments: VIEW_NAMES.map((view) => ({ view, segment: null })),
      // From the cab toward the bed, a little off the true plane x = 10.
      plane_normal: [-1, 0.02, 0],
      plane_offset: -(TRUCK.joinX - 0.4) / frame.scale,
    },
  };
}

/** The model's answer for the fused car: it sees four wheels and a body, and none of them is a component. */
export function fusedCarScenario(): Record<string, unknown> {
  const rendered = render(carFused().mesh);
  const frame = CAR_FRAME;
  const regions: Region[] = CAR_FUSED.wheelBlocks.map((w) => ({ lo: w.lo, hi: w.hi }));
  const wheels = CAR_FUSED.wheelBlocks.map((w, i) =>
    wheelEntry(
      i + 1,
      required(regions[i], 'region'),
      frame,
      viewList(rendered, inRegion(rendered, required(regions[i], 'region'), 0.02)),
      w.name.endsWith('left') ? 'subject_left' : 'subject_right',
      w.name.startsWith('front') ? 'front' : 'rear',
    ),
  );
  return {
    vehicle: { kind: 'car', forward_direction: '+X', up_direction: '+Z' },
    parts: {
      cab: slot('ABSENT', null, frame, absentViews()),
      cargo_or_bed: slot('ABSENT', null, frame, absentViews()),
      chassis_or_main_body: slot(
        'PRESENT',
        { lo: [-30, -16, 0], hi: [30, 16, 16] },
        frame,
        viewList(rendered, () => true),
      ),
    },
    wheels,
    cab_bed_boundary: {
      status: 'ABSENT',
      segments: VIEW_NAMES.map((view) => ({ view, segment: null })),
      plane_normal: null,
      plane_offset: null,
    },
  };
}

export function scenarioAnswer(name: ScenarioName): Record<string, unknown> {
  switch (name) {
    case 'human-ok':
    case 'human-missing-arm':
    case 'human-unsupported':
      return humanScenario(name);
    case 'vehicle-component':
      return carScenario();
    case 'vehicle-ambiguous-wheel':
      return carScenario(0.12);
    case 'vehicle-open-truck':
      return OPEN_TRUCK_ANSWER;
    case 'vehicle-truck-plane':
      return truckScenario();
    case 'vehicle-wheels-fused':
      return fusedCarScenario();
  }
}

export { humanFigure };
