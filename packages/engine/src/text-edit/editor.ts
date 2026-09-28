/**
 * `PdfTextEditor` on the PDFium host (ADR-0011 §4): every call is one `withRawAccess` on the
 * source, so it runs as a task on the orchestrator's queue, exclusive per source, and never
 * awaits engine or adapter calls. Reads use a fresh text page; every committed edit is
 * followed by `GenerateContent` and dropping the executor's cached page.
 *
 * In the app the editor lives in the PDFium worker (`pdfium.worker.ts`) next to the adapter
 * and is reached through `PdfiumProxy`; tests construct it on the calling thread with
 * `createTextEditor(await createHostedEngine(...))`.
 */
import type { Font } from '@cantoo/fontkit';
import type { SourceId } from '@pdf-editor/document-model';

import type { BundledFace } from '../fonts/font-catalog';
import type { HostedEngine, RawAccess } from '../pdfium/host/hosted-engine';
import type {
  EngineCallOptions,
  LocatedRun,
  PdfTextEditor,
  TextEditability,
  TextEditQuery,
  TextEditRequest,
  TextEditResult,
  TextFitOption,
  TextTier2Refusal,
} from '../types';
import { type EditPlan, performEdit } from './apply';
import {
  blockerOf,
  fitOption,
  fittedSize,
  freeSpace,
  type GlyphRange,
  glyphRange,
  honestyOf,
  tier1Width,
  tier2Precheck,
  tier2Width,
  type Tier2Check,
} from './editability';
import { textEditError } from './errors';
import {
  FaceCache,
  type FaceLoader,
  faceByKey,
  faceCandidates,
  familyName,
  isBlank,
  missingInFace,
  substituteFace,
} from './fonts';
import { locatePage, type ResolvedRun, resolveRun } from './locate';
import { RawText } from './raw';

export interface TextEditorOptions {
  /** Loads bundled face programs (default: `loadBundledFont`, fetched once per realm). */
  readonly loadFace?: FaceLoader;
  /**
   * Tests only: skip the tier-2 glyph pre-check so the read-back is the only guard (the
   * fixtures have no font whose pre-check passes and read-back fails).
   */
  readonly skipTier2Precheck?: boolean;
}

/** The raw-access part of `HostedEngine` the editor needs. */
export type TextEditorHost = Pick<HostedEngine, 'withRawAccess'>;

interface Resolved {
  readonly run: ResolvedRun;
  readonly range: GlyphRange;
  readonly space: ReturnType<typeof freeSpace>;
  readonly pagePtr: number;
  /**
   * Drops the page reference taken by `resolve` when nothing was changed. After
   * `performEdit` the page is closed already and this must not be called.
   */
  readonly release: () => void;
}

type Tier1Choice =
  | { readonly ok: true; readonly face: BundledFace; readonly font: Font }
  | { readonly ok: false; readonly missing: string[] };

function withSignal(options: EngineCallOptions | undefined) {
  return options?.signal ? { signal: options.signal } : {};
}

/** The replacement's size for `request` (releases the page when it does not fit). */
function sizeFor(resolved: Resolved, request: TextEditRequest, width: number): number {
  try {
    return (
      request.fontSize ??
      fittedSize(resolved.run.info.size, fitOption(width, resolved.space.available), request.fit)
    );
  } catch (error) {
    resolved.release();
    throw error;
  }
}

function planOf(
  query: TextEditQuery,
  resolved: Resolved,
  tier: 1 | 2,
  size: number,
  face?: EditPlan['face'],
): EditPlan {
  return {
    pageIndex: query.run.pageIndex,
    pagePtr: resolved.pagePtr,
    run: resolved.run,
    range: resolved.range,
    replacement: query.replacement,
    tier,
    size,
    ...(face ? { face } : {}),
    space: resolved.space,
  };
}

/** The text editor of a hosted engine. */
export class HostedTextEditor implements PdfTextEditor {
  private readonly faces: FaceCache;
  private readonly skipPrecheck: boolean;

  constructor(
    private readonly host: TextEditorHost,
    options: TextEditorOptions = {},
  ) {
    this.faces = new FaceCache(options.loadFace);
    this.skipPrecheck = options.skipTier2Precheck === true;
  }

  private precheck(raw: RawText, resolved: Resolved, replacement: string): Tier2Check {
    const check = tier2Precheck(raw, resolved.run.info, replacement);
    if (!this.skipPrecheck || check.ok) return check;
    return check.reason === 'missing-glyphs' || check.reason === 'outside-winansi'
      ? { ok: true }
      : check;
  }

  locateRuns(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly LocatedRun[]> {
    return this.host.withRawAccess(
      source,
      (access) => {
        const raw = new RawText(access.module, access.memory);
        const page = access.doc.acquirePage(pageIndex);
        try {
          return raw.withTextPage(page.pagePtr, (textPage) =>
            locatePage(raw, page.pagePtr, textPage, source, pageIndex),
          );
        } finally {
          page.release();
        }
      },
      withSignal(options),
    );
  }

  checkEditability(query: TextEditQuery, options?: EngineCallOptions): Promise<TextEditability> {
    return this.host.withRawAccess(
      query.run.source,
      async (access) => {
        const raw = new RawText(access.module, access.memory);
        const resolved = this.resolve(access, raw, query);
        const { info } = resolved.run;
        const blocker = blockerOf(info);
        let tier2: Tier2Check = this.precheck(raw, resolved, query.replacement);
        const tier2Fit: TextFitOption | undefined = tier2.ok
          ? fitOption(tier2Width(raw, info, query.replacement, info.size), resolved.space.available)
          : undefined;
        // Dry run of tier 2 (closes the page without GenerateContent): the read-back is the
        // only reliable signal (a missing char may map to a glyph that has an outline).
        if (tier2.ok && query.replacement.length > 0) {
          const outcome = performEdit(access, raw, planOf(query, resolved, 2, info.size), false);
          if (!outcome.ok) {
            const missing = [...new Set(query.replacement)].filter(
              (c) => !isBlank(c) && !outcome.replacementReadback.includes(c),
            );
            tier2 = { ok: false, reason: 'readback', missing };
          }
        } else {
          resolved.release();
        }
        const choice = blocker ? undefined : await this.tier1Face(resolved, query.replacement);
        const tier1: TextEditability['tier1'] = blocker
          ? { ok: false, reason: blocker }
          : choice?.ok
            ? { ok: true, substitute: choice.face.key, family: familyName(choice.face) }
            : { ok: false, reason: 'unsupported-chars', missing: choice?.missing ?? [] };
        const tier1Fit =
          choice?.ok === true
            ? fitOption(
                tier1Width(choice.font, info, query.replacement, info.size),
                resolved.space.available,
              )
            : undefined;
        const tier = blocker ? undefined : tier2.ok ? 2 : tier1.ok ? 1 : undefined;
        return {
          tier2: tier2.ok ? { ok: true } : tier2,
          tier1,
          ...(tier === undefined ? {} : { tier }),
          honesty: tier === undefined ? 'not-editable' : honestyOf(tier, info),
          fit: {
            available: resolved.space.available,
            boundedByGlyph: resolved.space.boundedByGlyph,
            replaced: resolved.space.replaced,
            ...(tier2.ok && tier2Fit ? { tier2: tier2Fit } : {}),
            ...(tier1Fit ? { tier1: tier1Fit } : {}),
          },
        } satisfies TextEditability;
      },
      withSignal(options),
    );
  }

  applyTextEdit(request: TextEditRequest, options?: EngineCallOptions): Promise<TextEditResult> {
    return this.host.withRawAccess(
      request.run.source,
      async (access) => {
        const raw = new RawText(access.module, access.memory);
        let resolved = this.resolve(access, raw, request);
        const { info } = resolved.run;
        const blocker = blockerOf(info);
        if (blocker) {
          resolved.release();
          throw textEditError('not-editable', `This text cannot be edited (${blocker})`);
        }
        const tier2 = this.precheck(raw, resolved, request.replacement);
        let refusal: TextTier2Refusal | undefined = tier2.ok ? undefined : tier2.reason;
        let fellBack = false;
        if (request.tier === 2 && !tier2.ok) {
          resolved.release();
          throw textEditError(
            'not-editable',
            `The original font cannot take the replacement (${tier2.reason}${tier2.missing.length > 0 ? `: ${tier2.missing.join('')}` : ''})`,
          );
        }
        if (request.tier !== 1 && tier2.ok) {
          const size = sizeFor(
            resolved,
            request,
            tier2Width(raw, info, request.replacement, info.size),
          );
          const outcome = performEdit(access, raw, planOf(request, resolved, 2, size), true);
          if (outcome.committed) {
            return {
              tier: 2,
              honesty: honestyOf(2, info),
              fontSize: size,
              fellBack: false,
              verification: outcome.verification,
            };
          }
          if (request.tier === 2) {
            throw textEditError(
              'verification-failed',
              `Tier 2 read-back failed: ${outcome.failure ?? 'unknown'}`,
            );
          }
          // Fall back to tier 1 on the unchanged page.
          fellBack = true;
          refusal = 'readback';
          resolved = this.resolve(access, raw, request);
        }
        return this.applyTier1(access, raw, request, resolved, fellBack, refusal);
      },
      withSignal(options),
    );
  }

  private async applyTier1(
    access: RawAccess,
    raw: RawText,
    request: TextEditRequest,
    resolved: Resolved,
    fellBack: boolean,
    refusal: TextTier2Refusal | undefined,
  ): Promise<TextEditResult> {
    const { info } = resolved.run;
    let face: BundledFace;
    let font: Font;
    try {
      const forced = request.face === undefined ? undefined : faceByKey(request.face);
      if (request.face !== undefined && !forced) {
        throw textEditError('unsupported-chars', `Unknown bundled face ${request.face}`);
      }
      const choice = forced
        ? { ok: true as const, face: forced, font: await this.faces.get(forced) }
        : await this.tier1Face(resolved, request.replacement);
      if (!choice.ok) {
        throw textEditError(
          'unsupported-chars',
          `No bundled font has glyphs for ${choice.missing.join(' ')}`,
        );
      }
      face = choice.face;
      font = choice.font;
      const missing = missingInFace(font, request.replacement);
      if (missing.length > 0) {
        throw textEditError(
          'unsupported-chars',
          `${face.key} has no glyph for ${missing.join(' ')}`,
        );
      }
    } catch (error) {
      resolved.release();
      throw error;
    }
    const size = sizeFor(resolved, request, tier1Width(font, info, request.replacement, info.size));
    const outcome = performEdit(
      access,
      raw,
      planOf(request, resolved, 1, size, { font, italic: info.classified.italic }),
      true,
    );
    if (!outcome.committed) {
      throw textEditError(
        'verification-failed',
        `Tier 1 read-back failed: ${outcome.failure ?? 'unknown'}`,
      );
    }
    return {
      tier: 1,
      honesty: honestyOf(1, info),
      substitute: face.key,
      fontSize: size,
      fellBack,
      ...(refusal === undefined ? {} : { tier2Refusal: refusal }),
      verification: outcome.verification,
    };
  }

  /** Resolves the run on the (cached) page and measures the free space; keeps the page. */
  private resolve(access: RawAccess, raw: RawText, query: TextEditQuery): Resolved {
    const page = access.doc.acquirePage(query.run.pageIndex);
    try {
      return raw.withTextPage(page.pagePtr, (textPage) => {
        const run = resolveRun(raw, page.pagePtr, textPage, query.run);
        const range = glyphRange(run, query.start, query.end);
        const space = freeSpace(raw, page.pagePtr, textPage, run, range);
        return {
          run,
          range,
          space,
          pagePtr: page.pagePtr,
          release: () => {
            page.release();
          },
        };
      });
    } catch (error) {
      page.release();
      throw error;
    }
  }

  /** The substitute face for tier 1: the matching family first, then any that has the chars. */
  private async tier1Face(resolved: Resolved, replacement: string): Promise<Tier1Choice> {
    const preferred = substituteFace(resolved.run.info.classified);
    let firstMissing: string[] | undefined;
    for (const face of faceCandidates(preferred)) {
      const font = await this.faces.get(face);
      const missing = missingInFace(font, replacement);
      if (missing.length === 0) return { ok: true, face, font };
      firstMissing ??= missing;
    }
    return { ok: false, missing: firstMissing ?? [] };
  }
}

/** A `PdfTextEditor` for a hosted engine (worker or, in tests, the calling thread). */
export function createTextEditor(
  host: TextEditorHost,
  options: TextEditorOptions = {},
): HostedTextEditor {
  return new HostedTextEditor(host, options);
}
