/**
 * WHAT MAKES A PNG ACCEPTABLE TO SEND.
 *
 * A render carries pixels and nothing else: the only chunks are IHDR, IDAT and IEND, so there is no
 * text chunk, no timestamp, no colour profile and no embedded metadata that could carry a path or a
 * name. The service refuses anything else rather than strip it, so a client that attaches metadata
 * fails loudly instead of leaking quietly.
 */
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1)
    c = (CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly chunkTypes: readonly string[];
}

export const PngProblem = {
  NotPng: 'not a PNG',
  Truncated: 'truncated',
  BadChecksum: 'chunk checksum mismatch',
  UnexpectedChunk: 'unexpected chunk',
  BadHeader: 'bad header',
} as const;
export type PngProblem = (typeof PngProblem)[keyof typeof PngProblem];

const u32 = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) |
    ((bytes[at + 1] ?? 0) << 16) |
    ((bytes[at + 2] ?? 0) << 8) |
    (bytes[at + 3] ?? 0)) >>>
  0;

/** Reads a PNG's structure, or says why it is not a clean one. Never decompresses the image data. */
export function inspectPng(
  bytes: Uint8Array,
): { ok: true; info: PngInfo } | { ok: false; problem: PngProblem } {
  if (bytes.length < 8 + 25 + 12 || !SIGNATURE.every((b, i) => bytes[i] === b))
    return { ok: false, problem: PngProblem.NotPng };
  const types: string[] = [];
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return { ok: false, problem: PngProblem.Truncated };
    const length = u32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return { ok: false, problem: PngProblem.Truncated };
    if (crc32(bytes, offset + 4, dataEnd) !== u32(bytes, dataEnd))
      return { ok: false, problem: PngProblem.BadChecksum };
    types.push(type);
    if (types.length === 1) {
      if (type !== 'IHDR' || length !== 13) return { ok: false, problem: PngProblem.BadHeader };
      width = u32(bytes, dataStart);
      height = u32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8] ?? 0;
      colorType = bytes[dataStart + 9] ?? 0;
    } else if (type !== 'IDAT' && type !== 'IEND') {
      return { ok: false, problem: PngProblem.UnexpectedChunk };
    }
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (types[types.length - 1] !== 'IEND' || offset !== bytes.length)
    return { ok: false, problem: PngProblem.Truncated };
  if (!types.includes('IDAT')) return { ok: false, problem: PngProblem.Truncated };
  return { ok: true, info: { width, height, bitDepth, colorType, chunkTypes: types } };
}
