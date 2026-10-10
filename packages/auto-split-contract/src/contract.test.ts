import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from './base64';
import { AnalyzeErrorCode, analyzeError } from './errors';
import { validateHuman } from './human';
import { PROTOCOL_VERSIONS, VIEW_NAMES } from './limits';
import { inspectPng, PngProblem } from './png';
import { validateAnalyzeRequest } from './request';
import { parseAnalyzeResponse } from './response';
import { cameraFor, projectPoint, VIEW_SPECS } from './views';
import { makePng, makeRequest } from './test-fixtures';
import { validateVehicle, VEHICLE_VIEW_ORDER } from './vehicle';

describe('base64', () => {
  it('round-trips every length and refuses what is not strict base64', () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(Array.from(decodeBase64(encodeBase64(bytes)) ?? [-1])).toEqual(
        n === 0 ? [-1] : Array.from(bytes),
      );
    }
    for (const bad of ['', 'abc', 'ab=c', 'a===', 'ab\ncd', 'ab-d', '====', 'é===', 'AA=A']) {
      expect(decodeBase64(bad), bad).toBeNull();
    }
  });
});

describe('inspectPng', () => {
  it('accepts a clean PNG and describes it', async () => {
    const r = inspectPng(await makePng());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.width).toBe(512);
      expect(r.info.chunkTypes).toEqual(['IHDR', 'IDAT', 'IEND']);
    }
  });
  it('refuses a PNG with a text chunk, a bad checksum, a truncation and a non-PNG', async () => {
    const withText = inspectPng(await makePng({ extraChunk: 'tEXt' }));
    expect(withText).toEqual({ ok: false, problem: PngProblem.UnexpectedChunk });
    const good = await makePng();
    const corrupt = good.slice();
    corrupt[40] = (corrupt[40] ?? 0) ^ 0xff;
    expect(inspectPng(corrupt).ok).toBe(false);
    expect(inspectPng(good.slice(0, good.length - 5)).ok).toBe(false);
    expect(inspectPng(new TextEncoderLike().encode('solid cube\nfacet normal 0 0 0')).ok).toBe(
      false,
    );
  });
});

class TextEncoderLike {
  public encode(text: string): Uint8Array {
    return Uint8Array.from(Array.from(text, (c) => c.charCodeAt(0) & 0xff));
  }
}

describe('validateAnalyzeRequest', () => {
  it('accepts a complete request and returns the decoded views', async () => {
    const r = validateAnalyzeRequest(await makeRequest('vehicle'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pngs).toHaveLength(6);
      expect(r.request.mode).toBe('vehicle');
    }
  });

  it('refuses raw geometry, file names and prompts at every level, with its own code', async () => {
    const base = await makeRequest('human');
    for (const key of [
      'positions',
      'vertices',
      'faces',
      'triangles',
      'mesh',
      'stl',
      'fileName',
      'prompt',
      'system',
      'instructions',
      'model',
    ]) {
      const r = validateAnalyzeRequest({ ...base, [key]: [0, 1, 2] });
      expect(r, key).toEqual({ ok: false, code: AnalyzeErrorCode.RawGeometryRejected });
    }
    const nested = validateAnalyzeRequest({
      ...base,
      summary: { extents: [1, 1, 1], shells: 1, radius: 0.6, positions: [1] },
    });
    expect(nested).toEqual({ ok: false, code: AnalyzeErrorCode.RawGeometryRejected });
    const inView = validateAnalyzeRequest({
      ...base,
      views: (base.views as { view: string; png: string }[]).map((v) => ({
        ...v,
        fileName: 'x.stl',
      })),
    });
    expect(inView).toEqual({ ok: false, code: AnalyzeErrorCode.RawGeometryRejected });
    expect(validateAnalyzeRequest({ ...base, surprise: 1 })).toEqual({
      ok: false,
      code: AnalyzeErrorCode.InvalidRequest,
    });
  });

  it('refuses a wrong mode, protocol, view count, view order, id and summary', async () => {
    const base = await makeRequest('human');
    expect(validateAnalyzeRequest({ ...base, mode: 'other' })).toMatchObject({
      code: AnalyzeErrorCode.UnsupportedMode,
    });
    expect(validateAnalyzeRequest({ ...base, mode: 'constructor' })).toMatchObject({
      code: AnalyzeErrorCode.UnsupportedMode,
    });
    expect(validateAnalyzeRequest({ ...base, protocolVersion: 'human-v0' })).toMatchObject({
      code: AnalyzeErrorCode.UnsupportedProtocol,
    });
    const views = base.views as { view: string; png: string }[];
    expect(validateAnalyzeRequest({ ...base, views: views.slice(0, 5) }).ok).toBe(false);
    expect(validateAnalyzeRequest({ ...base, views: [...views].reverse() }).ok).toBe(false);
    expect(validateAnalyzeRequest({ ...base, requestId: 'short' }).ok).toBe(false);
    expect(validateAnalyzeRequest({ ...base, requestId: 'has spaces and /slash' }).ok).toBe(false);
    for (const summary of [
      { extents: [1, 1], shells: 1, radius: 0.5 },
      { extents: [1, 1, 5], shells: 1, radius: 0.5 },
      { extents: [1, 1, 1], shells: 0, radius: 0.5 },
      { extents: [1, 1, 1], shells: 1.5, radius: 0.5 },
      { extents: [1, 1, 1], shells: 1, radius: 0 },
      { extents: [1, Number.NaN, 1], shells: 1, radius: 0.5 },
    ])
      expect(validateAnalyzeRequest({ ...base, summary }).ok, JSON.stringify(summary)).toBe(false);
  });

  it('refuses an image that is the wrong size, carries metadata, or is not an image', async () => {
    const base = await makeRequest('human');
    const swap = (png: string): Record<string, unknown> => ({
      ...base,
      views: VIEW_NAMES.map((view) => ({ view, png })),
    });
    expect(
      validateAnalyzeRequest(swap(encodeBase64(await makePng({ width: 256, height: 256 })))).ok,
    ).toBe(false);
    expect(
      validateAnalyzeRequest(swap(encodeBase64(await makePng({ extraChunk: 'tEXt' })))).ok,
    ).toBe(false);
    expect(
      validateAnalyzeRequest(
        swap(
          encodeBase64(
            Uint8Array.from([
              115, 111, 108, 105, 100, 32, 120, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
              0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            ]),
          ),
        ),
      ).ok,
    ).toBe(false);
    expect(validateAnalyzeRequest(swap('not base64!')).ok).toBe(false);
  });

  it('refuses an oversized image before decoding it', async () => {
    const base = await makeRequest('human');
    const huge = 'A'.repeat(900_000);
    const r = validateAnalyzeRequest({
      ...base,
      views: VIEW_NAMES.map((view) => ({ view, png: huge })),
    });
    expect(r).toEqual({ ok: false, code: AnalyzeErrorCode.PayloadTooLarge });
  });

  it('refuses non-objects', () => {
    for (const v of [null, 1, 'x', [], undefined]) expect(validateAnalyzeRequest(v).ok).toBe(false);
  });
});

describe('the response parser', () => {
  const human = {
    figure: { kind: 'humanoid_figure' },
    parts: Object.fromEntries(
      ['head', 'left_arm', 'right_arm'].map((s) => [
        s,
        {
          status: 'PRESENT',
          center: [0, 0, 0.4],
          extent: [0.2, 0.2, 0.2],
          plane_normal: [0, 0, 1],
          plane_offset: 0.3,
        },
      ]),
    ),
  };
  const wire = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ok: true,
    requestId: 'req-0123456789ab',
    mode: 'human',
    protocolVersion: PROTOCOL_VERSIONS.human,
    analysis: human,
    ...extra,
  });
  const expected = { requestId: 'req-0123456789ab', mode: 'human' as const };

  it('parses a valid human answer', () => {
    const r = parseAnalyzeResponse(wire(), expected);
    expect(r.ok).toBe(true);
    if (r.ok && r.analysis.mode === 'human')
      expect(r.analysis.human.parts.head.status).toBe('PRESENT');
  });
  it('refuses an answer for another request, mode, protocol or schema', () => {
    for (const extra of [
      { requestId: 'other-request-id' },
      { mode: 'vehicle' },
      { protocolVersion: 'human-v0' },
      { analysis: { figure: { kind: 'x' }, parts: {} } },
      { analysis: null },
    ])
      expect(parseAnalyzeResponse(wire(extra), expected)).toMatchObject({ ok: false });
  });
  it('re-derives the sentence of an error from its code and ignores provider text', () => {
    const r = parseAnalyzeResponse(
      {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'sk-secret provider text',
          retryAfterSeconds: 31.2,
        },
      },
      expected,
    );
    expect(r).toEqual({ ok: false, error: analyzeError(AnalyzeErrorCode.RateLimited, 32) });
    expect(parseAnalyzeResponse({ ok: false, error: { code: 'MADE_UP' } }, expected)).toMatchObject(
      {
        ok: false,
        error: { code: AnalyzeErrorCode.ProviderInvalidResponse },
      },
    );
  });
});

describe('the answers', () => {
  it('validates the human answer strictly', () => {
    expect(validateHuman({ figure: { kind: 'unclear' }, parts: { head: {} } }).ok).toBe(false);
    expect(
      validateHuman({ figure: { kind: 'humanoid_figure' }, parts: { head: { status: 'PRESENT' } } })
        .ok,
    ).toBe(false);
    expect(validateHuman('x').ok).toBe(false);
  });
  it('validates the vehicle answer strictly and keeps the six-view order', () => {
    expect(VEHICLE_VIEW_ORDER).toEqual(VIEW_NAMES);
    expect(validateVehicle({}).ok).toBe(false);
    expect(validateVehicle(null).ok).toBe(false);
  });
});

describe('the cameras', () => {
  it('projects the centre to the middle of every image and keeps image axes orthonormal', () => {
    for (const view of VIEW_NAMES) {
      expect(projectPoint(0.7, view, [0, 0, 0])).toEqual([0.5, 0.5]);
      const c = cameraFor(view);
      const dot = (a: readonly number[], b: readonly number[]): number =>
        a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
      expect(Math.abs(dot(c.right, c.up))).toBeLessThan(1e-12);
      expect(Math.abs(dot(c.right, c.forward))).toBeLessThan(1e-12);
      expect(VIEW_SPECS[view].description.length).toBeGreaterThan(10);
    }
  });
  it('puts +X on the right of the front view and +Z at the top of the side views', () => {
    const [xr] = projectPoint(0.7, 'front', [0.3, 0, 0]);
    expect(xr).toBeGreaterThan(0.5);
    const [, yTop] = projectPoint(0.7, 'left', [0, 0, 0.3]);
    expect(yTop).toBeLessThan(0.5);
  });
});
