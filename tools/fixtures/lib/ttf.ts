/**
 * Adds a Windows Unicode BMP (3,1) cmap to a TrueType subset produced by
 * fontkit (whose subsetter drops the cmap because pdf-lib addresses glyphs by
 * CID). A simple /TrueType font with /WinAnsiEncoding needs that cmap: readers
 * map code -> glyph name -> Unicode -> glyph through it.
 */

function cmapFormat4(map: ReadonlyMap<number, number>): Uint8Array {
  const codes = [...map.keys()].sort((a, b) => a - b);
  const segCount = codes.length + 1; // one segment per code, plus the 0xFFFF terminator
  const subLength = 16 + segCount * 8;
  const out = new DataView(new ArrayBuffer(12 + subLength));
  out.setUint16(0, 0); // version
  out.setUint16(2, 1); // numTables
  out.setUint16(4, 3); // platform: Windows
  out.setUint16(6, 1); // encoding: Unicode BMP
  out.setUint32(8, 12); // offset of the subtable
  const s = 12;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  out.setUint16(s, 4); // format
  out.setUint16(s + 2, subLength);
  out.setUint16(s + 4, 0); // language
  out.setUint16(s + 6, segCount * 2);
  out.setUint16(s + 8, searchRange);
  out.setUint16(s + 10, Math.log2(searchRange / 2));
  out.setUint16(s + 12, segCount * 2 - searchRange);
  const ends = s + 14;
  const starts = ends + segCount * 2 + 2; // after reservedPad
  const deltas = starts + segCount * 2;
  const offsets = deltas + segCount * 2;
  [...codes, 0xffff].forEach((code, i) => {
    const gid = code === 0xffff ? 0 : (map.get(code) ?? 0);
    out.setUint16(ends + i * 2, code);
    out.setUint16(starts + i * 2, code);
    out.setUint16(deltas + i * 2, code === 0xffff ? 1 : (gid - code) & 0xffff);
    out.setUint16(offsets + i * 2, 0);
  });
  return new Uint8Array(out.buffer);
}

function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  return sum;
}

/** Returns `font` (an sfnt) with a new cmap table mapping Unicode -> glyph id. */
export function withCmap(font: Uint8Array, map: ReadonlyMap<number, number>): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = view.getUint16(4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(...font.subarray(rec, rec + 4));
    const offset = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    tables.set(tag, font.slice(offset, offset + length));
  }
  tables.set('cmap', cmapFormat4(map));
  const head = tables.get('head');
  if (!head) throw new Error('font has no head table');
  new DataView(head.buffer).setUint32(8, 0); // checkSumAdjustment, fixed up below

  const tags = [...tables.keys()].sort();
  const n = tags.length;
  const headerLength = 12 + n * 16;
  const total = tags.reduce(
    (len, tag) => len + Math.ceil((tables.get(tag)?.length ?? 0) / 4) * 4,
    0,
  );
  const out = new Uint8Array(headerLength + total);
  const ov = new DataView(out.buffer);
  const searchRange = 16 * 2 ** Math.floor(Math.log2(n));
  ov.setUint32(0, view.getUint32(0)); // sfnt version
  ov.setUint16(4, n);
  ov.setUint16(6, searchRange);
  ov.setUint16(8, Math.log2(searchRange / 16));
  ov.setUint16(10, n * 16 - searchRange);
  let offset = headerLength;
  let headOffset = 0;
  tags.forEach((tag, i) => {
    const data = tables.get(tag) ?? new Uint8Array();
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = tag.charCodeAt(k);
    ov.setUint32(rec + 4, checksum(data));
    ov.setUint32(rec + 8, offset);
    ov.setUint32(rec + 12, data.length);
    out.set(data, offset);
    if (tag === 'head') headOffset = offset;
    offset += Math.ceil(data.length / 4) * 4;
  });
  ov.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}
