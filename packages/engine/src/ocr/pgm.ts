/**
 * Binary PGM (`P5`, maxval 255): the raster format handed from the PDFium worker to
 * Tesseract (research 07 §3: 5 ms to encode versus 400+ ms for PNG, and faster to
 * recognise). Leptonica reads it natively.
 */

/** Wraps `width × height` grey bytes (rows top-down) in a PGM header. */
export function encodePgm(grey: Uint8Array, width: number, height: number): Uint8Array {
  if (grey.length !== width * height) {
    throw new Error(`PGM: ${grey.length} bytes for ${width}×${height} pixels`);
  }
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(header.length + grey.length);
  out.set(header);
  out.set(grey, header.length);
  return out;
}

export interface PgmInfo {
  readonly width: number;
  readonly height: number;
  /** Offset of the first pixel byte. */
  readonly offset: number;
}

/** Reads a `P5` header (whitespace-separated fields, `#` comments). */
export function readPgmHeader(bytes: Uint8Array): PgmInfo {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x35) throw new Error('Not a binary PGM (P5)');
  const fields: number[] = [];
  const isSpace = (b: number | undefined) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
  let pos = 2;
  while (fields.length < 3) {
    while (isSpace(bytes[pos])) pos++;
    if (bytes[pos] === 0x23) {
      while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
      continue;
    }
    let value = 0;
    let digits = 0;
    while (pos < bytes.length && (bytes[pos] ?? 0) >= 0x30 && (bytes[pos] ?? 0) <= 0x39) {
      value = value * 10 + (bytes[pos] ?? 0) - 0x30;
      pos++;
      digits++;
    }
    if (digits === 0) throw new Error('PGM: bad header');
    fields.push(value);
  }
  const [width = 0, height = 0, maxval = 0] = fields;
  if (maxval !== 255) throw new Error(`PGM: maxval ${maxval}, expected 255`);
  const offset = pos + 1;
  if (bytes.length < offset + width * height) throw new Error('PGM: truncated');
  return { width, height, offset };
}
