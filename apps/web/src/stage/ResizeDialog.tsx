/**
 * "Resize pages…" (M4 page resize): a paper preset or a custom size (pt, mm or in, with an
 * orientation swap), how the content meets the new size (Scale, Fit, Canvas), a 3 × 3
 * anchor grid, the pages to apply it to (selection, the whole document, or every page of
 * the first page's size) and a live preview of the first page drawn by the same page
 * canvas the light table uses (low priority). Commits one history entry
 * (`resizePagesTo`); the model's `resizePages` converts the displayed request per page.
 */
import {
  ANCHOR_POSITIONS,
  type Anchor,
  type DocumentId,
  MAX_PAGE_SIDE,
  MIN_PAGE_SIDE,
  matchPaperSize,
  PAPER_SIZES,
  type PageId,
  type PaperSizeId,
  pageContentSize,
  pageDisplaySize,
  pagesOfSize,
  pageTotalRotation,
  type ResizeMode,
  type ResizeRequest,
  resizeContentPlacement,
  resizeForPage,
  type Size,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';
import { Fragment, type KeyboardEvent, type SyntheticEvent, useId, useRef, useState } from 'react';

import { RENDER_PRIORITY } from '../engine/engine-service';
import styles from '../export/ExportDialog.module.css';
import { formatNumber, m } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { displaySize, fitInBox } from '../pages/page-geometry';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import { Actions, Frame } from './OperationDialogFrame';
import local from './OperationDialogs.module.css';
import { closeOperationDialog } from './operation-dialogs-store';
import own from './ResizeDialog.module.css';
import { ResizedContent } from './ResizedContent';
import { resizePagesTo } from './section-operations';

export type ResizeUnit = 'mm' | 'in' | 'pt';
export type ResizePreset = PaperSizeId | 'custom' | 'original';
export type ResizeScope = 'selection' | 'document' | 'same-size';

const PRESETS: readonly PaperSizeId[] = ['a4', 'a3', 'a5', 'letter', 'legal', 'tabloid'];
const POINTS_PER: Readonly<Record<ResizeUnit, number>> = { pt: 1, mm: 72 / 25.4, in: 72 };
const DIGITS: Readonly<Record<ResizeUnit, number>> = { pt: 2, mm: 1, in: 2 };
const PREVIEW_BOX = 148;

export function toUnit(points: number, unit: ResizeUnit): number {
  const factor = 10 ** DIGITS[unit];
  return Math.round((points / POINTS_PER[unit]) * factor) / factor;
}

export function fromUnit(value: number, unit: ResizeUnit): number {
  return value * POINTS_PER[unit];
}

function presetName(id: PaperSizeId): string {
  switch (id) {
    case 'a4':
      return 'A4';
    case 'a3':
      return 'A3';
    case 'a5':
      return 'A5';
    case 'letter':
      return m.resize_preset_letter();
    case 'legal':
      return m.resize_preset_legal();
    case 'tabloid':
      return m.resize_preset_tabloid();
  }
}

function unitName(unit: ResizeUnit): string {
  switch (unit) {
    case 'mm':
      return m.resize_unit_mm();
    case 'in':
      return m.resize_unit_in();
    case 'pt':
      return m.resize_unit_pt();
  }
}

function anchorName(anchor: Anchor): string {
  switch (anchor) {
    case 'top-left':
      return m.resize_anchor_top_left();
    case 'top-center':
      return m.resize_anchor_top();
    case 'top-right':
      return m.resize_anchor_top_right();
    case 'middle-left':
      return m.resize_anchor_left();
    case 'center':
      return m.resize_anchor_center();
    case 'middle-right':
      return m.resize_anchor_right();
    case 'bottom-left':
      return m.resize_anchor_bottom_left();
    case 'bottom-center':
      return m.resize_anchor_bottom();
    case 'bottom-right':
      return m.resize_anchor_bottom_right();
  }
}

const oriented = (size: Size, landscape: boolean): Size =>
  landscape === size.width > size.height ? size : { width: size.height, height: size.width };

/** "210 × 297 mm", or "A4 (210 × 297 mm)" for a paper size in either orientation. */
export function sizeLabel(size: Size, unit: ResizeUnit): string {
  const dims = m.resize_size_dims({
    width: formatNumber(toUnit(size.width, unit)),
    height: formatNumber(toUnit(size.height, unit)),
    unit: unitName(unit),
  });
  const paper = matchPaperSize(size, 0.5);
  return paper ? m.resize_size_named({ name: presetName(paper.id), size: dims }) : dims;
}

/** The pages a scope covers, in document order. */
function scopePages(
  ws: Workspace,
  documentId: DocumentId,
  scope: ResizeScope,
  selection: readonly PageId[],
  reference: Size | undefined,
): PageId[] {
  const doc = ws.documents[documentId];
  if (doc === undefined) return [];
  switch (scope) {
    case 'selection':
      return [...selection];
    case 'document':
      return doc.pages.map((p) => p.id);
    case 'same-size':
      return reference === undefined ? [] : pagesOfSize(ws, documentId, reference);
  }
}

function findPage(ws: Workspace, id: PageId | undefined): VirtualPage | undefined {
  if (id === undefined) return undefined;
  for (const docId of ws.documentOrder) {
    const page = ws.documents[docId]?.pages.find((p) => p.id === id);
    if (page) return page;
  }
  return undefined;
}

export function ResizeDialog({
  documentId,
  pageIds,
}: {
  readonly documentId: DocumentId;
  readonly pageIds: readonly PageId[];
}) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const doc = ws.documents[documentId];
  const selection = pageIds.filter((id) => findPage(ws, id) !== undefined);
  const firstPage = findPage(ws, selection[0]) ?? doc?.pages[0];
  const [reference] = useState<Size | undefined>(() =>
    firstPage === undefined ? undefined : displaySize(ws, firstPage),
  );

  const [preset, setPreset] = useState<ResizePreset>('a4');
  const [landscape, setLandscape] = useState(
    () => reference !== undefined && reference.width > reference.height,
  );
  const [custom, setCustom] = useState<Size>(() => reference ?? PAPER_SIZES.a4);
  const [unit, setUnit] = useState<ResizeUnit>('mm');
  const [drafts, setDrafts] = useState<{ width?: string; height?: string }>({});
  const [matchOrientation, setMatchOrientation] = useState(true);
  const [mode, setMode] = useState<ResizeMode>('fit');
  const [stretch, setStretch] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>('center');
  const [scope, setScope] = useState<ResizeScope>(selection.length > 0 ? 'selection' : 'document');
  const presetRef = useRef<HTMLSelectElement>(null);
  const sizeErrorId = useId();
  const widthId = useId();
  const heightId = useId();
  const presetId = useId();
  const unitId = useId();

  if (doc === undefined) return null;

  const size: Size | undefined =
    preset === 'original'
      ? undefined
      : preset === 'custom'
        ? custom
        : oriented(PAPER_SIZES[preset], landscape);
  const shownSize = size ?? reference ?? PAPER_SIZES.a4;
  const sizeValid =
    size === undefined ||
    [size.width, size.height].every(
      (side) => Number.isFinite(side) && side >= MIN_PAGE_SIDE && side <= MAX_PAGE_SIDE,
    );
  const request: ResizeRequest | undefined =
    size === undefined
      ? undefined
      : {
          width: size.width,
          height: size.height,
          mode,
          anchor,
          ...(mode === 'scale' && stretch ? { stretch: true } : {}),
          matchOrientation,
        };
  const targets = scopePages(ws, documentId, scope, selection, reference);
  const ready = targets.length > 0 && sizeValid;
  const anchorDisabled = mode === 'scale' && stretch;

  const setSide = (side: 'width' | 'height', text: string) => {
    setDrafts((current) => ({ ...current, [side]: text }));
    const value = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(value)) return;
    const next = { ...shownSize, [side]: fromUnit(value, unit) };
    setCustom(next);
    setLandscape(next.width > next.height);
    setPreset('custom');
  };

  const swapOrientation = (toLandscape: boolean) => {
    if (toLandscape === landscape) return;
    setLandscape(toLandscape);
    setDrafts({});
    if (preset === 'custom') setCustom({ width: custom.height, height: custom.width });
  };

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready) return;
    resizePagesTo(targets, request, size === undefined ? '' : sizeLabel(size, unit));
    closeOperationDialog();
  };

  const field = (side: 'width' | 'height', id: string, label: string) => (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        className={`${styles.input} ${own.sizeInput}`}
        value={drafts[side] ?? formatNumber(toUnit(shownSize[side], unit), { useGrouping: false })}
        disabled={preset === 'original'}
        aria-invalid={!sizeValid || undefined}
        aria-describedby={sizeValid ? undefined : sizeErrorId}
        spellCheck={false}
        autoComplete="off"
        data-testid={`resize-${side}`}
        onChange={(event) => setSide(side, event.target.value)}
        onBlur={() => setDrafts({})}
      />
    </div>
  );

  const referenceLabel = reference === undefined ? '' : sizeLabel(reference, unit);

  return (
    <Frame title={m.resize_title()} testId="resize-dialog" initialFocus={presetRef} wide>
      <form className={styles.body} onSubmit={submit}>
        <fieldset className={local.options}>
          <legend className={local.legend}>{m.resize_size_label()}</legend>
          <div className={own.sizeRow}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={presetId}>
                {m.resize_preset_label()}
              </label>
              <select
                ref={presetRef}
                id={presetId}
                className={`${styles.input} ${own.select}`}
                value={preset}
                data-testid="resize-preset"
                onChange={(event) => {
                  setPreset(event.target.value as ResizePreset);
                  setDrafts({});
                }}
              >
                {PRESETS.map((id) => (
                  <option key={id} value={id}>
                    {presetName(id)}
                  </option>
                ))}
                <option value="custom">{m.resize_preset_custom()}</option>
                <option value="original">{m.resize_preset_original()}</option>
              </select>
            </div>
            {field('width', widthId, m.resize_width())}
            {field('height', heightId, m.resize_height())}
            <div className={styles.field}>
              <label className={styles.label} htmlFor={unitId}>
                {m.resize_unit_label()}
              </label>
              <select
                id={unitId}
                className={`${styles.input} ${own.select}`}
                value={unit}
                onChange={(event) => {
                  setUnit(event.target.value as ResizeUnit);
                  setDrafts({});
                }}
              >
                {(['mm', 'in', 'pt'] as const).map((u) => (
                  <option key={u} value={u}>
                    {unitName(u)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {sizeValid ? null : (
            <span id={sizeErrorId} className={local.fieldError}>
              {m.resize_error_size({
                min: formatNumber(toUnit(MIN_PAGE_SIDE, unit)),
                max: formatNumber(toUnit(MAX_PAGE_SIDE, unit)),
                unit: unitName(unit),
              })}
            </span>
          )}
          <div
            className={own.segmented}
            role="radiogroup"
            aria-label={m.resize_orientation_label()}
            data-disabled={preset === 'original' || undefined}
          >
            {([false, true] as const).map((value) => (
              <label key={String(value)} className={own.segment}>
                <input
                  type="radio"
                  name="resize-orientation"
                  checked={landscape === value}
                  disabled={preset === 'original'}
                  onChange={() => swapOrientation(value)}
                />
                <span>{value ? m.resize_landscape() : m.resize_portrait()}</span>
              </label>
            ))}
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={matchOrientation}
              disabled={preset === 'original'}
              onChange={(event) => setMatchOrientation(event.target.checked)}
            />
            <span>
              {m.resize_match_orientation()}
              <span className={styles.hint}>{m.resize_match_orientation_hint()}</span>
            </span>
          </label>
        </fieldset>

        <div className={own.modeRow} data-disabled={preset === 'original' || undefined}>
          <fieldset className={local.options}>
            <legend className={local.legend}>{m.resize_mode_label()}</legend>
            {(['fit', 'scale', 'canvas'] as const).map((value) => (
              <Fragment key={value}>
                <label className={local.option}>
                  <input
                    type="radio"
                    name="resize-mode"
                    checked={mode === value}
                    disabled={preset === 'original'}
                    onChange={() => setMode(value)}
                  />
                  <span className={local.optionTitle}>{modeTitle(value)}</span>
                  <span className={local.optionHint}>{modeHint(value)}</span>
                </label>
                {value === 'scale' ? (
                  <label className={`${styles.check} ${own.stretch}`}>
                    <input
                      type="checkbox"
                      checked={stretch}
                      disabled={mode !== 'scale' || preset === 'original'}
                      onChange={(event) => setStretch(event.target.checked)}
                    />
                    <span>{m.resize_stretch()}</span>
                  </label>
                ) : null}
              </Fragment>
            ))}
          </fieldset>
          <div className={own.anchorBlock}>
            <span className={local.legend} id={`${presetId}-anchor`}>
              {m.resize_anchor_label()}
            </span>
            <AnchorGrid
              value={anchor}
              disabled={anchorDisabled || preset === 'original'}
              labelledBy={`${presetId}-anchor`}
              onChange={setAnchor}
            />
          </div>
        </div>

        <fieldset className={local.options}>
          <legend className={local.legend}>{m.resize_scope_label()}</legend>
          {selection.length > 0 ? (
            <ScopeOption
              scope="selection"
              current={scope}
              onChange={setScope}
              label={m.resize_scope_selection({ count: selection.length })}
            />
          ) : null}
          <ScopeOption
            scope="document"
            current={scope}
            onChange={setScope}
            label={m.resize_scope_document({ title: doc.title, count: doc.pages.length })}
          />
          {reference === undefined ? null : (
            <ScopeOption
              scope="same-size"
              current={scope}
              onChange={setScope}
              label={m.resize_scope_same_size({
                size: referenceLabel,
                count: pagesOfSize(ws, documentId, reference).length,
              })}
            />
          )}
        </fieldset>

        <div className={own.previewRow}>
          <Preview ws={ws} pageId={targets[0]} request={sizeValid ? request : undefined} />
          <p
            className={local.preview}
            role="status"
            data-ok={ready || undefined}
            data-testid="resize-summary"
          >
            {targets.length === 0
              ? m.resize_nothing()
              : size === undefined
                ? m.resize_preview_original({ pages: pagesPhrase(targets.length) })
                : m.resize_preview({
                    pages: pagesPhrase(targets.length),
                    size: sizeLabel(size, unit),
                  })}
          </p>
        </div>
        <Actions confirm={m.resize_confirm()} disabled={!ready} />
      </form>
    </Frame>
  );
}

function modeTitle(mode: ResizeMode): string {
  switch (mode) {
    case 'scale':
      return m.resize_mode_scale();
    case 'fit':
      return m.resize_mode_fit();
    case 'canvas':
      return m.resize_mode_canvas();
  }
}

function modeHint(mode: ResizeMode): string {
  switch (mode) {
    case 'scale':
      return m.resize_mode_scale_hint();
    case 'fit':
      return m.resize_mode_fit_hint();
    case 'canvas':
      return m.resize_mode_canvas_hint();
  }
}

function ScopeOption({
  scope,
  current,
  label,
  onChange,
}: {
  readonly scope: ResizeScope;
  readonly current: ResizeScope;
  readonly label: string;
  readonly onChange: (scope: ResizeScope) => void;
}) {
  return (
    <label className={local.option}>
      <input
        type="radio"
        name="resize-scope"
        checked={current === scope}
        onChange={() => onChange(scope)}
      />
      <span className={local.optionTitle}>{label}</span>
    </label>
  );
}

/**
 * The 3 × 3 anchor grid: a radio group with a roving tab stop; arrow keys move in two
 * dimensions (no wrap), Home / End jump to the first / last position.
 */
export function AnchorGrid({
  value,
  disabled,
  labelledBy,
  onChange,
}: {
  readonly value: Anchor;
  readonly disabled: boolean;
  readonly labelledBy: string;
  readonly onChange: (anchor: Anchor) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = ANCHOR_POSITIONS.indexOf(value);

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const row = Math.floor(index / 3);
    const column = index % 3;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = column > 0 ? index - 1 : index;
        break;
      case 'ArrowRight':
        next = column < 2 ? index + 1 : index;
        break;
      case 'ArrowUp':
        next = row > 0 ? index - 3 : index;
        break;
      case 'ArrowDown':
        next = row < 2 ? index + 3 : index;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 8;
        break;
      default:
        return;
    }
    event.preventDefault();
    const anchor = ANCHOR_POSITIONS[next];
    if (anchor === undefined) return;
    onChange(anchor);
    refs.current[next]?.focus();
  };

  return (
    <div
      className={own.anchorGrid}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      data-testid="resize-anchor"
    >
      {ANCHOR_POSITIONS.map((anchor, i) => (
        <button
          key={anchor}
          ref={(element) => {
            refs.current[i] = element;
          }}
          type="button"
          role="radio"
          aria-checked={anchor === value}
          aria-label={anchorName(anchor)}
          aria-disabled={disabled || undefined}
          tabIndex={anchor === value ? 0 : -1}
          className={own.anchorCell}
          onKeyDown={move}
          onClick={() => {
            if (!disabled) onChange(anchor);
          }}
        >
          <span className={own.anchorDot} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** The first target page at its new size, content placed as the export will draw it. */
function Preview({
  ws,
  pageId,
  request,
}: {
  readonly ws: Workspace;
  readonly pageId: PageId | undefined;
  readonly request: ResizeRequest | undefined;
}) {
  const page = findPage(ws, pageId);
  if (page === undefined) return <div className={own.previewBox} aria-hidden="true" />;
  let shown: Size;
  let frame: ReturnType<typeof resizeContentPlacement> | undefined;
  let contentShown: Size;
  try {
    const rotation = pageTotalRotation(ws, page);
    const content = pageContentSize(ws, page);
    const quarter = rotation === 90 || rotation === 270;
    contentShown = quarter ? { width: content.height, height: content.width } : content;
    // "Original size" (no request) and a request that changes nothing show the content box.
    const resize = request === undefined ? undefined : resizeForPage(ws, page, request);
    if (resize === undefined) {
      shown = contentShown;
      frame = undefined;
    } else {
      shown = quarter ? { width: resize.height, height: resize.width } : resize;
      frame = resizeContentPlacement(content, resize, rotation);
    }
  } catch {
    shown = pageDisplaySize(ws, page);
    contentShown = shown;
    frame = undefined;
  }
  const sheet = fitInBox(shown, PREVIEW_BOX, PREVIEW_BOX);
  const ref = page.ref;
  return (
    <div className={own.previewBox} aria-label={m.resize_preview_label()} role="img">
      <div
        className={own.previewSheet}
        style={{ width: sheet.width, height: sheet.height }}
        data-testid="resize-preview-sheet"
      >
        <ResizedContent frame={frame}>
          <PageCanvas
            sourceId={ref.kind === 'source' ? ref.source : undefined}
            blobId={ref.kind === 'image' ? ref.blob : undefined}
            index={ref.kind === 'source' ? ref.index : 0}
            rotation={page.rotation}
            widthPt={contentShown.width}
            heightPt={contentShown.height}
            cssWidth={sheet.width * (frame?.width ?? 1)}
            priority={RENDER_PRIORITY.offscreen}
          />
        </ResizedContent>
      </div>
    </div>
  );
}
