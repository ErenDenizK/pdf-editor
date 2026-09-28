/**
 * LRU cache of rendered page bitmaps with a byte budget (light-table spec §7).
 *
 * Keys are `${sourceId}:${index}:${rotation}:${scale}`, where the scale (device pixels per
 * point, called `bucket` here) is a quarter-octave bucket (thumbnails) or an exact scale
 * rounded to 4 decimals (Read mode; `chooseScale` in engine-service.ts). Exact scales add a
 * variant per settled zoom level; the byte budget bounds them like any other entry.
 *
 * The cache owns its bitmaps: evicted or replaced bitmaps are `close()`d immediately, so
 * callers draw a bitmap onto their own canvas as soon as they receive it and never keep a
 * reference. A closed bitmap reports `width === 0`; callers that race an eviction simply
 * request the page again.
 */

export interface CachedBitmap {
  readonly key: string;
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly bucket: number;
}

/** Page identity without the scale: every scale of one rendered page shares it. */
export function pageKey(sourceId: string, index: number, rotation: number): string {
  return `${sourceId}:${index}:${rotation}`;
}

export function bitmapKey(
  sourceId: string,
  index: number,
  rotation: number,
  bucket: number,
): string {
  return `${pageKey(sourceId, index, rotation)}:${bucket}`;
}

/** RGBA, 4 bytes per pixel. */
export function bitmapBytes(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height) * 4;
}

export const DEFAULT_CACHE_BUDGET_BYTES = 150 * 1024 * 1024;

export class BitmapCache {
  /** Map iteration order is insertion order: first = least recently used. */
  private readonly entries = new Map<string, CachedBitmap>();
  /** pageKey -> scales present (any number), for "best lower-resolution bitmap" lookups. */
  private readonly buckets = new Map<string, Set<number>>();
  private bytes = 0;

  constructor(readonly budgetBytes: number = DEFAULT_CACHE_BUDGET_BYTES) {}

  get size(): number {
    return this.entries.size;
  }

  get usedBytes(): number {
    return this.bytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Returns the entry and marks it most recently used. */
  get(key: string): CachedBitmap | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  /**
   * Largest cached scale of a page that is <= `maxBucket` (or the smallest one above it
   * when `allowLarger`); used to show a stretched preview while the right scale renders.
   * Scales are compared as numbers, so buckets and exact scales mix freely.
   */
  best(page: string, maxBucket: number, allowLarger = false): CachedBitmap | undefined {
    const set = this.buckets.get(page);
    if (set === undefined || set.size === 0) return undefined;
    let below: number | undefined;
    let above: number | undefined;
    for (const bucket of set) {
      if (bucket <= maxBucket) {
        if (below === undefined || bucket > below) below = bucket;
      } else if (above === undefined || bucket < above) {
        above = bucket;
      }
    }
    const chosen = below ?? (allowLarger ? above : undefined);
    return chosen === undefined ? undefined : this.get(`${page}:${chosen}`);
  }

  /** Inserts (replacing and closing any previous bitmap under the key), then evicts. */
  set(page: string, entry: CachedBitmap): void {
    const previous = this.entries.get(entry.key);
    if (previous !== undefined) this.remove(entry.key);
    const size = bitmapBytes(entry.width, entry.height);
    this.entries.set(entry.key, entry);
    this.bytes += size;
    let set = this.buckets.get(page);
    if (set === undefined) {
      set = new Set();
      this.buckets.set(page, set);
    }
    set.add(entry.bucket);
    this.evict(entry.key);
  }

  /** Removes one entry and closes its bitmap. */
  remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.bytes -= bitmapBytes(entry.width, entry.height);
    const page = key.slice(0, key.lastIndexOf(':'));
    const set = this.buckets.get(page);
    set?.delete(entry.bucket);
    if (set?.size === 0) this.buckets.delete(page);
    entry.bitmap.close();
  }

  /** Drops every bitmap whose key starts with `${sourceId}:`. */
  removeSource(sourceId: string): void {
    this.removePrefix(`${sourceId}:`);
  }

  /** Drops every bitmap whose key starts with `prefix` (e.g. one page: `${source}:${index}:`). */
  removePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key);
  }

  /** Evicts least recently used entries until within budget; never the newest entry. */
  private evict(keep: string): void {
    if (this.bytes <= this.budgetBytes) return;
    for (const key of [...this.entries.keys()]) {
      if (this.bytes <= this.budgetBytes) break;
      if (key !== keep) this.remove(key);
    }
  }
}
