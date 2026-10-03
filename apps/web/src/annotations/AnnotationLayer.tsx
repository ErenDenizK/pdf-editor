/**
 * Annotation layer (spec §2–§4): one per page in Read mode, registered as a page overlay.
 *
 * PDFium draws every annotation's appearance into the page bitmap; this layer draws only
 * what the bitmap cannot: hit targets, the selection with its handles, creation feedback
 * (drag rectangles, ink strokes, markup quads), in-place editors and the contextual bar.
 * All of it is in CSS pixels of the displayed page; geometry is converted to and from
 * unrotated user space through the viewer's page frame, so rotated pages need no special
 * case here. The one exception is a note, which occupies its upright icon rather than its
 * /Rect on /Rotate pages: `displayRect` and `dragAnnotation` (geometry.ts) handle it.
 *
 * With the Select tool the layer lets pointer events through (to the text layer) except
 * on annotations; with a drawing tool it captures the whole page. In Read (ADR-0019 §3) it
 * is inert: no hit targets, no drawing, no bar, no editor, no handles (`useCanEdit`).
 *
 * Writing is never interrupted (experience-redesign spec §6.1): what a drawing tool creates
 * is not selected (no contextual bar, no inspector change), its preview stays until the
 * page bitmap shows the committed annotation (`whenPainted`), and a press while an inline
 * editor is open commits the editor and draws in the same press.
 *
 * The pen (ink tool) has its own input pipeline (spec §6.6, `pen/ink-input.ts`): native
 * pointer handlers attached while it is armed, coalesced points, a canvas preview drawn by
 * the engine's outline function (`pen/ink-preview.ts`) and width from pressure or speed,
 * with no React state per move. The other tools keep the React gesture below. Strokes
 * written in one go join one Ink annotation (a burst, spec §6.4, `pen/bursts.ts`); the
 * eraser removes whole paths from it and the annotation with its last path.
 *
 * The lasso (spec §6.5, `lasso/`) also has native handlers: it draws a free path, takes the
 * pen paths it touches as a path selection, highlights only those paths and shows the
 * contextual bar for them; its edits split an Ink when they take only some of its paths.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation, NewAnnotation } from '@pdf-editor/engine';
import { Lock } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import { getEngineService } from '../engine/engine-service';
import { m } from '../i18n';
import { announce } from '../shell/announcer';
import type { PageOverlayProps } from '../stage/page-overlays';
import { useCanEdit } from '../state/ui-store';
import { pageFrame } from '../viewer/page-frame';
import { whenPainted } from '../viewer/read-controller';
import { type ToolMode, useToolStore } from '../viewer/tool-store';
import { createAnnotations, deleteAnnotations, updateAnnotations } from './actions';
import { AnnotationBar } from './AnnotationBar';
import {
  activePathSelection,
  type PageTarget,
  useAnnotationStore,
  usePageAnnotations,
} from './annotation-store';
import { markupDraft, styleGroupOf } from './drafts';
import {
  type Box,
  boxFromPoints,
  canMove,
  canResize,
  cssBoxToUser,
  cssPointToUser,
  displayRect,
  dragAnnotation,
  geometryRect,
  isTextMarkup,
  type PageFrame,
  rectToCss,
  resizeAnnotation,
  roundRect,
  userToCss,
} from './geometry';
import { commitOpenEditor, InlineEditorView } from './InlineEditors';
import {
  boundsOf,
  distanceToPolyline,
  finishInkStroke,
  type Point,
  snapAngle,
  snapSquare,
} from './ink';
import { attachLassoInput } from './lasso/lasso-input';
import { LassoHighlight } from './lasso/LassoSelection';
import { mountedLayers } from './layer-registry';
import { commitPenStroke, noteBurstPress } from './pen/bursts';
import { attachInkInput, type InkStrokeInput, type SettleInk } from './pen/ink-input';
import { commitHighlighterStroke, createPenPreview } from './pen/highlighter';
import { previewPath } from './pen/ink-preview';
import { pageText } from './page-text';
import { glyphIndexAt, quadsForRange } from './quads';
import styles from './AnnotationLayer.module.css';
import { naturalStampSize } from './stamps';

/** Smallest drag (CSS px) that counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;
const HANDLE = 8;

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';

type Gesture =
  | {
      readonly type: 'draw';
      readonly tool: ToolMode;
      readonly start: Point;
      readonly current: Point;
      readonly points: readonly Point[];
      readonly shift: boolean;
      /** Markup: user-space quads under the drag. */
      readonly quads?: readonly Rect[];
    }
  | {
      readonly type: 'move';
      readonly ids: readonly string[];
      readonly start: Point;
      readonly current: Point;
    }
  | {
      readonly type: 'resize';
      readonly id: string;
      readonly handle: Handle;
      readonly start: Point;
      readonly current: Point;
      readonly shift: boolean;
    }
  | {
      readonly type: 'erase';
      readonly hits: ReadonlyMap<string, ReadonlySet<number>>;
      readonly points: readonly Point[];
    };

type DrawGesture = Extract<Gesture, { type: 'draw' }>;

/** A finished drawing gesture whose preview stays until the page shows what it created. */
interface SettlingPreview {
  readonly key: number;
  readonly gesture: DrawGesture;
}

let settlingSerial = 0;

const MARKUP_TOOLS = new Set<ToolMode>(['highlight', 'underline', 'strikeout', 'squiggly']);
const DRAWING_TOOLS = new Set<ToolMode>([
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'ink',
  'eraser',
  'lasso',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'text-box',
  'note',
  'stamp',
  'signature',
]);

export function AnnotationLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  const mode = useToolStore((s) => s.mode);
  // The Read lock: every press below fails closed while the document is not in Edit.
  const editable = useCanEdit();
  const annotations = usePageAnnotations(sourceId, sourceIndex);
  const selection = useAnnotationStore((s) =>
    s.selection?.pageId === pageId ? s.selection : null,
  );
  const editor = useAnnotationStore((s) => (s.editor?.target.pageId === pageId ? s.editor : null));
  const ensurePage = useAnnotationStore((s) => s.ensurePage);
  const rootRef = useRef<HTMLDivElement>(null);
  const inkHostRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [settling, setSettling] = useState<readonly SettlingPreview[]>([]);

  useEffect(() => {
    if (sourceId !== undefined && visible) ensurePage(sourceId, sourceIndex);
  }, [sourceId, sourceIndex, visible, ensurePage]);

  // Keep the registry current (geometry changes with zoom and rotation).
  useEffect(() => {
    const element = rootRef.current;
    if (!element || sourceId === undefined) return;
    mountedLayers.set(pageId, {
      element,
      frame: pageFrame(props),
      target: { source: sourceId, pageIndex: sourceIndex, pageId, position: pageIndex + 1 },
    });
    return () => {
      if (mountedLayers.get(pageId)?.element === element) mountedLayers.delete(pageId);
    };
  });

  // The pen: native input while armed (spec §6.6). Style, zoom and target are read at the
  // press from the store and the layer registry, so nothing re-attaches per render.
  const penArmed = editable && mode === 'ink' && sourceId !== undefined;
  useEffect(() => {
    const element = rootRef.current;
    const host = inkHostRef.current;
    if (!penArmed || !element || !host) return;
    // The Highlighter's profile (constant width, Multiply) applies when it is armed.
    const preview = createPenPreview(host, element, pageId);
    // The press of the stroke in progress (`performance.now()` clock, as event time stamps).
    let downAt = 0;
    const detach = attachInkInput({
      element,
      preview,
      context: () => {
        const layer = mountedLayers.get(pageId);
        if (!layer) return null;
        const style = useAnnotationStore.getState().styles.ink;
        return {
          width: style.strokeWidth,
          color: style.color,
          opacity: style.opacity,
          scale: layer.frame.scale,
        };
      },
      onBegin: (event) => {
        downAt = event.timeStamp;
        noteBurstPress();
        beginDrawingPress();
      },
      onStroke: (stroke, settle) => {
        const layer = mountedLayers.get(pageId);
        if (!layer) return;
        void commitInkStroke(stroke, settle, layer.frame, layer.target, {
          downAt,
          upAt: performance.now(),
        });
      },
    });
    return () => {
      detach();
      preview.destroy();
    };
  }, [penArmed, pageId]);

  // The lasso: native input while armed, like the pen (spec §6.5, lasso/lasso-input.ts).
  const lassoArmed = editable && mode === 'lasso' && sourceId !== undefined;
  useEffect(() => {
    const element = rootRef.current;
    if (!lassoArmed || !element) return;
    return attachLassoInput({ element, pageId });
  }, [lassoArmed, pageId]);
  const lassoPaths = useAnnotationStore((s) => {
    const paths = activePathSelection(s);
    return paths?.pageId === pageId ? paths.paths : null;
  });

  if (sourceId === undefined) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };
  const drawing = editable && DRAWING_TOOLS.has(mode);

  const update = (next: Gesture | null) => {
    gestureRef.current = next;
    setGesture(next);
  };

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: event.clientX - r.left, y: event.clientY - r.top } : { x: 0, y: 0 };
  };

  /** Follows the pointer on the window until release (works across the page edge). */
  const track = (
    onMove: (p: Point, e: PointerEvent) => void,
    onEnd: (p: Point, e: PointerEvent) => void,
  ) => {
    const move = (e: PointerEvent) => onMove(localPoint(e), e);
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      onEnd(localPoint(e), e);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      update(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // -------------------------------------------------------------------------
  // Drawing tools
  // -------------------------------------------------------------------------

  const onRootPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // The pen has its own native handlers (see above).
    // The pen and the lasso have their own native handlers (see above).
    if (!drawing || mode === 'ink' || mode === 'lasso' || event.button !== 0) return;
    // Presses in the layer's own chrome (bar, editors) are theirs.
    if (event.target instanceof Element && event.target.closest('[data-annotation-keep]')) return;
    event.preventDefault();
    // With the text box or note tool a press that finishes an editor does only that; going
    // on would open a second, empty editor under the pointer at once.
    if (beginDrawingPress() && (mode === 'text-box' || mode === 'note')) return;
    const start = localPoint(event);
    if (mode === 'eraser') {
      const first: Gesture = {
        type: 'erase',
        hits: eraseHits(new Map(), annotations, frame, start),
        points: [start],
      };
      update(first);
      track(
        (p) => {
          const g = gestureRef.current;
          if (g?.type !== 'erase') return;
          update({
            ...g,
            hits: eraseHits(g.hits, annotations, frame, p),
            points: [...g.points, p],
          });
        },
        () => {
          const g = gestureRef.current;
          update(null);
          if (g?.type === 'erase') void commitErase(target, annotations, g.hits);
        },
      );
      return;
    }
    const initial: Gesture = {
      type: 'draw',
      tool: mode,
      start,
      current: start,
      points: [start],
      shift: event.shiftKey,
    };
    update(initial);
    const markup = MARKUP_TOOLS.has(mode);
    const runs = markup ? pageText(sourceId, sourceIndex) : undefined;
    const withQuads = async (g: Extract<Gesture, { type: 'draw' }>) => {
      if (!runs) return g;
      const text = await runs;
      const from = glyphIndexAt(text, cssPointToUser(frame, g.start));
      const to = glyphIndexAt(text, cssPointToUser(frame, g.current));
      return { ...g, quads: quadsForRange(text, from, to) };
    };
    track(
      (p, e) => {
        const g = gestureRef.current;
        if (g?.type !== 'draw') return;
        const next = { ...g, current: p, points: [...g.points, p], shift: e.shiftKey };
        update(next);
        if (markup) {
          void withQuads(next).then((q) => {
            if (gestureRef.current?.type === 'draw' && gestureRef.current.current === p) update(q);
          });
        }
      },
      (p, e) => {
        const g = gestureRef.current;
        if (g?.type !== 'draw') {
          update(null);
          return;
        }
        const final = { ...g, current: p, points: [...g.points, p], shift: e.shiftKey };
        // The preview moves from the gesture to the settling list in the same render, so
        // there is no frame without it; it goes once the page shows the annotation.
        const key = ++settlingSerial;
        setSettling((list) => [...list, { key, gesture: final }]);
        update(null);
        const release = () => {
          setSettling((list) => list.filter((x) => x.key !== key));
        };
        void (markup ? withQuads(final) : Promise.resolve(final))
          .then((done) => finishDraw(done, frame, target))
          .catch((error: unknown) => {
            console.warn('Creating the annotation failed', error);
            return 'failed' as const;
          })
          .then(async (outcome) => {
            if (outcome === 'committed') {
              const generation = getEngineService().pageRevision(target.source, target.pageIndex);
              await whenPainted(target.source, target.pageIndex, generation);
            }
            release();
          });
      },
    );
  };

  // -------------------------------------------------------------------------
  // Selection, move, resize
  // -------------------------------------------------------------------------

  const onAnnotationPointerDown = (event: ReactPointerEvent, a: Annotation) => {
    if (!editable || drawing || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const store = useAnnotationStore.getState();
    const current = store.selection?.pageId === pageId ? store.selection.ids : [];
    let ids: readonly string[];
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      ids = current.includes(a.id) ? current.filter((id) => id !== a.id) : [...current, a.id];
    } else {
      ids = current.includes(a.id) ? current : [a.id];
    }
    store.select({ ...target, ids });
    if (a.flags?.locked || !canMove(a) || !ids.includes(a.id)) return;
    const movable = ids.filter((id) => {
      const x = annotations.find((b) => b.id === id);
      return x !== undefined && canMove(x) && !x.flags?.locked;
    });
    const start = localPoint(event);
    track(
      (p) => {
        const g = gestureRef.current;
        if (g?.type === 'move') update({ ...g, current: p });
        else if (Math.hypot(p.x - start.x, p.y - start.y) >= DRAG_THRESHOLD) {
          update({ type: 'move', ids: movable, start, current: p });
        }
      },
      (p) => {
        const g = gestureRef.current;
        update(null);
        if (g?.type !== 'move') return;
        const a0 = cssPointToUser(frame, g.start);
        const a1 = cssPointToUser(frame, p);
        if (Math.abs(a1.x - a0.x) < 0.01 && Math.abs(a1.y - a0.y) < 0.01) return;
        // Notes move by their drawn icon, which is not their /Rect on /Rotate pages.
        void updateAnnotations(target, g.ids, (x) => dragAnnotation(frame, x, g.start, p), {
          action: 'move',
          coalesceKey: `move:${[...g.ids].sort().join(',')}`,
        });
      },
    );
  };

  const onHandlePointerDown = (event: ReactPointerEvent, a: Annotation, handle: Handle) => {
    if (!editable || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const start = localPoint(event);
    update({ type: 'resize', id: a.id, handle, start, current: start, shift: event.shiftKey });
    track(
      (p, e) => {
        const g = gestureRef.current;
        if (g?.type === 'resize') update({ ...g, current: p, shift: e.shiftKey });
      },
      (p, e) => {
        const g = gestureRef.current;
        update(null);
        if (g?.type !== 'resize') return;
        const next = resized(a, { ...g, current: p, shift: e.shiftKey }, frame);
        if (!next) return;
        void updateAnnotations(target, [a.id], () => next, {
          action: 'resize',
          coalesceKey: `resize:${a.id}`,
        });
      },
    );
  };

  const onAnnotationDoubleClick = (a: Annotation) => {
    if (!editable || drawing || a.flags?.locked) return;
    const store = useAnnotationStore.getState();
    if (a.kind === 'free-text') {
      store.setEditor({
        kind: 'free-text',
        target,
        id: a.id,
        rect: a.rect,
        text: a.text,
        fixedWidth: true,
      });
    } else {
      store.setEditor({ kind: 'note', target, id: a.id, rect: a.rect, text: a.contents ?? '' });
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const selected = selection ? annotations.filter((a) => selection.ids.includes(a.id)) : [];
  const hitsEnabled = editable && !drawing;
  return (
    <div
      ref={rootRef}
      className={styles.layer}
      data-annotation-layer={pageIndex}
      data-tool={mode}
      data-drawing={drawing || undefined}
      onPointerDown={onRootPointerDown}
    >
      <svg className={styles.svg} aria-hidden="true">
        <defs>
          <marker
            id="annotation-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" />
          </marker>
        </defs>
        {annotations.map((a) => (
          <HitTarget
            key={a.id}
            annotation={a}
            frame={frame}
            enabled={hitsEnabled}
            hidden={gesture?.type === 'erase' && gesture.hits.has(a.id)}
            onPointerDown={(e) => onAnnotationPointerDown(e, a)}
            onDoubleClick={() => onAnnotationDoubleClick(a)}
          />
        ))}
        {lassoPaths ? (
          <LassoHighlight annotations={selected} picks={lassoPaths} frame={frame} />
        ) : null}
        {(lassoPaths ? [] : selected).map((a) => (
          <SelectionOutline
            key={`sel-${a.id}`}
            annotation={a}
            frame={frame}
            gesture={gesture}
            single={editable && selected.length === 1}
            onHandle={onHandlePointerDown}
          />
        ))}
        {settling.map((x) => (
          <DrawPreview key={x.key} gesture={x.gesture} frame={frame} settling />
        ))}
        {gesture?.type === 'draw' ? <DrawPreview gesture={gesture} frame={frame} /> : null}
        {gesture?.type === 'erase' ? <EraseTrail points={gesture.points} /> : null}
      </svg>
      {/* The pen's canvases (pen/ink-preview.ts); React never renders into it. */}
      <div ref={inkHostRef} className={styles.inkPreview} aria-hidden="true" />
      {editable && selected.length > 0 && gesture === null && editor === null ? (
        <AnnotationBar
          target={target}
          annotations={selected}
          frame={frame}
          {...(lassoPaths ? { paths: lassoPaths } : {})}
        />
      ) : null}
      {editable && editor ? <InlineEditorView editor={editor} frame={frame} /> : null}
    </div>
  );
}

AnnotationLayer.displayName = 'AnnotationLayer';

/**
 * What every drawing press does first: clear the selection and commit an open inline
 * editor (spec §6.1), so the first stroke after typing a label is not lost. The caller has
 * prevented the press's default, which keeps focus in the editor; an editor that is not
 * mounted (its page scrolled away) is committed by a blur. True when an editor was open.
 */
function beginDrawingPress(): boolean {
  const store = useAnnotationStore.getState();
  // Skipped when nothing is selected: a store write per stroke is a render per stroke.
  if (store.selection !== null || store.pathSelection !== null) store.select(null);
  if (!store.editor) return false;
  if (!commitOpenEditor() && document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Hit targets and selection
// ---------------------------------------------------------------------------

function polyline(points: readonly Point[]): string {
  return points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function HitTarget({
  annotation: a,
  frame,
  enabled,
  hidden,
  onPointerDown,
  onDoubleClick,
}: {
  readonly annotation: Annotation;
  readonly frame: PageFrame;
  readonly enabled: boolean;
  readonly hidden: boolean;
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onDoubleClick: () => void;
}) {
  const common = {
    'data-annotation-id': a.id,
    'data-annotation-kind': a.kind,
    'data-annotation-keep': '',
    className: styles.hit,
    style: { pointerEvents: enabled ? undefined : 'none' } as const,
    onPointerDown,
    onDoubleClick,
  };
  if (isTextMarkup(a) && 'quads' in a) {
    return (
      <g {...common}>
        {a.quads.map((q, i) => {
          const b = rectToCss(frame, q);
          return <rect key={i} x={b.left} y={b.top} width={b.width} height={b.height} />;
        })}
      </g>
    );
  }
  const width = 'strokeWidth' in a ? Math.max(10, a.strokeWidth * frame.scale + 8) : 10;
  if (a.kind === 'ink') {
    return (
      <g {...common} data-stroke="" opacity={hidden ? 0.2 : undefined}>
        {a.paths.map((path, i) => (
          <polyline
            key={i}
            points={polyline(path.map((p) => userToCss(frame, p)))}
            strokeWidth={width}
          />
        ))}
      </g>
    );
  }
  if ((a.kind === 'line' || a.kind === 'polyline' || a.kind === 'polygon') && a.vertices) {
    return (
      <g {...common} data-stroke="">
        <polyline
          points={polyline(a.vertices.map((p) => userToCss(frame, p)))}
          strokeWidth={width}
        />
      </g>
    );
  }
  const b = rectToCss(frame, displayRect(frame, a));
  return (
    <rect
      {...common}
      x={b.left}
      y={b.top}
      width={Math.max(4, b.width)}
      height={Math.max(4, b.height)}
    />
  );
}

const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function handlePoint(box: Box, handle: Handle): Point {
  const x = handle.includes('w')
    ? box.left
    : handle.includes('e')
      ? box.left + box.width
      : box.left + box.width / 2;
  const y = handle.startsWith('n')
    ? box.top
    : handle.startsWith('s')
      ? box.top + box.height
      : box.top + box.height / 2;
  return { x, y };
}

/** The box of `box` with `handle` dragged by (dx, dy); Shift (or `keepAspect`) keeps the ratio. */
export function resizeBox(
  box: Box,
  handle: Handle,
  dx: number,
  dy: number,
  keepAspect: boolean,
): Box {
  let left = box.left;
  let top = box.top;
  let right = box.left + box.width;
  let bottom = box.top + box.height;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.startsWith('n')) top += dy;
  if (handle.startsWith('s')) bottom += dy;
  let width = Math.max(4, right - left);
  let height = Math.max(4, bottom - top);
  if (keepAspect && box.width > 0 && box.height > 0) {
    const ratio = box.height / box.width;
    if (handle === 'n' || handle === 's') width = height / ratio;
    else height = width * ratio;
  }
  if (handle.includes('w')) left = right - width;
  if (handle.startsWith('n')) top = bottom - height;
  return { left, top, width, height };
}

/** The annotation after a resize gesture, or undefined when nothing changes. */
function resized(
  a: Annotation,
  g: Extract<Gesture, { type: 'resize' }>,
  frame: PageFrame,
): Annotation | undefined {
  const dx = g.current.x - g.start.x;
  const dy = g.current.y - g.start.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return undefined;
  if (
    a.kind === 'line' &&
    a.vertices?.length === 2 &&
    (g.handle === 'start' || g.handle === 'end')
  ) {
    const [v0, v1] = a.vertices as [Point, Point];
    const moving = g.handle === 'start' ? v0 : v1;
    const fixed = g.handle === 'start' ? v1 : v0;
    const fixedCss = userToCss(frame, fixed);
    const css = userToCss(frame, moving);
    let next: Point = { x: css.x + dx, y: css.y + dy };
    if (g.shift) next = snapAngle(fixedCss, next);
    const user = cssPointToUser(frame, next);
    const vertices = g.handle === 'start' ? [user, fixed] : [fixed, user];
    return { ...a, vertices, rect: roundRect(boundsOf([vertices], a.strokeWidth / 2 + 6)) };
  }
  const from = geometryRect(a);
  const box = rectToCss(frame, from);
  const next = resizeBox(box, g.handle, dx, dy, g.shift || a.kind === 'stamp');
  return resizeAnnotation(a, from, cssBoxToUser(frame, next));
}

function SelectionOutline({
  annotation: a,
  frame,
  gesture,
  single,
  onHandle,
}: {
  readonly annotation: Annotation;
  readonly frame: PageFrame;
  readonly gesture: Gesture | null;
  readonly single: boolean;
  readonly onHandle: (event: ReactPointerEvent, a: Annotation, handle: Handle) => void;
}) {
  let shown: Annotation = a;
  if (gesture?.type === 'move' && gesture.ids.includes(a.id)) {
    shown = dragAnnotation(frame, a, gesture.start, gesture.current);
  } else if (gesture?.type === 'resize' && gesture.id === a.id) {
    shown = resized(a, gesture, frame) ?? a;
  }
  const box = rectToCss(frame, displayRect(frame, shown));
  const locked = a.flags?.locked === true;
  const showHandles = single && !locked && gesture === null;
  const isLine = a.kind === 'line' && a.vertices?.length === 2;
  return (
    <g className={styles.selection} data-selected-annotation={a.id}>
      {isTextMarkup(shown) && 'quads' in shown ? (
        shown.quads.map((q, i) => {
          const b = rectToCss(frame, q);
          return (
            <rect
              key={i}
              className={styles.outline}
              x={b.left - 1}
              y={b.top - 1}
              width={b.width + 2}
              height={b.height + 2}
            />
          );
        })
      ) : isLine && shown.kind === 'line' && shown.vertices ? (
        <polyline
          className={styles.outline}
          points={polyline(shown.vertices.map((p) => userToCss(frame, p)))}
        />
      ) : (
        <rect
          className={styles.outline}
          x={box.left - 2}
          y={box.top - 2}
          width={box.width + 4}
          height={box.height + 4}
        />
      )}
      {gesture !== null && shown !== a ? <GhostShape annotation={shown} frame={frame} /> : null}
      {showHandles && isLine && a.kind === 'line' && a.vertices
        ? (['start', 'end'] as const).map((handle, i) => {
            const p = userToCss(frame, a.vertices?.[i] ?? { x: 0, y: 0 });
            return (
              <rect
                key={handle}
                className={styles.handle}
                data-handle={handle}
                data-annotation-keep=""
                x={p.x - HANDLE / 2}
                y={p.y - HANDLE / 2}
                width={HANDLE}
                height={HANDLE}
                onPointerDown={(e) => onHandle(e, a, handle)}
              />
            );
          })
        : null}
      {showHandles && canResize(a)
        ? HANDLES.map((handle) => {
            const p = handlePoint(
              {
                left: box.left - 2,
                top: box.top - 2,
                width: box.width + 4,
                height: box.height + 4,
              },
              handle,
            );
            return (
              <rect
                key={handle}
                className={styles.handle}
                data-handle={handle}
                data-annotation-keep=""
                x={p.x - HANDLE / 2}
                y={p.y - HANDLE / 2}
                width={HANDLE}
                height={HANDLE}
                onPointerDown={(e) => onHandle(e, a, handle)}
              />
            );
          })
        : null}
      {locked ? (
        <foreignObject x={box.left + box.width - 8} y={box.top - 18} width={20} height={20}>
          <span className={styles.lockBadge} title={m.annot_locked()}>
            <Lock aria-hidden="true" />
          </span>
        </foreignObject>
      ) : null}
    </g>
  );
}

/** Dashed outline of where a moved or resized annotation will go. */
function GhostShape({
  annotation: a,
  frame,
}: {
  readonly annotation: Annotation;
  readonly frame: PageFrame;
}) {
  if (a.kind === 'ink') {
    return (
      <g className={styles.ghost}>
        {a.paths.map((path, i) => (
          <polyline key={i} points={polyline(path.map((p) => userToCss(frame, p)))} />
        ))}
      </g>
    );
  }
  if (a.kind === 'line' && a.vertices) {
    return (
      <polyline
        className={styles.ghost}
        points={polyline(a.vertices.map((p) => userToCss(frame, p)))}
      />
    );
  }
  if (a.kind === 'circle') {
    const b = rectToCss(frame, a.rect);
    return (
      <ellipse
        className={styles.ghost}
        cx={b.left + b.width / 2}
        cy={b.top + b.height / 2}
        rx={b.width / 2}
        ry={b.height / 2}
      />
    );
  }
  const b = rectToCss(frame, displayRect(frame, a));
  return <rect className={styles.ghost} x={b.left} y={b.top} width={b.width} height={b.height} />;
}

// ---------------------------------------------------------------------------
// Creation feedback and commit
// ---------------------------------------------------------------------------

function constrainedEnd(g: DrawGesture): Point {
  if (!g.shift) return g.current;
  if (g.tool === 'line' || g.tool === 'arrow') return snapAngle(g.start, g.current);
  if (g.tool === 'rectangle' || g.tool === 'ellipse') return snapSquare(g.start, g.current);
  return g.current;
}

function DrawPreview({
  gesture: g,
  frame,
  settling = false,
}: {
  readonly gesture: DrawGesture;
  readonly frame: PageFrame;
  /** Released, waiting for the page to show the committed annotation (`data-settling`). */
  readonly settling?: boolean;
}) {
  const marker = settling ? { 'data-settling': '' } : {};
  const style = useAnnotationStore((s) => s.styles[styleGroupOf(g.tool)]);
  const stroke = style.color;
  const width = Math.max(1, style.strokeWidth * frame.scale);
  const end = constrainedEnd(g);
  switch (g.tool) {
    case 'rectangle':
    case 'text-box':
    case 'stamp':
    case 'signature': {
      const b = boxFromPoints(g.start, end);
      return (
        <rect
          className={g.tool === 'rectangle' ? styles.previewShape : styles.previewBox}
          x={b.left}
          y={b.top}
          width={b.width}
          height={b.height}
          stroke={g.tool === 'rectangle' ? stroke : undefined}
          strokeWidth={g.tool === 'rectangle' ? width : undefined}
          data-testid="annotation-preview"
          {...marker}
        />
      );
    }
    case 'ellipse': {
      const b = boxFromPoints(g.start, end);
      return (
        <ellipse
          className={styles.previewShape}
          cx={b.left + b.width / 2}
          cy={b.top + b.height / 2}
          rx={b.width / 2}
          ry={b.height / 2}
          stroke={stroke}
          strokeWidth={width}
          data-testid="annotation-preview"
          {...marker}
        />
      );
    }
    case 'line':
    case 'arrow':
      return (
        <polyline
          className={styles.previewShape}
          points={polyline([g.start, end])}
          stroke={stroke}
          strokeWidth={width}
          markerEnd={g.tool === 'arrow' ? 'url(#annotation-arrow)' : undefined}
          data-testid="annotation-preview"
          {...marker}
        />
      );
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return (
        <g
          className={styles.previewMarkup}
          data-tool={g.tool}
          data-testid="annotation-preview"
          {...marker}
        >
          {(g.quads ?? []).map((q, i) => {
            const b = rectToCss(frame, q);
            return (
              <rect key={i} x={b.left} y={b.top} width={b.width} height={b.height} fill={stroke} />
            );
          })}
        </g>
      );
    default:
      return null;
  }
}

function EraseTrail({ points }: { readonly points: readonly Point[] }) {
  return <polyline className={styles.eraseTrail} points={polyline(points)} />;
}

/** Ink strokes under `p` (CSS px), added to `hits` (annotation id → stroke indices). */
function eraseHits(
  hits: ReadonlyMap<string, ReadonlySet<number>>,
  annotations: readonly Annotation[],
  frame: PageFrame,
  p: Point,
): ReadonlyMap<string, ReadonlySet<number>> {
  const user = cssPointToUser(frame, p);
  let next: Map<string, Set<number>> | undefined;
  for (const a of annotations) {
    if (a.kind !== 'ink' || a.flags?.locked) continue;
    const tolerance = a.strokeWidth / 2 + 6 / frame.scale;
    a.paths.forEach((path, i) => {
      if (hits.get(a.id)?.has(i)) return;
      if (distanceToPolyline(user, path) > tolerance) return;
      next ??= new Map([...hits].map(([k, v]) => [k, new Set(v)]));
      const set = next.get(a.id) ?? new Set<number>();
      set.add(i);
      next.set(a.id, set);
    });
  }
  return next ?? hits;
}

/**
 * Removes erased strokes (spec §6.4): whole paths, never parts of one. An Ink whose every
 * path goes is deleted; otherwise the paths that remain stay one annotation, their widths
 * kept parallel (ADR-0018), even when the erased path was between them.
 */
async function commitErase(
  target: PageTarget,
  annotations: readonly Annotation[],
  hits: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<void> {
  const whole: string[] = [];
  const partial: string[] = [];
  for (const [id, strokes] of hits) {
    const a = annotations.find((x) => x.id === id);
    if (a?.kind !== 'ink') continue;
    if (strokes.size >= a.paths.length) whole.push(id);
    else partial.push(id);
  }
  if (whole.length > 0) await deleteAnnotations(target, whole);
  if (partial.length > 0) {
    await updateAnnotations(
      target,
      partial,
      (a) => {
        if (a.kind !== 'ink') return undefined;
        const gone = hits.get(a.id) ?? new Set<number>();
        const paths = a.paths.filter((_, i) => !gone.has(i));
        // Per-point widths stay parallel to the paths that remain (ADR-0018).
        const widths = a.widths?.filter((_, i) => !gone.has(i));
        const widest = Math.max(a.strokeWidth, ...(widths?.flat() ?? []));
        // Paths left on both sides of an erased one stay one annotation: the burst was
        // written as one item, and splitting it would change its Review row and comment.
        return {
          ...a,
          paths,
          ...(widths ? { widths } : {}),
          rect: roundRect(boundsOf(paths, widest / 2 + 1)),
        };
      },
      { action: 'erase' },
    );
  }
}

function dragged(g: DrawGesture): boolean {
  return Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) >= DRAG_THRESHOLD;
}

/**
 * What became of a finished drawing gesture: nothing to create (too small, or an editor
 * opened), an annotation committed to the history, or a commit that did not happen.
 */
type DrawOutcome = 'none' | 'committed' | 'failed';

/**
 * Turns a finished drawing gesture into an annotation (or an in-place editor). Nothing it
 * creates is selected (spec §6.1), except a placed stamp or signature: those are placed to
 * be moved and sized at once, and are not part of a writing flow.
 */
async function finishDraw(
  g: DrawGesture,
  frame: PageFrame,
  target: PageTarget,
): Promise<DrawOutcome> {
  const store = useAnnotationStore.getState();
  const style = store.styles[styleGroupOf(g.tool)];
  const pageIndex = target.pageIndex;
  const end = constrainedEnd(g);
  const base = { pageIndex, opacity: style.opacity };
  let draft: NewAnnotation | undefined;
  let labelKind: 'arrow' | 'signature' | undefined;
  switch (g.tool) {
    case 'rectangle':
    case 'ellipse': {
      if (!dragged(g)) return 'none';
      const rect = roundRect(cssBoxToUser(frame, boxFromPoints(g.start, end)));
      draft = {
        ...base,
        kind: g.tool === 'rectangle' ? 'square' : 'circle',
        rect,
        color: style.color,
        strokeWidth: style.strokeWidth,
      };
      break;
    }
    case 'line':
    case 'arrow': {
      if (!dragged(g)) return 'none';
      const vertices = [cssPointToUser(frame, g.start), cssPointToUser(frame, end)];
      draft = {
        ...base,
        kind: 'line',
        rect: roundRect(boundsOf([vertices], style.strokeWidth / 2 + 6)),
        vertices,
        color: style.color,
        strokeWidth: style.strokeWidth,
        ...(g.tool === 'arrow' ? { lineEndings: { start: 'none', end: 'open-arrow' } } : {}),
      };
      if (g.tool === 'arrow') labelKind = 'arrow';
      break;
    }
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const quads = g.quads ?? [];
      if (quads.length === 0) return 'none';
      draft = markupDraft(g.tool, pageIndex, quads, style.color, style.opacity);
      break;
    }
    case 'text-box': {
      const isDrag = dragged(g);
      const box = isDrag
        ? boxFromPoints(g.start, end)
        : { left: g.start.x, top: g.start.y, width: 200 * frame.scale, height: 0 };
      const rect = cssBoxToUser(frame, box);
      store.setEditor({
        kind: 'free-text',
        target,
        rect: roundRect(rect),
        text: '',
        fixedWidth: isDrag,
      });
      return 'none';
    }
    case 'note': {
      const p = cssPointToUser(frame, g.start);
      store.setEditor({
        kind: 'note',
        target,
        rect: { x: Math.round(p.x), y: Math.round(p.y - 20), width: 20, height: 20 },
        text: '',
      });
      return 'none';
    }
    case 'stamp':
    case 'signature': {
      const pending = store.pendingStamp;
      if (!pending) return 'none';
      const natural = naturalStampSize(pending);
      const ratio = natural.height / natural.width;
      let rect: Rect;
      if (dragged(g)) {
        // The dragged width (along the page's user x axis) decides; the aspect stays.
        const r = cssBoxToUser(frame, boxFromPoints(g.start, end));
        const width = Math.max(12, r.width);
        rect = { x: r.x, y: r.y + r.height - width * ratio, width, height: width * ratio };
      } else {
        const p = cssPointToUser(frame, g.start);
        rect = { x: p.x - natural.width / 2, y: p.y - natural.height / 2, ...natural };
      }
      draft = {
        ...base,
        kind: 'stamp',
        rect: roundRect(rect),
        ...(pending.blob ? { imageBlob: pending.blob } : {}),
        ...(pending.name ? { name: pending.name } : {}),
      };
      if (g.tool === 'signature') labelKind = 'signature';
      break;
    }
    default:
      return 'none';
  }
  const placed = g.tool === 'stamp' || g.tool === 'signature';
  const created = await createAnnotations(target, [draft], {
    ...(labelKind ? { labelKind } : {}),
    ...(placed ? { select: true } : {}),
  });
  return created && created.length > 0 ? 'committed' : 'failed';
}

// ---------------------------------------------------------------------------
// Pen commit (spec §6.6, §9)
// ---------------------------------------------------------------------------

/** A stroke as it is committed: user-space centre line and the full width per point (pt). */
export interface InkCommit {
  readonly path: Point[];
  readonly widths: number[];
}

/**
 * The centre line and widths a finished pen stroke commits: points mapped to user space,
 * then `finishInkStroke` (dedupe 0.5 pt, Catmull-Rom, Douglas–Peucker 0.3 pt, outline
 * within 0.1 pt) with the widths resampled to the points it keeps. Shift draws a straight
 * line at the nominal width; a tap becomes a short dot so it leaves a mark.
 */
export function inkCommit(
  stroke: InkStrokeInput,
  frame: PageFrame,
  nominal: number,
): InkCommit | undefined {
  const first = stroke.points[0];
  const last = stroke.points[stroke.points.length - 1];
  if (!first || !last) return undefined;
  let path: Point[];
  let widths: number[];
  if (stroke.straight) {
    const end = snapAngle(first, last);
    path = [cssPointToUser(frame, first), cssPointToUser(frame, end)];
    widths = [nominal, nominal];
  } else {
    const done = finishInkStroke(
      stroke.points.map((p, i) => ({
        ...cssPointToUser(frame, p),
        w: stroke.widths[i] ?? nominal,
      })),
    );
    path = done.points;
    widths = done.widths;
  }
  const bounds = boundsOf([path]);
  const start = path[0];
  if (start && (path.length < 2 || (bounds.width < 0.01 && bounds.height < 0.01))) {
    // A dot: a tiny stroke so a tap leaves a mark.
    const w = widths[0] ?? nominal;
    path = [start, { x: start.x + 0.5, y: start.y }];
    widths = [w, w];
  }
  return { path, widths };
}

/**
 * Commits a finished pen stroke (not selected, spec §6.1) with its per-point widths
 * (ADR-0018): a new Ink annotation, or one more path of the open burst's Ink when the stroke
 * joins it (spec §6.4, `pen/bursts.ts`). `/BS /W` is the armed preset's width, the stroke's
 * nominal width: a pressure of 0.5 or a moderate speed draws exactly it. Until the engine
 * writes the variable-width appearance (P4) PDFium draws the stroke at that width. The
 * preview settles to the committed outline and stays until the page has painted the stroke.
 */
async function commitInkStroke(
  stroke: InkStrokeInput,
  settle: SettleInk,
  frame: PageFrame,
  target: PageTarget,
  times: { readonly downAt: number; readonly upAt: number },
): Promise<void> {
  // The Highlighter: a Highlight over text, else free Multiply ink (craft spec §5.4).
  const highlighter = commitHighlighterStroke(stroke, settle, frame, target, times);
  if (highlighter) return highlighter;
  const style = useAnnotationStore.getState().styles.ink;
  const ink = inkCommit(stroke, frame, style.strokeWidth);
  if (!ink) return;
  const release = settle(
    previewPath(
      ink.path.map((p) => userToCss(frame, p)),
      ink.widths.map((w) => w * frame.scale),
    ),
  );
  let committed = false;
  try {
    committed = await commitPenStroke({
      target,
      path: ink.path,
      widths: ink.widths,
      style,
      ...times,
    });
  } catch (error) {
    console.warn('Saving the stroke failed', error);
  }
  if (committed) {
    const generation = getEngineService().pageRevision(target.source, target.pageIndex);
    await whenPainted(target.source, target.pageIndex, generation);
  } else {
    // A loss the person did not see happen: said at once.
    announce(m.annot_stroke_not_saved(), { politeness: 'assertive' });
  }
  release();
}
