/**
 * Strict standard base64, in plain TypeScript so the contract stays platform-free (no `Buffer`, no
 * `atob`). Padding is required, the alphabet is the standard one and whitespace is not tolerated:
 * a payload that is not exactly base64 is not an image.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Int16Array = ((): Int16Array => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** The decoded bytes, or null when the text is not strict base64. */
export function decodeBase64(text: string): Uint8Array | null {
  const length = text.length;
  if (length === 0 || length % 4 !== 0) return null;
  let padding = 0;
  if (text.charCodeAt(length - 1) === 61) padding += 1;
  if (text.charCodeAt(length - 2) === 61) padding += 1;
  const out = new Uint8Array((length / 4) * 3 - padding);
  let written = 0;
  for (let i = 0; i < length; i += 4) {
    let bits = 0;
    for (let k = 0; k < 4; k += 1) {
      const code = text.charCodeAt(i + k);
      const isPad = code === 61;
      if (isPad && (i + k < length - padding || k < 2)) return null;
      const value = isPad ? 0 : code < 128 ? (LOOKUP[code] ?? -1) : -1;
      if (value < 0) return null;
      bits = (bits << 6) | value;
    }
    if (written < out.length) out[written++] = (bits >> 16) & 0xff;
    if (written < out.length) out[written++] = (bits >> 8) & 0xff;
    if (written < out.length) out[written++] = bits & 0xff;
  }
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((bits >> 18) & 63) + ALPHABET.charAt((bits >> 12) & 63);
    out += i + 1 < bytes.length ? ALPHABET.charAt((bits >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? ALPHABET.charAt(bits & 63) : '=';
  }
  return out;
}
