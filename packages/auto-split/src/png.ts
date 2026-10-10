import { crc32 } from '@cadfixer/auto-split-contract';

/**
 * A minimal DETERMINISTIC PNG encoder: signature, IHDR, one IDAT, IEND, and nothing else. No text, no
 * time, no software tag, no colour profile: an image carries pixels and nothing that could carry a path
 * or a name. The compressor is INJECTED, because this package compiles without DOM or Node types; the
 * geometry worker supplies `CompressionStream('deflate')` (zlib framing, which is what PNG wants).
 */
export type Deflate = (raw: Uint8Array) => Promise<Uint8Array>;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export async function encodePng(
  width: number,
  height: number,
  rgb: Uint8Array,
  deflate: Deflate,
): Promise<Uint8Array> {
  if (rgb.length !== width * height * 3) throw new Error('encodePng: pixel buffer size mismatch');
  // Filter type 0 (None) on every row: a fixed filter makes the bytes a pure function of the pixels.
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1)
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
