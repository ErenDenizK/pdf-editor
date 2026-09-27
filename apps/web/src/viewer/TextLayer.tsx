/**
 * Text layer (spec §1, §8, §9): the page's text as transparent DOM spans over the bitmap,
 * one span per engine text run, positioned from glyph geometry and stretched to the run's
 * width. It gives native selection (double-click word, triple-click line, drag across
 * pages), copy with sensible spaces and line breaks (see `installCopyHandler`), and the
 * page's readable content for assistive technology.
 *
 * Built for pages within one page of the viewport, kept while within three, dropped
 * beyond. Selectable only while the Select tool is active.
 */
import type { TextRun } from '@pdf-editor/engine';
import { type CSSProperties, useEffect, useRef, useState } from 'react';

import { getEngineService } from '../engine/engine-service';
import type { PageOverlayProps } from '../stage/page-overlays';
import { distanceFromView, useViewStore } from '../state/view-store';
import { pageFrame } from './page-frame';
import {
  layoutTextLines,
  selectionCopyText,
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

export function TextLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageIndex } = props;
  const distance = useViewStore((s) => distanceFromView(pageIndex, s.visibleRange));
  const selectable = useToolStore((s) => s.mode === 'select');
  const [built, setBuilt] = useState(false);
  const [runs, setRuns] = useState<{ key: string; runs: readonly TextRun[] } | null>(null);

  // Hysteresis: build near the viewport, keep until clearly away (spec §8).
  if (!built && distance <= BUILD_DISTANCE && sourceId !== undefined) setBuilt(true);
  if (built && distance > DROP_DISTANCE) setBuilt(false);

  const key = `${sourceId ?? ''}:${sourceIndex}`;
  const layerRef = useRef<HTMLDivElement>(null);

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
        if (result.ok) setRuns({ key, runs: result.value });
      });
    return () => controller.abort();
  }, [built, sourceId, sourceIndex, key]);

  if (!built || runs?.key !== key) return null;
  const lines = layoutTextLines(runs.runs, pageFrame(props));
  if (lines.length === 0) return null;

  return (
    <div
      className={styles.layer}
      {...{ [TEXT_LAYER_ATTR]: String(pageIndex) }}
      data-selectable={selectable}
      data-testid="text-layer"
      ref={layerRef}
    >
      {lines.map((line, i) => (
        <span key={i} {...{ [TEXT_ROW_ATTR]: line.row }} style={lineStyle(line)}>
          {line.text}
        </span>
      ))}
      <div className={styles.end} aria-hidden="true" />
    </div>
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
