/**
 * Redaction layer (redaction spec §1.1), a page overlay in Read mode.
 *
 * Draws every pending mark as a translucent red area with a red outline, so a mark reads
 * as "will be removed" and never as an applied black fill (PDFium draws the mark's own
 * appearance into the bitmap underneath; this layer makes the state unmistakable). Marks
 * left out of "apply selected" are dashed, and the mark under review is outlined more
 * strongly.
 *
 * With the Redact tool (X) the layer takes the whole page: a press on text and a drag
 * marks the text between the two points (quads per line, like the highlight tool), a
 * click on a word marks that word, and a drag that starts off text (or with Alt held)
 * marks a rectangular area. Otherwise it lets every pointer event through.
 */
import type { Rect } from '@pdf-editor/document-model';
import type { TextRun } from '@pdf-editor/engine';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

import { type PageTarget, usePageAnnotations } from '../annotations/annotation-store';
import {
  boxFromPoints,
  cssBoxToUser,
  cssPointToUser,
  type PageFrame,
  rectToCss,
} from '../annotations/geometry';
import type { Point } from '../annotations/ink';
import { pageText } from '../annotations/page-text';
import { glyphIndexAt, quadsForRange } from '../annotations/quads';
import type { PageOverlayProps } from '../stage/page-overlays';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import { createMarks, isRedactMark } from './marks';
import { markKeyOf, useRedactionStore } from './redaction-store';
import styles from './RedactionLayer.module.css';

/** Smallest drag (CSS px) that counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

type Gesture =
  | {
      readonly type: 'text';
      readonly start: Point;
      readonly current: Point;
      readonly quads: readonly Rect[];
    }
  | { readonly type: 'area'; readonly start: Point; readonly current: Point };

function dragged(g: Gesture): boolean {
  return Math.hypot(g.current.x - g.start.x, g.current.y - g.start.y) >= DRAG_THRESHOLD;
}

/** Flattened glyph range of the word around glyph `index` (non-space glyphs of its run). */
function wordRange(runs: readonly TextRun[], index: number): [number, number] {
  const flat: { run: number; text: string }[] = [];
  runs.forEach((run, r) => {
    for (const glyph of run.glyphs) flat.push({ run: r, text: glyph.text });
  });
  const blank = (i: number) => /^\s*$/.test(flat[i]?.text ?? ' ');
  const run = flat[index]?.run;
  let from = index;
  let to = index;
  while (from > 0 && flat[from - 1]?.run === run && !blank(from - 1)) from -= 1;
  while (to < flat.length - 1 && flat[to + 1]?.run === run && !blank(to + 1)) to += 1;
  return [from, to];
}

function round(r: Rect): Rect {
  const q = (v: number) => Math.round(v * 100) / 100;
  return { x: q(r.x), y: q(r.y), width: q(r.width), height: q(r.height) };
}

export function RedactionLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex, visible } = props;
  const mode = useToolStore((s) => s.mode);
  const annotations = usePageAnnotations(sourceId, sourceIndex);
  const excluded = useRedactionStore((s) => s.excluded);
  const current = useRedactionStore((s) => s.current);
  const rootRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef<readonly TextRun[] | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const active = mode === 'redact';

  // Text is needed at the first press: read it as soon as the tool is on for this page.
  useEffect(() => {
    if (!active || !visible || sourceId === undefined) return;
    let live = true;
    void pageText(sourceId, sourceIndex).then((runs) => {
      if (live) runsRef.current = runs;
    });
    return () => {
      live = false;
    };
  }, [active, visible, sourceId, sourceIndex]);

  if (sourceId === undefined) return null;
  const marks = annotations.filter(isRedactMark);
  if (!active && marks.length === 0) return null;
  const frame = pageFrame(props);
  const target: PageTarget = {
    source: sourceId,
    pageIndex: sourceIndex,
    pageId,
    position: pageIndex + 1,
  };

  const update = (next: Gesture | null) => {
    gestureRef.current = next;
    setGesture(next);
  };

  const localPoint = (event: { clientX: number; clientY: number }): Point => {
    const r = rootRef.current?.getBoundingClientRect();
    return r ? { x: event.clientX - r.left, y: event.clientY - r.top } : { x: 0, y: 0 };
  };

  const textQuads = (runs: readonly TextRun[], from: Point, to: Point): Rect[] =>
    quadsForRange(
      runs,
      glyphIndexAt(runs, cssPointToUser(frame, from), 4),
      glyphIndexAt(runs, cssPointToUser(frame, to), 24),
    );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!active || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = localPoint(event);
    const runs = runsRef.current;
    // Text mode when the press lands on (or right next to) a glyph and Alt is not held.
    const onText =
      !event.altKey &&
      runs !== null &&
      glyphIndexAt(runs, cssPointToUser(frame, start), 1.5 / Math.max(frame.scale, 0.01)) >= 0;
    update(
      onText && runs
        ? { type: 'text', start, current: start, quads: textQuads(runs, start, start) }
        : { type: 'area', start, current: start },
    );
    const move = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const p = localPoint(e);
      if (g.type === 'text' && runs) {
        update({ ...g, current: p, quads: textQuads(runs, g.start, p) });
      } else update({ ...g, current: p });
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      const g = gestureRef.current;
      update(null);
      if (!g) return;
      const final = { ...g, current: localPoint(e) };
      let quads: readonly Rect[] = [];
      if (final.type === 'text' && runs) {
        if (dragged(final)) {
          quads = textQuads(runs, final.start, final.current);
        } else {
          const at = glyphIndexAt(runs, cssPointToUser(frame, final.start), 4);
          if (at >= 0) quads = quadsForRange(runs, ...wordRange(runs, at));
        }
      } else if (final.type === 'area' && dragged(final)) {
        quads = [round(cssBoxToUser(frame, boxFromPoints(final.start, final.current)))];
      }
      if (quads.length > 0) void createMarks([{ target, marks: [quads] }]);
    };
    const cancel = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      update(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', cancel);
  };

  return (
    <div
      ref={rootRef}
      className={styles.layer}
      data-redaction-layer={pageIndex}
      data-active={active || undefined}
      onPointerDown={onPointerDown}
    >
      <svg className={styles.svg} aria-hidden="true">
        {marks.map((a) => {
          const rowKey = `${pageId}\u0000${a.id}`;
          return (
            <g
              key={a.id}
              className={styles.mark}
              data-redaction-mark={a.id}
              data-excluded={excluded.has(markKeyOf(sourceId, a.id)) || undefined}
              data-current={current === rowKey || undefined}
            >
              {a.quads.map((q, i) => (
                <QuadRect key={i} frame={frame} rect={q} />
              ))}
            </g>
          );
        })}
        {gesture ? <Preview gesture={gesture} frame={frame} /> : null}
      </svg>
    </div>
  );
}

RedactionLayer.displayName = 'RedactionLayer';

function QuadRect({ frame, rect }: { readonly frame: PageFrame; readonly rect: Rect }) {
  const b = rectToCss(frame, rect);
  return <rect x={b.left} y={b.top} width={Math.max(1, b.width)} height={Math.max(1, b.height)} />;
}

function Preview({ gesture: g, frame }: { readonly gesture: Gesture; readonly frame: PageFrame }) {
  if (g.type === 'text') {
    return (
      <g className={styles.preview} data-testid="redaction-preview">
        {g.quads.map((q, i) => (
          <QuadRect key={i} frame={frame} rect={q} />
        ))}
      </g>
    );
  }
  const b = boxFromPoints(g.start, g.current);
  return (
    <rect
      className={styles.preview}
      data-testid="redaction-preview"
      x={b.left}
      y={b.top}
      width={b.width}
      height={b.height}
    />
  );
}
