/**
 * Area-averaging downsampling (a box filter with exact fractional coverage): every output
 * pixel is the mean of the source area it covers. For reduction this is the classic
 * high-quality choice (no aliasing, no ringing); it is what Photoshop calls "Bicubic
 * Sharper"-free averaging and what Ghostscript's /Average downsampling does. Separable:
 * a horizontal pass into floats, then a vertical pass.
 */

/** Resamples RGBA `src` (sw × sh) to dw × dh (dw ≤ sw, dh ≤ sh). */
export function downsampleArea(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  if (dw === sw && dh === sh) return src;
  if (dw > sw || dh > sh || dw < 1 || dh < 1) {
    throw new RangeError(`downsampleArea: ${sw}x${sh} -> ${dw}x${dh} is not a reduction`);
  }
  const horizontal = new Float32Array(dw * sh * 4);
  const xs = weights(sw, dw);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    const out = y * dw * 4;
    for (let x = 0; x < dw; x++) {
      const { start, w } = xs[x] as Span;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < w.length; k++) {
        const weight = w[k] as number;
        const s = row + (start + k) * 4;
        r += (src[s] as number) * weight;
        g += (src[s + 1] as number) * weight;
        b += (src[s + 2] as number) * weight;
        a += (src[s + 3] as number) * weight;
      }
      const o = out + x * 4;
      horizontal[o] = r;
      horizontal[o + 1] = g;
      horizontal[o + 2] = b;
      horizontal[o + 3] = a;
    }
  }
  const result = new Uint8ClampedArray(dw * dh * 4);
  const ys = weights(sh, dh);
  for (let y = 0; y < dh; y++) {
    const { start, w } = ys[y] as Span;
    for (let x = 0; x < dw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < w.length; k++) {
        const weight = w[k] as number;
        const s = ((start + k) * dw + x) * 4;
        r += (horizontal[s] as number) * weight;
        g += (horizontal[s + 1] as number) * weight;
        b += (horizontal[s + 2] as number) * weight;
        a += (horizontal[s + 3] as number) * weight;
      }
      const o = (y * dw + x) * 4;
      result[o] = r + 0.5;
      result[o + 1] = g + 0.5;
      result[o + 2] = b + 0.5;
      result[o + 3] = a + 0.5;
    }
  }
  return result;
}

interface Span {
  readonly start: number;
  readonly w: Float32Array;
}

/** Coverage weights of source cells for each destination cell (sum to 1). */
function weights(source: number, dest: number): Span[] {
  const scale = source / dest;
  const spans: Span[] = [];
  for (let i = 0; i < dest; i++) {
    const from = i * scale;
    const to = from + scale;
    const start = Math.floor(from);
    const end = Math.min(source, Math.ceil(to));
    const w = new Float32Array(end - start);
    for (let k = start; k < end; k++) {
      const cover = Math.min(to, k + 1) - Math.max(from, k);
      w[k - start] = cover / scale;
    }
    spans.push({ start, w });
  }
  return spans;
}
