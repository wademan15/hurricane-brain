/**
 * Small byte helpers shared by the decoders, the recorder and the tests. Pure functions.
 */

/** Read `count` unsigned integers of `width` bits, packed LSB-first, byte by byte. */
export function unpackUintLE(data: Uint8Array, width: number, count: number, offset = 0): number[] {
  const out = new Array<number>(count);
  let bit = 0;
  for (let i = 0; i < count; i++) {
    let v = 0;
    for (let b = 0; b < width; b++, bit++) {
      const byte = data[offset + (bit >> 3)];
      if ((byte >> (bit & 7)) & 1) v += 2 ** b;
    }
    out[i] = v;
  }
  return out;
}

/** Inverse of `unpackUintLE`. Used by the test encoder; values must fit in `width` bits. */
export function packUintLE(values: readonly number[], width: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((values.length * width) / 8));
  let bit = 0;
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) {
      throw new RangeError(`value ${value} does not fit in ${width} bits`);
    }
    let v = value;
    for (let b = 0; b < width; b++, bit++) {
      if (v % 2 === 1) out[bit >> 3] |= 1 << (bit & 7);
      v = Math.floor(v / 2);
    }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new Error(`bad hex at ${i * 2}`);
    out[i] = v;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function u16be(d: Uint8Array, o: number): number {
  return (d[o] << 8) | d[o + 1];
}
export function i16be(d: Uint8Array, o: number): number {
  const v = (d[o] << 8) | d[o + 1];
  return v >= 0x8000 ? v - 0x10000 : v;
}
export function u16le(d: Uint8Array, o: number): number {
  return d[o] | (d[o + 1] << 8);
}
export function i16le(d: Uint8Array, o: number): number {
  const v = d[o] | (d[o + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** Copy a DataView's bytes (Web Bluetooth reuses buffers between notifications). */
export function copyDataView(v: DataView): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}
