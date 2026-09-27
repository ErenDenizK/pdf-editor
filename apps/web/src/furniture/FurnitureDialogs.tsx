/**
 * Page furniture dialogs (document-tools spec §2): Page numbers, Header and footer, Bates
 * numbering, Watermark. Each dialog is docked to the right with no scrim so the pages show
 * the live preview (furniture-store.ts) while settings change; Apply commits one history
 * entry, Cancel and Esc discard the preview, Remove deletes that kind of furniture (one
 * history entry). Styled as the other operation dialogs (ShortcutOverlay popup and
 * ExportDialog form parts).
 */
import { Dialog } from '@base-ui/react/dialog';
import type {
  Anchor,
  BatesConfig,
  BlobId,
  DocumentId,
  OverlayOp,
  TextOverlay,
} from '@pdf-editor/document-model';
import { formatBates } from '@pdf-editor/engine/overlay-geometry';
import { X } from 'lucide-react';
import { type ReactNode, type SyntheticEvent, useEffect, useId, useState } from 'react';

import styles from '../export/ExportDialog.module.css';
import { decodeImageFile } from '../files/images';
import { pickFiles } from '../files/open-files';
import { formatNumber, m } from '../i18n';
import { announce } from '../shell/announcer';
import overlay from '../shell/ShortcutOverlay.module.css';
import local from '../stage/OperationDialogs.module.css';
import { readJson, writeJson } from '../state/safe-storage';
import { pagesPhrase, useTabItems, useWorkspaceStore } from '../state/workspace-store';
import { useRetained } from '../ui/use-retained';
import {
  applyBatesRun,
  applyFurniture,
  batesOverlay,
  type BatesSettings,
  clampRotation,
  defaultHeaderFooter,
  defaultPageNumbers,
  defaultWatermark,
  FONT_FAMILIES,
  type FurnitureFamily,
  type FurnitureKind,
  firstPosition,
  furnitureOf,
  type HeaderFooterSettings,
  headerFooterOverlays,
  type PageNumberPreset,
  type PageNumberSettings,
  pageNumberOverlay,
  planBatesRun,
  presetOf,
  presetTemplate,
  type RangeChoice,
  type RangeMode,
  readBates,
  readHeaderFooter,
  readPageNumbers,
  readWatermark,
  removeFurniture,
  SLOTS,
  type TextStyle,
  type WatermarkSettings,
  watermarkOverlay,
} from './furniture-model';
import { closeFurnitureDialog, setFurniturePreview, useFurnitureStore } from './furniture-store';
import local2 from './FurnitureDialogs.module.css';
import { dropPreviewBlob, isPreviewBlob, putPreviewBlob, takePreviewBlob } from './preview-blobs';

export function FurnitureDialogs() {
  const dialog = useFurnitureStore((s) => s.dialog);
  const [shown, release] = useRetained(dialog);
  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) closeFurnitureDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) release();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={local2.backdrop} />
        {shown === null ? null : (
          <Content key={shown.nonce} kind={shown.kind} documentId={shown.documentId} />
        )}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Content({
  kind,
  documentId,
}: {
  readonly kind: FurnitureKind;
  readonly documentId: DocumentId;
}) {
  switch (kind) {
    case 'page-numbers':
      return <PageNumbersDialog documentId={documentId} />;
    case 'header-footer':
      return <HeaderFooterDialog documentId={documentId} />;
    case 'bates':
      return <BatesDialog documentId={documentId} />;
    case 'watermark':
      return <WatermarkDialog documentId={documentId} />;
  }
}

export function furnitureName(kind: FurnitureKind): string {
  switch (kind) {
    case 'page-numbers':
      return m.furniture_title_page_numbers();
    case 'header-footer':
      return m.furniture_title_header_footer();
    case 'bates':
      return m.furniture_title_bates();
    case 'watermark':
      return m.furniture_title_watermark();
  }
}

export function removeLabel(kind: FurnitureKind): string {
  switch (kind) {
    case 'page-numbers':
      return m.cmd_remove_page_numbers();
    case 'header-footer':
      return m.cmd_remove_header_footer();
    case 'bates':
      return m.cmd_remove_bates();
    case 'watermark':
      return m.cmd_remove_watermark();
  }
}

/** Removes one kind of furniture from a document as one history entry. */
export function removeFurnitureFrom(documentId: DocumentId, kind: FurnitureKind): boolean {
  const done = useWorkspaceStore
    .getState()
    .applyOperation((ws) => removeFurniture(ws, documentId, kind), removeLabel(kind));
  if (done) announce(m.announce_furniture_removed({ name: furnitureName(kind) }));
  return done;
}

// ---------------------------------------------------------------------------
// Frame and shared controls
// ---------------------------------------------------------------------------

function Frame({
  kind,
  documentId,
  existing,
  canApply,
  onApply,
  children,
}: {
  readonly kind: FurnitureKind;
  readonly documentId: DocumentId;
  readonly existing: boolean;
  readonly canApply: boolean;
  readonly onApply: () => void;
  readonly children: ReactNode;
}) {
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (canApply) onApply();
  };
  return (
    <Dialog.Popup
      className={`${overlay.popup} ${styles.popup} ${local2.side}`}
      data-testid={`furniture-dialog-${kind}`}
    >
      <div className={overlay.header}>
        <Dialog.Title className={overlay.title}>{furnitureName(kind)}</Dialog.Title>
        <Dialog.Close className={overlay.close} aria-label={m.common_close()}>
          <X aria-hidden="true" />
        </Dialog.Close>
      </div>
      <form className={styles.body} onSubmit={submit}>
        <p className={styles.hint}>{m.furniture_preview_note()}</p>
        {children}
        <div className={local2.actions}>
          {existing ? (
            <button
              type="button"
              className={local2.danger}
              onClick={() => {
                if (removeFurnitureFrom(documentId, kind)) closeFurnitureDialog();
              }}
            >
              {m.furniture_remove()}
            </button>
          ) : (
            <span />
          )}
          <Dialog.Close className={styles.secondary}>{m.common_cancel()}</Dialog.Close>
          <button type="submit" className={styles.primary} disabled={!canApply}>
            {m.furniture_apply()}
          </button>
        </div>
      </form>
    </Dialog.Popup>
  );
}

function Section({ legend, children }: { readonly legend: string; readonly children: ReactNode }) {
  return (
    <fieldset className={local2.section}>
      <legend className={local2.legend}>{legend}</legend>
      {children}
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly testId?: string;
}) {
  return (
    <label className={local2.inline}>
      {label}
      <input
        type="number"
        inputMode="decimal"
        className={`${styles.input} ${local2.number}`}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {unit}
    </label>
  );
}

const ANCHORS: readonly Anchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

export function anchorName(anchor: Anchor): string {
  switch (anchor) {
    case 'top-left':
      return m.furniture_anchor_top_left();
    case 'top-center':
      return m.furniture_anchor_top_center();
    case 'top-right':
      return m.furniture_anchor_top_right();
    case 'middle-left':
      return m.furniture_anchor_middle_left();
    case 'center':
      return m.furniture_anchor_center();
    case 'middle-right':
      return m.furniture_anchor_middle_right();
    case 'bottom-left':
      return m.furniture_anchor_bottom_left();
    case 'bottom-center':
      return m.furniture_anchor_bottom_center();
    case 'bottom-right':
      return m.furniture_anchor_bottom_right();
  }
}

function AnchorPicker({
  value,
  onChange,
}: {
  readonly value: Anchor;
  readonly onChange: (anchor: Anchor) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={m.furniture_anchor_label()} className={local2.anchors}>
      {ANCHORS.map((anchor) => (
        <label key={anchor} className={local2.anchor} title={anchorName(anchor)}>
          <input
            type="radio"
            name={name}
            aria-label={anchorName(anchor)}
            checked={value === anchor}
            onChange={() => onChange(anchor)}
          />
        </label>
      ))}
    </div>
  );
}

function PositionSection({
  anchor,
  onAnchor,
  marginX,
  marginY,
  onMargins,
  mirror,
  onMirror,
}: {
  readonly anchor?: Anchor;
  readonly onAnchor?: (anchor: Anchor) => void;
  readonly marginX: number;
  readonly marginY: number;
  readonly onMargins: (x: number, y: number) => void;
  readonly mirror?: boolean;
  readonly onMirror?: (mirror: boolean) => void;
}) {
  return (
    <Section legend={m.furniture_position()}>
      <div className={local2.row}>
        {anchor !== undefined && onAnchor ? (
          <AnchorPicker value={anchor} onChange={onAnchor} />
        ) : null}
        <div className={local2.section} style={{ border: 'none', padding: 0 }}>
          <NumberField
            label={m.furniture_margin_x()}
            value={marginX}
            min={0}
            max={500}
            unit={m.furniture_unit_pt()}
            onChange={(x) => onMargins(Math.max(0, x), marginY)}
          />
          <NumberField
            label={m.furniture_margin_y()}
            value={marginY}
            min={0}
            max={500}
            unit={m.furniture_unit_pt()}
            onChange={(y) => onMargins(marginX, Math.max(0, y))}
          />
        </div>
      </div>
      {onMirror ? (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={mirror === true}
            onChange={(e) => onMirror(e.target.checked)}
          />
          <span>{m.furniture_mirror()}</span>
        </label>
      ) : null}
    </Section>
  );
}

function Percent({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
}) {
  const percent = Math.round(value * 100);
  return (
    <label className={local2.row}>
      <span className={local2.inline}>{label}</span>
      <input
        type="range"
        className={local2.range}
        min={min}
        max={max}
        value={percent}
        aria-valuetext={`${percent}%`}
        onChange={(event) => onChange(event.target.valueAsNumber / 100)}
      />
      <span className={local2.value}>{percent}%</span>
    </label>
  );
}

function StyleSection({
  style,
  onChange,
  showOpacity = true,
}: {
  readonly style: TextStyle;
  readonly onChange: (style: TextStyle) => void;
  readonly showOpacity?: boolean;
}) {
  return (
    <Section legend={m.furniture_text()}>
      <div className={local2.row}>
        <label className={local2.inline}>
          {m.furniture_font()}
          <select
            className={`${styles.input} ${local2.select}`}
            value={style.family}
            onChange={(e) => onChange({ ...style, family: e.target.value as FurnitureFamily })}
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label={m.furniture_size()}
          value={style.size}
          min={4}
          max={400}
          unit={m.furniture_unit_pt()}
          onChange={(size) => onChange({ ...style, size: Math.min(400, Math.max(4, size)) })}
        />
      </div>
      <div className={local2.row}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={style.bold}
            onChange={(e) => onChange({ ...style, bold: e.target.checked })}
          />
          <span>{m.furniture_bold()}</span>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={style.italic}
            onChange={(e) => onChange({ ...style, italic: e.target.checked })}
          />
          <span>{m.furniture_italic()}</span>
        </label>
        <label className={local2.inline}>
          {m.furniture_color()}
          <input
            type="color"
            className={local2.color}
            value={style.color}
            onChange={(e) => onChange({ ...style, color: e.target.value })}
          />
        </label>
      </div>
      {showOpacity ? (
        <Percent
          label={m.furniture_opacity()}
          value={style.opacity}
          min={5}
          onChange={(opacity) => onChange({ ...style, opacity })}
        />
      ) : null}
    </Section>
  );
}

function RangeSection({
  range,
  pageCount,
  onChange,
  children,
}: {
  readonly range: RangeChoice;
  readonly pageCount: number;
  readonly onChange: (range: RangeChoice) => void;
  readonly children?: ReactNode;
}) {
  const modes: readonly [RangeMode, () => string][] = [
    ['all', m.furniture_range_all],
    ['skip-first', m.furniture_range_skip_first],
    ['odd', m.furniture_range_odd],
    ['even', m.furniture_range_even],
    ['custom', m.furniture_range_custom],
  ];
  return (
    <Section legend={m.furniture_pages()}>
      <div className={local2.row}>
        <select
          className={`${styles.input} ${local2.select}`}
          aria-label={m.furniture_pages()}
          value={range.mode}
          data-testid="furniture-range"
          onChange={(e) => onChange({ ...range, mode: e.target.value as RangeMode })}
        >
          {modes.map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label()}
            </option>
          ))}
        </select>
        {range.mode === 'custom' ? (
          <>
            <NumberField
              label={m.furniture_range_from()}
              value={range.from}
              min={1}
              max={pageCount}
              onChange={(from) => onChange({ ...range, from: Math.max(1, Math.round(from)) })}
            />
            <NumberField
              label={m.furniture_range_to()}
              value={range.to}
              min={1}
              max={pageCount}
              onChange={(to) => onChange({ ...range, to: Math.max(1, Math.round(to)) })}
            />
          </>
        ) : null}
      </div>
      {children}
    </Section>
  );
}

const TOKENS = '{page} {pages} {label} {title} {date} {date:short} {date:long} {date:iso} {bates}';

function TokenHint() {
  return (
    <p className={local2.tokens}>
      {m.furniture_tokens()}: {TOKENS}
    </p>
  );
}

/** Keeps the dialog's preview in the furniture store in step with its settings. */
function usePreview(
  kind: FurnitureKind,
  documents: readonly DocumentId[],
  overlays: readonly OverlayOp[],
  bates?: Readonly<Record<DocumentId, BatesConfig>>,
): void {
  const key = JSON.stringify([kind, documents, overlays, bates]);
  useEffect(() => {
    setFurniturePreview({ kind, documents, overlays, ...(bates ? { bates } : {}) });
    // The key captures every input; the preview object is rebuilt from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function commit(kind: FurnitureKind, apply: () => boolean): void {
  if (apply()) {
    announce(m.announce_furniture_applied({ name: furnitureName(kind) }));
    closeFurnitureDialog();
  }
}

function useDocument(documentId: DocumentId) {
  return useWorkspaceStore((s) => s.workspace.documents[documentId]);
}

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------

function PageNumbersDialog({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useDocument(documentId);
  const pageCount = doc?.pages.length ?? 1;
  const pageOf = m.furniture_preset_page_of({ page: '{page}', pages: '{pages}' });
  const [initial] = useState(() => {
    const existing = doc ? furnitureOf(doc, 'page-numbers')[0] : undefined;
    return existing?.kind === 'text'
      ? readPageNumbers(existing, pageCount)
      : defaultPageNumbers(pageCount);
  });
  const [existing] = useState(() => (doc ? furnitureOf(doc, 'page-numbers').length > 0 : false));
  const [settings, setSettings] = useState<PageNumberSettings>(initial);
  const [preset, setPreset] = useState<PageNumberPreset>(() => presetOf(initial.template, pageOf));
  const [startEdited, setStartEdited] = useState(existing);
  const overlays = settings.template.trim() === '' ? [] : [pageNumberOverlay(settings)];
  usePreview('page-numbers', [documentId], overlays);
  if (!doc) return null;

  const update = (patch: Partial<PageNumberSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const presets: readonly [PageNumberPreset, string][] = [
    ['plain', '1'],
    ['page-of', pageOf.replace('{page}', '1').replace('{pages}', formatNumber(pageCount))],
    ['slash', `1 / ${formatNumber(pageCount)}`],
    ['dashes', '- 1 -'],
    ['custom', m.furniture_preset_custom()],
  ];

  return (
    <Frame
      kind="page-numbers"
      documentId={documentId}
      existing={existing}
      canApply={overlays.length > 0}
      onApply={() =>
        commit('page-numbers', () =>
          useWorkspaceStore
            .getState()
            .applyOperation(
              (ws) => applyFurniture(ws, documentId, 'page-numbers', overlays),
              m.furniture_title_page_numbers(),
            ),
        )
      }
    >
      <Section legend={m.furniture_format()}>
        <div className={local2.segments} role="radiogroup" aria-label={m.furniture_format()}>
          {presets.map(([id, label]) => (
            <label key={id} className={local2.segment}>
              <input
                type="radio"
                name="page-number-preset"
                checked={preset === id}
                data-testid={`preset-${id}`}
                onChange={() => {
                  setPreset(id);
                  if (id !== 'custom') update({ template: presetTemplate(id, pageOf) });
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {preset === 'custom' ? (
          <>
            <input
              className={styles.input}
              aria-label={m.furniture_template_label()}
              value={settings.template}
              spellCheck={false}
              data-testid="page-number-template"
              onChange={(e) => update({ template: e.target.value })}
            />
            <TokenHint />
          </>
        ) : null}
      </Section>
      <PositionSection
        anchor={settings.anchor}
        onAnchor={(anchor) => update({ anchor })}
        marginX={settings.marginX}
        marginY={settings.marginY}
        onMargins={(marginX, marginY) => update({ marginX, marginY })}
        mirror={settings.mirror}
        onMirror={(mirror) => update({ mirror })}
      />
      <StyleSection style={settings.style} onChange={(style) => update({ style })} />
      <RangeSection
        range={settings.range}
        pageCount={pageCount}
        onChange={(range) =>
          update(startEdited ? { range } : { range, startNumber: firstPosition(range) })
        }
      >
        <NumberField
          label={m.furniture_start_number()}
          value={settings.startNumber}
          min={0}
          testId="page-number-start"
          onChange={(startNumber) => {
            setStartEdited(true);
            update({ startNumber: Math.max(0, Math.round(startNumber)) });
          }}
        />
      </RangeSection>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Header and footer
// ---------------------------------------------------------------------------

function HeaderFooterDialog({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useDocument(documentId);
  const pageCount = doc?.pages.length ?? 1;
  const [initial] = useState(() => {
    const found = doc ? furnitureOf(doc, 'header-footer') : [];
    const texts = found.filter((o): o is TextOverlay => o.kind === 'text');
    return texts.length > 0 ? readHeaderFooter(texts, pageCount) : defaultHeaderFooter(pageCount);
  });
  const [existing] = useState(() => (doc ? furnitureOf(doc, 'header-footer').length > 0 : false));
  const [settings, setSettings] = useState<HeaderFooterSettings>(initial);
  const overlays = headerFooterOverlays(settings);
  usePreview('header-footer', [documentId], overlays);
  if (!doc) return null;
  const update = (patch: Partial<HeaderFooterSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const slotName = [m.furniture_slot_left, m.furniture_slot_center, m.furniture_slot_right];

  return (
    <Frame
      kind="header-footer"
      documentId={documentId}
      existing={existing}
      canApply={overlays.length > 0}
      onApply={() =>
        commit('header-footer', () =>
          useWorkspaceStore
            .getState()
            .applyOperation(
              (ws) => applyFurniture(ws, documentId, 'header-footer', overlays),
              m.furniture_title_header_footer(),
            ),
        )
      }
    >
      {(['top', 'bottom'] as const).map((edge) => (
        <Section key={edge} legend={edge === 'top' ? m.furniture_header() : m.furniture_footer()}>
          <div className={local2.slots}>
            {SLOTS.filter((slot) => slot.startsWith(edge)).map((slot, i) => (
              <input
                key={slot}
                className={`${styles.input} ${local2.slot}`}
                aria-label={m.furniture_slot_label({
                  edge: edge === 'top' ? m.furniture_header() : m.furniture_footer(),
                  slot: (slotName[i] as () => string)(),
                })}
                placeholder={(slotName[i] as () => string)()}
                spellCheck={false}
                value={settings.slots[slot]}
                data-testid={`slot-${slot}`}
                onChange={(e) => update({ slots: { ...settings.slots, [slot]: e.target.value } })}
              />
            ))}
          </div>
        </Section>
      ))}
      <TokenHint />
      <PositionSection
        marginX={settings.marginX}
        marginY={settings.marginY}
        onMargins={(marginX, marginY) => update({ marginX, marginY })}
        mirror={settings.mirror}
        onMirror={(mirror) => update({ mirror })}
      />
      <StyleSection style={settings.style} onChange={(style) => update({ style })} />
      <RangeSection
        range={settings.range}
        pageCount={pageCount}
        onChange={(range) => update({ range })}
      />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Bates
// ---------------------------------------------------------------------------

const BATES_MEMORY_KEY = 'pdf-editor:bates-last-number';

/** Last Bates number used per prefix (localStorage; see safe-storage.ts). */
export function lastBatesNumber(prefix: string): number | undefined {
  const stored = readJson(BATES_MEMORY_KEY);
  if (typeof stored !== 'object' || stored === null) return undefined;
  const value = (stored as Record<string, unknown>)[prefix];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

export function rememberBatesNumber(prefix: string, last: number): void {
  const stored = readJson(BATES_MEMORY_KEY);
  const record =
    typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  writeJson(BATES_MEMORY_KEY, { ...record, [prefix]: last });
}

function BatesDialog({ documentId }: { readonly documentId: DocumentId }) {
  const tabs = useTabItems();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const doc = workspace.documents[documentId];
  const [existing] = useState(() => (doc ? furnitureOf(doc, 'bates').length > 0 : false));
  const [initial] = useState<BatesSettings>(() => {
    const found = doc ? furnitureOf(doc, 'bates')[0] : undefined;
    const settings = readBates(found?.kind === 'text' ? found : undefined, doc?.bates);
    if (doc?.bates) return settings;
    const last = lastBatesNumber(settings.prefix);
    return last === undefined ? settings : { ...settings, start: last + 1 };
  });
  const [settings, setSettings] = useState(initial);
  const [startEdited, setStartEdited] = useState(existing);
  const [selected, setSelected] = useState<readonly DocumentId[]>([documentId]);
  const update = (patch: Partial<BatesSettings>) => setSettings((s) => ({ ...s, ...patch }));

  const documents = tabs
    .filter((t) => selected.includes(t.id))
    .map((t) => workspace.documents[t.id])
    .filter((d) => d !== undefined);
  const run = planBatesRun(documents, settings);
  const overlay = batesOverlay(settings);
  const bates = Object.fromEntries(run.map((entry) => [entry.documentId, entry.config]));
  usePreview('bates', selected, [overlay], bates);
  if (!doc) return null;
  const first = run[0];
  const last = run[run.length - 1];
  const remembered = lastBatesNumber(settings.prefix);

  return (
    <Frame
      kind="bates"
      documentId={documentId}
      existing={existing}
      canApply={run.length > 0 && run.some((entry) => entry.last >= entry.first)}
      onApply={() =>
        commit('bates', () => {
          const done = useWorkspaceStore
            .getState()
            .applyOperation((ws) => applyBatesRun(ws, run, overlay), m.furniture_title_bates());
          if (done && last) rememberBatesNumber(settings.prefix, last.last);
          return done;
        })
      }
    >
      <Section legend={m.furniture_format()}>
        <div className={local2.row}>
          <label className={local2.inline}>
            {m.furniture_bates_prefix()}
            <input
              className={`${styles.input} ${local2.number}`}
              style={{ width: 96 }}
              value={settings.prefix}
              spellCheck={false}
              data-testid="bates-prefix"
              onChange={(e) => {
                const prefix = e.target.value;
                const known = lastBatesNumber(prefix);
                update(
                  !startEdited && known !== undefined ? { prefix, start: known + 1 } : { prefix },
                );
              }}
            />
          </label>
          <label className={local2.inline}>
            {m.furniture_bates_suffix()}
            <input
              className={`${styles.input} ${local2.number}`}
              value={settings.suffix}
              spellCheck={false}
              onChange={(e) => update({ suffix: e.target.value })}
            />
          </label>
        </div>
        <div className={local2.row}>
          <NumberField
            label={m.furniture_bates_width()}
            value={settings.width}
            min={1}
            max={12}
            onChange={(width) => update({ width: Math.min(12, Math.max(1, Math.round(width))) })}
          />
          <NumberField
            label={m.furniture_start_number()}
            value={settings.start}
            min={0}
            testId="bates-start"
            onChange={(start) => {
              setStartEdited(true);
              update({ start: Math.max(0, Math.round(start)) });
            }}
          />
        </div>
        {first && last && last.last >= first.first ? (
          <p className={local2.sample} role="status" data-testid="bates-sample">
            {m.furniture_bates_sample({
              first: formatBates(first.config, 0),
              last: formatBates(last.config, last.last - last.first),
            })}
          </p>
        ) : null}
        {remembered !== undefined ? (
          <p className={styles.hint}>
            {m.furniture_bates_remembered({ number: formatNumber(remembered) })}
          </p>
        ) : null}
      </Section>
      <Section legend={m.furniture_bates_documents()}>
        <div className={local2.docList}>
          {tabs.map((tab) => (
            <label key={tab.id} className={local.docOption}>
              <input
                type="checkbox"
                checked={selected.includes(tab.id)}
                onChange={(e) =>
                  setSelected((current) =>
                    e.target.checked
                      ? tabs.map((t) => t.id).filter((id) => id === tab.id || current.includes(id))
                      : current.filter((id) => id !== tab.id),
                  )
                }
              />
              <span className={local.tag} data-tag={tab.colorIndex} aria-hidden="true" />
              <span className={local.docTitle}>{tab.title}</span>
              <span className={local.docMeta}>{pagesPhrase(tab.pageCount)}</span>
            </label>
          ))}
        </div>
      </Section>
      <PositionSection
        anchor={settings.anchor}
        onAnchor={(anchor) => update({ anchor })}
        marginX={settings.marginX}
        marginY={settings.marginY}
        onMargins={(marginX, marginY) => update({ marginX, marginY })}
      />
      <StyleSection style={settings.style} onChange={(style) => update({ style })} />
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

function WatermarkDialog({ documentId }: { readonly documentId: DocumentId }) {
  const doc = useDocument(documentId);
  const pageCount = doc?.pages.length ?? 1;
  const [initial] = useState<WatermarkSettings>(() => {
    const found = doc ? furnitureOf(doc, 'watermark')[0] : undefined;
    return found ? readWatermark(found, pageCount) : defaultWatermark(pageCount);
  });
  const [existing] = useState(() => (doc ? furnitureOf(doc, 'watermark').length > 0 : false));
  const [settings, setSettings] = useState(initial);
  const [imageError, setImageError] = useState(false);
  const update = (patch: Partial<WatermarkSettings>) => setSettings((s) => ({ ...s, ...patch }));
  const built = watermarkOverlay(settings);
  usePreview('watermark', [documentId], built ? [built] : []);
  const previewBlob =
    settings.blob !== undefined && isPreviewBlob(settings.blob) ? settings.blob : undefined;
  useEffect(
    () => () => {
      if (previewBlob !== undefined) dropPreviewBlob(previewBlob);
    },
    [previewBlob],
  );
  if (!doc) return null;

  const chooseImage = async () => {
    const [file] = await pickFiles('images');
    if (!file) return;
    try {
      const blob = await decodeImageFile(file);
      setImageError(false);
      update({ mode: 'image', blob: putPreviewBlob(blob) });
    } catch {
      setImageError(true);
    }
  };

  const apply = () => {
    if (!built) return;
    if (built.kind === 'image' && isPreviewBlob(built.blob)) {
      const pending = takePreviewBlob(built.blob);
      if (!pending) return;
      void useWorkspaceStore
        .getState()
        .applyComposed(
          (lease) => Promise.resolve(useWorkspaceStore.getState().addBlob(pending, lease)),
          (ws, _ids, blob: BlobId) =>
            applyFurniture(ws, documentId, 'watermark', [{ ...built, blob }]),
          m.furniture_title_watermark(),
        )
        .then((done) => commit('watermark', () => done));
      return;
    }
    commit('watermark', () =>
      useWorkspaceStore
        .getState()
        .applyOperation(
          (ws) => applyFurniture(ws, documentId, 'watermark', [built]),
          m.furniture_title_watermark(),
        ),
    );
  };

  const rotation = clampRotation(settings.rotate);
  return (
    <Frame
      kind="watermark"
      documentId={documentId}
      existing={existing}
      canApply={built !== undefined}
      onApply={apply}
    >
      <Section legend={m.furniture_watermark_kind()}>
        <div
          className={local2.segments}
          role="radiogroup"
          aria-label={m.furniture_watermark_kind()}
        >
          {(['text', 'image'] as const).map((mode) => (
            <label key={mode} className={local2.segment}>
              <input
                type="radio"
                name="watermark-mode"
                checked={settings.mode === mode}
                onChange={() => update({ mode })}
              />
              {mode === 'text' ? m.furniture_text() : m.furniture_image()}
            </label>
          ))}
        </div>
        {settings.mode === 'text' ? (
          <input
            className={styles.input}
            aria-label={m.furniture_text()}
            value={settings.text}
            data-testid="watermark-text"
            onChange={(e) => update({ text: e.target.value })}
          />
        ) : (
          <div className={local2.row}>
            <button type="button" className={styles.secondary} onClick={() => void chooseImage()}>
              {m.furniture_choose_image()}
            </button>
            <span className={styles.hint}>
              {imageError
                ? m.furniture_image_failed()
                : settings.blob === undefined
                  ? m.furniture_no_image()
                  : ''}
            </span>
          </div>
        )}
      </Section>
      {settings.mode === 'text' ? (
        <StyleSection style={settings.style} onChange={(style) => update({ style })} />
      ) : (
        <Section legend={m.furniture_image()}>
          <Percent
            label={m.furniture_scale()}
            value={settings.scale}
            min={5}
            max={400}
            onChange={(scale) => update({ scale })}
          />
          <Percent
            label={m.furniture_opacity()}
            value={settings.style.opacity}
            min={5}
            onChange={(opacity) => update({ style: { ...settings.style, opacity } })}
          />
        </Section>
      )}
      <Section legend={m.furniture_position()}>
        <label className={local2.row}>
          <span className={local2.inline}>{m.furniture_rotation()}</span>
          <input
            type="range"
            className={local2.range}
            min={-90}
            max={90}
            value={rotation}
            aria-valuetext={`${rotation}°`}
            data-testid="watermark-rotation"
            onChange={(e) => update({ rotate: e.target.valueAsNumber })}
          />
          <span className={local2.value}>{rotation}°</span>
        </label>
        <div className={local2.segments}>
          {[-45, 0, 45, 90].map((preset) => (
            <button
              key={preset}
              type="button"
              className={local2.segment}
              aria-pressed={rotation === preset}
              onClick={() => update({ rotate: preset })}
            >
              {preset}°
            </button>
          ))}
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.tile}
            onChange={(e) => update({ tile: e.target.checked })}
          />
          <span>{m.furniture_tile()}</span>
        </label>
        {settings.tile ? (
          <div className={local2.row}>
            <NumberField
              label={m.furniture_gap_x()}
              value={settings.gapX}
              min={0}
              unit={m.furniture_unit_pt()}
              onChange={(gapX) => update({ gapX: Math.max(0, gapX) })}
            />
            <NumberField
              label={m.furniture_gap_y()}
              value={settings.gapY}
              min={0}
              unit={m.furniture_unit_pt()}
              onChange={(gapY) => update({ gapY: Math.max(0, gapY) })}
            />
          </div>
        ) : null}
        <div className={local2.segments} role="radiogroup" aria-label={m.furniture_layer()}>
          {(['over', 'behind'] as const).map((layer) => (
            <label key={layer} className={local2.segment}>
              <input
                type="radio"
                name="watermark-layer"
                checked={settings.layer === layer}
                onChange={() => update({ layer })}
              />
              {layer === 'over' ? m.furniture_layer_over() : m.furniture_layer_behind()}
            </label>
          ))}
        </div>
        {settings.layer === 'behind' ? (
          <p className={styles.hint}>{m.furniture_behind_note()}</p>
        ) : null}
      </Section>
      <RangeSection
        range={settings.range}
        pageCount={pageCount}
        onChange={(range) => update({ range })}
      />
    </Frame>
  );
}
