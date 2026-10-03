/**
 * The lasso selection on the page (craft spec §5.5, after experience-redesign spec §6.5):
 * the taken paths traced in the accent at the highlight alpha (only those paths, not the
 * Ink's box), the annotations taken whole traced or tinted by their hit outlines
 * (`hitOutlines`: vertices, edges, the note's icon, quads), one dashed bounding box around
 * all of it that a press moves, and the controls the contextual bar shows for them: colour,
 * opacity and width (`StyleControls` through `applyStyle`), a move grip, and Delete.
 *
 * A split moves the taken paths to a new Ink; the selection follows once the page cache
 * holds it (`followPaths`), so the highlight and the bar never lose their paths meanwhile.
 */
import type { PageId } from '@pdf-editor/document-model';
import type { Annotation } from '@pdf-editor/engine';
import { Move, Trash2 } from 'lucide-react';

import { m } from '../../i18n';
import { IconButton } from '../../ui/IconButton';
import { type PageFrame, userToCss } from '../geometry';
import { boundsOf, type Point } from '../ink';
import { StyleControls } from '../StyleControls';
import { deleteLassoSelection } from './edits';
import { hitOutlines, type PathPicks, pickedPaths, picksOfSelection } from './geometry';
import styles from './Lasso.module.css';
import { startLassoMove } from './lasso-input';

/** How far (CSS px) around the selection a press still grabs it. */
const GRAB_MARGIN_PX = 8;

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
  return (
    <g key={signature} className={styles.highlight} data-lasso-selection="">
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
  );
}

/**
 * The contextual bar's controls for a lasso selection (after its name). The width shows
 * disabled when nothing selected takes one (text boxes, notes, stamps, markups).
 */
export function LassoBarControls({
  pageId,
  strokesOnly,
}: {
  readonly pageId: PageId;
  /** The selection holds ink strokes only (the grip then says "Move strokes"). */
  readonly strokesOnly: boolean;
}) {
  return (
    <>
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
