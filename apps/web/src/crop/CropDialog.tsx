/**
 * "Crop pages…" (M4 §3): margins from the displayed page's edges (pt, mm or in), a live
 * preview of the first page it crops with the crop rectangle over it (edges and corners
 * drag; the edge handles are sliders for the keyboard), "Draw crop area" (a rectangle
 * dragged on the page in Read mode, CropLayer.tsx), "Reset crop", the pages to crop
 * (selection, the whole document, or every page of the first page's size) and, honesty
 * first, whether to also remove the content outside the crop through the redaction
 * pipeline. A plain crop commits at once; with the removal the dialog shows the
 * redaction's progress and then its result sheet (redaction/ApplyRedactionsDialog.tsx).
 *
 * "Trim to content" is left out: the engine reports text and annotation bounds, but not
 * the bounds of images and vector drawings, so a trim computed from text would cut them.
 */
import {
  type DocumentId,
  type PageId,
  pageTotalRotation,
  type Size,
  type VirtualPage,
  type Workspace,
} from '@pdf-editor/document-model';
import { type KeyboardEvent, type SyntheticEvent, useEffect, useId, useRef, useState } from 'react';

import { RENDER_PRIORITY } from '../engine/engine-service';
import styles from '../export/ExportDialog.module.css';
import { formatNumber, m } from '../i18n';
import { PageCanvas } from '../pages/PageCanvas';
import { fitInBox } from '../pages/page-geometry';
import type { ApplyOutcome } from '../redaction/apply';
import { Outcome } from '../redaction/ApplyRedactionsDialog';
import { Actions, Frame } from '../stage/OperationDialogFrame';
import local from '../stage/OperationDialogs.module.css';
import { closeOperationDialog } from '../stage/operation-dialogs-store';
import { fromUnit, type ResizeUnit, sizeLabel, toUnit } from '../stage/ResizeDialog';
import { pagesPhrase, useWorkspaceStore } from '../state/workspace-store';
import {
  cropPages,
  displayedSizeOf,
  planCrops,
  planDiscard,
  scopePages,
  startCropDrawing,
} from './actions';
import own from './Crop.module.css';
import { type CropScope, clearResume, peekResume } from './crop-store';
import { pageBoxOf } from './display';
import {
  dragMargins,
  type Handle,
  isNoCrop,
  type Margins,
  marginsFromCrop,
  marginsProblem,
  NO_MARGINS,
  roundMargins,
  SIDES,
  type Side,
  turned,
} from './geometry';

const PREVIEW_BOX = 220;
const HANDLES: readonly Handle[] = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
/** Edge handles are sliders (keyboard); corners are for the pointer only. */
const EDGE_SIDE: Readonly<Partial<Record<Handle, Side>>> = {
  n: 'top',
  e: 'right',
  s: 'bottom',
  w: 'left',
};

type Step =
  | { readonly kind: 'form' }
  | { readonly kind: 'working' }
  | { readonly kind: 'done'; readonly outcome: ApplyOutcome };

function findPage(ws: Workspace, id: PageId | undefined): VirtualPage | undefined {
  if (id === undefined) return undefined;
  for (const docId of ws.documentOrder) {
    const page = ws.documents[docId]?.pages.find((p) => p.id === id);
    if (page) return page;
  }
  return undefined;
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

function sideName(side: Side): string {
  switch (side) {
    case 'top':
      return m.crop_margin_top();
    case 'right':
      return m.crop_margin_right();
    case 'bottom':
      return m.crop_margin_bottom();
    case 'left':
      return m.crop_margin_left();
  }
}

/** The page's current crop as displayed margins (none for an uncropped page). */
function currentMargins(ws: Workspace, page: VirtualPage | undefined): Margins {
  const crop = page?.cropBox;
  if (page === undefined || crop === undefined) return NO_MARGINS;
  try {
    return roundMargins(marginsFromCrop(pageBoxOf(page), crop, pageTotalRotation(ws, page)));
  } catch {
    return NO_MARGINS;
  }
}

/** The page box as displayed and its rotation; undefined when the page cannot be read. */
function shownBox(ws: Workspace, page: VirtualPage | undefined): Size | undefined {
  if (page === undefined) return undefined;
  try {
    return turned(pageBoxOf(page), pageTotalRotation(ws, page));
  } catch {
    return undefined;
  }
}

export function CropDialog({
  documentId,
  pageIds,
}: {
  readonly documentId: DocumentId;
  readonly pageIds: readonly PageId[];
}) {
  const ws = useWorkspaceStore((s) => s.workspace);
  const doc = ws.documents[documentId];
  const selection = pageIds.filter((id) => findPage(ws, id) !== undefined);
  const firstId = selection[0] ?? doc?.pages[0]?.id;
  // Opening again after "Draw crop area": the dialog comes back as it was, with the drawing.
  const [resume] = useState(() => peekResume(documentId));
  useEffect(() => clearResume(), []);
  const [reference] = useState<Size | undefined>(() => displayedSizeOf(ws, firstId));
  const [margins, setMargins] = useState<Margins>(
    () => resume?.margins ?? currentMargins(ws, findPage(ws, firstId)),
  );
  const [unit, setUnit] = useState<ResizeUnit>(resume?.unit ?? 'mm');
  const [drafts, setDrafts] = useState<Partial<Record<Side, string>>>({});
  const [scope, setScope] = useState<CropScope>(
    resume?.scope ?? (selection.length > 0 ? 'selection' : 'document'),
  );
  const [discard, setDiscard] = useState(resume?.discard ?? false);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const firstInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const unitId = useId();
  const baseId = useId();

  if (doc === undefined) return null;

  const targets = scopePages(ws, documentId, scope, selection, reference);
  const previewPage = findPage(ws, targets[0] ?? firstId);
  const previewSize = shownBox(ws, previewPage);
  const problem = previewSize === undefined ? undefined : marginsProblem(margins, previewSize);
  const clear = isNoCrop(margins);
  const plan = planCrops(ws, targets, margins);
  const hasCrop = targets.some((id) => findPage(ws, id)?.cropBox !== undefined);
  const ready = problem === undefined && plan.crops.length > 0 && (!clear || hasCrop);
  const removing = discard && !clear;
  const shared = removing && ready ? planDiscard(ws, plan.crops).shared : 0;
  const croppedSize =
    previewSize === undefined || problem !== undefined
      ? undefined
      : {
          width: previewSize.width - margins.left - margins.right,
          height: previewSize.height - margins.top - margins.bottom,
        };

  const setSide = (side: Side, text: string) => {
    setDrafts((current) => ({ ...current, [side]: text }));
    const value = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(value)) return;
    setMargins((current) => ({ ...current, [side]: fromUnit(value, unit) }));
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!ready || step.kind !== 'form') return;
    if (!removing) {
      await cropPages(targets, margins, { discard: false });
      closeOperationDialog();
      return;
    }
    setStep({ kind: 'working' });
    const result = await cropPages(targets, margins, { discard: true });
    if (result.kind === 'discarded' && result.outcome.kind !== 'nothing') {
      setStep({ kind: 'done', outcome: result.outcome });
    } else {
      closeOperationDialog();
    }
  };

  const draw = () =>
    startCropDrawing({ documentId, pageIds: selection, margins, unit, scope, discard }, targets[0]);

  if (step.kind === 'working') {
    return (
      <Frame title={m.crop_title()} testId="crop-dialog" wide>
        <div className={styles.body}>
          <p className={styles.description} role="status">
            {m.crop_removing()}
          </p>
          <progress className={styles.progress} aria-label={m.crop_removing()} />
        </div>
      </Frame>
    );
  }

  if (step.kind === 'done') {
    return (
      <Frame title={m.crop_title()} testId="crop-dialog" wide>
        <div className={styles.body} data-testid="crop-result">
          <Outcome outcome={step.outcome} />
          <div className={styles.actions}>
            {step.outcome.kind === 'applied' ? null : (
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setStep({ kind: 'form' })}
              >
                {m.common_back()}
              </button>
            )}
            <button type="button" className={styles.primary} onClick={closeOperationDialog}>
              {m.common_close()}
            </button>
          </div>
        </div>
      </Frame>
    );
  }

  const summary =
    targets.length === 0
      ? m.crop_nothing()
      : problem === 'invalid'
        ? m.crop_error_invalid()
        : problem === 'too-small'
          ? m.crop_error_too_small()
          : clear
            ? hasCrop
              ? m.crop_preview_reset({ pages: pagesPhrase(plan.crops.length) })
              : m.crop_preview_none()
            : m.crop_preview({
                pages: pagesPhrase(plan.crops.length),
                size: croppedSize === undefined ? '' : sizeLabel(croppedSize, unit),
              });

  return (
    <Frame title={m.crop_title()} testId="crop-dialog" initialFocus={firstInput} wide>
      <form className={styles.body} onSubmit={(event) => void submit(event)}>
        <p className={own.notice}>{m.crop_notice()}</p>
        <fieldset className={local.options}>
          <legend className={local.legend}>{m.crop_margins_label()}</legend>
          <div className={own.marginRow}>
            {SIDES.map((side, index) => {
              const id = `${baseId}-${side}`;
              return (
                <div key={side} className={styles.field}>
                  <label className={styles.label} htmlFor={id}>
                    {sideName(side)}
                  </label>
                  <input
                    ref={index === 0 ? firstInput : undefined}
                    id={id}
                    type="text"
                    inputMode="decimal"
                    className={`${styles.input} ${own.marginInput}`}
                    value={
                      drafts[side] ??
                      formatNumber(toUnit(margins[side], unit), { useGrouping: false })
                    }
                    aria-invalid={problem !== undefined || undefined}
                    aria-describedby={problem === undefined ? undefined : errorId}
                    spellCheck={false}
                    autoComplete="off"
                    data-testid={`crop-${side}`}
                    onChange={(event) => setSide(side, event.target.value)}
                    onBlur={() => setDrafts({})}
                  />
                </div>
              );
            })}
            <div className={styles.field}>
              <label className={styles.label} htmlFor={unitId}>
                {m.resize_unit_label()}
              </label>
              <select
                id={unitId}
                className={`${styles.input} ${own.select}`}
                value={unit}
                data-testid="crop-unit"
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
          {problem === undefined ? null : (
            <span id={errorId} className={local.fieldError}>
              {problem === 'invalid' ? m.crop_error_invalid() : m.crop_error_too_small()}
            </span>
          )}
        </fieldset>

        <div className={own.previewRow}>
          <CropPreview
            ws={ws}
            page={previewPage}
            size={previewSize}
            margins={margins}
            unit={unit}
            onChange={(next) => {
              setMargins(next);
              setDrafts({});
            }}
          />
          <div className={own.previewSide}>
            <div className={own.buttons}>
              <button
                type="button"
                className={styles.secondary}
                data-testid="crop-draw"
                disabled={targets.length === 0}
                onClick={draw}
              >
                {m.crop_draw()}
              </button>
              <button
                type="button"
                className={styles.secondary}
                data-testid="crop-reset"
                disabled={clear}
                onClick={() => {
                  setMargins(NO_MARGINS);
                  setDrafts({});
                }}
              >
                {m.crop_reset()}
              </button>
            </div>
            <p
              className={local.preview}
              role="status"
              data-ok={ready || undefined}
              data-testid="crop-summary"
            >
              {summary}
            </p>
            {plan.notPdf > 0 ? (
              <p className={own.notice}>{m.crop_skipped_not_pdf({ count: plan.notPdf })}</p>
            ) : null}
            {plan.tooSmall > 0 && problem === undefined ? (
              <p className={own.notice}>{m.crop_skipped_too_small({ count: plan.tooSmall })}</p>
            ) : null}
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
                size: sizeLabel(reference, unit),
                count: scopePages(ws, documentId, 'same-size', selection, reference).length,
              })}
            />
          )}
        </fieldset>

        <fieldset className={local.options}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={discard}
              data-testid="crop-discard"
              onChange={(event) => setDiscard(event.target.checked)}
            />
            <span>
              {m.crop_discard()}
              <span className={styles.hint}>{m.crop_discard_hint()}</span>
            </span>
          </label>
          {removing ? (
            <p className={own.warning} role="note">
              {m.crop_discard_warning()}
            </p>
          ) : null}
          {shared > 0 ? (
            <p className={own.notice}>{m.crop_discard_shared({ count: shared })}</p>
          ) : null}
        </fieldset>

        <Actions
          confirm={
            clear && hasCrop
              ? m.crop_confirm_reset()
              : removing
                ? m.crop_confirm_discard()
                : m.crop_confirm()
          }
          disabled={!ready}
        />
      </form>
    </Frame>
  );
}

function ScopeOption({
  scope,
  current,
  label,
  onChange,
}: {
  readonly scope: CropScope;
  readonly current: CropScope;
  readonly label: string;
  readonly onChange: (scope: CropScope) => void;
}) {
  return (
    <label className={local.option}>
      <input
        type="radio"
        name="crop-scope"
        checked={current === scope}
        onChange={() => onChange(scope)}
      />
      <span className={local.optionTitle}>{label}</span>
    </label>
  );
}

interface PreviewDrag {
  readonly handle: Handle;
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly start: Margins;
}

/**
 * The first page to crop, whole (its page box, as displayed), with the crop rectangle over
 * it: the scrim shows what the crop hides. Everything here is in display space; the model
 * conversion happens per page when the crop is applied (geometry.ts).
 */
function CropPreview({
  ws,
  page,
  size,
  margins,
  unit,
  onChange,
}: {
  readonly ws: Workspace;
  readonly page: VirtualPage | undefined;
  readonly size: Size | undefined;
  readonly margins: Margins;
  readonly unit: ResizeUnit;
  readonly onChange: (margins: Margins) => void;
}) {
  const drag = useRef<PreviewDrag | null>(null);
  if (page === undefined || size === undefined) {
    return <div className={own.previewBox} aria-hidden="true" />;
  }
  const sheet = fitInBox(size, PREVIEW_BOX, PREVIEW_BOX);
  const scale = sheet.width / size.width;
  const valid = marginsProblem(margins, size) === undefined;
  const shown = valid ? margins : NO_MARGINS;
  const rect = {
    left: shown.left * scale,
    top: shown.top * scale,
    width: (size.width - shown.left - shown.right) * scale,
    height: (size.height - shown.top - shown.bottom) * scale,
  };
  const ref = page.ref;
  let rotation: number;
  try {
    rotation = pageTotalRotation(ws, page);
  } catch {
    rotation = 0;
  }

  const nudge = (handle: Handle) => (event: KeyboardEvent<HTMLElement>) => {
    const step = fromUnit(1, unit) * (event.shiftKey ? 10 : 1);
    const vertical = handle === 'n' || handle === 's';
    let d: number;
    switch (event.key) {
      case 'ArrowUp':
        d = vertical ? -step : 0;
        break;
      case 'ArrowDown':
        d = vertical ? step : 0;
        break;
      case 'ArrowLeft':
        d = vertical ? 0 : -step;
        break;
      case 'ArrowRight':
        d = vertical ? 0 : step;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (d === 0 || !valid) return;
    const next = vertical
      ? dragMargins(margins, handle, 0, d, size)
      : dragMargins(margins, handle, d, 0, size);
    onChange(roundMargins(next));
  };

  const handleAt = (handle: Handle) => ({
    left:
      rect.left + (handle.includes('w') ? 0 : handle.includes('e') ? rect.width : rect.width / 2),
    top:
      rect.top + (handle.includes('n') ? 0 : handle.includes('s') ? rect.height : rect.height / 2),
  });

  return (
    <div className={own.previewBox} data-testid="crop-preview">
      <div
        className={own.previewSheet}
        style={{ width: sheet.width, height: sheet.height }}
        data-testid="crop-preview-sheet"
        // One set of pointer handlers for the rectangle and its handles (`data-handle`).
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          const handle = target.dataset.handle as Handle | undefined;
          if (handle === undefined || event.button !== 0 || !valid) return;
          event.preventDefault();
          event.stopPropagation();
          target.setPointerCapture(event.pointerId);
          drag.current = {
            handle,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            start: margins,
          };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointerId !== event.pointerId) return;
          const dx = (event.clientX - current.x) / scale;
          const dy = (event.clientY - current.y) / scale;
          onChange(roundMargins(dragMargins(current.start, current.handle, dx, dy, size)));
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <PageCanvas
          sourceId={ref.kind === 'source' ? ref.source : undefined}
          blobId={ref.kind === 'image' ? ref.blob : undefined}
          index={ref.kind === 'source' ? ref.index : 0}
          rotation={page.rotation}
          widthPt={size.width}
          heightPt={size.height}
          cssWidth={sheet.width}
          priority={RENDER_PRIORITY.offscreen}
        />
        <div className={own.shade} style={{ left: 0, top: 0, right: 0, height: rect.top }} />
        <div
          className={own.shade}
          style={{ left: 0, right: 0, top: rect.top + rect.height, bottom: 0 }}
        />
        <div
          className={own.shade}
          style={{ left: 0, top: rect.top, width: rect.left, height: rect.height }}
        />
        <div
          className={own.shade}
          style={{
            left: rect.left + rect.width,
            right: 0,
            top: rect.top,
            height: rect.height,
          }}
        />
        <div
          className={own.cropRect}
          data-testid="crop-rect"
          data-handle="move"
          data-rotation={rotation}
          style={rect}
          aria-hidden="true"
        />
        {HANDLES.map((handle) => {
          const side = EDGE_SIDE[handle];
          const at = handleAt(handle);
          if (side === undefined) {
            return (
              <span
                key={handle}
                className={own.handle}
                data-handle={handle}
                style={at}
                aria-hidden="true"
              />
            );
          }
          const max = side === 'top' || side === 'bottom' ? size.height : size.width;
          return (
            <span
              key={handle}
              role="slider"
              tabIndex={0}
              className={own.handle}
              data-handle={handle}
              style={at}
              aria-label={m.crop_edge_label({ side: sideName(side) })}
              aria-orientation={side === 'top' || side === 'bottom' ? 'vertical' : 'horizontal'}
              aria-valuemin={0}
              aria-valuemax={toUnit(max, unit)}
              aria-valuenow={toUnit(margins[side], unit)}
              aria-valuetext={`${formatNumber(toUnit(margins[side], unit))} ${unitName(unit)}`}
              onKeyDown={nudge(handle)}
            />
          );
        })}
      </div>
    </div>
  );
}
