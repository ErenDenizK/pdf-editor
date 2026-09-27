/**
 * Annotation layer (spec §2–§4): one per page in Read mode, registered as a page overlay.
 *
 * PDFium draws every annotation's appearance into the page bitmap; this layer draws only
 * what the bitmap cannot: hit targets, the selection with its handles, creation feedback
 * (drag rectangles, ink strokes, markup quads), in-place editors and the contextual bar.
 * All of it is in CSS pixels of the displayed page; geometry is converted to and from
 * unrotated user space through the viewer's page frame, so rotated pages need no special
 * case here.
 *
 * With the Select tool the layer lets pointer events through (to the text layer) except
 * on annotations; with a drawing tool it captures the whole page.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { Annotation, NewAnnotation } from '@pdf-editor/engine';
import { Lock } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { pageFrame } from '../viewer/page-frame';
import { type ToolMode, useToolStore } from '../viewer/tool-store';
import { createAnnotations, deleteAnnotations, updateAnnotations } from './actions';
import { AnnotationBar } from './AnnotationBar';
import { type PageTarget, useAnnotationStore, usePageAnnotations } from './annotation-store';
import { markupDraft, styleGroupOf } from './drafts';
import {
  type Box,
  boxFromPoints,
  canMove,
  canResize,
  cssBoxToUser,
  cssPointToUser,
  geometryRect,
  isTextMarkup,
  type PageFrame,
  rectToCss,
  resizeAnnotation,
  roundRect,
  translateAnnotation,
  userToCss,
} from './geometry';
import { InlineEditorView } from './InlineEditors';
import {
  boundsOf,
  distanceToPolyline,
  finishStroke,
  type Point,
  snapAngle,
  snapSquare,
} from './ink';
import { mountedLayers } from './layer-registry';
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

const MARKUP_TOOLS = new Set<ToolMode>(['highlight', 'underline', 'strikeout', 'squiggly']);
const DRAWING_TOOLS = new Set<ToolMode>([
  'highlight',
  'underline',
  'strikeout',
  'squiggly',
  'ink',
  'eraser',
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
  const annotations = usePageAnnotations(sourceId, sourceIndex);
  const selection = useAnnotationStore((s) =>
    s.selection?.pageId === pageId ? s.selection : null,
  );
  const editor = useAnnotationStore((s) => (s.editor?.target.pageId === pageId ? s.editor : null));
  const ensurePage = useAnnotationStore((s) => s.ensurePage);
  const rootRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

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

  if (sourceId === undefined) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };
  const drawing = DRAWING_TOOLS.has(mode);

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
    if (!drawing || event.button !== 0) return;
    // Presses in the layer's own chrome (bar, editors) are theirs.
    if (event.target instanceof Element && event.target.closest('[data-annotation-keep]')) return;
    event.preventDefault();
    const store = useAnnotationStore.getState();
    store.select(null);
    if (store.editor) {
      // preventDefault above keeps focus where it is: blur the editor so it commits.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return;
    }
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
        update(null);
        if (g?.type !== 'draw') return;
        const final = { ...g, current: p, points: [...g.points, p], shift: e.shiftKey };
        void (markup ? withQuads(final) : Promise.resolve(final)).then((done) =>
          finishDraw(done, frame, target),
        );
      },
    );
  };

  // -------------------------------------------------------------------------
  // Selection, move, resize
  // -------------------------------------------------------------------------

  const onAnnotationPointerDown = (event: ReactPointerEvent, a: Annotation) => {
    if (drawing || event.button !== 0) return;
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
        const dx = a1.x - a0.x;
        const dy = a1.y - a0.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
        void updateAnnotations(target, g.ids, (x) => translateAnnotation(x, dx, dy), {
          action: 'move',
          coalesceKey: `move:${[...g.ids].sort().join(',')}`,
        });
      },
    );
  };

  const onHandlePointerDown = (event: ReactPointerEvent, a: Annotation, handle: Handle) => {
    if (event.button !== 0) return;
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
    if (drawing || a.flags?.locked) return;
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
  const hitsEnabled = !drawing;
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
        {selected.map((a) => (
          <SelectionOutline
            key={`sel-${a.id}`}
            annotation={a}
            frame={frame}
            gesture={gesture}
            single={selected.length === 1}
            onHandle={onHandlePointerDown}
          />
        ))}
        {gesture?.type === 'draw' ? <DrawPreview gesture={gesture} frame={frame} /> : null}
        {gesture?.type === 'erase' ? <EraseTrail points={gesture.points} /> : null}
      </svg>
      {selected.length > 0 && gesture === null && editor === null ? (
        <AnnotationBar target={target} annotations={selected} frame={frame} />
      ) : null}
      {editor ? <InlineEditorView editor={editor} frame={frame} /> : null}
    </div>
  );
}

AnnotationLayer.displayName = 'AnnotationLayer';

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
  const b = rectToCss(frame, a.rect);
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
    const p0 = cssPointToUser(frame, gesture.start);
    const p1 = cssPointToUser(frame, gesture.current);
    shown = translateAnnotation(a, p1.x - p0.x, p1.y - p0.y);
  } else if (gesture?.type === 'resize' && gesture.id === a.id) {
    shown = resized(a, gesture, frame) ?? a;
  }
  const box = rectToCss(frame, geometryRect(shown));
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
  const b = rectToCss(frame, a.rect);
  return <rect className={styles.ghost} x={b.left} y={b.top} width={b.width} height={b.height} />;
}

// ---------------------------------------------------------------------------
// Creation feedback and commit
// ---------------------------------------------------------------------------

function constrainedEnd(g: Extract<Gesture, { type: 'draw' }>): Point {
  if (!g.shift) return g.current;
  if (g.tool === 'line' || g.tool === 'arrow' || g.tool === 'ink')
    return snapAngle(g.start, g.current);
  if (g.tool === 'rectangle' || g.tool === 'ellipse') return snapSquare(g.start, g.current);
  return g.current;
}

function DrawPreview({
  gesture: g,
  frame,
}: {
  readonly gesture: Extract<Gesture, { type: 'draw' }>;
  readonly frame: PageFrame;
}) {
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
        />
      );
    case 'ink':
      return (
        <polyline
          className={styles.previewShape}
          points={polyline(g.shift ? [g.start, end] : g.points)}
          stroke={stroke}
          strokeWidth={width}
          opacity={style.opacity}
          data-testid="annotation-preview"
        />
      );
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return (
        <g className={styles.previewMarkup} data-tool={g.tool} data-testid="annotation-preview">
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

/** Removes erased strokes: whole annotations when every stroke goes, else the strokes. */
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
        return { ...a, paths, rect: roundRect(boundsOf(paths, a.strokeWidth / 2 + 1)) };
      },
      { action: 'erase' },
    );
  }
}

function dragged(g: Extract<Gesture, { type: 'draw' }>): boolean {
  return Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) >= DRAG_THRESHOLD;
}

/** Turns a finished drawing gesture into an annotation (or an in-place editor). */
async function finishDraw(
  g: Extract<Gesture, { type: 'draw' }>,
  frame: PageFrame,
  target: PageTarget,
): Promise<void> {
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
      if (!dragged(g)) return;
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
      if (!dragged(g)) return;
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
    case 'ink': {
      const raw = g.shift ? [g.start, end] : g.points;
      const user = raw.map((p) => cssPointToUser(frame, p));
      const path = g.shift ? user : finishStroke(user);
      if (path.length < 2 && !dragged(g)) {
        // A dot: a tiny stroke so a tap leaves a mark.
        const p = user[0];
        if (!p) return;
        path.push({ x: p.x + 0.5, y: p.y });
      }
      draft = {
        ...base,
        kind: 'ink',
        paths: [path],
        rect: roundRect(boundsOf([path], style.strokeWidth / 2 + 1)),
        color: style.color,
        strokeWidth: style.strokeWidth,
      };
      break;
    }
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const quads = g.quads ?? [];
      if (quads.length === 0) return;
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
      return;
    }
    case 'note': {
      const p = cssPointToUser(frame, g.start);
      store.setEditor({
        kind: 'note',
        target,
        rect: { x: Math.round(p.x), y: Math.round(p.y - 20), width: 20, height: 20 },
        text: '',
      });
      return;
    }
    case 'stamp':
    case 'signature': {
      const pending = store.pendingStamp;
      if (!pending) return;
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
      return;
  }
  await createAnnotations(target, [draft], labelKind ? { labelKind } : {});
}
