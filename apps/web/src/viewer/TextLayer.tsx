/**
 * Text layer (spec §1, §8, §9): the page's text as transparent DOM spans over the bitmap,
 * one span per engine text run, positioned from glyph geometry and stretched to the run's
 * width. It gives native selection (double-click word, triple-click line, drag across
 * pages), copy with sensible spaces and line breaks (see `installCopyHandler`), and the
 * page's readable content for assistive technology.
 *
 * Built for pages within one page of the viewport, kept while within three, dropped
 * beyond. Selectable only while text selection is live in the one hit order
 * (`hit-order.ts`: the Select tool, and always in Read).
 *
 * In Edit it is also the way into the page-text editor and its hover hint (craft spec
 * §3.5): with Select armed, a double-click on page text from a mouse, or from a pen used
 * as a pointer, opens the editor with the caret at the point (`openTextEditorAt`); never
 * from touch, never from a pen while "Pen draws in Edit" is on. After 400 ms of idle hover
 * (no button down, mouse or pen, not within 300 ms of a pen stroke) over page text with
 * Select or Edit text armed, a faint outline marks the run under the pointer, from this
 * layer's own text model; a target above the text in the hit order (annotation, field,
 * image) shows none, and none shows while a paragraph editor is open. Until the first such
 * double-click, the outline brings a one-line hint, "Double-click to edit text", once per
 * device (`edit-policy-store.ts`).
 */
import type { TextRun } from '@pdf-editor/engine';
import {
  type CSSProperties,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { cssPointToUser } from '../annotations/geometry';
import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { useEditPolicyStore } from '../state/edit-policy-store';
import { useCanEdit } from '../state/ui-store';
import { distanceFromView, useViewStore } from '../state/view-store';
import { openTextEditorAt } from '../text-edit/entry';
import { useTextEditStore } from '../text-edit/text-edit-store';
import { penDrawsNow, pointerLog } from './edit-policy';
import {
  HOVER_DELAY_MS,
  hitAt,
  hitKindOf,
  hoverAllowed,
  isLive,
  opensTextOnDoubleClick,
} from './hit-order';
import { pageFrame } from './page-frame';
import {
  layoutTextLines,
  selectionCopyText,
  separatorAfter,
  TEXT_LAYER_ATTR,
  TEXT_ROW_ATTR,
  type TextLine,
} from './text-model';
import styles from './TextLayer.module.css';
import { useToolStore } from './tool-store';

/** Build within this many pages of the viewport; drop beyond DROP_DISTANCE. */
export const BUILD_DISTANCE = 1;
export const DROP_DISTANCE = 3;
const FONT_FAMILY = 'sans-serif';
const MEASURE_SIZE = 100;
/** A pointer this close to a line's box (CSS px) is over it, for the hover outline. */
const HOVER_SLOP_PX = 2;
/** Gap between the outlined run and the hint below it, CSS px. */
const HINT_GAP_PX = 4;

let measureContext: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

/** Width of `text` at MEASURE_SIZE px in the layer's font (memoized). */
function measure(text: string): number {
  const cached = widths.get(text);
  if (cached !== undefined) return cached;
  measureContext ??= document.createElement('canvas').getContext('2d');
  let width = text.length * MEASURE_SIZE * 0.5;
  if (measureContext) {
    measureContext.font = `${MEASURE_SIZE}px ${FONT_FAMILY}`;
    width = measureContext.measureText(text).width;
  }
  if (widths.size > 5000) widths.clear();
  widths.set(text, width);
  return width;
}

function lineStyle(line: TextLine): CSSProperties {
  const natural = (measure(line.text) * line.thickness) / MEASURE_SIZE;
  const scaleX = natural > 0 ? line.length / natural : 1;
  const transforms: string[] = [];
  if (line.angle !== 0) transforms.push(`rotate(${line.angle}deg)`);
  if (Math.abs(scaleX - 1) > 0.001) transforms.push(`scaleX(${scaleX})`);
  return {
    left: line.left,
    top: line.top,
    fontSize: line.thickness,
    ...(transforms.length === 0 ? {} : { transform: transforms.join(' ') }),
  };
}

/** Index of the line whose box holds `p` (CSS px of the page), or -1. */
export function lineAt(lines: readonly TextLine[], p: { x: number; y: number }): number {
  for (let i = 0; i < lines.length; i++) {
    const box = lines[i]?.box;
    if (!box) continue;
    if (
      p.x >= box.left - HOVER_SLOP_PX &&
      p.x <= box.left + box.width + HOVER_SLOP_PX &&
      p.y >= box.top - HOVER_SLOP_PX &&
      p.y <= box.top + box.height + HOVER_SLOP_PX
    ) {
      return i;
    }
  }
  return -1;
}

export function TextLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageIndex, pageId } = props;
  const distance = useViewStore((s) => distanceFromView(pageIndex, s.visibleRange));
  const mode = useToolStore((s) => s.mode);
  const editable = useCanEdit();
  const selectable = isLive('text-selection', mode, editable);
  // The idle hover outline: Edit only (ADR-0019 §5), and never over an open paragraph
  // editor (its own glyphs and caret are the affordance then).
  const paragraphOpen = useTextEditStore((s) => s.paragraph !== null);
  const hovering = editable && (mode === 'select' || mode === 'edit-text') && !paragraphOpen;
  const hintShown = useEditPolicyStore((s) => s.editTextHintShown);
  const [hover, setHover] = useState<{ readonly key: string; readonly line: number } | null>(null);
  const [built, setBuilt] = useState(false);
  const [runs, setRuns] = useState<{
    key: string;
    page: string;
    runs: readonly TextRun[];
  } | null>(null);

  // Hysteresis: build near the viewport, keep until clearly away (spec §8).
  if (!built && distance <= BUILD_DISTANCE && sourceId !== undefined) setBuilt(true);
  if (built && distance > DROP_DISTANCE) setBuilt(false);

  // The page's content revision: a text edit changes its text (and bumps the revision).
  const service = getEngineService();
  const revision = useSyncExternalStore(service.subscribeRevisions, () =>
    sourceId === undefined ? 0 : service.pageRevision(sourceId, sourceIndex),
  );
  const page = `${sourceId ?? ''}:${sourceIndex}`;
  const key = `${page}:${revision}`;
  const layerRef = useRef<HTMLDivElement>(null);
  const linesRef = useRef<readonly TextLine[]>([]);
  const hasLayer = built && runs?.page === page;

  // The idle hover outline (craft spec §3.5). Follows the pointer over the page's overlays
  // (the page container can be re-created under a mounted layer, so it listens on the
  // document), which also covers the Edit text tool's run targets above this layer.
  useEffect(() => {
    if (!hovering || !hasLayer) return;
    let timer: number | undefined;
    const hide = () => {
      window.clearTimeout(timer);
      setHover((h) => (h === null ? h : null));
    };
    const onMove = (event: PointerEvent) => {
      window.clearTimeout(timer);
      const layer = layerRef.current;
      const overlays = layer?.parentElement;
      if (
        !layer ||
        !(event.target instanceof Node) ||
        !overlays?.contains(event.target) ||
        !hoverAllowed(event, performance.now(), pointerLog.lastPenUpAt)
      ) {
        hide();
        return;
      }
      // A target above the text in the hit order owns the point.
      const kind = hitKindOf(event.target instanceof Element ? event.target : null);
      if (kind === 'annotation' || kind === 'form-widget' || kind === 'image') {
        hide();
        return;
      }
      const r = layer.getBoundingClientRect();
      const line = lineAt(linesRef.current, {
        x: event.clientX - r.left,
        y: event.clientY - r.top,
      });
      setHover((h) => (h === null || h.line === line ? h : null));
      if (line < 0) return;
      timer = window.setTimeout(() => setHover({ key, line }), HOVER_DELAY_MS);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', hide, { capture: true, passive: true });
    document.addEventListener('pointerleave', hide);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', hide, { capture: true });
      document.removeEventListener('pointerleave', hide);
      hide();
    };
  }, [hovering, hasLayer, key]);

  // While dragging a selection, the whole layer catches the pointer so the selection does
  // not jump to the page gap or to other elements (pdf.js "endOfContent").
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !selectable) return;
    const done = () => {
      delete layer.dataset.selecting;
      window.removeEventListener('pointerup', done);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      layer.dataset.selecting = 'true';
      window.addEventListener('pointerup', done);
    };
    layer.addEventListener('mousedown', onMouseDown);
    return () => {
      layer.removeEventListener('mousedown', onMouseDown);
      done();
    };
  });

  useEffect(() => {
    if (!built || sourceId === undefined) return;
    const controller = new AbortController();
    void getEngineService()
      .getPageText(sourceId, sourceIndex, controller.signal)
      .then((result) => {
        if (result.ok) setRuns({ key, page, runs: result.value });
      });
    return () => controller.abort();
  }, [built, sourceId, sourceIndex, key, page]);

  const frame = pageFrame(props);
  const lines = hasLayer && runs ? layoutTextLines(runs.runs, frame) : [];
  useEffect(() => {
    linesRef.current = lines;
  });

  // A new revision keeps showing the previous text until the new text arrives.
  if (!hasLayer || lines.length === 0) return null;

  /** Select, in Edit: a double-click on page text opens the editor with the caret there. */
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!editable || mode !== 'select' || sourceId === undefined || event.button !== 0) return;
    if (!opensTextOnDoubleClick(pointerLog.lastDownType, penDrawsNow())) return;
    // The one hit order: only when page text is what is under the pointer.
    if (hitAt(event.clientX, event.clientY)?.kind !== 'text-selection') return;
    const r = event.currentTarget.getBoundingClientRect();
    const point = cssPointToUser(frame, { x: event.clientX - r.left, y: event.clientY - r.top });
    // The editor takes the place of the word the double-click selected.
    window.getSelection()?.removeAllRanges();
    useEditPolicyStore.getState().markEditTextHintShown();
    setHover(null);
    void openTextEditorAt(
      { source: sourceId, pageIndex: sourceIndex, pageId, position: pageIndex + 1 },
      point,
    );
  };

  const outlined = hover?.key === key && hovering ? lines[hover.line] : undefined;
  const hint = outlined !== undefined && mode === 'select' && !hintShown;

  return (
    <>
      <div
        className={styles.layer}
        {...{ [TEXT_LAYER_ATTR]: String(pageIndex) }}
        data-selectable={selectable}
        data-testid="text-layer"
        ref={layerRef}
        onDoubleClick={onDoubleClick}
      >
        {lines.map((line, i) => {
          const separator = separatorAfter(lines, i);
          return (
            <Fragment key={i}>
              <span {...{ [TEXT_ROW_ATTR]: line.row }} style={lineStyle(line)}>
                {line.text}
              </span>
              {separator === '' ? null : <span className={styles.separator}>{separator}</span>}
            </Fragment>
          );
        })}
        <div className={styles.end} aria-hidden="true" />
      </div>
      {hovering ? (
        <div className={styles.hover} data-text-hover="">
          {outlined ? (
            <div
              className={styles.outline}
              data-testid="text-hover-outline"
              aria-hidden="true"
              style={{
                left: outlined.box.left,
                top: outlined.box.top,
                width: outlined.box.width,
                height: outlined.box.height,
              }}
            />
          ) : null}
          {mode === 'select' && !hintShown ? (
            <div className={styles.hintStatus} role="status">
              {hint && outlined ? (
                <span
                  className={styles.hint}
                  style={{
                    left: outlined.box.left,
                    top: outlined.box.top + outlined.box.height + HINT_GAP_PX,
                  }}
                >
                  {m.edit_text_hint()}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Replaces the browser's copy text (absolutely positioned spans serialize one per line)
 * with the assembled page text whenever the selection lies in a text layer. Returns a
 * disposer.
 */
export function installCopyHandler(target: Document = document): () => void {
  const onCopy = (event: ClipboardEvent) => {
    const text = selectionCopyText(target.getSelection());
    if (text === undefined || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  };
  target.addEventListener('copy', onCopy);
  return () => target.removeEventListener('copy', onCopy);
}
