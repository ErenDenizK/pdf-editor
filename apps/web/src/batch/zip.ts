/**
 * A minimal ZIP writer for the batch outputs (APPNOTE 6.3.10, "stored" entries only). PDFs,
 * PNG/JPEG/WebP files and the image ZIPs are compressed already, so deflating them again
 * would cost time for a few bytes. Each entry's CRC-32 is computed once, when the output is
 * produced (`zipEntry`), and the archive is a `Blob` stitched from small headers and the
 * outputs' own Blobs, so building it never copies the outputs into one buffer (the browser
 * may keep large Blobs on disk). Names are UTF-8 (general purpose flag bit 11). No ZIP64:
 * archives stay below 4 GiB and 65,535 entries (`ZipLimitError` otherwise).
 */

export interface ZipEntry {
  /** File name inside the archive (no directories). */
  readonly name: string;
  readonly data: Blob;
  readonly crc32: number;
}

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC, as ZIP uses it) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** An entry for `bytes` (checksummed now; the bytes then live in a Blob). */
export function zipEntry(
  name: string,
  bytes: ArrayBuffer,
  type = 'application/octet-stream',
): ZipEntry {
  return { name, data: new Blob([bytes], { type }), crc32: crc32(new Uint8Array(bytes)) };
}

const MAX_32 = 0xffffffff;

/** MS-DOS date and time of `date` (local time, 2-second resolution, 1980 at the earliest). */
function dosDateTime(date: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The archive of `entries`, in order, as `application/zip`. */
export function buildZip(entries: readonly ZipEntry[], modified: Date = new Date()): Blob {
  if (entries.length > 0xffff) throw new ZipLimitError('Too many files for one ZIP');
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    if (size > MAX_32 || offset > MAX_32) throw new ZipLimitError('The ZIP would exceed 4 GiB');
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed: 2.0
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, entry.crc32, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    new Uint8Array(local.buffer).set(name, 30);
    parts.push(local.buffer, entry.data);

    const header = new DataView(new ArrayBuffer(46 + name.length));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // made by: 2.0, MS-DOS attributes
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, stamp.time, true);
    header.setUint16(14, stamp.date, true);
    header.setUint32(16, entry.crc32, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    // Extra, comment, disk number, internal and external attributes: zero.
    header.setUint32(42, offset, true);
    const bytes = new Uint8Array(header.buffer);
    bytes.set(name, 46);
    central.push(bytes);
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0);
  if (offset > MAX_32 || offset + centralSize > MAX_32) {
    throw new ZipLimitError('The ZIP would exceed 4 GiB');
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  for (const bytes of central) parts.push(bytes as Uint8Array<ArrayBuffer>);
  parts.push(end.buffer);
  return new Blob(parts, { type: 'application/zip' });
}
