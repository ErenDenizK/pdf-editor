/**
 * Left rail "Forms" (spec document-tools §1): every form field shown by the active
 * document, in document order and grouped by page, with a type icon, its name (the /TU
 * tooltip when it has one), its value and a required marker. Activating a row shows the
 * page in Read mode and opens the field's editor.
 *
 * Toolbar: "Highlight fields" (translucent fill over the widgets), "Clear all" (one
 * history entry) and "Flatten on export" (read by the export dialog).
 *
 * XFA honesty: a source with /XFA and AcroForm widgets fills through the AcroForm (a
 * badge explains that export removes the XFA part); one without widgets shows that no
 * browser engine can edit it, and the form layer has nothing to offer.
 */
import type { SourceId, VirtualDocument } from '@pdf-editor/document-model';
import type { FormField, FormFieldKind } from '@pdf-editor/engine';
import {
  CircleDot,
  CircleHelp,
  Eraser,
  Highlighter,
  List,
  type LucideIcon,
  MousePointerClick,
  PenLine,
  SquareCheck,
  SquareChevronDown,
  TextCursorInput,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId } from 'react';

import { clearActiveForm } from '../forms';
import { fieldLabel } from '../forms/actions';
import {
  documentSources,
  type FieldStop,
  fieldStops,
  isFillable,
  useFormStore,
} from '../forms/form-store';
import { openField } from '../forms/navigation';
import { m } from '../i18n';
import { useUiStore } from '../state/ui-store';
import { useViewStore } from '../state/view-store';
import { useActiveDocument, useWorkspaceStore } from '../state/workspace-store';
import { Tooltip } from '../ui/Tooltip';
import { EmptyNote } from './EmptyNote';
import styles from './FormsPanel.module.css';

const ICONS: Record<FormFieldKind, LucideIcon> = {
  text: TextCursorInput,
  checkbox: SquareCheck,
  radio: CircleDot,
  combobox: SquareChevronDown,
  listbox: List,
  button: MousePointerClick,
  signature: PenLine,
  unknown: CircleHelp,
};

export function FormsPanel() {
  const doc = useActiveDocument();
  return (
    <div className={styles.panel} data-forms-panel="">
      {doc ? (
        <FormList key={doc.id} doc={doc} />
      ) : (
        <div className={styles.empty}>
          <EmptyNote title={m.no_document_title()} body={m.forms_no_document_body()} />
        </div>
      )}
    </div>
  );
}

/** The value of a field as the list shows it. */
export function valueText(field: FormField): { text: string; empty: boolean } {
  const v = field.value;
  switch (field.kind) {
    case 'checkbox':
      return { text: v === true ? m.forms_checked() : m.forms_unchecked(), empty: v !== true };
    case 'button':
      return { text: m.forms_kind_button(), empty: true };
    case 'signature':
      return field.signature
        ? { text: m.forms_signed(), empty: false }
        : { text: m.forms_signature_unsigned(), empty: true };
    default: {
      const text = typeof v === 'object' ? v.join(', ') : typeof v === 'string' ? v : '';
      if (text === '') return { text: m.forms_empty(), empty: true };
      return { text: field.password ? '••••••' : text, empty: false };
    }
  }
}

function FormList({ doc }: { readonly doc: VirtualDocument }) {
  const sources = useFormStore((s) => s.sources);
  const ensureSource = useFormStore((s) => s.ensureSource);
  const active = useFormStore((s) => s.active);
  const flags = useWorkspaceStore((s) => s.workspace.sources);
  const ids = documentSources(doc);

  useEffect(() => {
    for (const id of documentSources(doc)) ensureSource(id);
  }, [doc, ensureSource]);

  const loading = ids.some((id) => sources[id] === undefined);
  const stops = fieldStops(doc, sources);
  // One row per field and page (a field with several widgets on a page is one row).
  const rows: FieldStop[] = [];
  for (const stop of stops) {
    if (
      !rows.some(
        (r) => r.source === stop.source && r.name === stop.name && r.pageId === stop.pageId,
      )
    ) {
      rows.push(stop);
    }
  }
  const xfa = ids.filter((id) => flags[id]?.flags.hasXfa === true);
  const xfaOnly = xfa.filter((id) => sources[id]?.loaded && sources[id]?.fields.length === 0);
  const xfaWithFields = xfa.filter((id) => (sources[id]?.fields.length ?? 0) > 0);

  return (
    <>
      <Toolbar sources={ids} fillable={rows.some((r) => isFillable(r.field))} />
      {xfaWithFields.length > 0 ? <XfaBadge /> : null}
      {xfaOnly.length > 0 ? (
        <p className={styles.warning} role="note">
          <TriangleAlert aria-hidden="true" />
          <span>{m.forms_xfa_only()}</span>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <div className={styles.empty} aria-busy={loading}>
          {loading ? (
            <EmptyNote title={m.forms_loading()} />
          ) : xfaOnly.length > 0 ? null : (
            <EmptyNote title={m.forms_empty_title()} body={m.forms_empty_body()} />
          )}
        </div>
      ) : (
        <FieldRows rows={rows} activeName={active?.name} activePage={active?.pageId} />
      )}
    </>
  );
}

function Toolbar({
  sources,
  fillable,
}: {
  readonly sources: readonly SourceId[];
  readonly fillable: boolean;
}) {
  const highlight = useFormStore((s) => s.highlight);
  const flatten = useFormStore((s) => s.flattenOnExport);
  const id = useId();
  return (
    <div className={styles.toolbar} data-annotation-keep="">
      <div className={styles.buttons}>
        <button
          type="button"
          className={styles.button}
          aria-pressed={highlight}
          onClick={() => useFormStore.getState().setHighlight(!highlight)}
        >
          <Highlighter aria-hidden="true" />
          {m.forms_highlight()}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={!fillable || sources.length === 0}
          onClick={() => void clearActiveForm()}
        >
          <Eraser aria-hidden="true" />
          {m.forms_clear_all()}
        </button>
      </div>
      <label className={styles.check} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={flatten}
          onChange={(e) => useFormStore.getState().setFlattenOnExport(e.target.checked)}
        />
        {m.forms_flatten_on_export()}
      </label>
    </div>
  );
}

function XfaBadge() {
  return (
    <div className={styles.xfa}>
      <Tooltip label={m.forms_xfa_badge_explanation()}>
        <button type="button" className={styles.badge} aria-label={m.forms_xfa_badge_explanation()}>
          {m.badge_xfa()}
        </button>
      </Tooltip>
      <span className={styles.xfaText}>{m.forms_xfa_acroform()}</span>
    </div>
  );
}

function FieldRows({
  rows,
  activeName,
  activePage,
}: {
  readonly rows: readonly FieldStop[];
  readonly activeName: string | undefined;
  readonly activePage: string | undefined;
}) {
  const pages: { position: number; pageId: string; rows: FieldStop[] }[] = [];
  for (const row of rows) {
    const last = pages[pages.length - 1];
    if (last?.pageId === row.pageId) last.rows.push(row);
    else pages.push({ position: row.position, pageId: row.pageId, rows: [row] });
  }
  const open = (row: FieldStop) => {
    if (isFillable(row.field)) {
      openField(row);
      return;
    }
    useUiStore.getState().setViewMode('read');
    useViewStore.getState().scrollToPage(row.pageId);
  };
  return (
    <div className={styles.scroll}>
      {pages.map((page) => (
        <section
          key={`${page.pageId}:${page.position}`}
          className={styles.group}
          aria-label={m.comments_page({ page: page.position + 1 })}
        >
          <h3 className={styles.pageTitle}>{m.comments_page({ page: page.position + 1 })}</h3>
          <ul className={styles.list}>
            {page.rows.map((row) => {
              const Icon = ICONS[row.field.kind];
              const value = valueText(row.field);
              const label = fieldLabel(row.field);
              const current = activeName === row.name && activePage === row.pageId;
              return (
                <li key={`${row.source}:${row.name}`}>
                  <button
                    type="button"
                    className={styles.item}
                    aria-current={current ? 'true' : undefined}
                    data-field-row={row.name}
                    title={label === row.name ? undefined : row.name}
                    onClick={() => open(row)}
                  >
                    <span className={styles.icon} aria-hidden="true">
                      <Icon />
                    </span>
                    <span className={styles.body}>
                      <span className={styles.name}>
                        {label}
                        {row.field.required ? (
                          <span className={styles.required} title={m.forms_required()}>
                            <span aria-hidden="true">*</span>
                            <span className={styles.srOnly}>{m.forms_required()}</span>
                          </span>
                        ) : null}
                        {row.field.readOnly ? (
                          <span className={styles.tag}>{m.forms_read_only_tag()}</span>
                        ) : null}
                      </span>
                      <span className={styles.value} data-empty={value.empty || undefined}>
                        {value.text}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
