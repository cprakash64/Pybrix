import type { Deflate } from '../png';
/** Test-only platform compressor; matches the worker without introducing Node imports in engine types. */
export const fixtureDeflate: Deflate = async (raw) => {
  const stream = new CompressionStream('deflate'),
    writer = stream.writable.getWriter();
  const written = writer.write(new Uint8Array(raw)).then(() => writer.close());
  const reader = stream.readable.getReader(),
    chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (value) chunks.push(value);
    if (done) break;
  }
  await written;
  const out = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
};
