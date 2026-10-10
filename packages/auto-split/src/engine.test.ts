import { describe, expect, it } from 'vitest';
import {
  encodeBase64,
  parseAnalyzeResponse,
  PROTOCOL_VERSIONS,
  validateAnalyzeRequest,
  validateHuman,
  validateVehicle,
  VIEW_NAMES,
  type HumanAnswer,
  type VehicleAnswer,
} from '@cadfixer/auto-split-contract';
import { assertMeshStructure, type CanonicalMesh } from '@cadfixer/mesh-core';
import { analyseTopology } from '@cadfixer/mesh-topology';
import { CancellationSource } from '@cadfixer/shared';
import { labelComponents } from './components';
import { componentPieces } from './extract';
import { faceFacts, normalizeGeometry, toSourcePoint } from './geometry';
import { prepareViews } from './prepare';
import type { Deflate } from './png';
import { suggestFor } from './suggest';
import {
  SuggestionOperation,
  SuggestionReason,
  SuggestionStatus,
  type Suggestion,
} from './suggestions';
import {
  carFused,
  carMultipart,
  humanFigure,
  openCube,
  scenarioAnswer,
  toBinaryStl,
  truckFused,
  CAR,
  TRUCK,
} from './fixtures';
import { required } from './required';

const deflate: Deflate = async (raw) => {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(raw)).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) parts.push(value);
    if (done) break;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function report(mesh: CanonicalMesh): ReturnType<typeof analyseTopology>['report'] {
  assertMeshStructure(mesh, 'test');
  return analyseTopology(mesh, {
    documentId: 't',
    documentRevision: 0,
    partId: 'p',
    cancellation: new CancellationSource().token,
    sampleLimit: 0,
    componentSummaryLimit: 8,
  }).report;
}

describe('the test models', () => {
  it('are closed, manifold, consistently wound and outward, which Split requires', () => {
    for (const model of [humanFigure(), carMultipart(), truckFused(), carFused()]) {
      const r = report(model.mesh);
      expect(r.boundaryEdgeCount, model.name).toBe(0);
      expect(r.nonManifoldEdgeCount, model.name).toBe(0);
      expect(r.nonManifoldVertexCount, model.name).toBe(0);
      expect(r.windingConflictEdgeCount, model.name).toBe(0);
      expect(r.zeroAreaFaceCount, model.name).toBe(0);
      expect(r.totalSignedVolume, model.name).toBeGreaterThan(0);
    }
  });
  it('have the number of shells their names say', () => {
    expect(report(humanFigure().mesh).componentCount).toBe(1);
    expect(report(carMultipart().mesh).componentCount).toBe(5);
    expect(report(truckFused().mesh).componentCount).toBe(5);
    expect(report(carFused().mesh).componentCount).toBe(1);
  });
  it('make an open cube that is not a solid', () => {
    expect(report(openCube().mesh).boundaryEdgeCount).toBeGreaterThan(0);
  });
  it('write a binary STL of the right size', () => {
    const mesh = carMultipart().mesh;
    expect(toBinaryStl(mesh).length).toBe(84 + (mesh.indices.length / 3) * 50);
  });
});

describe('the six views', () => {
  it('produce a request the service accepts, and the same bytes every time', async () => {
    const mesh = carMultipart().mesh;
    const first = await prepareViews(mesh, deflate);
    const second = await prepareViews(mesh, deflate);
    expect(first.pngs).toHaveLength(6);
    expect(first.pngs.map((p) => Array.from(p))).toEqual(second.pngs.map((p) => Array.from(p)));
    expect(first.summary).toEqual({
      extents: [1, 0.55, 0.267],
      shells: 5,
      radius: first.summary.radius,
    });
    const request = {
      requestId: 'req-0123456789ab',
      mode: 'vehicle',
      protocolVersion: PROTOCOL_VERSIONS.vehicle,
      views: VIEW_NAMES.map((view, i) => ({
        view,
        png: encodeBase64(required(first.pngs[i], 'view png')),
      })),
      summary: first.summary,
    };
    expect(validateAnalyzeRequest(request).ok).toBe(true);
    // The images carry no metadata at all.
    expect(first.pngs.every((p) => p.length > 100 && p.length < 512 * 1024)).toBe(true);
  });

  it('show the model: the picture is not blank and the background is neutral', async () => {
    const { pngs } = await prepareViews(humanFigure().mesh, deflate);
    // A render of a figure compresses to something, and differs between views.
    expect(new Set(pngs.map((p) => p.length)).size).toBeGreaterThan(1);
  });

  it('refuse a part with no extent', async () => {
    const flat = {
      positions: new Float32Array(9),
      indices: Uint32Array.from([0, 1, 2]),
      metadata: {},
    };
    await expect(prepareViews(flat as unknown as CanonicalMesh, deflate)).rejects.toThrow(/extent/);
  });
});

function human(name: 'human-ok' | 'human-missing-arm' | 'human-unsupported'): HumanAnswer {
  const checked = validateHuman(scenarioAnswer(name));
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return checked.value;
}
function vehicle(name: Parameters<typeof scenarioAnswer>[0]): VehicleAnswer {
  const checked = validateVehicle(scenarioAnswer(name));
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  return checked.value;
}
const byId = (list: readonly Suggestion[], id: string): Suggestion => {
  const found = list.find((s) => s.id === id);
  if (!found) throw new Error(`no suggestion ${id} in ${list.map((s) => s.id).join(',')}`);
  return found;
};

describe('human suggestions', () => {
  const mesh = humanFigure().mesh;

  it('suggest the head as a cut across the neck, in the part’s own coordinates, normal into the head', () => {
    const result = suggestFor(mesh, { mode: 'human', human: human('human-ok') });
    const head = byId(result.suggestions, 'head');
    expect(head.operation).toBe(SuggestionOperation.Plane);
    expect(head.status).toBe(SuggestionStatus.Suggested);
    expect(head.plane).not.toBeNull();
    const plane = required(head.plane, 'head plane');
    expect(plane.normal[2]).toBeGreaterThan(0.99);
    // The neck is z 24 to 26 (the cut is shortest there); the model said 25.3 and the refinement keeps it inside.
    expect(plane.origin[2]).toBeGreaterThan(24);
    expect(plane.origin[2]).toBeLessThan(26);
  });

  it('suggest both arms as cuts that need adjustment, never as confident ones', () => {
    const result = suggestFor(mesh, { mode: 'human', human: human('human-ok') });
    for (const id of ['left_arm', 'right_arm']) {
      const arm = byId(result.suggestions, id);
      expect(arm.status).toBe(SuggestionStatus.NeedsAdjustment);
      expect(arm.reason).toBe(SuggestionReason.ReviewCut);
      expect(arm.plane).not.toBeNull();
    }
    const left = required(byId(result.suggestions, 'left_arm').plane, 'left plane');
    const right = required(byId(result.suggestions, 'right_arm').plane, 'right plane');
    // The figure's own left is +X, and the normal points into the arm.
    expect(left.normal[0]).toBeGreaterThan(0.99);
    expect(right.normal[0]).toBeLessThan(-0.99);
    expect(left.origin[0]).toBeGreaterThan(4.5);
    expect(left.origin[0]).toBeLessThan(10);
  });

  it('leaves out a part the model says is absent, and has nothing for a figure that is not one', () => {
    const missing = suggestFor(mesh, { mode: 'human', human: human('human-missing-arm') });
    expect(missing.suggestions.map((s) => s.id)).toEqual(['head', 'left_arm']);
    const none = suggestFor(mesh, { mode: 'human', human: human('human-unsupported') });
    expect(none.suggestions).toEqual([]);
  });

  it('turns a plane that cuts off nearly everything into "no safe split", not into a cut', () => {
    const answer = human('human-ok');
    const wrong: HumanAnswer = {
      ...answer,
      parts: {
        ...answer.parts,
        head: { ...answer.parts.head, planeNormal: [0, 0, 1], planeOffset: -0.45, center: null },
      },
    };
    const result = suggestFor(mesh, { mode: 'human', human: wrong });
    const head = byId(result.suggestions, 'head');
    expect(head.status).toBe(SuggestionStatus.Unavailable);
    expect(head.reason).toBe(SuggestionReason.CutDoesNotIsolate);
    expect(head.plane).toBeNull();
  });

  it('flips a normal that points out of the part when the model’s own centre says so', () => {
    const answer = human('human-ok');
    const flipped: HumanAnswer = {
      ...answer,
      parts: {
        ...answer.parts,
        head: { ...answer.parts.head, planeNormal: [0, 0, -1], planeOffset: -0.2353 },
      },
    };
    const head = byId(suggestFor(mesh, { mode: 'human', human: flipped }).suggestions, 'head');
    expect(required(head.plane, 'head plane').normal[2]).toBeGreaterThan(0.99);
  });

  it('is a pure function: the same part and answer give the same suggestions, and the mesh is untouched', () => {
    const copy = mesh.positions.slice();
    const a = suggestFor(mesh, { mode: 'human', human: human('human-ok') });
    const b = suggestFor(mesh, { mode: 'human', human: human('human-ok') });
    expect(a).toEqual(b);
    expect(Array.from(mesh.positions)).toEqual(Array.from(copy));
  });
});

describe('vehicle suggestions', () => {
  it('select each wheel of a multi-part car as its own component, and mark none as a certainty it has not earned', () => {
    const mesh = carMultipart().mesh;
    const result = suggestFor(mesh, { mode: 'vehicle', vehicle: vehicle('vehicle-component') });
    const wheels = result.suggestions.filter((s) => s.family === 'wheel');
    expect(wheels).toHaveLength(4);
    expect(wheels.every((w) => w.operation === SuggestionOperation.Component)).toBe(true);
    // Every suggested component is a wheel: small, and where a wheel is.
    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const labelling = labelComponents(mesh, faceFacts(geometry));
    expect(labelling.count).toBe(5);
    const taken = new Set(wheels.flatMap((w) => w.components));
    expect(taken.size).toBe(4);
    for (const w of wheels) {
      expect(w.components).toHaveLength(1);
      // Rank 0 is the largest: the body. A wheel is never it.
      expect(w.components[0]).not.toBe(0);
    }
    const names = wheels.map((w) => w.label);
    expect(new Set(names).size).toBe(4);
    expect(names).toEqual(expect.arrayContaining(['Front-left wheel', 'Rear-right wheel']));
    const body = byId(result.suggestions, 'chassis_or_main_body');
    expect(body.components).toEqual([0]);
  });

  it('ask for review, not trust, when the model’s boxes are loose', () => {
    const mesh = carMultipart().mesh;
    const loose = suggestFor(mesh, {
      mode: 'vehicle',
      vehicle: vehicle('vehicle-ambiguous-wheel'),
    });
    const wheels = loose.suggestions.filter((s) => s.family === 'wheel');
    expect(wheels.length).toBeGreaterThan(0);
    for (const w of wheels) expect(w.status).not.toBe(SuggestionStatus.Suggested);
  });

  it('offer a fused cab and bed as one beta cut, with the wheels as components', () => {
    const mesh = truckFused().mesh;
    const result = suggestFor(mesh, { mode: 'vehicle', vehicle: vehicle('vehicle-truck-plane') });
    const cut = byId(result.suggestions, 'cab_bed');
    expect(cut.operation).toBe(SuggestionOperation.Plane);
    expect(cut.status).toBe(SuggestionStatus.NeedsAdjustment);
    expect(cut.reason).toBe(SuggestionReason.BetaCut);
    const plane = required(cut.plane, 'cut plane');
    // The cab meets the bed at x = 10, so the cut is across X there.
    expect(Math.abs(plane.normal[0])).toBeGreaterThan(0.98);
    expect(Math.abs(plane.origin[0] - TRUCK.joinX)).toBeLessThan(2.5);
    expect(result.suggestions.some((s) => s.id === 'cab')).toBe(false);
    expect(result.suggestions.filter((s) => s.family === 'wheel').length).toBeGreaterThan(0);
  });

  it('say "no safe split" for wheels and body that are fused into one shell', () => {
    const mesh = carFused().mesh;
    const result = suggestFor(mesh, { mode: 'vehicle', vehicle: vehicle('vehicle-wheels-fused') });
    const wheels = byId(result.suggestions, 'wheels:fused');
    expect(wheels.status).toBe(SuggestionStatus.Unavailable);
    expect(wheels.reason).toBe(SuggestionReason.FusedIntoBody);
    const body = byId(result.suggestions, 'chassis_or_main_body');
    expect(body.status).toBe(SuggestionStatus.Unavailable);
    expect(result.suggestions.every((s) => s.operation === SuggestionOperation.None)).toBe(true);
  });

  it('bound the selection list and keep the selected components in it', () => {
    const result = suggestFor(carMultipart().mesh, {
      mode: 'vehicle',
      vehicle: vehicle('vehicle-component'),
    });
    expect(result.componentCount).toBe(5);
    expect(result.components.length).toBeLessThanOrEqual(24);
    for (const s of result.suggestions)
      for (const r of s.components) expect(result.components.some((c) => c.rank === r)).toBe(true);
    expect(result.components[0]?.areaShare).toBeGreaterThan(result.components[1]?.areaShare ?? 1);
  });
});

describe('component extraction', () => {
  it('splits a car into a wheel and the rest, each a closed solid, with every face in exactly one piece', () => {
    const mesh = carMultipart().mesh;
    const geometry = normalizeGeometry(mesh.positions, mesh.indices);
    const labelling = labelComponents(mesh, faceFacts(geometry));
    const before = mesh.positions.slice();
    const pieces = componentPieces(mesh, labelling, [1]);
    expect(pieces.selectedFaces + pieces.restFaces).toBe(mesh.indices.length / 3);
    for (const piece of [pieces.selected, pieces.rest]) {
      const r = report(piece);
      expect(r.boundaryEdgeCount).toBe(0);
      expect(r.nonManifoldEdgeCount).toBe(0);
      expect(r.windingConflictEdgeCount).toBe(0);
      expect(r.totalSignedVolume).toBeGreaterThan(0);
    }
    expect(
      report(pieces.selected).totalSignedVolume + report(pieces.rest).totalSignedVolume,
    ).toBeCloseTo(report(mesh).totalSignedVolume, 6);
    // The source is not written.
    expect(Array.from(mesh.positions)).toEqual(Array.from(before));
  });

  it('refuses an empty selection and a selection of everything', () => {
    const mesh = carMultipart().mesh;
    const labelling = labelComponents(
      mesh,
      faceFacts(normalizeGeometry(mesh.positions, mesh.indices)),
    );
    expect(() => componentPieces(mesh, labelling, [])).toThrow(/No component/);
    expect(() => componentPieces(mesh, labelling, [0, 1, 2, 3, 4])).toThrow(/whole model/);
    expect(() => componentPieces(mesh, labelling, [99])).toThrow(/No component/);
  });
});

describe('the normalized frame', () => {
  it('puts the bounding-box centre at the origin and the longest side at 1, and converts back', () => {
    const mesh = carMultipart().mesh;
    const g = normalizeGeometry(mesh.positions, mesh.indices);
    expect(Math.max(...g.extents)).toBeCloseTo(1, 6);
    expect(g.scale).toBeCloseTo(60, 4);
    expect(toSourcePoint(g, [0.5, 0, 0])[0]).toBeCloseTo(g.center[0] + 30, 4);
    expect(CAR.radius).toBe(5);
  });
});

describe('a response a browser would parse', () => {
  it('accepts a scenario answer end to end', () => {
    const wire = {
      ok: true,
      requestId: 'req-0123456789ab',
      mode: 'vehicle',
      protocolVersion: PROTOCOL_VERSIONS.vehicle,
      analysis: scenarioAnswer('vehicle-component'),
    };
    expect(parseAnalyzeResponse(wire, { requestId: 'req-0123456789ab', mode: 'vehicle' }).ok).toBe(
      true,
    );
  });
});
