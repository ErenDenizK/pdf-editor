/**
 * Minimal deterministic baseline JPEG encoder: 8-bit YCbCr, 4:4:4 (no chroma
 * subsampling), ITU-T T.81 Annex K example quantisation and Huffman tables.
 * Written so the corpus can contain a DCTDecode image without committing a
 * third-party photo. Not tuned for size or speed.
 */

// Natural-order index of the i-th coefficient in zig-zag order (T.81 Figure A.6).
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// Table K.1 / K.2, natural order.
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

// Table K.3 - K.6.
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

interface HuffTable {
  code: number[];
  size: number[];
}

function buildHuffman(bits: number[], values: number[]): HuffTable {
  const total = bits.reduce((a, b) => a + b, 0);
  if (total !== values.length) throw new Error('Huffman table size mismatch');
  const code: number[] = new Array<number>(256).fill(0);
  const size: number[] = new Array<number>(256).fill(0);
  let next = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1] ?? 0;
    for (let i = 0; i < count; i++) {
      const symbol = values[k++] ?? 0;
      code[symbol] = next++;
      size[symbol] = len;
    }
    next <<= 1;
  }
  return { code, size };
}

function scaleTable(table: number[], quality: number): number[] {
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return table.map((t) => Math.min(255, Math.max(1, Math.floor((t * scale + 50) / 100))));
}

class BitWriter {
  readonly bytes: number[] = [];
  private acc = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.count++;
      if (this.count === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0x00); // byte stuffing
    this.acc = 0;
    this.count = 0;
  }

  finish(): void {
    while (this.count !== 0) this.write(1, 1); // pad with 1-bits
  }
}

const COS = (() => {
  const table: number[] = [];
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) table.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16));
  }
  return table;
})();

function fdct(block: number[]): number[] {
  const out: number[] = new Array<number>(64).fill(0);
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          sum += (block[y * 8 + x] ?? 0) * (COS[x * 8 + u] ?? 0) * (COS[y * 8 + v] ?? 0);
        }
      }
      const cu = u === 0 ? Math.SQRT1_2 : 1;
      const cv = v === 0 ? Math.SQRT1_2 : 1;
      out[v * 8 + u] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

function category(value: number): number {
  let abs = Math.abs(value);
  let bits = 0;
  while (abs > 0) {
    bits++;
    abs >>= 1;
  }
  return bits;
}

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function dhtPayload(tableClass: number, id: number, bits: number[], values: number[]): number[] {
  return [(tableClass << 4) | id, ...bits, ...values];
}

/** `rgb` is row-major, 3 bytes per pixel. */
export function encodeJpeg(
  width: number,
  height: number,
  rgb: Uint8Array,
  quality = 75,
): Uint8Array {
  const qLuma = scaleTable(LUMA_Q, quality);
  const qChroma = scaleTable(CHROMA_Q, quality);
  const dcLuma = buildHuffman(DC_LUMA_BITS, DC_VALUES);
  const dcChroma = buildHuffman(DC_CHROMA_BITS, DC_VALUES);
  const acLuma = buildHuffman(AC_LUMA_BITS, AC_LUMA_VALUES);
  const acChroma = buildHuffman(AC_CHROMA_BITS, AC_CHROMA_VALUES);

  const out: number[] = [0xff, 0xd8];
  // JFIF APP0: version 1.01, aspect ratio 1:1, no thumbnail.
  out.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  out.push(
    ...segment(0xdb, [
      0x00,
      ...ZIGZAG.map((i) => qLuma[i] ?? 1),
      0x01,
      ...ZIGZAG.map((i) => qChroma[i] ?? 1),
    ]),
  );
  out.push(
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
  );
  out.push(
    ...segment(0xc4, [
      ...dhtPayload(0, 0, DC_LUMA_BITS, DC_VALUES),
      ...dhtPayload(1, 0, AC_LUMA_BITS, AC_LUMA_VALUES),
      ...dhtPayload(0, 1, DC_CHROMA_BITS, DC_VALUES),
      ...dhtPayload(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALUES),
    ]),
  );
  out.push(...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]));

  const writer = new BitWriter();
  const prevDc = [0, 0, 0];
  const comps = [
    { q: qLuma, dc: dcLuma, ac: acLuma },
    { q: qChroma, dc: dcChroma, ac: acChroma },
    { q: qChroma, dc: dcChroma, ac: acChroma },
  ];

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      const blocks: number[][] = [[], [], []];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const px = Math.min(bx + x, width - 1);
          const py = Math.min(by + y, height - 1);
          const o = (py * width + px) * 3;
          const r = rgb[o] ?? 0;
          const g = rgb[o + 1] ?? 0;
          const b = rgb[o + 2] ?? 0;
          blocks[0]?.push(0.299 * r + 0.587 * g + 0.114 * b - 128);
          blocks[1]?.push(-0.168736 * r - 0.331264 * g + 0.5 * b);
          blocks[2]?.push(0.5 * r - 0.418688 * g - 0.081312 * b);
        }
      }
      for (let c = 0; c < 3; c++) {
        const comp = comps[c];
        const block = blocks[c];
        if (!comp || !block) continue;
        const coeffs = fdct(block);
        const zz = ZIGZAG.map((i) => Math.round((coeffs[i] ?? 0) / (comp.q[i] ?? 1)));
        const dc = zz[0] ?? 0;
        const diff = dc - (prevDc[c] ?? 0);
        prevDc[c] = dc;
        const dcCat = category(diff);
        writer.write(comp.dc.code[dcCat] ?? 0, comp.dc.size[dcCat] ?? 0);
        if (dcCat > 0) writer.write(diff < 0 ? diff + (1 << dcCat) - 1 : diff, dcCat);

        let run = 0;
        for (let k = 1; k < 64; k++) {
          const value = zz[k] ?? 0;
          if (value === 0) {
            run++;
            continue;
          }
          while (run > 15) {
            writer.write(comp.ac.code[0xf0] ?? 0, comp.ac.size[0xf0] ?? 0);
            run -= 16;
          }
          const cat = category(value);
          const symbol = (run << 4) | cat;
          writer.write(comp.ac.code[symbol] ?? 0, comp.ac.size[symbol] ?? 0);
          writer.write(value < 0 ? value + (1 << cat) - 1 : value, cat);
          run = 0;
        }
        if (run > 0) writer.write(comp.ac.code[0x00] ?? 0, comp.ac.size[0x00] ?? 0);
      }
    }
  }
  writer.finish();
  out.push(...writer.bytes, 0xff, 0xd9);
  return Uint8Array.from(out);
}
