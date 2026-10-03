/**
 * `PdfTextEditor` on the PDFium host (ADR-0011 §4): every call is one task on the
 * orchestrator's queue and never awaits engine or adapter calls. Edits (`applyTextEdit`) are
 * `withRawAccess`, exclusive per source, at the queue's top priority. Calls that leave the
 * document as it was (`locateRuns`, `analyzeRun`, the dry run of `checkEditability`) hold the
 * source's lock shared, like adapter calls, and run as one raw task behind pending renders
 * (craft spec §4.8), so page renders do not wait for them. Reads use a fresh text page; every
 * committed edit is followed by `GenerateContent` and dropping the executor's cached page.
 *
 * An edit runs in steps, each on a clean page: the analysis reads the object's codes from a
 * snapshot and matches them to the text page with probe glyphs, which also give tier 2 its
 * codes (`prepare`); `measure` lays the new code sequence out in the original object and
 * drops the page; `performEdit` splits the object on a freshly loaded page, verifies and
 * commits (or, for `checkEditability`, drops the page again).
 *
 * `analyzeRun` does the analysis and probing once for a run, for every character a keyboard
 * is likely to type, and measures their advances, so the web editor checks each keystroke
 * with arithmetic and asks `checkEditability` only after a pause and on commit.
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
  GlyphOutlineSegment,
  ParagraphBlock,
  ParagraphEdit,
  ParagraphEditOptions,
  ParagraphEditResult,
  ParagraphLayoutAnalysis,
  ParagraphPreview,
  ParagraphRef,
  PdfTextEditor,
  TextAdvance,
  TextEditability,
  TextEditBlocker,
  TextEditQuery,
  TextEditRequest,
  TextEditResult,
  TextFitOption,
  TextRunAnalysis,
  TextRunRef,
  TextTier2Refusal,
} from '../types';
import {
  analysisChars,
  analyzeObject,
  measurableChar,
  type ObjectAnalysis,
  withGlyphs,
} from './analysis';
import {
  type EditPlan,
  type Entry,
  layoutVerdict,
  measure,
  performEdit,
  type Sequence,
  sequenceOf,
  tier2Advance,
} from './apply';
import { analyzePageParagraphs, ParagraphCache } from './blocks';
import {
  blockerOf,
  fitOption,
  fittedSize,
  freeSpace,
  type GlyphRange,
  glyphRange,
  glyphSelection,
  honestyOf,
  lineLimit,
  tier1Width,
  tier2Precheck,
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
import { ParagraphWriter } from './paragraph-edit';
import { fontIds, locatePage, objectTree, type ResolvedRun, resolveRun } from './locate';
import { RawText } from './raw';
import { probeCodes } from './probe';
import { chooseTier2Codes, tier2Candidates } from './tier2-codes';

export interface TextEditorOptions {
  /** Loads bundled face programs (default: `loadBundledFont`, fetched once per realm). */
  readonly loadFace?: FaceLoader;
  /**
   * Tests only: skip the tier-2 glyph pre-check so the read-back is the only guard (a
   * character the font has no code for is written with an arbitrary code).
   */
  readonly skipTier2Precheck?: boolean;
}

/** The raw-access part of `HostedEngine` the editor needs. */
export type TextEditorHost = Pick<
  HostedEngine,
  'withRawAccess' | 'withRawTask' | 'withEngineAccess'
>;

/** Codes measured in one pass of `measure` by `analyzeRun` (a failed pass loses only these). */
const MEASURE_CHUNK = 32;

interface Resolved {
  readonly run: ResolvedRun;
  readonly range: GlyphRange;
  readonly space: ReturnType<typeof freeSpace>;
  readonly pagePtr: number;
  /**
   * Drops the page reference taken by `resolve` when nothing was changed. After `measure`
   * or `performEdit` the page is closed already and this must not be called.
   */
  readonly release: () => void;
}

/** A run with its analysis, selection and tier-2 codes, ready for either tier. */
interface Prepared {
  readonly analysis: ObjectAnalysis;
  readonly selection: { readonly g0: number; readonly g1: number };
  /** Tier 2: the codes of the replacement, or why the original font cannot take it. */
  readonly tier2: Tier2Codes;
}

/** Tier 2's codes and what each reads as (the character, unless a test forced a code). */
type Tier2Codes = Tier2Check & {
  readonly codes?: readonly number[];
  readonly texts?: readonly string[];
};

type Tier1Choice =
  | { readonly ok: true; readonly face: BundledFace; readonly font: Font }
  | { readonly ok: false; readonly missing: string[] };

function withSignal(options: EngineCallOptions | undefined) {
  return options?.signal ? { signal: options.signal } : {};
}

/** The replacement's size for `request` (releases the page when it does not fit). */
function sizeFor(resolved: Resolved, request: TextEditRequest, option: TextFitOption): number {
  try {
    return request.fontSize ?? fittedSize(resolved.run.info.size, option, request.fit);
  } catch (error) {
    resolved.release();
    throw error;
  }
}

function planOf(
  query: TextEditQuery,
  resolved: Resolved,
  prepared: Prepared,
  sequence: Sequence,
  metrics: EditPlan['metrics'],
  tier: 1 | 2,
  size: number,
  face?: EditPlan['face'],
): EditPlan {
  return {
    pageIndex: query.run.pageIndex,
    pagePtr: resolved.pagePtr,
    run: resolved.run,
    analysis: prepared.analysis,
    sequence,
    metrics,
    replacement: query.replacement,
    tier,
    size,
    ...(face ? { face } : {}),
    space: resolved.space,
  };
}

function notEditable(blocker: TextEditBlocker): Error {
  return textEditError('not-editable', `This text cannot be edited (${blocker})`);
}

/** The text editor of a hosted engine. */
export class HostedTextEditor implements PdfTextEditor {
  private readonly faces: FaceCache;
  /** `analyzeParagraphs` per page, reused while the page is unchanged (craft spec §4.1). */
  private readonly paragraphs = new ParagraphCache();
  private readonly skipPrecheck: boolean;
  /** `applyParagraphEdit` and friends (craft spec §4.4). */
  private readonly writer: ParagraphWriter;

  constructor(
    private readonly host: TextEditorHost,
    options: TextEditorOptions = {},
  ) {
    this.faces = new FaceCache(options.loadFace);
    this.skipPrecheck = options.skipTier2Precheck === true;
    this.writer = new ParagraphWriter(this.faces, this.paragraphs);
  }

  locateRuns(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly LocatedRun[]> {
    return this.read(
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
      options,
    );
  }

  analyzeParagraphs(
    source: SourceId,
    pageIndex: number,
    options?: EngineCallOptions,
  ): Promise<readonly ParagraphBlock[]> {
    return this.read(
      source,
      (access) => {
        const raw = new RawText(access.module, access.memory);
        const page = access.doc.acquirePage(pageIndex);
        try {
          return analyzePageParagraphs(raw, page.pagePtr, source, pageIndex, this.paragraphs);
        } finally {
          page.release();
        }
      },
      options,
    );
  }

  glyphPaths(
    source: SourceId,
    pageIndex: number,
    fontId: number,
    chars: readonly string[],
    options?: EngineCallOptions,
  ): Promise<Readonly<Record<string, readonly GlyphOutlineSegment[] | null>>> {
    return this.read(
      source,
      (access) => {
        const raw = new RawText(access.module, access.memory);
        const page = access.doc.acquirePage(pageIndex);
        try {
          let font: number | undefined;
          for (const [handle, id] of fontIds(raw, objectTree(raw, page.pagePtr))) {
            if (id === fontId) font = handle;
          }
          const out: Record<string, readonly GlyphOutlineSegment[] | null> = {};
          for (const ch of chars) {
            // Outlines are in em units whatever the size asked for (`GlyphSegment`).
            out[ch] = font === undefined ? null : (raw.glyphPath(font, ch, 1) ?? null);
          }
          return out;
        } finally {
          page.release();
        }
      },
      options,
    );
  }

  analyzeParagraphLayout(
    ref: ParagraphRef,
    options?: EngineCallOptions,
  ): Promise<ParagraphLayoutAnalysis> {
    return this.read(ref.source, (access) => this.writer.analyze(access, ref), options);
  }

  /** Dry runs work on a private copy of the page (shared lock); commits are exclusive. */
  applyParagraphEdit(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    options: ParagraphEditOptions,
  ): Promise<ParagraphEditResult> {
    if (!options.commit) {
      return this.read(
        source,
        async (access) => (await this.writer.dryRun(access, pageIndex, edit)).result,
        options,
      );
    }
    return this.host.withRawAccess(
      source,
      (access) => this.writer.commit(access, pageIndex, edit),
      withSignal(options),
    );
  }

  renderParagraphPreview(
    source: SourceId,
    pageIndex: number,
    edit: ParagraphEdit,
    scale: number,
    options?: EngineCallOptions,
  ): Promise<ParagraphPreview> {
    return this.read(
      source,
      async (access) => {
        const { result, image } = await this.writer.dryRun(access, pageIndex, edit, scale);
        if (!image) throw textEditError('verification-failed', 'The preview was not rendered');
        const bitmap = await createImageBitmap(
          new ImageData(image.data, image.width, image.height),
        );
        return { bitmap, width: image.width, height: image.height, clip: result.box, result };
      },
      options,
    );
  }

  analyzeRun(run: TextRunRef, options?: EngineCallOptions): Promise<TextRunAnalysis> {
    return this.read(run.source, (access) => this.analyze(access, run), options);
  }

  checkEditability(query: TextEditQuery, options?: EngineCallOptions): Promise<TextEditability> {
    return this.read(
      query.run.source,
      async (access) => {
        const raw = new RawText(access.module, access.memory);
        let resolved = this.resolve(access, raw, query);
        const { info } = resolved.run;
        const { prepared, blocker } = await this.prepare(access, raw, query, resolved, true);
        let open = true;
        const reopen = () => {
          if (!open) resolved = this.resolve(access, raw, query);
          open = true;
        };
        let tier2: Tier2Check = prepared?.tier2 ?? { ok: false, reason: 'blocked', missing: [] };
        let tier2Fit: TextFitOption | undefined;
        let tier2Recolours = false;
        if (!blocker && prepared?.tier2.ok) {
          const sequence = sequenceOf(
            prepared.analysis,
            prepared.selection,
            prepared.tier2.codes,
            prepared.tier2.texts,
          );
          try {
            open = false; // `measure` and `performEdit` close the page, also when they throw
            const metrics = measure(access, raw, this.pageOf(query, resolved, prepared), sequence);
            reopen();
            const { width, spacing } = tier2Advance(sequence, metrics);
            tier2Fit = fitOption(width, resolved.space.available, spacing);
            // Dry run (closes the page without GenerateContent): the read-back is the only
            // reliable signal (a missing char may map to a glyph that has an outline).
            open = false;
            const outcome = performEdit(
              access,
              raw,
              planOf(query, resolved, prepared, sequence, metrics, 2, info.size),
              false,
            );
            tier2Recolours = outcome.colorSpaceChanged;
            if (!outcome.ok) {
              const missing = [...new Set(query.replacement)].filter(
                (c) => !isBlank(c) && !outcome.replacementReadback.includes(c),
              );
              tier2 =
                outcome.refusal === 'clipped'
                  ? { ok: false, reason: 'clipped', missing: [] }
                  : { ok: false, reason: 'readback', missing };
            }
          } catch {
            // The edit itself would fail the same way: tier 2 is not available.
            tier2 = { ok: false, reason: 'readback', missing: [] };
          }
        }
        const choice = blocker ? undefined : await this.tier1Face(resolved, query.replacement);
        let tier1Blocker: TextEditBlocker | undefined = blocker;
        let tier1Recolours = false;
        let tier1Fit: TextFitOption | undefined;
        if (choice?.ok && prepared) {
          const width = tier1Width(choice.font, info, query.replacement, info.size);
          tier1Fit = fitOption(width, resolved.space.available);
          reopen();
          open = false; // closed by `tier1Verdict`, also when it throws
          try {
            const verdict = this.tier1Verdict(
              access,
              raw,
              query,
              resolved,
              prepared,
              choice,
              width,
            );
            tier1Recolours = verdict.colorSpaceChanged;
            if (verdict.clipped) tier1Blocker = 'clipped';
          } catch {
            // The kept glyphs could not be laid out again: the edit would fail the same way.
            tier1Blocker = 'unreadable-encoding';
          }
        }
        if (open) resolved.release();
        const tier1: TextEditability['tier1'] = tier1Blocker
          ? { ok: false, reason: tier1Blocker }
          : choice?.ok
            ? { ok: true, substitute: choice.face.key, family: familyName(choice.face) }
            : { ok: false, reason: 'unsupported-chars', missing: choice?.missing ?? [] };
        const tier = blocker ? undefined : tier2.ok ? 2 : tier1.ok ? 1 : undefined;
        const recolours = tier === 2 ? tier2Recolours : tier === 1 ? tier1Recolours : false;
        return {
          tier2: tier2.ok ? { ok: true } : tier2,
          tier1,
          ...(tier === undefined ? {} : { tier }),
          honesty: tier === undefined ? 'not-editable' : honestyOf(tier, info),
          ...(recolours ? { colorSpaceChanged: true } : {}),
          fit: {
            available: resolved.space.available,
            boundedByGlyph: resolved.space.boundedByGlyph,
            boundedBy: resolved.space.boundedBy,
            replaced: resolved.space.replaced,
            ...(tier2.ok && tier2Fit ? { tier2: tier2Fit } : {}),
            ...(tier1Fit && tier1.ok ? { tier1: tier1Fit } : {}),
          },
        } satisfies TextEditability;
      },
      options,
    );
  }

  applyTextEdit(request: TextEditRequest, options?: EngineCallOptions): Promise<TextEditResult> {
    return this.host.withRawAccess(
      request.run.source,
      async (access) => {
        const raw = new RawText(access.module, access.memory);
        let resolved = this.resolve(access, raw, request);
        const { info } = resolved.run;
        const { prepared, blocker } = await this.prepare(
          access,
          raw,
          request,
          resolved,
          request.tier !== 1,
        );
        if (blocker || !prepared) {
          resolved.release();
          throw notEditable(blocker ?? 'unreadable-encoding');
        }
        const tier2 = prepared.tier2;
        let refusal: TextTier2Refusal | undefined =
          request.tier === 1 || tier2.ok ? undefined : tier2.reason;
        let fellBack = false;
        if (request.tier === 2 && !tier2.ok) {
          resolved.release();
          throw textEditError(
            'not-editable',
            `The original font cannot take the replacement (${tier2.reason}${tier2.missing.length > 0 ? `: ${tier2.missing.join('')}` : ''})`,
          );
        }
        if (request.tier !== 1 && tier2.ok) {
          const sequence = sequenceOf(
            prepared.analysis,
            prepared.selection,
            tier2.codes,
            tier2.texts,
          );
          const metrics = measure(access, raw, this.pageOf(request, resolved, prepared), sequence);
          resolved = this.resolve(access, raw, request);
          const { width, spacing } = tier2Advance(sequence, metrics);
          const size = sizeFor(
            resolved,
            request,
            fitOption(width, resolved.space.available, spacing),
          );
          const outcome = performEdit(
            access,
            raw,
            planOf(request, resolved, prepared, sequence, metrics, 2, size),
            true,
          );
          if (outcome.committed) {
            return {
              tier: 2,
              honesty: honestyOf(2, info),
              fontSize: size,
              fellBack: false,
              ...(outcome.colorSpaceChanged ? { colorSpaceChanged: true } : {}),
              verification: outcome.verification,
            };
          }
          if (request.tier === 2) {
            if (outcome.refusal === 'clipped') throw notEditable('clipped');
            throw textEditError(
              'verification-failed',
              `Tier 2 read-back failed: ${outcome.failure ?? 'unknown'}`,
            );
          }
          // Fall back to tier 1 on the unchanged page.
          fellBack = true;
          refusal = outcome.refusal ?? 'readback';
          resolved = this.resolve(access, raw, request);
        }
        return this.applyTier1(access, raw, request, resolved, prepared, fellBack, refusal);
      },
      withSignal(options),
    );
  }

  /**
   * Runs read-only work on `source`: the source's lock shared (edits wait, adapter calls do
   * not) and one raw task behind pending renders. The work must leave the document as it was
   * (temporary object changes are dropped with the page before it returns).
   */
  private read<R>(
    source: SourceId,
    fn: (access: RawAccess) => R | Promise<R>,
    options: EngineCallOptions | undefined,
  ): Promise<R> {
    const signal = withSignal(options);
    return this.host.withEngineAccess(
      source,
      () => this.host.withRawTask(source, fn, { ...signal, priority: 'normal' }),
      signal,
    );
  }

  /** `analyzeRun` inside the raw task (see `TextRunAnalysis`). */
  private async analyze(access: RawAccess, ref: TextRunRef): Promise<TextRunAnalysis> {
    const raw = new RawText(access.module, access.memory);
    const page = access.doc.acquirePage(ref.pageIndex);
    let held = true;
    const release = () => {
      if (held) page.release();
      held = false;
    };
    try {
      const { run, line } = raw.withTextPage(page.pagePtr, (textPage) => {
        const resolved = resolveRun(raw, page.pagePtr, textPage, ref);
        return { run: resolved, line: lineLimit(raw, page.pagePtr, textPage, resolved) };
      });
      const { info } = run;
      const base = {
        run: {
          source: ref.source,
          pageIndex: ref.pageIndex,
          objectPath: ref.objectPath,
          charStart: ref.charStart,
          charCount: ref.charCount,
          text: ref.text,
        },
        honesty: {
          tier2: honestyOf(2, info) as TextRunAnalysis['honesty']['tier2'],
          tier1: honestyOf(1, info) as TextRunAnalysis['honesty']['tier1'],
        },
        runEnd: line.runEnd,
        lineEnd: line.limit,
        lineBound: line.boundedBy,
      };
      const blocked = (blocker: TextEditBlocker): TextRunAnalysis => ({
        ...base,
        blocker,
        tier2: { refusal: 'blocked', advances: {}, refused: {} },
      });
      const staticBlocker = blockerOf(info);
      if (staticBlocker) return blocked(staticBlocker);
      const facts = await analyzeObject(access, raw, page.pagePtr, ref.pageIndex, info);
      if (facts.blocker) return blocked(facts.blocker);

      const wanted = analysisChars(ref.text);
      const precheck = tier2Precheck(raw, info, '');
      let refusal: TextTier2Refusal | undefined = precheck.ok ? undefined : precheck.reason;
      const candidates = refusal ? [] : tier2Candidates(facts, [...wanted].join(''));
      if (!refusal && candidates === undefined) refusal = 'ambiguous-encoding';
      const refused: Record<string, TextTier2Refusal> = {};
      const chosen = new Map<string, number>();
      const probes = probeCodes(access, raw, page.pagePtr, info.font, [
        ...facts.decodings.flat(),
        ...(candidates ?? []),
      ]);
      let analysis: ObjectAnalysis;
      try {
        analysis = withGlyphs(info, facts, (code) => probes.results.get(code)?.text);
        if (analysis.blocker) return blocked(analysis.blocker);
        if (!refusal) {
          // Simple fonts: every character the font's codes read as.
          for (const p of probes.results.values()) {
            if (!p.mapError && measurableChar(p.text)) wanted.add(p.text);
          }
          for (const ch of wanted) {
            const pre = tier2Precheck(raw, info, ch);
            if (!pre.ok && !this.skipPrecheck) {
              refused[ch] = pre.reason;
              continue;
            }
            const choice = chooseTier2Codes(probes, analysis, ch);
            if (choice.ok && choice.codes[0] !== undefined) chosen.set(ch, choice.codes[0]);
            else if (!choice.ok) refused[ch] = choice.reason;
          }
        }
      } finally {
        probes.dispose();
      }
      release();
      const advances = this.measureChars(access, raw, ref, analysis, chosen);
      if (!advances) access.dropPageCache(ref.pageIndex); // the probes changed the page

      const face = substituteFace(info.classified);
      const font = await this.faces.get(face);
      const tier1: Record<string, number> = {};
      for (const ch of new Set([...wanted, ...chosen.keys()])) {
        if (missingInFace(font, ch).length === 0) tier1[ch] = tier1Width(font, info, ch, info.size);
      }
      return {
        ...base,
        tier2: { ...(refusal ? { refusal } : {}), advances: advances ?? {}, refused },
        tier1: { substitute: face.key, family: familyName(face), advances: tier1 },
      };
    } finally {
      release();
    }
  }

  /**
   * Advances of the `chosen` codes in the run's object and alone (`measure`), by character,
   * in passes of `MEASURE_CHUNK` codes on a freshly resolved page each (`measure` drops it).
   * A pass that cannot read its codes back is left out. Undefined when nothing was measured.
   */
  private measureChars(
    access: RawAccess,
    raw: RawText,
    ref: TextRunRef,
    analysis: ObjectAnalysis,
    chosen: ReadonlyMap<string, number>,
  ): Record<string, TextAdvance> | undefined {
    const entries = [...chosen];
    if (entries.length === 0) return undefined;
    const out: Record<string, TextAdvance> = {};
    for (let i = 0; i < entries.length; i += MEASURE_CHUNK) {
      const chunk = entries.slice(i, i + MEASURE_CHUNK);
      const sequence: Sequence = {
        entries: chunk.map(([text, code]): Entry => ({ kind: 'new', code, text })),
        replacementAt: 0,
        suffixAt: chunk.length,
      };
      const page = access.doc.acquirePage(ref.pageIndex);
      let run: ResolvedRun;
      try {
        run = raw.withTextPage(page.pagePtr, (textPage) =>
          resolveRun(raw, page.pagePtr, textPage, ref),
        );
      } catch (error) {
        page.release();
        throw error;
      }
      try {
        // Closes the page, also when it throws.
        const metrics = measure(
          access,
          raw,
          { pageIndex: ref.pageIndex, pagePtr: page.pagePtr, run, analysis },
          sequence,
        );
        chunk.forEach(([text], k) => {
          out[text] = { spaced: metrics.spaced[k] ?? 0, plain: metrics.plain[k] ?? 0 };
        });
      } catch {
        // These characters stay unknown: the engine's check decides for them.
      }
    }
    return out;
  }

  private async applyTier1(
    access: RawAccess,
    raw: RawText,
    request: TextEditRequest,
    resolved: Resolved,
    prepared: Prepared,
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
    const size = sizeFor(
      resolved,
      request,
      fitOption(tier1Width(font, info, request.replacement, info.size), resolved.space.available),
    );
    const sequence = sequenceOf(prepared.analysis, prepared.selection);
    const metrics = measure(access, raw, this.pageOf(request, resolved, prepared), sequence);
    const fresh = this.resolve(access, raw, request);
    const outcome = performEdit(
      access,
      raw,
      planOf(request, fresh, prepared, sequence, metrics, 1, size, {
        font,
        italic: info.classified.italic,
        width: tier1Width(font, info, request.replacement, size),
      }),
      true,
    );
    if (outcome.refusal === 'clipped') throw notEditable('clipped');
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
      ...(outcome.colorSpaceChanged ? { colorSpaceChanged: true } : {}),
      verification: outcome.verification,
    };
  }

  /** Tier 1's clip and colour verdict (measures, so the page is closed afterwards). */
  private tier1Verdict(
    access: RawAccess,
    raw: RawText,
    query: TextEditQuery,
    resolved: Resolved,
    prepared: Prepared,
    choice: { readonly face: BundledFace; readonly font: Font },
    width: number,
  ): { clipped: boolean; colorSpaceChanged: boolean } {
    const sequence = sequenceOf(prepared.analysis, prepared.selection);
    const metrics = measure(access, raw, this.pageOf(query, resolved, prepared), sequence);
    const fresh = this.resolve(access, raw, query);
    try {
      return layoutVerdict(
        raw,
        planOf(query, fresh, prepared, sequence, metrics, 1, fresh.run.info.size, {
          font: choice.font,
          italic: fresh.run.info.classified.italic,
          width,
        }),
      );
    } finally {
      fresh.release();
    }
  }

  private pageOf(query: TextEditQuery, resolved: Resolved, prepared: Prepared) {
    return {
      pageIndex: query.run.pageIndex,
      pagePtr: resolved.pagePtr,
      run: resolved.run,
      analysis: prepared.analysis,
    };
  }

  /**
   * The run's analysis (codes, colour spaces, form reuse), its glyph selection and the
   * tier-2 codes of the replacement (`tier2`: whether to look for them), or why it cannot be
   * edited. Releases the page when it throws.
   */
  private async prepare(
    access: RawAccess,
    raw: RawText,
    query: TextEditQuery,
    resolved: Resolved,
    tier2: boolean,
  ): Promise<{ prepared?: Prepared; blocker?: TextEditBlocker }> {
    const { info } = resolved.run;
    const staticBlocker = blockerOf(info);
    if (staticBlocker) return { blocker: staticBlocker };
    try {
      const facts = await analyzeObject(access, raw, resolved.pagePtr, query.run.pageIndex, info);
      if (facts.blocker) return { blocker: facts.blocker };
      let check: Tier2Codes = tier2
        ? tier2Precheck(raw, info, query.replacement)
        : { ok: false, reason: 'blocked', missing: [] };
      if (!check.ok && this.skipPrecheck) {
        if (check.reason === 'missing-glyphs' || check.reason === 'outside-winansi') {
          check = { ok: true };
        }
      }
      const candidates = check.ok ? tier2Candidates(facts, query.replacement) : [];
      const probes = probeCodes(access, raw, resolved.pagePtr, info.font, [
        ...facts.decodings.flat(),
        ...(candidates ?? []),
      ]);
      try {
        const analysis = withGlyphs(info, facts, (code) => probes.results.get(code)?.text);
        if (analysis.blocker) return { blocker: analysis.blocker };
        const selection = glyphSelection(
          resolved.run,
          resolved.range,
          analysis.glyphOfChar,
          analysis.glyphs.length,
        );
        if (check.ok) {
          const choice = chooseTier2Codes(
            candidates ? probes : undefined,
            analysis,
            query.replacement,
            this.skipPrecheck,
          );
          const chars = Array.from(query.replacement);
          check = choice.ok
            ? {
                ok: true,
                codes: choice.codes,
                texts: choice.codes.map((c, k) => probes.results.get(c)?.text ?? chars[k] ?? ''),
              }
            : { ok: false, reason: choice.reason, missing: [...choice.chars] };
        }
        return { prepared: { analysis, selection, tier2: check } };
      } finally {
        probes.dispose();
      }
    } catch (error) {
      resolved.release();
      throw error;
    }
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
