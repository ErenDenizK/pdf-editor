/**
 * Applying redactions (spec redaction-and-text-editing §1.2, ADR-0011 §3): the ticked marks
 * of the Redactions panel become permanent removals, source by source, as one history
 * entry ("Redactions applied (N areas)").
 *
 * Per source with ticked marks, inside the edit runner's queue (`runAction`):
 *
 * 1. every /Redact mark of the source is deleted (`annotation.delete`, invertible), so the
 *    bytes the engine redacts carry no pending marks;
 * 2. one `redaction.apply` edit runs `PdfRedactor.applyRedactionPlan` in the PDFium worker:
 *    the source is saved, redacted and verified in private scratch documents (engine pass,
 *    scrub, blank-region gate, fill, forensic self-check) and the open document is replaced
 *    by the verified bytes under the same source id, so the model's pages and their ids
 *    stay as they are. The recorded payload is `{ plan: result.plan }` in the source's page
 *    indices (`RedactionApplyPayload`), which `planExport` reads;
 * 3. the marks that were not ticked (or sit on pages no document shows) are created again
 *    with their ids: they stay marks. A mark that reaches into an area the source now has
 *    redacted (this apply's or an earlier one) is not created again: it would stand on
 *    removed content, and the export's self-check refuses any annotation in a redacted
 *    area. The result sheet reports how many were deleted that way (`removedMarks`).
 *
 * The model carries copies of source strings the assembler writes again at export: the
 * document's metadata (Info and XMP) and its bookmark titles. For every document showing a
 * redacted source, the redacted strings are replaced there too ("[redacted]"), committed
 * into the same history entry (coalesced right after the engine edits). Anything else the
 * export writes from the model (e.g. overlay text the user typed) is left to the export's
 * self-check, which blocks the download when it still finds a redacted string.
 *
 * A `RedactionFailedError` (gate or self-check) stops everything: the action returns
 * nothing, the runner reverts what it executed (deletes are re-created; a source already
 * redacted in this action is reopened from its original bytes and its earlier edits
 * replayed) and the document is unchanged. The failure's stage and reports are returned for
 * the result sheet.
 *
 * Undo is reopen + replay (the edit's inverse is replay-required, as for text edits); redo
 * applies the forward edits again. Every time the redactions a source holds change (apply,
 * undo, redo) every page of that source is invalidated here: bitmaps, text, annotations and
 * links, since the removal is not limited to the edit's own page.
 */
import type {
  DocumentMetadata,
  EngineEdit,
  OutlineNode,
  Rect,
  SourceId,
  VirtualDocument,
  Workspace,
} from '@pdf-editor/document-model';
import type {
  ApplyRedactionsResult,
  PdfRedactor,
  RedactionFailure,
  RedactionPlan,
} from '@pdf-editor/engine';

import { useAnnotationStore } from '../annotations/annotation-store';
import { pageText } from '../annotations/page-text';
import {
  type EngineContext,
  executeEdit,
  onPagesChanged,
  readAnnotations,
  runAction,
} from '../annotations/edit-runner';
import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import { useWorkspaceStore } from '../state/workspace-store';
import { clearLinksForSource } from '../viewer/LinkLayer';
import { isRedactMark, type RedactMark } from './marks';
import { markKeyOf, useRedactionStore } from './redaction-store';
import { textUnderQuads } from './text-index';

/** Fill choices of the confirmation dialog (spec §1.2 step 4). */
export type FillChoice = 'black' | 'white' | 'custom';

export interface ApplyChoices {
  readonly fill: FillChoice;
  /** `#rrggbb`, used when `fill` is 'custom'. */
  readonly customColor: string;
  /** Drawn centred in every area; empty for none. */
  readonly overlayText: string;
  /** Keep embedded files and file attachment annotations (reported unverified). */
  readonly keepAttachments: boolean;
  /**
   * Area only: the text under the marks is not added to the redacted strings, so the same
   * text elsewhere in the document stays and is not searched for (`captureStrings: false`).
   */
  readonly areaOnly: boolean;
  /**
   * Text under the marks too short for the engine to search document-wide on its own
   * (`shortTextUnderMarks`) that the user asked to search and scrub anyway: added to the
   * plan's strings of its source (ignored with `areaOnly`).
   */
  readonly alsoSearch: readonly ShortText[];
}

/** A string under ticked marks of `source` shorter than the engine searches by itself. */
export interface ShortText {
  readonly source: SourceId;
  readonly text: string;
}

export const DEFAULT_CHOICES: ApplyChoices = {
  fill: 'black',
  customColor: '#1a237e',
  overlayText: '',
  keepAttachments: false,
  areaOnly: false,
  alsoSearch: [],
};

/**
 * Captured strings shorter than this (normalised) are not searched document-wide by the
 * engine (`MIN_CAPTURED_LENGTH` of packages/engine/src/redaction/apply.ts).
 */
const MIN_SEARCHED_LENGTH = 4;

/** Length of `text` as the engine matches it: NFKC, no whitespace or invisible characters. */
function matchLength(text: string): number {
  return text.normalize('NFKC').replace(/[\s\u00ad\u180e\u200b-\u200d\u2060\ufeff]/gu, '').length;
}

/**
 * The text under `marks` (one string per line of a mark, as the engine captures it) that is
 * too short to be searched document-wide, e.g. "NDA": applying removes it inside the marks
 * only, unless the user adds it to the searched strings (`ApplyChoices.alsoSearch`).
 * Distinct per source, in mark order.
 */
export async function shortTextUnderMarks(
  marks: readonly {
    readonly source: SourceId;
    readonly mark: Pick<RedactMark, 'pageIndex' | 'quads'>;
  }[],
): Promise<ShortText[]> {
  const out: ShortText[] = [];
  const seen = new Set<string>();
  for (const { source, mark } of marks) {
    const runs = await pageText(source, mark.pageIndex);
    for (const line of markAreas(mark.quads)) {
      const text = textUnderQuads(runs, [line]);
      const length = matchLength(text);
      if (length === 0 || length >= MIN_SEARCHED_LENGTH) continue;
      const key = `${source}\u0000${text.normalize('NFKC').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source, text });
    }
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function fillColorOf(choices: ApplyChoices): string {
  if (choices.fill === 'white') return '#ffffff';
  if (choices.fill === 'custom' && HEX.test(choices.customColor)) return choices.customColor;
  return '#000000';
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Whether two quads lie on one line (they overlap by more than half the lower one). */
function sameLine(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > Math.min(a.height, b.height) / 2;
}

/**
 * A mark's areas: its quads, those on one line joined (a token split across text runs
 * gives several quads with nothing unselected between them), so an area is a line of a mark.
 */
export function markAreas(quads: readonly Rect[]): Rect[] {
  const lines: Rect[] = [];
  for (const quad of quads) {
    const at = lines.findIndex((line) => sameLine(line, quad));
    if (at >= 0) lines[at] = union(lines[at] as Rect, quad);
    else lines.push({ ...quad });
  }
  return lines;
}

/** The plan for one source's ticked marks (areas in the source's page indices). */
export function planForMarks(marks: readonly RedactMark[], choices: ApplyChoices): RedactionPlan {
  const overlayText = choices.overlayText.trim();
  return {
    areas: marks.flatMap((mark) =>
      markAreas(mark.quads).map((rect) => ({ pageIndex: mark.pageIndex, rect })),
    ),
    strings: [],
    fillColor: fillColorOf(choices),
    ...(overlayText === '' ? {} : { overlayText }),
    ...(choices.keepAttachments ? { keepAttachments: true } : {}),
  };
}

/** What one source's apply reported (the result sheet; no bytes). */
export interface SourceRedaction {
  readonly source: SourceId;
  readonly name: string;
  /** Marks applied (ticked). */
  readonly marks: number;
  /** Marks left as marks. */
  readonly keptMarks: number;
  /** Marks not applied that reached into a redacted area: deleted, not kept (step 3). */
  readonly removedMarks: number;
  readonly byteLength: number;
  readonly result: Omit<ApplyRedactionsResult, 'bytes'>;
}

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly label: string; readonly sources: SourceRedaction[] }
  | {
      /** The gate or the self-check stopped the apply; nothing changed. */
      readonly kind: 'blocked';
      readonly source: SourceId;
      readonly name: string;
      readonly stage: 'gate' | 'forensic';
      readonly message: string;
      readonly failure: RedactionFailure;
    }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'nothing' };

/** Areas of an applied outcome (the history label's count). */
export function appliedAreas(sources: readonly SourceRedaction[]): number {
  return sources.reduce((n, s) => n + s.result.plan.areas.length, 0);
}

interface Replacer {
  matches(text: string): boolean;
  replace(text: string, placeholder: string): string;
}

function scrubOutline(
  nodes: readonly OutlineNode[],
  matcher: Replacer,
  placeholder: string,
): readonly OutlineNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    const children = scrubOutline(node.children, matcher, placeholder);
    const title = matcher.matches(node.title)
      ? matcher.replace(node.title, placeholder)
      : node.title;
    if (title === node.title && children === node.children) return node;
    changed = true;
    return { ...node, title, children };
  });
  return changed ? out : nodes;
}

const METADATA_STRINGS = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const;

function scrubMetadata(
  metadata: DocumentMetadata,
  matcher: Replacer,
  placeholder: string,
): DocumentMetadata {
  const next: Record<string, unknown> = { ...metadata };
  let changed = false;
  for (const key of METADATA_STRINGS) {
    const value = metadata[key];
    if (value !== undefined && matcher.matches(value)) {
      next[key] = matcher.replace(value, placeholder);
      changed = true;
    }
  }
  if (metadata.custom) {
    const custom: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata.custom)) {
      const scrubbed = matcher.matches(value) ? matcher.replace(value, placeholder) : value;
      if (scrubbed !== value) changed = true;
      custom[key] = scrubbed;
    }
    next.custom = custom;
  }
  return changed ? (next as unknown as DocumentMetadata) : metadata;
}

/**
 * The workspace with the redacted strings replaced in the metadata and bookmark titles of
 * every document that shows a page of `sources` (unchanged when nothing matched).
 */
export function scrubModelStrings(
  ws: Workspace,
  sources: ReadonlySet<SourceId>,
  matcher: Replacer,
  placeholder: string,
): Workspace {
  let documents: Workspace['documents'] | undefined;
  for (const id of ws.documentOrder) {
    const doc = ws.documents[id];
    if (!doc) continue;
    if (!doc.pages.some((p) => p.ref.kind === 'source' && sources.has(p.ref.source))) continue;
    const metadata = scrubMetadata(doc.metadata, matcher, placeholder);
    const outline = scrubOutline(doc.outline, matcher, placeholder);
    if (metadata === doc.metadata && outline === doc.outline) continue;
    const next: VirtualDocument = { ...doc, metadata, outline, clean: false };
    documents = { ...(documents ?? ws.documents), [id]: next };
  }
  return documents ? { ...ws, documents } : ws;
}

/** Pages of the workspace's documents that show each source page (listed marks). */
function shownPages(ws: Workspace): Map<SourceId, Set<number>> {
  const shown = new Map<SourceId, Set<number>>();
  for (const id of ws.documentOrder) {
    for (const page of ws.documents[id]?.pages ?? []) {
      if (page.ref.kind !== 'source') continue;
      const set = shown.get(page.ref.source) ?? new Set<number>();
      set.add(page.ref.index);
      shown.set(page.ref.source, set);
    }
  }
  return shown;
}

interface SourceJob {
  readonly source: SourceId;
  readonly name: string;
  readonly all: readonly RedactMark[];
  readonly ticked: readonly RedactMark[];
}

async function jobsOf(ctx: EngineContext): Promise<SourceJob[]> {
  const ws = useWorkspaceStore.getState().workspace;
  const excluded = useRedactionStore.getState().excluded;
  const jobs: SourceJob[] = [];
  for (const [source, pages] of shownPages(ws)) {
    const info = ws.sources[source];
    if (!info) continue;
    const all: RedactMark[] = [];
    const ticked: RedactMark[] = [];
    for (let pageIndex = 0; pageIndex < info.pageCount; pageIndex++) {
      const marks = (await readAnnotations(source, pageIndex, ctx)).filter(
        (a): a is RedactMark => isRedactMark(a) && !a.flags?.hidden,
      );
      for (const mark of marks) {
        all.push(mark);
        if (pages.has(pageIndex) && !excluded.has(markKeyOf(source, mark.id))) ticked.push(mark);
      }
    }
    if (ticked.length > 0) jobs.push({ source, name: info.name, all, ticked });
  }
  return jobs;
}

/** Whether any listed mark is ticked (the panel's Apply button). */
export function hasTickedMarks(entries: readonly { readonly markKey: string }[]): boolean {
  const excluded = useRedactionStore.getState().excluded;
  return entries.some((e) => !excluded.has(e.markKey));
}

/** `ctx` whose editor reports the result of `applyRedactionPlan` (executeEdit drops it). */
function capturing(ctx: EngineContext): {
  readonly ctx: EngineContext;
  readonly result: () => ApplyRedactionsResult | undefined;
} {
  let captured: ApplyRedactionsResult | undefined;
  const editor = new Proxy(ctx.editor, {
    get(target, property, receiver): unknown {
      if (property !== 'applyRedactionPlan') {
        return Reflect.get(target, property, receiver) as unknown;
      }
      const apply = (target as Partial<PdfRedactor>).applyRedactionPlan;
      if (!apply) return undefined;
      return async (...args: Parameters<PdfRedactor['applyRedactionPlan']>) => {
        captured = await apply.apply(target, args);
        return captured;
      };
    },
  });
  return { ctx: { ...ctx, editor }, result: () => captured };
}

function isRedactionFailure(
  error: unknown,
): error is Error & { stage: 'gate' | 'forensic'; failure: RedactionFailure } {
  const e = error as { name?: unknown; stage?: unknown; failure?: unknown } | null;
  return (
    e?.name === 'RedactionFailedError' &&
    (e.stage === 'gate' || e.stage === 'forensic') &&
    typeof e.failure === 'object'
  );
}

/** Positive-area overlap of two rectangles (as the engine's self-check tests it). */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether a mark's /Rect or one of its quads meets one of `areas` on its page. */
export function markInAreas(
  mark: Pick<RedactMark, 'pageIndex' | 'rect' | 'quads'>,
  areas: readonly { readonly pageIndex: number; readonly rect: Rect }[],
): boolean {
  const rects = [mark.rect, ...mark.quads];
  return areas.some(
    (area) => area.pageIndex === mark.pageIndex && rects.some((r) => overlaps(r, area.rect)),
  );
}

/** Areas of the `redaction.apply` edits the model already holds for `source`. */
function recordedAreas(source: SourceId): RedactionPlan['areas'] {
  return useWorkspaceStore
    .getState()
    .workspace.engineEdits.filter((e) => e.source === source && e.kind === 'redaction.apply')
    .flatMap((e) => (e.payload as { plan?: RedactionPlan } | undefined)?.plan?.areas ?? []);
}

let applying = false;

/** Whether an apply is running. */
export function isApplying(): boolean {
  return applying;
}

/** One source to redact inside an action: its marks, which of them apply, and the plan. */
interface RedactionJob extends SourceJob {
  readonly plan: RedactionPlan;
  readonly captureStrings: boolean;
}

type Blocked = Extract<ApplyOutcome, { kind: 'blocked' }>;

/**
 * Redacts one source inside the runner's action (steps 1–3 of the module comment): deletes
 * every /Redact mark of the source, runs `redaction.apply` with the job's plan and creates
 * the marks that were not ticked again, unless they reach into a redacted area. The
 * recorded edits are appended to `edits`.
 */
async function redactSource(
  ctx: EngineContext,
  job: RedactionJob,
  edits: EngineEdit[],
): Promise<SourceRedaction | Blocked> {
  const earlier = recordedAreas(job.source);
  const recreate: { readonly mark: RedactMark; readonly edit: EngineEdit }[] = [];
  for (const mark of job.all) {
    const deleted = await executeEdit(ctx, {
      id: globalThis.crypto.randomUUID(),
      source: job.source,
      pageIndex: mark.pageIndex,
      kind: 'annotation.delete',
      payload: { annotationId: mark.id },
    });
    edits.push(deleted.recorded);
    const ticked = job.ticked.some((t) => t.id === mark.id);
    // The delete's inverse is the create that restores the mark exactly.
    if (!ticked && deleted.recorded.inverse) {
      recreate.push({
        mark,
        edit: {
          id: globalThis.crypto.randomUUID(),
          source: job.source,
          pageIndex: mark.pageIndex,
          kind: 'annotation.create',
          payload: deleted.recorded.inverse.payload,
        },
      });
    }
  }
  const { plan } = job;
  const capture = capturing(ctx);
  let applied;
  try {
    applied = await executeEdit(capture.ctx, {
      id: globalThis.crypto.randomUUID(),
      source: job.source,
      pageIndex: plan.areas[0]?.pageIndex ?? 0,
      kind: 'redaction.apply',
      payload: { plan, captureStrings: job.captureStrings },
    });
  } catch (error) {
    if (!isRedactionFailure(error)) throw error;
    return {
      kind: 'blocked',
      source: job.source,
      name: job.name,
      stage: error.stage,
      message: error.message,
      failure: error.failure,
    };
  }
  edits.push(applied.recorded);
  const result = capture.result();
  if (!result) throw new Error('The engine returned no redaction result');
  const redacted = [...earlier, ...result.plan.areas];
  let kept = 0;
  for (const { mark, edit } of recreate) {
    if (markInAreas(mark, redacted)) continue;
    edits.push((await executeEdit(ctx, edit)).recorded);
    kept += 1;
  }
  const { bytes, ...reports } = result;
  return {
    source: job.source,
    name: job.name,
    marks: job.ticked.length,
    keptMarks: kept,
    removedMarks: recreate.length - kept,
    byteLength: bytes.byteLength,
    result: reports,
  };
}

/**
 * Runs the jobs `plan` returns as one action and one history entry labelled `label(done)`
 * (with `coalesceKey`, so a caller can join a model change to the entry), then scrubs the
 * redacted strings from the model and announces the label (or, when the gate or the
 * self-check stopped it or it failed, that nothing was applied). Never rejects.
 */
async function runRedactions(
  plan: (ctx: EngineContext) => Promise<readonly RedactionJob[]>,
  label: (done: readonly SourceRedaction[]) => string,
  coalesceKey: string,
): Promise<ApplyOutcome> {
  if (applying) return { kind: 'error', message: m.redaction_apply_busy() };
  applying = true;
  // Set inside the action (a holder, so control flow does not narrow them away).
  const status: { blocked?: Blocked; nothing: boolean } = { nothing: false };
  try {
    const sources = await runAction(async (ctx) => {
      const jobs = await plan(ctx);
      if (jobs.length === 0) {
        status.nothing = true;
        return undefined;
      }
      const edits: EngineEdit[] = [];
      const done: SourceRedaction[] = [];
      for (const job of jobs) {
        const outcome = await redactSource(ctx, job, edits);
        if ('kind' in outcome) {
          status.blocked = outcome;
          // Nothing is committed; the runner reverts what this action executed.
          return undefined;
        }
        done.push(outcome);
      }
      return { edits, label: label(done), coalesceKey, value: done };
    });
    if (status.blocked) {
      // The dialog may be closed (or read by a screen reader elsewhere): say it here too.
      announce(
        status.blocked.stage === 'gate'
          ? m.redaction_blocked_gate()
          : m.redaction_blocked_forensic(),
      );
      return status.blocked;
    }
    if (!sources) {
      if (status.nothing) return { kind: 'nothing' };
      announce(m.redaction_apply_failed());
      return { kind: 'error', message: m.redaction_apply_failed() };
    }
    const text = label(sources);
    const strings = sources.flatMap((s) => s.result.plan.strings);
    if (strings.length > 0) {
      const { RedactedStringMatcher } = await import('@pdf-editor/engine');
      const matcher = new RedactedStringMatcher(strings);
      const placeholder = matcher.placeholder();
      const redacted = new Set(sources.map((s) => s.source));
      useWorkspaceStore
        .getState()
        .applyOperation((ws) => scrubModelStrings(ws, redacted, matcher, placeholder), text, {
          coalesceKey,
        });
    }
    announce(text);
    return { kind: 'applied', label: text, sources };
  } catch (error) {
    console.warn('Applying redactions failed', error);
    announce(m.redaction_apply_failed());
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    applying = false;
  }
}

/**
 * Applies every ticked mark of the workspace (see the module comment). Never rejects.
 */
export async function applyTickedRedactions(choices: ApplyChoices): Promise<ApplyOutcome> {
  return runRedactions(
    async (ctx) =>
      (await jobsOf(ctx)).map((job) => {
        const plan = planForMarks(job.ticked, choices);
        const strings = choices.areaOnly
          ? []
          : choices.alsoSearch.filter((s) => s.source === job.source).map((s) => s.text);
        return {
          ...job,
          plan: strings.length > 0 ? { ...plan, strings } : plan,
          captureStrings: !choices.areaOnly,
        };
      }),
    (done) => m.history_redactions_applied({ count: appliedAreas(done) }),
    // Joins the model scrub to the engine edits' history entry.
    `redaction.apply:${globalThis.crypto.randomUUID()}`,
  );
}

/** A plan a caller built for one source (areas in the source's page indices). */
export interface PlannedRedaction {
  readonly source: SourceId;
  readonly plan: RedactionPlan;
}

/**
 * Applies plans built elsewhere (crop and discard, crop/actions.ts) through the same
 * pipeline as ticked marks: per source every /Redact mark is set aside and created again
 * afterwards unless it reaches into a redacted area (none of them is applied; a crop
 * deletes the marks reaching outside it, `marksOutsideCrop` in crop/actions.ts), the plan
 * runs with its gate and self-check, and the edits commit as one history entry labelled
 * `options.label` under
 * `options.coalesceKey`, so the caller can join its model change to the same entry
 * (`applyOperation` with that key, right after). Plans without areas are skipped; the
 * outcome is 'nothing' when none has any. Never rejects.
 */
export async function applyRedactionPlans(
  plans: readonly PlannedRedaction[],
  options: {
    readonly label: string;
    readonly coalesceKey: string;
    /** Add the glyph text under the areas to the searched strings (see `ApplyChoices`). */
    readonly captureStrings: boolean;
  },
): Promise<ApplyOutcome> {
  return runRedactions(
    async (ctx) => {
      const ws = useWorkspaceStore.getState().workspace;
      const jobs: RedactionJob[] = [];
      for (const { source, plan } of plans) {
        const info = ws.sources[source];
        if (!info || plan.areas.length === 0) continue;
        const all: RedactMark[] = [];
        for (let pageIndex = 0; pageIndex < info.pageCount; pageIndex++) {
          const marks = (await readAnnotations(source, pageIndex, ctx)).filter(
            (a): a is RedactMark => isRedactMark(a) && !a.flags?.hidden,
          );
          all.push(...marks);
        }
        jobs.push({
          source,
          name: info.name,
          all,
          ticked: [],
          plan,
          captureStrings: options.captureStrings,
        });
      }
      return jobs;
    },
    () => options.label,
    options.coalesceKey,
  );
}

// ---------------------------------------------------------------------------
// Whole-source invalidation when a source's applied redactions change
// ---------------------------------------------------------------------------

/** Redaction edit ids per source as last seen by the page listener. */
const seen = new Map<SourceId, string>();

function redactionSignature(ws: Workspace, source: SourceId): string {
  return ws.engineEdits
    .filter((edit) => edit.source === source && edit.kind === 'redaction.apply')
    .map((edit) => edit.id)
    .join(',');
}

/** Drops everything cached for every page of `source` (after its content was replaced). */
export function refreshSource(source: SourceId): void {
  const ws = useWorkspaceStore.getState().workspace;
  const count = ws.sources[source]?.pageCount ?? 0;
  const service = getEngineService();
  for (let index = 0; index < count; index++) {
    service.invalidatePageText(source, index);
    service.invalidatePage(source, index);
  }
  clearLinksForSource(source);
  const annotations = useAnnotationStore.getState();
  const prefix = `${source}:`;
  for (const key of Object.keys(annotations.pages)) {
    if (!key.startsWith(prefix)) continue;
    const pageIndex = Number(key.slice(prefix.length));
    if (Number.isInteger(pageIndex)) void annotations.reloadPage(source, pageIndex);
  }
}

onPagesChanged((pages) => {
  const ws = useWorkspaceStore.getState().workspace;
  for (const source of new Set(pages.map((p) => p.source))) {
    const signature = redactionSignature(ws, source);
    if ((seen.get(source) ?? '') === signature) continue;
    if (signature === '') seen.delete(source);
    else seen.set(source, signature);
    refreshSource(source);
  }
});

getEngineService().onSourceClosed((source) => {
  seen.delete(source);
});

/** Tests: forget what the page listener saw. */
export function resetRedactionApply(): void {
  seen.clear();
  applying = false;
}
