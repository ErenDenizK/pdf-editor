/**
 * The lasso selection on the page (craft spec §5.5, after experience-redesign spec §6.5):
 * the taken paths traced in the accent at the highlight alpha (only those paths, not the
 * Ink's box), the annotations taken whole traced or tinted by their hit outlines
 * (`hitOutlines`: vertices, edges, the note's icon, quads), one dashed bounding box around
 * all of it that a press moves, and the controls the contextual bar shows for them: colour,
 * opacity and width (`StyleControls` through `applyStyle`), a move grip, and Delete.
 *
 * Group resize and rotate (craft spec §5.5, `transform.ts`): eight handles on the box scale
 * the selection about the opposite edge or corner (Shift on a corner keeps the aspect), and
 * a rotation grip on the side away from the bar turns it about the box's centre (Shift
 * snaps to 15°). While a handle is dragged the highlight follows as a transform; release
 * commits one edit. The keyboard path is the selection box itself, a focusable element over
 * the box (outside the page's hidden SVG): arrows move it (`keys.ts`), Shift and an arrow
 * resize it by 1 pt from the opposite edge (Right and Down grow it, Left and Up shrink it),
 * Alt and an arrow rotate it by 1°, each announced; a series of presses is one history
 * entry.
 *
 * A split moves the taken paths to a new Ink; the selection follows once the page cache
 * holds it (`followPaths`), so the highlight and the bar never lose their paths meanwhile.
 */
import type { PageId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { Move, Trash2 } from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { m } from '../../i18n';
import { announce } from '../../shell/announcer';
import { IconButton } from '../../ui/IconButton';
import { activePathSelection, useAnnotationStore } from '../annotation-store';
import { type Box, type PageFrame, userToCss } from '../geometry';
import { boundsOf, type Point } from '../ink';
import { kindCounts, lassoItems } from '../labels';
import { StyleControls } from '../StyleControls';
import { deleteLassoSelection, transformLassoSelection, useLassoNotice } from './edits';
import {
  hitOutlines,
  type PathPicks,
  pickCount,
  pickedPaths,
  pickedWhole,
  picksOfSelection,
} from './geometry';
import styles from './Lasso.module.css';
import { startLassoMove } from './lasso-input';
import {
  type Affine,
  angleAround,
  BOX_HANDLES,
  type BoxHandle,
  boxScaleAffine,
  handlePoint,
  handleScale,
  keyDegrees,
  keyScale,
  normalizeDegrees,
  rotation,
  snapDegrees,
  userTransform,
} from './transform';

/** How far (CSS px) around the selection a press still grabs it. */
const GRAB_MARGIN_PX = 8;
/**
 * The drawn size of a handle, and of the area around it that takes a press (CSS px): no
 * wider than twice the grab margin, so a handle never covers the selection itself and a
 * press on a thin selection still moves it.
 */
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 2 * GRAB_MARGIN_PX;
/** How far (CSS px) the rotation grip sits from the box, and its radius. */
const ROTATE_OFFSET_PX = 22;
const ROTATE_RADIUS_PX = 5;
/** Shift snaps a rotation to this step (degrees). */
const ROTATE_SNAP_DEG = 15;
/** Keyboard steps: 1 pt of resize, 1° of rotation. */
const KEY_RESIZE_PT = 1;
const KEY_ROTATE_DEG = 1;
/** Key presses within this window are one series (one history entry, one running angle). */
const SERIES_MS = 800;
/** Smallest pointer travel (CSS px) that counts as a handle drag. */
const DRAG_PX = 2;

function points(path: readonly Point[], frame: PageFrame): string {
  return path
    .map((p) => {
      const c = userToCss(frame, p);
      return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
    })
    .join(' ');
}

/** Kinds whose highlight is a tint over their area rather than a trace of their outline. */
function tinted(a: Annotation): boolean {
  return (
    a.kind === 'free-text' ||
    a.kind === 'stamp' ||
    a.kind === 'text' ||
    a.kind === 'highlight' ||
    a.kind === 'underline' ||
    a.kind === 'strikeout' ||
    a.kind === 'squiggly'
  );
}

/**
 * `annotations` are the selected ones: the inks of `picks` (only their taken paths are
 * traced) and every other one, taken whole.
 */
export function LassoHighlight({
  annotations,
  picks,
  frame,
}: {
  readonly annotations: readonly Annotation[];
  readonly picks: PathPicks;
  readonly frame: PageFrame;
}) {
  const rootRef = useRef<SVGGElement>(null);
  // The layer element: the selection box (keyboard) lives there, outside the hidden SVG.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(rootRef.current?.ownerSVGElement?.parentElement ?? null);
  }, []);
  const shown = pickedPaths(annotations, picks);
  const { whole: wholeIds } = picksOfSelection(annotations, picks);
  const whole = annotations
    .filter((a) => wholeIds.includes(a.id))
    .map((a) => ({ annotation: a, outlines: hitOutlines(a, frame) }));
  // A new geometry is a new element: a move's transform (lasso-input.ts) goes with the old.
  const signature = [
    ...shown.map(({ annotation, index, path }) => {
      const first = path[0];
      return `${annotation.id}:${index}:${path.length}:${first?.x ?? 0},${first?.y ?? 0}`;
    }),
    ...whole.map(({ annotation: a }) => `${a.id}:${a.rect.x},${a.rect.y},${a.rect.width}`),
  ].join('|');
  // The grab area: a press inside the selection moves it (lasso-input.ts) and keeps it.
  const css = [
    ...shown.map(({ path }) => path.map((p) => userToCss(frame, p))),
    ...whole.flatMap(({ outlines }) => outlines.map((o) => o.map((p) => userToCss(frame, p)))),
  ];
  const grab = boundsOf(css, GRAB_MARGIN_PX);
  // The box the handles scale and turn: what the selection's outlines span.
  const tight = boundsOf(css);
  const box: Box | null =
    css.length > 0
      ? { left: tight.x, top: tight.y, width: tight.width, height: tight.height }
      : null;
  const items = lassoItems(kindCounts(pickCount(picks), pickedWhole(annotations, wholeIds)));
  return (
    <g ref={rootRef} data-lasso-root="">
      <g key={signature} className={styles.highlight} data-lasso-selection="">
        <g data-lasso-content="">
          {css.length > 0 ? (
            <rect
              className={styles.grab}
              data-lasso-grab=""
              data-annotation-keep=""
              x={grab.x}
              y={grab.y}
              width={grab.width}
              height={grab.height}
            />
          ) : null}
          {shown.map(({ annotation, index, path }) => {
            const width = annotation.kind === 'ink' ? annotation.strokeWidth : 1;
            return (
              <polyline
                key={`${annotation.id}:${index}`}
                data-lasso-path={`${annotation.id}:${index}`}
                points={points(path, frame)}
                strokeWidth={Math.max(8, width * frame.scale + 6)}
              />
            );
          })}
          {whole.map(({ annotation: a, outlines }) => (
            <g key={a.id} data-lasso-whole={a.id}>
              {outlines.map((outline, i) =>
                tinted(a) ? (
                  <polygon key={i} points={points(outline, frame)} />
                ) : (
                  <polyline
                    key={i}
                    points={points(outline, frame)}
                    strokeWidth={Math.max(
                      8,
                      ('strokeWidth' in a ? a.strokeWidth : 1) * frame.scale + 6,
                    )}
                  />
                ),
              )}
            </g>
          ))}
        </g>
        {box ? (
          <LassoHandles
            box={box}
            outer={{ left: grab.x, top: grab.y, width: grab.width, height: grab.height }}
            frame={frame}
          />
        ) : null}
      </g>
      {host && box ? createPortal(<LassoBox box={box} frame={frame} items={items} />, host) : null}
    </g>
  );
}

/** Follows one pointer on the window until release or cancel (`null`). */
function followPointer(
  pointerId: number,
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent | null) => void,
): void {
  const move = (e: PointerEvent) => {
    if (e.pointerId === pointerId) onMove(e);
  };
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    onEnd(e);
  };
  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    stop();
    onEnd(null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}

function svgMatrix(t: Affine): string {
  return `matrix(${[t.a, t.b, t.c, t.d, t.e, t.f].map((v) => +v.toFixed(5)).join(' ')})`;
}

/**
 * Drags a handle (`BoxHandle`) or the rotation grip of the selection on `layer`: the
 * highlight follows as a transform, the handles and the bar hide, release commits.
 */
function startTransformDrag(
  layer: HTMLElement,
  frame: PageFrame,
  box: Box,
  handle: BoxHandle | 'rotate',
  event: PointerEvent,
): void {
  const origin = layer.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }): Point => ({
    x: e.clientX - origin.left,
    y: e.clientY - origin.top,
  });
  const start = local(event);
  const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  let dragging = false;
  let current: Affine | null = null;
  const content = () => layer.querySelector<SVGGElement>('[data-lasso-content]');
  const handles = () => layer.querySelector<SVGGElement>('[data-lasso-handles]');
  const bar = () => layer.querySelector<HTMLElement>('[data-testid="annotation-bar"]');
  const reset = () => {
    content()?.removeAttribute('transform');
    const h = handles();
    if (h) h.style.visibility = '';
    const b = bar();
    if (b) b.style.visibility = '';
    delete layer.dataset.lassoTransforming;
  };
  followPointer(
    event.pointerId,
    (e) => {
      const p = local(e);
      if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_PX) return;
      if (!dragging) {
        dragging = true;
        layer.dataset.lassoTransforming = handle;
        const h = handles();
        if (h) h.style.visibility = 'hidden';
        const b = bar();
        if (b) b.style.visibility = 'hidden';
      }
      if (handle === 'rotate') {
        const turned = angleAround(centre, p) - angleAround(centre, start);
        const degrees = normalizeDegrees(
          e.shiftKey ? snapDegrees(turned, ROTATE_SNAP_DEG) : turned,
        );
        current = rotation(centre, degrees);
      } else {
        current = boxScaleAffine(
          handleScale(box, handle, p.x - start.x, p.y - start.y, e.shiftKey),
        );
      }
      content()?.setAttribute('transform', svgMatrix(current));
    },
    (e) => {
      if (!dragging || !e || !current) {
        reset();
        return;
      }
      const user = userTransform(frame, current);
      void transformLassoSelection(handle === 'rotate' ? 'rotate' : 'resize', user, frame).finally(
        reset,
      );
    },
  );
}

/** The eight resize handles and the rotation grip, on the selection's dashed box. */
function LassoHandles({
  box,
  outer,
  frame,
}: {
  /** What the selection spans (the scale's reference). */
  readonly box: Box;
  /** The dashed box the handles sit on. */
  readonly outer: Box;
  readonly frame: PageFrame;
}) {
  const press = (e: ReactPointerEvent<SVGElement>, handle: BoxHandle | 'rotate') => {
    if (e.button !== 0) return;
    const layer = e.currentTarget.ownerSVGElement?.parentElement;
    if (!layer) return;
    e.preventDefault();
    e.stopPropagation();
    startTransformDrag(layer, frame, box, handle, e.nativeEvent);
  };
  // The bar sits above the selection unless the selection touches the page top
  // (AnnotationBar); the grip goes on the other side.
  const below = box.top >= 12;
  const gripX = outer.left + outer.width / 2;
  const edgeY = below ? outer.top + outer.height : outer.top;
  const gripY = below ? edgeY + ROTATE_OFFSET_PX : edgeY - ROTATE_OFFSET_PX;
  return (
    <g data-lasso-handles="">
      <line className={styles.stem} x1={gripX} y1={edgeY} x2={gripX} y2={gripY} />
      {BOX_HANDLES.map((handle) => {
        const p = handlePoint(outer, handle);
        return (
          <g key={handle}>
            <rect
              className={styles.handle}
              x={p.x - HANDLE_PX / 2}
              y={p.y - HANDLE_PX / 2}
              width={HANDLE_PX}
              height={HANDLE_PX}
            />
            <rect
              className={styles.handleHit}
              data-lasso-handle={handle}
              data-annotation-keep=""
              x={p.x - HANDLE_HIT_PX / 2}
              y={p.y - HANDLE_HIT_PX / 2}
              width={HANDLE_HIT_PX}
              height={HANDLE_HIT_PX}
              onPointerDown={(e) => press(e, handle)}
            />
          </g>
        );
      })}
      <circle className={styles.handle} cx={gripX} cy={gripY} r={ROTATE_RADIUS_PX} />
      <circle
        className={styles.rotateHit}
        data-lasso-rotate=""
        data-annotation-keep=""
        cx={gripX}
        cy={gripY}
        r={HANDLE_HIT_PX / 2}
        onPointerDown={(e) => press(e, 'rotate')}
      />
    </g>
  );
}

/** The running angle of a series of rotation key presses, per lasso selection. */
let series: { key: string; degrees: number; at: number } | null = null;

/** Tests: start the next rotation series afresh. */
export function resetLassoKeySeries(): void {
  series = null;
}

/**
 * The selection box: the keyboard path to the selection (module header). It takes no
 * pointer; the dashed box and the handles under it do. A focusable, labelled group that
 * handles keys: jsx-a11y classifies the role as static, so its two rules are off here.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
function LassoBox({
  box,
  frame,
  items,
}: {
  readonly box: Box;
  readonly frame: PageFrame;
  readonly items: string;
}) {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return;
    if (e.shiftKey === e.altKey) return; // plain arrows move it (keys.ts)
    if (!e.key.startsWith('Arrow')) return;
    const key = activePathSelection(useAnnotationStore.getState())?.key;
    if (!key) return;
    e.preventDefault();
    if (e.shiftKey) {
      const scale = keyScale(box, e.key, KEY_RESIZE_PT * frame.scale);
      if (!scale) return;
      void transformLassoSelection('resize', userTransform(frame, boxScaleAffine(scale)), frame);
      const width = Math.round((box.width * scale.sx) / frame.scale);
      const height = Math.round((box.height * scale.sy) / frame.scale);
      announce(m.lasso_resized({ width, height }));
      return;
    }
    const step = keyDegrees(e.key, KEY_ROTATE_DEG);
    if (step === undefined) return;
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    void transformLassoSelection('rotate', userTransform(frame, rotation(centre, step)), frame);
    const now = performance.now();
    const running = series?.key === key && now - series.at < SERIES_MS ? series.degrees : 0;
    series = { key, degrees: normalizeDegrees(running + step), at: now };
    const angle = Math.abs(series.degrees);
    announce(series.degrees >= 0 ? m.lasso_rotated_cw({ angle }) : m.lasso_rotated_ccw({ angle }));
  };
  return (
    <div
      className={styles.box}
      role="group"
      tabIndex={0}
      aria-label={m.lasso_box_label({ items })}
      aria-keyshortcuts="Shift+ArrowRight Shift+ArrowLeft Shift+ArrowDown Shift+ArrowUp Alt+ArrowRight Alt+ArrowLeft Alt+ArrowDown Alt+ArrowUp"
      data-lasso-box=""
      data-annotation-keep=""
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onKeyDown={onKeyDown}
    />
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

/**
 * The contextual bar's controls for a lasso selection (after its name). The width shows
 * disabled when nothing selected takes one (text boxes, notes, stamps, markups). After a
 * rotation that included a stamp the bar says, once, that stamps keep their orientation.
 */
export function LassoBarControls({
  pageId,
  strokesOnly,
}: {
  readonly pageId: PageId;
  /** The selection holds ink strokes only (the grip then says "Move strokes"). */
  readonly strokesOnly: boolean;
}) {
  const notice = useLassoNotice((s) => s.message);
  const noticeKey = useLassoNotice((s) => s.key);
  const key = useAnnotationStore((s) => activePathSelection(s)?.key);
  return (
    <>
      {notice && noticeKey === key ? (
        <span className={styles.notice} data-lasso-notice="">
          {notice}
        </span>
      ) : null}
      <StyleControls variant="tool" group="ink" placement="tier" keepStrokeWidth />
      <IconButton
        label={strokesOnly ? m.lasso_move() : m.lasso_move_selection()}
        tooltip={strokesOnly ? m.lasso_move_tooltip() : m.lasso_move_selection_tooltip()}
        icon={<Move />}
        className={styles.grip}
        data-lasso-move=""
        // Its arrows nudge the selection (keys.ts), not move along the bar.
        data-keeps-arrows=""
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          startLassoMove(pageId, e.nativeEvent);
        }}
      />
      <IconButton
        label={m.annot_delete()}
        icon={<Trash2 />}
        onClick={() => void deleteLassoSelection()}
      />
    </>
  );
}
