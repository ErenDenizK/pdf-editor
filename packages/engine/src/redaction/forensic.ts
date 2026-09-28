/**
 * Forensic self-check of a redacted file (spec redaction §1.2 step 5, research 06 §4), run
 * on the exact bytes offered for download. Checks, in report order:
 *
 * - `parse`: pdf-lib parses the file (with `options.password` when encrypted);
 * - `single-revision` (1): one `startxref`, one `%%EOF`, no /Prev in any trailer or
 *   cross-reference stream;
 * - `no-unreachable-objects` (2): every indirect object is reachable from the trailer
 *   (object and cross-reference streams excepted);
 * - `no-text-in-areas` (3): no non-blank glyph box intersects an area, except the overlay
 *   text drawn there (`deps.getPageText`; boxes are whole points, so a glyph must overlap
 *   the area by more than 1 pt);
 * - `no-search-hits` (4): searching the whole document for each redacted string finds
 *   nothing (`deps.search`);
 * - `object-strings` (5): no decoded string, name or decodable stream of any object
 *   contains a redacted string;
 * - `byte-grep` (6): nor do the raw bytes or any inflated stream, in every encoding of
 *   `byte-grep.ts`;
 * - `no-annotations-in-areas` (7): no annotation or widget intersects an area, and no
 *   /Redact mark is left;
 * - `fill-pixels` (8): a scale-2 render of each area (`deps.renderArea`, with annotations
 *   and forms) is at least 99 % fill colour, overlay text colour and the blend between
 *   them allowed.
 *
 * Deterministic (fixed order, no randomness) and total: it never throws. A parse failure,
 * or an error from a dependency, is a failing check with the reason as its finding.
 */

import type { PDFDocument } from '@cantoo/pdf-lib';
import type { Rect } from '@pdf-editor/document-model';

import { loadForReading } from '../pdflib/inspect';
import type {
  ForensicCheckId,
  ForensicCheckResult,
  ForensicDeps,
  ForensicFinding,
  ForensicReport,
  RedactionPlan,
} from '../types';
import { byteVariants } from './byte-grep';
import {
  byteGrepFindings,
  encryptRefs,
  type GrepTarget,
  readRawFile,
  singleRevisionFindings,
} from './forensic-file';
import {
  annotationFindings,
  attachmentNames,
  objectStringFindings,
  unreachableFindings,
} from './forensic-objects';
import { BLACK, contrastingColor, intersects, parseColor, type Rgb } from './pdf-util';
import { normalizeForMatch, RedactedStringMatcher } from './strings';

export interface ForensicOptions {
  /** User password of an encrypted output. */
  readonly password?: string;
}

/** Findings listed per check; the rest is summarised by `truncated`. */
const MAX_FINDINGS = 50;
/** Render scale of the pixel check, and the device pixels ignored along each edge. */
const SCALE = 2;
const INSET = 2;
/** Share of area pixels that must be fill (or overlay) colour. */
const MIN_FILL_SHARE = 0.99;
/** Per-channel tolerance (0–255) of the pixel comparison. */
const TOLERANCE = 24;
/**
 * Glyph boxes from PDFium (through EmbedPDF) are rounded to whole points, so a glyph next to
 * an area can touch it by a fraction of a point although the engine, which works with exact
 * boxes, correctly kept it. A glyph counts as inside when it overlaps the area by more than
 * this in both directions (less for tiny areas).
 */
const GLYPH_TOLERANCE = 1;

/** `rect` shrunk by the glyph tolerance on every side. */
function glyphProbe(rect: Rect): Rect {
  const dx = Math.min(GLYPH_TOLERANCE, rect.width / 4);
  const dy = Math.min(GLYPH_TOLERANCE, rect.height / 4);
  return {
    x: rect.x + dx,
    y: rect.y + dy,
    width: rect.width - 2 * dx,
    height: rect.height - 2 * dy,
  };
}

function result(id: ForensicCheckId, findings: readonly ForensicFinding[], note?: string) {
  const out: ForensicCheckResult = {
    id,
    passed: findings.length === 0,
    findings: findings.slice(0, MAX_FINDINGS),
    ...(findings.length > MAX_FINDINGS ? { truncated: true } : {}),
    ...(note === undefined ? {} : { note }),
  };
  return out;
}

async function guarded(
  id: ForensicCheckId,
  run: () => Promise<ForensicCheckResult> | ForensicCheckResult,
): Promise<ForensicCheckResult> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return result(id, [{ where: 'check', channel: 'error', detail }]);
  }
}

const notParsed = (id: ForensicCheckId) =>
  result(id, [{ where: 'file', channel: 'parse', detail: 'the file could not be parsed' }]);

/** Distance test of a pixel to the segment between two colours (0–255 components). */
function nearSegment(p: Rgb, a: Rgb, b: Rgb): boolean {
  const [dr, dg, db] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = dr * dr + dg * dg + db * db;
  const t =
    len > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dr + (p[1] - a[1]) * dg + (p[2] - a[2]) * db) / len),
        )
      : 0;
  return (
    Math.abs(p[0] - (a[0] + t * dr)) <= TOLERANCE &&
    Math.abs(p[1] - (a[1] + t * dg)) <= TOLERANCE &&
    Math.abs(p[2] - (a[2] + t * db)) <= TOLERANCE
  );
}

/**
 * Runs every check of the module comment on `bytes` for `plan` (the plan the scrub used:
 * areas, strings, fill and overlay). `deps` must be bound to the same bytes.
 */
export async function forensicCheck(
  bytes: ArrayBuffer | Uint8Array,
  plan: RedactionPlan,
  deps: ForensicDeps,
  options: ForensicOptions = {},
): Promise<ForensicReport> {
  const raw = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  const matcher = new RedactedStringMatcher(plan.strings);
  const strings = plan.strings.map((s) => s.trim()).filter((s) => normalizeForMatch(s) !== '');
  const targets: GrepTarget[] = plan.strings
    .map((s, stringIndex) => ({ stringIndex, variants: byteVariants(s) }))
    .filter((t) => t.variants.length > 0);
  const fill = parseColor(plan.fillColor) ?? BLACK;
  const overlay = parseColor(plan.overlayColor) ?? contrastingColor(fill);
  const checks: ForensicCheckResult[] = [];
  let notSearched: string[] = [];
  let unverified: string[] = [];

  // Parse.
  let doc: PDFDocument | undefined;
  let pageCount = 0;
  checks.push(
    await guarded('parse', async () => {
      const parsed = await loadForReading(raw.slice(), options.password);
      if (!parsed) {
        return result('parse', [
          { where: 'file', channel: 'parse', detail: 'pdf-lib could not parse the file' },
        ]);
      }
      pageCount = parsed.getPageCount(); // throws without a page tree
      doc = parsed;
      return result('parse', []);
    }),
  );
  const areasByPage = new Map<number, Rect[]>();
  const areaProblems: ForensicFinding[] = [];
  plan.areas.forEach((area, areaIndex) => {
    if (
      doc &&
      (area.pageIndex < 0 || area.pageIndex >= pageCount || !Number.isInteger(area.pageIndex))
    ) {
      areaProblems.push({
        where: `area ${areaIndex}`,
        areaIndex,
        channel: 'plan',
        detail: `page ${area.pageIndex + 1} does not exist`,
      });
      return;
    }
    areasByPage.set(area.pageIndex, [...(areasByPage.get(area.pageIndex) ?? []), area.rect]);
  });

  // 1. Single revision.
  const file = readRawFile(raw);
  checks.push(
    await guarded('single-revision', () => result('single-revision', singleRevisionFindings(file))),
  );

  // 2. Unreachable objects.
  checks.push(
    await guarded('no-unreachable-objects', () =>
      doc
        ? result('no-unreachable-objects', unreachableFindings(doc, encryptRefs(file)))
        : notParsed('no-unreachable-objects'),
    ),
  );

  // 3. Text in areas.
  checks.push(
    await guarded('no-text-in-areas', async () => {
      const findings: ForensicFinding[] = [...areaProblems];
      const pages = [...new Set(plan.areas.map((a) => a.pageIndex))].sort((a, b) => a - b);
      for (const pageIndex of pages) {
        if (doc && (pageIndex < 0 || pageIndex >= pageCount)) continue;
        const glyphs = (await deps.getPageText(pageIndex)).flatMap((run) => run.glyphs);
        const overlays = plan.areas
          .filter((a) => a.pageIndex === pageIndex)
          .map((a) => a.overlayText ?? plan.overlayText ?? '')
          // The scrub never draws an overlay containing a redacted string: no excuse for it.
          .filter((t) => !matcher.matches(t))
          .map((t) => normalizeForMatch(t))
          .filter((t) => t !== '');
        plan.areas.forEach((area, areaIndex) => {
          if (area.pageIndex !== pageIndex) return;
          const probe = glyphProbe(area.rect);
          const inside = glyphs.filter((g) => g.text.trim() !== '' && intersects(g.rect, probe));
          let rest = normalizeForMatch(inside.map((g) => g.text).join(''));
          for (const text of overlays) rest = rest.split(text).join('');
          if (rest !== '') {
            findings.push({
              where: `page ${pageIndex + 1}, area ${areaIndex}`,
              pageIndex,
              areaIndex,
              channel: 'text',
              detail: `${rest.length} extractable characters`,
            });
          }
        });
      }
      return result('no-text-in-areas', findings);
    }),
  );

  // 4. Search.
  checks.push(
    await guarded('no-search-hits', async () => {
      const findings: ForensicFinding[] = [];
      for (const [stringIndex, s] of strings.entries()) {
        for (const hit of await deps.search(s)) {
          findings.push({
            where: `page ${hit.pageIndex + 1}`,
            pageIndex: hit.pageIndex,
            channel: 'search',
            detail: `redacted string ${stringIndex}`,
          });
        }
      }
      return result(
        'no-search-hits',
        findings,
        strings.length === 0 ? 'no redacted strings given' : undefined,
      );
    }),
  );

  // 5. Object strings.
  checks.push(
    await guarded('object-strings', () => {
      if (!doc) return notParsed('object-strings');
      const walk = objectStringFindings(doc, matcher, targets);
      notSearched = walk.notSearched;
      unverified = attachmentNames(doc);
      const note =
        walk.notSearched.length > 0
          ? `${walk.notSearched.length} streams could not be decoded (see notSearched)`
          : undefined;
      return result('object-strings', walk.findings, note);
    }),
  );

  // 6. Byte grep.
  checks.push(
    await guarded('byte-grep', () =>
      result(
        'byte-grep',
        byteGrepFindings(file, targets),
        `${file.payloads.length} streams searched`,
      ),
    ),
  );

  // 7. Annotations.
  checks.push(
    await guarded('no-annotations-in-areas', () =>
      doc
        ? result('no-annotations-in-areas', annotationFindings(doc, areasByPage))
        : notParsed('no-annotations-in-areas'),
    ),
  );

  // 8. Pixels.
  checks.push(
    await guarded('fill-pixels', async () => {
      const findings: ForensicFinding[] = [...areaProblems];
      const fill255: Rgb = [fill[0] * 255, fill[1] * 255, fill[2] * 255];
      const overlay255: Rgb = [overlay[0] * 255, overlay[1] * 255, overlay[2] * 255];
      for (const [areaIndex, area] of plan.areas.entries()) {
        if (areaProblems.some((p) => p.areaIndex === areaIndex)) continue;
        const withText = (area.overlayText ?? plan.overlayText ?? '').trim() !== '';
        const px = await deps.renderArea(area.pageIndex, area.rect, SCALE);
        const inset = (n: number) => Math.min(INSET, Math.max(0, Math.floor((n - 1) / 2)));
        const [ix, iy] = [inset(px.width), inset(px.height)];
        let ok = 0;
        let total = 0;
        let [sr, sg, sb] = [0, 0, 0];
        for (let y = iy; y < px.height - iy; y++) {
          for (let x = ix; x < px.width - ix; x++) {
            const i = (y * px.width + x) * 4;
            const p: Rgb = [px.data[i] ?? 0, px.data[i + 1] ?? 0, px.data[i + 2] ?? 0];
            sr += p[0];
            sg += p[1];
            sb += p[2];
            total++;
            if (withText ? nearSegment(p, fill255, overlay255) : nearSegment(p, fill255, fill255))
              ok++;
          }
        }
        const share = total === 0 ? 0 : ok / total;
        if (share < MIN_FILL_SHARE) {
          const mean = [sr, sg, sb].map((v) => Math.round(v / Math.max(total, 1))).join(', ');
          findings.push({
            where: `page ${area.pageIndex + 1}, area ${areaIndex}`,
            pageIndex: area.pageIndex,
            areaIndex,
            channel: 'pixels',
            detail:
              total === 0
                ? 'nothing rendered'
                : `${(share * 100).toFixed(1)} % fill colour, mean rgb(${mean})`,
          });
        }
      }
      return result('fill-pixels', findings);
    }),
  );

  return {
    ok: checks.every((c) => c.passed),
    checks,
    notSearched,
    unverifiedAttachments: unverified,
  };
}
