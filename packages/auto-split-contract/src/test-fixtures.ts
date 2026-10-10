import { encodeBase64 } from './base64';
import { crc32 } from './png';
import { PROTOCOL_VERSIONS, VIEW_IMAGE_SIZE, VIEW_NAMES, type SemanticMode } from './limits';
import type { AnalyzeRequest } from './request';

/**
 * TEST-ONLY. Builds a real, clean, 512 x 512 RGB PNG and a complete valid request around it. Not
 * exported from the package index.
 */
async function deflate(raw: Uint8Array): Promise<Uint8Array> {
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
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export async function makePng(
  options: { width?: number; height?: number; extraChunk?: string; shade?: number } = {},
): Promise<Uint8Array> {
  const width = options.width ?? VIEW_IMAGE_SIZE;
  const height = options.height ?? VIEW_IMAGE_SIZE;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1)
    raw.fill(options.shade ?? 200, y * (1 + width * 3) + 1, (y + 1) * (1 + width * 3));
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(options.extraChunk === undefined
      ? []
      : [chunk(options.extraChunk, new Uint8Array([1, 2, 3]))]),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function makeRequest(
  mode: SemanticMode = 'human',
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const png = encodeBase64(await makePng());
  return {
    requestId: 'req-0123456789ab',
    mode,
    protocolVersion: PROTOCOL_VERSIONS[mode],
    views: VIEW_NAMES.map((view) => ({ view, png })),
    summary: { extents: [1, 0.5, 0.25], shells: 1, radius: 0.6 },
    ...overrides,
  };
}

export type { AnalyzeRequest };
