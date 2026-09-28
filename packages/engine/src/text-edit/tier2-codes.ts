/**
 * Tier-2 character codes (review M3): the code each replacement character is written with
 * in the original font. PDFium's own `FPDFText_SetText` picks one code per Unicode value,
 * which is wrong when the font maps several codes to the same character with different
 * glyphs (an alternate or small-cap "A" whose /ToUnicode says "A"). So the editor finds
 * every code the font reads as each character and requires them to draw one glyph:
 *
 * - candidates: simple fonts, all 256 codes; Type0 fonts with an Identity encoding, the
 *   codes their /ToUnicode maps to the character (other Type0 fonts: none we can trust);
 * - PDFium reads each candidate on a text page (probe.ts; map errors excluded), so the
 *   mapping is the one the read-back uses;
 * - candidates that draw the same glyph (same advance and box, same rendering, like
 *   WinAnsi's space and no-break space, or hyphen and soft hyphen) count as one;
 * - otherwise the character is `ambiguous-encoding` (tier 2 refused, tier 1 used).
 */
import type { ObjectAnalysis } from './analysis';
import type { CodeProbe, CodeProbes } from './probe';

const METRIC_TOLERANCE = 0.02;

export type CodeChoice =
  | { readonly ok: true; readonly codes: readonly number[] }
  | {
      readonly ok: false;
      readonly reason: 'ambiguous-encoding' | 'missing-glyphs';
      readonly chars: readonly string[];
    };

/** Codes to probe for tier 2 (undefined: the font's codes cannot be enumerated). */
export function tier2Candidates(
  analysis: Pick<ObjectAnalysis, 'type0' | 'identity' | 'toUnicode'>,
  replacement: string,
): number[] | undefined {
  if (!analysis.type0) return Array.from({ length: 256 }, (_, i) => i);
  if (!analysis.identity || !analysis.toUnicode) return undefined;
  const wanted = new Set(Array.from(replacement));
  const out: number[] = [];
  for (const [code, text] of analysis.toUnicode) if (wanted.has(text)) out.push(code);
  return out;
}

function sameMetrics(a: CodeProbe, b: CodeProbe): boolean {
  const close = (x: number, y: number) =>
    (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) <= METRIC_TOLERANCE;
  return (
    close(a.advance, b.advance) &&
    close(a.box.x, b.box.x) &&
    close(a.box.y, b.box.y) &&
    close(a.box.width, b.box.width) &&
    close(a.box.height, b.box.height)
  );
}

/** The code for each character of `replacement`, or why there is none. */
export function chooseTier2Codes(
  probes: CodeProbes | undefined,
  analysis: ObjectAnalysis,
  replacement: string,
  /** Tests only: a character without a code gets an arbitrary one (the read-back must catch it). */
  lenient = false,
): CodeChoice {
  const chars = Array.from(replacement);
  const wanted = [...new Set(chars)];
  if (chars.length === 0) return { ok: true, codes: [] };
  if (!probes) return { ok: false, reason: 'ambiguous-encoding', chars: wanted };
  const all = [...probes.results.values()].sort((a, b) => a.code - b.code);
  const choice = new Map<string, number | 'ambiguous' | 'missing'>();
  for (const ch of wanted) {
    const candidates = all.filter((p) => p.text === ch && !p.mapError);
    const [head, ...rest] = candidates;
    if (!head) {
      choice.set(ch, 'missing');
      continue;
    }
    const single =
      rest.every((p) => sameMetrics(p, head)) &&
      rest.every((p) => probes.sameRendering(head.code, p.code));
    if (!single) {
      choice.set(ch, 'ambiguous');
      continue;
    }
    // Equivalent codes: the one numbered like the character (a space is 32, which keeps
    // Tw applying), else the lowest.
    const natural = candidates.find((p) => p.code === ch.codePointAt(0));
    choice.set(ch, (natural ?? head).code);
  }
  const codes: number[] = [];
  const ambiguous: string[] = [];
  const missing: string[] = [];
  for (const ch of chars) {
    const c = choice.get(ch);
    if (c === 'ambiguous') {
      if (!ambiguous.includes(ch)) ambiguous.push(ch);
    } else if (c === 'missing' || c === undefined) {
      if (lenient) codes.push((ch.codePointAt(0) ?? 0) & (analysis.type0 ? 0xffff : 0xff));
      else if (!missing.includes(ch)) missing.push(ch);
    } else {
      codes.push(c);
    }
  }
  if (ambiguous.length > 0) return { ok: false, reason: 'ambiguous-encoding', chars: ambiguous };
  if (missing.length > 0) return { ok: false, reason: 'missing-glyphs', chars: missing };
  return { ok: true, codes };
}
