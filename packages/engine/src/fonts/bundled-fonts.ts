/**
 * URLs and loading of the bundled font files (assets/fonts). `new URL(…, import.meta.url)`
 * makes the bundler emit each TTF as a separate hashed asset, fetched only when a face is
 * first used: by the assembler (in its worker) when an export embeds it, and by the app's
 * furniture preview (as a FontFace). The fonts are never part of a JavaScript chunk.
 */
import type { BundledFace } from './font-catalog';

const URLS: Readonly<Record<string, string>> = {
  'Inter-Regular': new URL('../../assets/fonts/Inter-Regular.ttf', import.meta.url).href,
  'Inter-Bold': new URL('../../assets/fonts/Inter-Bold.ttf', import.meta.url).href,
  'JetBrainsMono-Regular': new URL('../../assets/fonts/JetBrainsMono-Regular.ttf', import.meta.url)
    .href,
  'NotoSerif-Regular': new URL('../../assets/fonts/NotoSerif-Regular.ttf', import.meta.url).href,
  'NotoSerif-Bold': new URL('../../assets/fonts/NotoSerif-Bold.ttf', import.meta.url).href,
};

/** URL of a bundled face's TTF. */
export function bundledFontUrl(face: BundledFace): string {
  const url = URLS[face.key];
  if (url === undefined) throw new Error(`Unknown bundled font ${face.key}`);
  return url;
}

const cache = new Map<string, Promise<Uint8Array>>();

/** Fetches a bundled face's bytes once per realm (worker or window). */
export function loadBundledFont(face: BundledFace): Promise<Uint8Array> {
  let pending = cache.get(face.key);
  if (!pending) {
    pending = fetch(bundledFontUrl(face)).then(async (response) => {
      if (!response.ok) throw new Error(`Font ${face.key}: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    pending.catch(() => cache.delete(face.key));
    cache.set(face.key, pending);
  }
  return pending;
}
