/**
 * The paragraph editor (craft spec §4.2, §4.5–§4.10; ADR-0020 §7; research 11 §6): a
 * detected paragraph edited in place, laid out on the main thread at every keystroke and
 * drawn from the PDF font's own glyph outlines, so it looks like the page while you type.
 *
 * - **Canvas** (`glyph-canvas.ts`): at device pixel ratio over the paragraph, the rewritten
 *   and moved lines from glyph paths on their real baselines, over a page-white plate (the
 *   engine renders no "page without this paragraph" cheaply: decision §13 #8's fallback);
 *   lines before the edit are the page itself. Caret, selection, composition underline and
 *   the overlap warning are drawn there too.
 * - **Mirror**: a hidden `contenteditable` (`role="textbox"`, multi-line, "Paragraph on
 *   page N") holds the paragraph's text and the focus. It takes keys, IME composition,
 *   clipboard and assistive technology; `beforeinput` becomes model operations
 *   (`paragraph-model.ts`), so the DOM never edits itself outside a composition.
 * - **Per keystroke**: `layoutParagraph` and `decideOverflow` (pure, from the engine chunk)
 *   on the advances asked for once at open (`analyzeParagraphLayout`), then a redraw. No
 *   worker round trip.
 * - **After a 300 ms pause**: one dry run, rendered (`renderParagraphPreview`, which runs
 *   the dry run and returns its result with the bitmap), replaces the drawn glyphs with
 *   exactly what will be saved; typing again returns to the canvas.
 * - **Leaving** (Esc, a press outside, the focus leaving, the tool or document changing)
 *   commits a change as one history entry (decision §13 #9); with no change nothing happens.
 * - **Header**: the honesty line (spec §4.5), the overflow line (§4.6), "Join with next" and
 *   "Split here" (Alt+J, Alt+S: shown but unavailable, detection takes no hints yet), and an
 *   info popover with the §4.10 text. No font, size or colour controls.
 */
import { Popover } from '@base-ui/react/popover';
import type {
  ParagraphBlock,
  ParagraphEditRefusal,
  ParagraphLayoutAnalysis,
  ParagraphRef,
  ParagraphStyleInfo,
} from '@pdf-editor/engine';
import { BUNDLED_FACES, faceFamilyName } from '@pdf-editor/engine/fonts';
import { Info } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { PageTarget } from '../annotations/annotation-store';
import { cssPointToUser, rectToCss } from '../annotations/geometry';
import { getEngineService } from '../engine/engine-service';
import { cssFamilyOf, ensureFace } from '../furniture/furniture-fonts';
import { formatPercent, getLocale, m } from '../i18n';
import { announce } from '../shell/announcer';
import { type PageOverlayProps, registerPageOverlay } from '../stage/page-overlays';
import { useCanEdit } from '../state/ui-store';
import popoverStyles from '../ui/Popover.module.css';
import { Tooltip } from '../ui/Tooltip';
import type { PageFrame } from '../viewer/geometry';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import { commitParagraphEdit, type ParagraphCommit } from './actions';
import {
  apply,
  buildScene,
  compose,
  cssFromUser,
  drawScene,
  drawStylesOf,
  type GlyphCache,
  invert,
  scale,
  sceneBounds,
  type TextRect,
  translate,
  userFromText,
} from './glyph-canvas';
import { blockerLabel, failureMessage } from './model';
import {
  caretLines,
  deleteBackward,
  deleteForward,
  initialState,
  insertText,
  type LayoutFunctions,
  moveHorizontal,
  moveLineEdge,
  moveTo,
  moveVertical,
  offsetAtPoint,
  offsetNearPoint,
  type ParagraphSetup,
  type ParagraphState,
  paragraphEdit,
  paragraphOfRun,
  relayout,
  replaceRange,
  selectAll,
  selectionOf,
  type TextRange,
  wordRange,
} from './paragraph-model';
import styles from './ParagraphEditor.module.css';
import { pageRevision, usePageRevision } from './runs';
import {
  glyphCacheFor,
  type ParagraphSession,
  pageParagraphs,
  paragraphLayoutAnalysis,
  type TextEditSession,
  useTextEditStore,
} from './text-edit-store';

/** Pause after the last keystroke before the dry run and its preview (spec §4.7, §4.8). */
export const PREVIEW_DELAY_MS = 300;
/** Gap between the paragraph and the header, CSS pixels. */
const HEADER_GAP = 8;
/** Room kept around the drawn area on the canvas, CSS pixels. */
const CANVAS_PAD = 4;
/** Characters whose outlines are asked for at open besides the paragraph's own. */
const COMMON_CHARS = (() => {
  let out = '';
  for (let c = 0x21; c < 0x7f; c++) out += String.fromCharCode(c);
  return `${out}çğıöşüÇĞİÖŞÜâêîôûàèéùäëïáíóúñß’‘“”–—…`;
})();

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Opens the paragraph editor on `page` for the detected paragraph `blockRef` (its index in
 * the page's analysis), with the caret nearest `point` (unrotated user space). Resolves to
 * false, with nothing opened, when the paragraph is not found at the page's current state or
 * refuses paragraph mode.
 */
export async function openParagraphEditor(
  page: PageTarget,
  blockRef: Pick<ParagraphRef, 'index'>,
  point: { readonly x: number; readonly y: number },
): Promise<boolean> {
  const revision = pageRevision(page.source, page.pageIndex);
  let blocks: readonly ParagraphBlock[];
  try {
    blocks = await pageParagraphs(page.source, page.pageIndex);
  } catch (error) {
    console.warn('Detecting the paragraphs failed', error);
    return false;
  }
  if (pageRevision(page.source, page.pageIndex) !== revision) return false;
  const block = blocks.find((b) => b.ref.index === blockRef.index);
  if (!block || block.refusal) return false;
  useTextEditStore.getState().openParagraph({
    target: page,
    block,
    revision,
    caret: offsetNearPoint(block, point),
    point,
  });
  return true;
}

/**
 * Opens the editor for a clicked run: the paragraph editor when the run belongs to a
 * detected paragraph that does not refuse paragraph mode, else the line editor (as today).
 */
export async function openRunEditor(session: TextEditSession): Promise<'paragraph' | 'line'> {
  const { target, run, revision, selection } = session;
  const line = () => {
    useTextEditStore.getState().open(session);
    return 'line' as const;
  };
  let blocks: readonly ParagraphBlock[];
  try {
    blocks = await pageParagraphs(target.source, target.pageIndex);
  } catch (error) {
    console.warn('Detecting the paragraphs failed', error);
    return line();
  }
  if (pageRevision(target.source, target.pageIndex) !== revision) return line();
  const found = paragraphOfRun(blocks, run, selection.start);
  if (!found || found.block.refusal) return line();
  useTextEditStore.getState().openParagraph({
    target,
    block: found.block,
    revision,
    caret: found.offset,
    fallback: session,
  });
  return 'paragraph';
}

// ---------------------------------------------------------------------------
// Page overlay
// ---------------------------------------------------------------------------

/** Shows the open paragraph's editor on its page (registered as a page overlay). */
export function ParagraphEditLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, visible } = props;
  const editable = useCanEdit();
  const session = useTextEditStore((s) =>
    s.paragraph?.target.pageId === pageId ? s.paragraph : null,
  );
  const revision = usePageRevision(sourceId, sourceIndex);
  const armed = useToolStore((s) => s.mode === 'edit-text') && editable;

  // Detect the page's paragraphs ahead of a click while Edit text is armed.
  useEffect(() => {
    if (!armed || !visible || sourceId === undefined) return;
    pageParagraphs(sourceId, sourceIndex).catch(() => undefined);
  }, [armed, visible, sourceId, sourceIndex, revision]);

  // The Read lock: an editor open when the document leaves Edit closes (it commits).
  useEffect(() => {
    if (session && !editable) useTextEditStore.getState().closeParagraph();
  }, [session, editable]);

  if (!session || !editable || sourceId === undefined) return null;
  return (
    <div className={styles.layer} data-paragraph-layer={props.pageIndex}>
      <ParagraphEditor session={session} frame={pageFrame(props)} revision={revision} />
    </div>
  );
}

registerPageOverlay(Object.assign(ParagraphEditLayer, { displayName: 'ParagraphEditLayer' }));

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

interface Loaded {
  readonly session: ParagraphSession;
  readonly setup: ParagraphSetup;
  readonly analysis: ParagraphLayoutAnalysis;
  readonly fns: LayoutFunctions;
}

type LoadState =
  | { readonly session: ParagraphSession; readonly value: Loaded }
  | { readonly session: ParagraphSession; readonly error: string };

/** What the user reads for a refused paragraph. */
export function paragraphRefusalLabel(reason: ParagraphEditRefusal): string {
  switch (reason) {
    case 'drop-cap':
      return m.paragraph_reason_drop_cap();
    case 'in-form':
      return m.text_edit_refusal_in_form();
    case 'clipped':
      return m.text_edit_reason_clipped();
    case 'shared-object':
      return m.paragraph_reason_shared_object();
    case 'shared-form':
      return m.text_edit_reason_shared_form();
    case 'unreadable-encoding':
      return m.text_edit_reason_unreadable_encoding();
    case 'unsupported-chars':
      return m.text_edit_error_unsupported_chars();
    default:
      return blockerLabel(reason);
  }
}

/** "‘ğ’ and ‘ş’" in the interface language. */
function quotedList(chars: readonly string[]): string {
  const quoted = chars.map((c) => `‘${c}’`);
  try {
    return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(quoted);
  } catch {
    return quoted.join(', ');
  }
}

/**
 * The CSS `font-family` the canvas draws a style's substituted characters with until the
 * preview settles: the bundled faces in the order the engine tries them (each registered
 * under its private family name once loaded), then the family's name and a generic family.
 * The browser picks per character, as the writer does.
 */
export function substituteCssFamily(info: ParagraphStyleInfo, base: string): string {
  const keys = info.substitute.faces ?? [info.substitute.face];
  const faces = keys.flatMap((key) => BUNDLED_FACES.filter((face) => face.key === key));
  return [...faces.map((face) => `"${cssFamilyOf(face)}"`), base].join(', ');
}

/** The honesty lines (spec §4.5): substituted characters grouped by the face setting them. */
export function honestyLines(
  substitutions: readonly { readonly char: string; readonly family: string }[],
): string[] {
  const byFamily = new Map<string, string[]>();
  for (const { char, family } of substitutions) {
    const list = byFamily.get(family) ?? [];
    if (!list.includes(char)) list.push(char);
    byFamily.set(family, list);
  }
  return [...byFamily].map(([family, chars]) =>
    chars.length === 1
      ? m.paragraph_honesty_one({ char: `‘${chars[0] ?? ''}’`, family })
      : m.paragraph_honesty_many({ chars: quotedList(chars), family }),
  );
}

/**
 * Where the preview bitmap goes: the engine renders it as the page is oriented by its own
 * /Rotate, so only the app's view rotation on top of that is turned here.
 */
export function previewPlacement(
  frame: PageFrame,
  clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): { left: number; top: number; width: number; height: number; transform?: string } {
  const box = rectToCss(frame, clip);
  const view = (((frame.rotation - (frame.intrinsicRotation ?? 0)) % 360) + 360) % 360;
  if (view === 0) return box;
  const quarter = view === 90 || view === 270;
  const width = quarter ? box.height : box.width;
  const height = quarter ? box.width : box.height;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
    transform: `rotate(${view}deg)`,
  };
}

function readVar(element: Element | null, name: string, fallback: string): string {
  if (!element) return fallback;
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

export function ParagraphEditor({
  session,
  frame,
  revision,
}: {
  readonly session: ParagraphSession;
  readonly frame: PageFrame;
  readonly revision: number;
}) {
  const { block, target } = session;
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const current = loaded?.session === session ? loaded : null;
  const value = current && 'value' in current ? current.value : null;
  const [edited, setEdited] = useState<{
    readonly key: Loaded;
    readonly state: ParagraphState;
  } | null>(null);
  const [composition, setComposition] = useState<TextRange | null>(null);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glyphVersion, setGlyphVersion] = useState(0);
  const [side, setSide] = useState<'above' | 'below'>('above');
  const preview = useTextEditStore((s) => s.paragraphPreview);

  const rootRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<ParagraphState | null>(null);
  const valueRef = useRef<Loaded | null>(null);
  const composingRef = useRef<{ base: ParagraphState; range: TextRange } | null>(null);
  /** Set once the editor commits or discards, so unmounting does not commit again. */
  const finishedRef = useRef(false);
  const draggingRef = useRef(false);
  const mountedRef = useRef(true);
  const returnFocusRef = useRef<Element | null>(null);
  const describedBy = useId();
  const honestyRef = useRef<ParagraphCommit['honesty']>(undefined);

  const cache: GlyphCache = useMemo(
    () => glyphCacheFor(block.ref.source, block.ref.pageIndex, session.revision),
    [block.ref.source, block.ref.pageIndex, session.revision],
  );
  const drawStyles = useMemo(() => {
    if (!value) return {};
    const out = { ...drawStylesOf(value.analysis.styles) };
    for (const [id, info] of Object.entries(value.analysis.styles)) {
      const base = out[id];
      if (base) out[id] = { ...base, family: substituteCssFamily(info, base.family) };
    }
    return out;
  }, [value]);

  // Open: the layout analysis and the layout functions, once per paragraph and revision.
  useEffect(() => {
    let live = true;
    Promise.all([paragraphLayoutAnalysis(session), getEngineService().paragraphLayout()]).then(
      ([analysis, fns]) => {
        if (!live) return;
        if (analysis.refusal) {
          const reason = paragraphRefusalLabel(analysis.refusal);
          if (session.fallback) {
            // The line editor still edits the clicked run.
            finishedRef.current = true;
            useTextEditStore.getState().open(session.fallback);
            announce(m.paragraph_refused({ reason }));
            return;
          }
          setLoaded({ session, error: m.paragraph_refused({ reason }) });
          return;
        }
        const setup: ParagraphSetup = {
          block: session.block,
          input: analysis.input,
          paragraphGap: analysis.paragraphGap,
          gapBelow: analysis.gapBelow,
        };
        setLoaded({ session, value: { session, setup, analysis, fns } });
      },
      async (caught: unknown) => {
        const { textEditFailureReason } = await import('@pdf-editor/engine');
        if (live) setLoaded({ session, error: failureMessage(textEditFailureReason(caught)) });
      },
    );
    return () => {
      live = false;
    };
  }, [session]);

  // The model starts from the paragraph's text with the caret at the click.
  const initial = useMemo(() => {
    if (!value) return null;
    const start = initialState(value.setup.input, value.session.caret);
    const { point } = value.session;
    if (!point) return start;
    const fresh = relayout(value.fns, value.setup, start);
    const lines = caretLines(value.setup, start, fresh.layout);
    const local = invert(userFromText(value.setup.block.direction));
    return moveTo(start, offsetAtPoint(lines, apply(local, point)), false);
  }, [value]);
  const state = edited !== null && edited.key === value ? edited.state : initial;

  // Glyph outlines of every character shown, per font, asked for once (cached per page).
  const text = state?.text;
  useEffect(() => {
    if (!value || text === undefined) return;
    const wanted = new Map<number, Set<string>>();
    for (const info of Object.values(value.analysis.styles)) {
      if (info.fontId === undefined) continue;
      const set = wanted.get(info.fontId) ?? new Set<string>();
      for (const ch of `${block.text}${text}${COMMON_CHARS}-`) set.add(ch);
      wanted.set(info.fontId, set);
    }
    for (const [fontId, chars] of wanted) {
      const missing = cache.missing(fontId, chars);
      if (missing.length === 0) continue;
      // Asked for once: the next keystrokes do not ask again; drawn as text until they arrive.
      cache.request(fontId, missing);
      getEngineService()
        .glyphPaths(block.ref.source, block.ref.pageIndex, fontId, missing)
        .then(
          (paths) => {
            for (const ch of missing) cache.put(fontId, ch, paths[ch] ?? null);
            if (mountedRef.current) setGlyphVersion((v) => v + 1);
          },
          (caught: unknown) => {
            cache.release(fontId, missing);
            console.warn('Reading the glyph outlines failed', caught);
          },
        );
    }
  }, [value, text, cache, block.text, block.ref.source, block.ref.pageIndex]);

  // Per keystroke: the layout, its caret geometry and the scene (pure arithmetic).
  const laid = useMemo(() => {
    if (!value || !state) return null;
    const result = relayout(value.fns, value.setup, state);
    const lines = caretLines(value.setup, state, result.layout);
    return { result, lines };
  }, [value, state]);

  // The draft follows the text only (caret moves keep it, and its preview).
  const stateText = state?.text;
  const stateStyles = state?.styles;
  const draft = useMemo(() => {
    if (!value || stateText === undefined || !stateStyles) return null;
    const edit = paragraphEdit(value.setup.input.text, {
      text: stateText,
      styles: stateStyles,
      anchor: 0,
      focus: 0,
    });
    return edit ? { text: stateText, edit } : null;
  }, [value, stateText, stateStyles]);
  const draftRef = useRef(draft);
  const layoutRef = useRef(laid);

  // Publish the draft (what leaving commits) and drop a preview of older text.
  useEffect(() => {
    useTextEditStore.getState().setParagraphDraft(
      draft
        ? {
            text: draft.text,
            caretSpan: { start: draft.edit.start, end: draft.edit.end },
            ...(draft.edit.style === undefined ? {} : { style: draft.edit.style }),
          }
        : null,
    );
  }, [draft]);

  const showPreview =
    preview !== null && draft !== null && preview.text === draft.text && composition === null;

  // After a pause in typing: one dry run, rendered, replaces the drawn glyphs.
  useEffect(() => {
    if (!draft || composition !== null) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const dpr = window.devicePixelRatio || 1;
      getEngineService()
        .renderParagraphPreview(
          block.ref.source,
          block.ref.pageIndex,
          {
            ref: block.ref,
            text: draft.text,
            caretSpan: { start: draft.edit.start, end: draft.edit.end },
            ...(draft.edit.style === undefined ? {} : { style: draft.edit.style }),
            ...(layoutRef.current ? { layout: layoutRef.current.result.layout } : {}),
          },
          frame.scale * dpr,
          { signal: controller.signal },
        )
        .then(
          (rendered) => {
            if (controller.signal.aborted) return;
            useTextEditStore.getState().setParagraphPreview({
              text: draft.text,
              bitmap: rendered.bitmap,
              clip: rendered.clip,
              result: rendered.result,
            });
          },
          async (caught: unknown) => {
            if (controller.signal.aborted) return;
            const { textEditFailureReason } = await import('@pdf-editor/engine');
            setError(failureMessage(textEditFailureReason(caught)));
          },
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [draft, composition, block.ref, frame.scale]);

  // ---- Geometry -----------------------------------------------------------------------

  const textToUser = useMemo(() => userFromText(block.direction), [block.direction]);
  const scene = useMemo(() => {
    if (!value || !state || !laid) return null;
    return buildScene({
      setup: value.setup,
      state,
      relayout: laid.result,
      lines: laid.lines,
      styles: drawStyles,
      focused,
      ...(composition ? { composition } : {}),
    });
  }, [value, state, laid, drawStyles, focused, composition]);

  /** The paragraph's own extent in text space (the canvas never shrinks below it). */
  const extent: TextRect = useMemo(() => {
    const first = block.lines[0];
    const last = block.lines[block.lines.length - 1];
    return {
      x0: block.measure.left,
      x1: block.measure.right,
      y0: (last?.baseline ?? 0) - 0.4 * block.size,
      y1: (first?.baseline ?? 0) + 1.1 * block.size,
    };
  }, [block]);

  const cssOfText = useMemo(() => compose(textToUser, cssFromUser(frame)), [textToUser, frame]);
  const box = useMemo(() => {
    const bounds = scene ? sceneBounds(scene, extent) : extent;
    const corners = [
      apply(cssOfText, { x: bounds.x0, y: bounds.y0 }),
      apply(cssOfText, { x: bounds.x1, y: bounds.y0 }),
      apply(cssOfText, { x: bounds.x1, y: bounds.y1 }),
      apply(cssOfText, { x: bounds.x0, y: bounds.y1 }),
    ];
    const left = Math.floor(Math.min(...corners.map((c) => c.x)) - CANVAS_PAD);
    const top = Math.floor(Math.min(...corners.map((c) => c.y)) - CANVAS_PAD);
    const right = Math.ceil(Math.max(...corners.map((c) => c.x)) + CANVAS_PAD);
    const bottom = Math.ceil(Math.max(...corners.map((c) => c.y)) + CANVAS_PAD);
    return { left, top, width: right - left, height: bottom - top };
  }, [scene, extent, cssOfText]);
  const paragraphBox = rectToCss(frame, block.box);
  /** On-screen angle of the writing direction (clockwise degrees): the canvas turns with it. */
  const screenAngle =
    ((Math.round((Math.atan2(cssOfText[1], cssOfText[0]) * 180) / Math.PI) % 360) + 360) % 360;

  // Draw (each keystroke, caret move, focus change, glyph arrival).
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scene) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(box.width * dpr));
    const height = Math.max(1, Math.round(box.height * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const userToDevice = compose(
      compose(cssFromUser(frame), translate(-box.left, -box.top)),
      scale(dpr),
    );
    const root = rootRef.current;
    drawScene(ctx, { width, height }, scene, cache, textToUser, userToDevice, {
      colors: {
        plate: '#ffffff',
        selection: readVar(root, '--accent-highlight', 'rgba(124, 140, 255, 0.35)'),
        caret: readVar(root, '--accent', '#7c8cff'),
        overlap: 'rgba(220, 38, 38, 0.22)',
      },
      dpr,
      ...(showPreview && preview ? { preview: preview.clip } : {}),
    });
    // `glyphVersion`: outlines arrived, draw them.
  }, [scene, box, frame, cache, textToUser, showPreview, preview, glyphVersion]);

  // The settled preview: the dry run's bitmap at its clip.
  const previewBox = showPreview && preview ? previewPlacement(frame, preview.clip) : null;
  useLayoutEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !showPreview || !preview) return;
    canvas.width = preview.bitmap.width;
    canvas.height = preview.bitmap.height;
    canvas.getContext('2d')?.drawImage(preview.bitmap, 0, 0);
  }, [showPreview, preview]);

  // ---- The mirror ---------------------------------------------------------------------

  // Keep the mirror's text and selection on the model's (never during a composition).
  useLayoutEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror || !state || composition) return;
    if (mirror.textContent !== state.text) mirror.textContent = state.text;
    if (document.activeElement !== mirror) return;
    const selection = window.getSelection();
    if (!selection) return;
    const node = mirror.firstChild ?? mirror;
    const max = node.nodeType === Node.TEXT_NODE ? (node.textContent?.length ?? 0) : 0;
    const anchor = Math.min(state.anchor, max);
    const focus = Math.min(state.focus, max);
    if (
      selection.anchorNode === node &&
      selection.focusNode === node &&
      selection.anchorOffset === anchor &&
      selection.focusOffset === focus
    ) {
      return;
    }
    selection.setBaseAndExtent(node, anchor, node, focus);
  }, [state, composition, focused]);

  // Focus the mirror when the editor is ready; remember where the focus was.
  useLayoutEffect(() => {
    if (!value) return;
    const mirror = mirrorRef.current;
    if (!mirror) return;
    if (document.activeElement !== mirror) {
      returnFocusRef.current = document.activeElement;
      mirror.focus({ preventScroll: true });
    }
  }, [value]);

  const update = useCallback((next: ParagraphState) => {
    const key = valueRef.current;
    if (!key || next === stateRef.current) return;
    stateRef.current = next;
    setEdited({ key, state: next });
    setError(null);
  }, []);

  // Assistive technology may move the caret in the mirror: follow it.
  useEffect(() => {
    const onSelectionChange = () => {
      const mirror = mirrorRef.current;
      const model = stateRef.current;
      if (!mirror || !model || composingRef.current || document.activeElement !== mirror) return;
      const selection = window.getSelection();
      if (!selection || !mirror.contains(selection.anchorNode)) return;
      const anchor = selection.anchorOffset;
      const focus = selection.focusOffset;
      if (anchor === model.anchor && focus === model.focus) return;
      update({ ...model, anchor, focus });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [update]);

  // Text input arrives as `beforeinput`: model operations, the DOM is then re-synced.
  useEffect(() => {
    const mirror = mirrorRef.current;
    if (!mirror) return;
    const onBeforeInput = (event: InputEvent) => {
      const model = stateRef.current;
      if (!model) {
        event.preventDefault();
        return;
      }
      if (event.isComposing || event.inputType === 'insertCompositionText') return;
      event.preventDefault();
      if (busy) return;
      const pasted = () =>
        (event.dataTransfer?.getData('text/plain') ?? event.data ?? '').replace(/\r\n?/g, '\n');
      switch (event.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          update(insertText(model, event.data ?? pasted()));
          break;
        case 'insertLineBreak':
        case 'insertParagraph':
          update(insertText(model, '\n'));
          break;
        case 'insertFromPaste':
        case 'insertFromDrop':
        case 'insertFromYank':
          update(insertText(model, pasted()));
          break;
        case 'deleteContentBackward':
          update(deleteBackward(model));
          break;
        case 'deleteContentForward':
          update(deleteForward(model));
          break;
        case 'deleteWordBackward':
          update(deleteBackward(model, 'word'));
          break;
        case 'deleteWordForward':
          update(deleteForward(model, 'word'));
          break;
        case 'deleteByCut':
        case 'deleteByDrag':
        case 'deleteContent':
          update(replaceRange(model, selectionOf(model), ''));
          break;
        case 'deleteSoftLineBackward':
        case 'deleteHardLineBackward': {
          const lines = layoutRef.current?.lines;
          if (!lines) break;
          const start = moveLineEdge(model, lines, 'start', false).focus;
          update(replaceRange(model, { start, end: model.focus }, ''));
          break;
        }
        default:
          // History and formatting have no meaning here (no font, size or colour controls).
          break;
      }
    };
    mirror.addEventListener('beforeinput', onBeforeInput);
    return () => mirror.removeEventListener('beforeinput', onBeforeInput);
  }, [busy, update]);

  // ---- Leaving ------------------------------------------------------------------------

  const restoreFocus = useCallback(() => {
    const previous = returnFocusRef.current;
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus({ preventScroll: true });
      return;
    }
    rootRef.current?.closest<HTMLElement>('[data-read-viewport]')?.focus({ preventScroll: true });
  }, []);

  /**
   * Closes after leaving: opened from a run, the focus goes back to it (or, after a commit, to
   * the run on its line once the page is located again); otherwise where it was before.
   */
  const finishWith = (committed: boolean) => {
    if (session.fallback) {
      useTextEditStore.getState().finishParagraph(committed);
      return;
    }
    useTextEditStore.getState().closeParagraph();
    restoreFocus();
  };
  const finishRef = useRef(finishWith);

  /** The commit of a draft: what the user saw (layout) and was told (honesty). */
  const commitOf = (pending: NonNullable<typeof draft>, shown: typeof laid): ParagraphCommit => ({
    target,
    block,
    text: pending.text,
    caretSpan: { start: pending.edit.start, end: pending.edit.end },
    ...(pending.edit.style === undefined ? {} : { style: pending.edit.style }),
    ...(shown ? { layout: shown.result.layout } : {}),
    ...(honestyRef.current ? { honesty: honestyRef.current } : {}),
  });
  const commitRef = useRef(commitOf);

  const leave = useCallback(async () => {
    if (finishedRef.current || busy) return;
    const pending = draftRef.current;
    const lastLayout = layoutRef.current;
    if (!pending) {
      finishedRef.current = true;
      finishRef.current(false);
      return;
    }
    setBusy(true);
    setError(null);
    // Committing: unmounting meanwhile (another editor opening) must not commit again.
    finishedRef.current = true;
    const outcome = await commitParagraphEdit(commitRef.current(pending, lastLayout));
    if (outcome.ok) {
      finishRef.current(true);
      return;
    }
    finishedRef.current = false;
    setBusy(false);
    setError(outcome.message);
    mirrorRef.current?.focus({ preventScroll: true });
  }, [busy]);
  const leaveRef = useRef(leave);

  // Leaving by any other way (tool or document change, the page unmounting) still commits.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      const pending = draftRef.current;
      if (finishedRef.current || !pending) return;
      finishedRef.current = true;
      void commitParagraphEdit(commitRef.current(pending, layoutRef.current));
    },
    [],
  );

  // A press outside the editor leaves it.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const element = event.target;
      if (element instanceof Element && element.closest('[data-paragraph-editor]')) return;
      void leaveRef.current();
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, []);

  // The page changed under the editor (undo, another edit): the paragraph is stale.
  useEffect(() => {
    if (busy || revision === session.revision) return;
    finishedRef.current = true;
    useTextEditStore.getState().closeParagraph();
  }, [busy, revision, session.revision]);

  // ---- Keys ---------------------------------------------------------------------------

  const unavailable = () => announce(m.paragraph_hint_unavailable());

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Page shortcuts never fire while typing.
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const model = stateRef.current;
    const lines = layoutRef.current?.lines;
    const mod = event.ctrlKey || event.metaKey;
    const word = event.altKey || event.ctrlKey;
    const handled = (next?: ParagraphState) => {
      event.preventDefault();
      if (next) update(next);
    };
    if (event.key === 'Escape') {
      handled();
      void leave();
      return;
    }
    if (!model || !lines) return;
    if (event.altKey && !mod && (event.code === 'KeyJ' || event.code === 'KeyS')) {
      handled();
      unavailable();
      return;
    }
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const dir = event.key === 'ArrowLeft' ? -1 : 1;
        if (event.metaKey) {
          handled(moveLineEdge(model, lines, dir < 0 ? 'start' : 'end', event.shiftKey));
        } else handled(moveHorizontal(model, dir, event.shiftKey, word ? 'word' : 'char'));
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const dir = event.key === 'ArrowUp' ? -1 : 1;
        if (mod) handled(moveTo(model, dir < 0 ? 0 : model.text.length, event.shiftKey));
        else handled(moveVertical(model, lines, dir, event.shiftKey));
        return;
      }
      case 'Home':
      case 'End': {
        const edge = event.key === 'Home' ? 'start' : 'end';
        if (mod) handled(moveTo(model, edge === 'start' ? 0 : model.text.length, event.shiftKey));
        else handled(moveLineEdge(model, lines, edge, event.shiftKey));
        return;
      }
      default:
        if (mod && !event.altKey && event.key.toLowerCase() === 'a') handled(selectAll(model));
    }
  };

  // ---- Composition --------------------------------------------------------------------

  const onCompositionStart = () => {
    const model = stateRef.current;
    if (!model) return;
    const range = selectionOf(model);
    composingRef.current = { base: model, range };
    setComposition({ start: range.start, end: range.start });
  };
  const compose_ = (data: string, done: boolean) => {
    const composing = composingRef.current;
    if (!composing) return;
    const next = replaceRange(composing.base, composing.range, data);
    if (done) {
      composingRef.current = null;
      setComposition(null);
    } else {
      setComposition({ start: composing.range.start, end: composing.range.start + data.length });
    }
    update(next);
  };

  // ---- Pointer on the canvas ----------------------------------------------------------

  const pointToOffset = (clientX: number, clientY: number): number | undefined => {
    const layer = rootRef.current?.getBoundingClientRect();
    const lines = layoutRef.current?.lines;
    if (!layer || !lines) return undefined;
    const user = cssPointToUser(frame, { x: clientX - layer.left, y: clientY - layer.top });
    return offsetAtPoint(lines, apply(invert(textToUser), user));
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    mirrorRef.current?.focus({ preventScroll: true });
    const model = stateRef.current;
    const offset = pointToOffset(event.clientX, event.clientY);
    if (!model || offset === undefined) return;
    if (event.detail >= 3) update(selectAll(model));
    else if (event.detail === 2) {
      const range = wordRange(model.text, offset);
      update({ ...moveTo(model, range.start, false), focus: range.end });
    } else {
      update(moveTo(model, offset, event.shiftKey));
      draggingRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const model = stateRef.current;
    const offset = pointToOffset(event.clientX, event.clientY);
    if (model && offset !== undefined) update(moveTo(model, offset, true));
  };
  const onCanvasPointerUp = () => {
    draggingRef.current = false;
  };

  // ---- Header -------------------------------------------------------------------------

  const headerKey = `${frame.scale}:${value === null}:${busy}:${error ?? ''}:${state?.text ?? ''}`;

  // Above the paragraph unless the free rectangle (the viewport minus its scroll padding:
  // the title bar and stage header sit over it) has no room; then below.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = rootRef.current;
    if (!header || !root) return;
    const viewport = root.closest<HTMLElement>('[data-read-viewport]');
    const view = viewport?.getBoundingClientRect();
    const padding = viewport
      ? Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0
      : 0;
    const layer = root.getBoundingClientRect();
    const room = layer.top + paragraphBox.top - ((view?.top ?? 0) + padding);
    const next = room >= header.offsetHeight + 2 * HEADER_GAP ? 'above' : 'below';
    if (next !== side) setSide(next);
    // The header's height follows its lines; the geometry the zoom and the scroll.
  }, [side, paragraphBox.top, headerKey]);

  const substitutions = useMemo(() => {
    if (preview && draft !== null && preview.text === draft.text) {
      return preview.result.substitutions;
    }
    if (!laid || !value) return [];
    return laid.result.layout.substituted.map((s) => ({
      char: s.char,
      font: s.font,
      family: faceFamilyName(s.font),
    }));
  }, [preview, draft, laid, value]);
  // The faces substituted characters are drawn in, loaded on first use.
  const substitutedFaces = [...new Set(substitutions.map((s) => s.font))].join(' ');
  useEffect(() => {
    for (const key of substitutedFaces.split(' ')) {
      const face = BUNDLED_FACES.find((f) => f.key === key);
      if (face) ensureFace(face);
    }
  }, [substitutedFaces]);
  const honestyFacts = useMemo((): NonNullable<ParagraphCommit['honesty']> => {
    if (preview && draft !== null && preview.text === draft.text) return preview.result;
    const embedded = Object.values(value?.analysis.styles ?? {}).every((st) => st.font.embedded);
    return {
      honesty:
        substitutions.length > 0
          ? 'font-substituted'
          : embedded
            ? 'same-font'
            : 'same-font-not-embedded',
      substitutions,
    };
  }, [preview, draft, substitutions, value]);
  const honesty = honestyLines(substitutions);
  const decision = laid?.result.decision;
  const unsupported = laid?.result.layout.unsupported ?? [];
  const overflowLine =
    decision?.kind === 'tighten'
      ? m.paragraph_tightened({ percent: formatPercent(decision.percent / 100) })
      : decision?.kind === 'overflow'
        ? m.paragraph_overflow()
        : null;
  const ragged = laid?.result.layout.ragged === true;
  const loadError = current && 'error' in current ? current.error : null;
  const shownError =
    error ??
    loadError ??
    (unsupported.length > 0 ? m.paragraph_unsupported({ chars: quotedList(unsupported) }) : null);

  // Say the honesty and overflow lines when they first appear or change.
  const spoken = [...honesty, overflowLine, ragged ? m.paragraph_ragged() : null]
    .filter((line): line is string => line !== null)
    .join(' ');
  const spokenRef = useRef('');
  useEffect(() => {
    if (spoken !== '' && spoken !== spokenRef.current)
      announce(spoken, { key: 'paragraph-editor' });
    spokenRef.current = spoken;
  }, [spoken]);

  // The latest values for event handlers and the unmount commit.
  useLayoutEffect(() => {
    stateRef.current = state;
    valueRef.current = value;
    draftRef.current = draft;
    layoutRef.current = laid;
    leaveRef.current = leave;
    commitRef.current = commitOf;
    finishRef.current = finishWith;
    honestyRef.current = honestyFacts;
  });

  const headerTop =
    side === 'above'
      ? Math.min(paragraphBox.top, box.top) - HEADER_GAP
      : Math.max(paragraphBox.top + paragraphBox.height, box.top + box.height) + HEADER_GAP;

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-paragraph-editor=""
      data-busy={busy || undefined}
      data-composing={composition ? '' : undefined}
      data-preview={showPreview ? '' : undefined}
      data-angle={screenAngle}
    >
      {previewBox ? (
        <canvas
          ref={previewRef}
          className={styles.preview}
          data-testid="paragraph-preview"
          aria-hidden="true"
          style={previewBox}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-testid="paragraph-canvas"
        aria-hidden="true"
        style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      />
      {/* The hidden mirror: keys, IME, clipboard and assistive technology. */}
      <div
        ref={mirrorRef}
        className={styles.mirror}
        role="textbox"
        aria-multiline="true"
        aria-label={m.paragraph_editor_label({ page: target.position })}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        aria-readonly={value === null || busy || undefined}
        contentEditable={value !== null && !busy}
        suppressContentEditableWarning
        spellCheck={false}
        tabIndex={0}
        data-paragraph-mirror=""
        style={{
          left: paragraphBox.left,
          top: paragraphBox.top,
          width: Math.max(paragraphBox.width, 1),
          height: Math.max(paragraphBox.height, 1),
          fontSize: Math.max(6, block.size * frame.scale),
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          setFocused(false);
          // Focus leaving the editor (Tab, another control) leaves it.
          const next = event.relatedTarget;
          if (next instanceof Element && next.closest('[data-paragraph-editor]')) return;
          if (next !== null) void leave();
        }}
        onCompositionStart={onCompositionStart}
        onCompositionUpdate={(event) => compose_(event.data, false)}
        onCompositionEnd={(event) => compose_(event.data, true)}
      />
      <div
        ref={headerRef}
        id={describedBy}
        className={styles.header}
        role="group"
        aria-label={m.paragraph_panel_label()}
        data-side={side}
        data-testid="paragraph-header"
        style={{ left: Math.max(0, Math.min(paragraphBox.left, box.left)), top: headerTop }}
      >
        <div className={styles.lines}>
          {honesty.map((line) => (
            <p key={line} className={styles.honesty} data-testid="paragraph-honesty">
              {line}
            </p>
          ))}
          {overflowLine ? (
            <p
              className={styles.overflow}
              data-kind={decision?.kind}
              data-testid="paragraph-overflow"
            >
              {overflowLine}
            </p>
          ) : null}
          {ragged ? <p className={styles.note}>{m.paragraph_ragged()}</p> : null}
          {shownError ? (
            <p className={styles.error} role="alert" data-testid="paragraph-error">
              {shownError}
            </p>
          ) : null}
          <p className={styles.hint}>
            {busy
              ? m.text_edit_applying()
              : value === null && !loadError
                ? m.paragraph_loading()
                : m.paragraph_hint()}
          </p>
        </div>
        <div className={styles.actions}>
          <Tooltip label={m.paragraph_hint_unavailable()} side="top">
            <button
              type="button"
              className={styles.action}
              aria-disabled="true"
              aria-keyshortcuts="Alt+J"
              onMouseDown={(event) => event.preventDefault()}
              onClick={unavailable}
            >
              {m.paragraph_join()}
            </button>
          </Tooltip>
          <Tooltip label={m.paragraph_hint_unavailable()} side="top">
            <button
              type="button"
              className={styles.action}
              aria-disabled="true"
              aria-keyshortcuts="Alt+S"
              onMouseDown={(event) => event.preventDefault()}
              onClick={unavailable}
            >
              {m.paragraph_split()}
            </button>
          </Tooltip>
          <Popover.Root>
            <Popover.Trigger
              className={styles.info}
              aria-label={m.paragraph_info_label()}
              data-testid="paragraph-info"
            >
              <Info aria-hidden="true" />
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8}>
                <Popover.Popup className={popoverStyles.popup} data-paragraph-editor="">
                  <Popover.Title className={popoverStyles.title}>
                    {m.paragraph_info_label()}
                  </Popover.Title>
                  <Popover.Description className={popoverStyles.body}>
                    {m.paragraph_info_text()}
                  </Popover.Description>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
    </div>
  );
}
