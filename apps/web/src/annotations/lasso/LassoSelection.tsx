/**
 * The lasso selection on the page (experience-redesign spec §6.5): the taken paths traced in
 * the accent at the highlight alpha (only those paths, not the Ink's box), and the controls
 * the contextual bar shows for them: colour, opacity and width (`StyleControls` through
 * `applyStyle`), a move grip, and Delete.
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
import { boundsOf } from '../ink';
import { StyleControls } from '../StyleControls';
import { deleteLassoSelection } from './edits';
import { type PathPicks, pickedPaths } from './geometry';
import styles from './Lasso.module.css';
import { startLassoMove } from './lasso-input';

/** How far (CSS px) around the taken paths a press still grabs them. */
const GRAB_MARGIN_PX = 8;

function points(path: readonly { x: number; y: number }[], frame: PageFrame): string {
  return path
    .map((p) => {
      const c = userToCss(frame, p);
      return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
    })
    .join(' ');
}

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
  // A new geometry is a new element: a move's transform (lasso-input.ts) goes with the old.
  const signature = shown
    .map(({ annotation, index, path }) => {
      const first = path[0];
      return `${annotation.id}:${index}:${path.length}:${first?.x ?? 0},${first?.y ?? 0}`;
    })
    .join('|');
  // The grab area: a press inside the selection moves it (lasso-input.ts) and keeps it.
  const grab = boundsOf(
    shown.map(({ path }) => path.map((p) => userToCss(frame, p))),
    GRAB_MARGIN_PX,
  );
  return (
    <g key={signature} className={styles.highlight} data-lasso-selection="">
      {shown.length > 0 ? (
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
    </g>
  );
}

/** The contextual bar's controls for a lasso selection (after its name). */
export function LassoBarControls({ pageId }: { readonly pageId: PageId }) {
  return (
    <>
      <StyleControls variant="tool" group="ink" placement="tier" />
      <IconButton
        label={m.lasso_move()}
        tooltip={m.lasso_move_tooltip()}
        icon={<Move />}
        className={styles.grip}
        data-lasso-move=""
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
