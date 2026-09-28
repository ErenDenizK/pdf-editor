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
 *
 * Field creation (M4, forms/create): "Add field" picks a kind to place on a page; "Edit
 * fields" makes created fields selectable (a row then selects its field) and shows their
 * tab-order buttons. Created fields list after the source fields of their page, tagged.
 */
import { Menu } from '@base-ui/react/menu';
import type { CreatedFieldKind, VirtualDocument } from '@pdf-editor/document-model';
import type { FormField, FormFieldKind } from '@pdf-editor/engine';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CircleDot,
  CircleHelp,
  Eraser,
  Highlighter,
  List,
  type LucideIcon,
  MousePointerClick,
  PenLine,
  Plus,
  SquareCheck,
  SquareChevronDown,
  SquareDashedMousePointer,
  TextCursorInput,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useId } from 'react';

import { clearActiveForm } from '../forms';
import { fieldLabel } from '../forms/actions';
import { FIELD_KINDS, kindName, setDesign, startPlacing, useCreateStore } from '../forms/create';
import { stepTabOrder } from '../forms/create/field-actions';
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
import menuStyles from '../ui/Menu.module.css';
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

const CREATE_ICONS: Record<CreatedFieldKind, LucideIcon> = {
  text: TextCursorInput,
  checkbox: SquareCheck,
  radio: CircleDot,
  dropdown: SquareChevronDown,
  listbox: List,
  signature: PenLine,
  button: MousePointerClick,
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
        (r) =>
          r.source === stop.source &&
          r.fieldId === stop.fieldId &&
          r.name === stop.name &&
          r.pageId === stop.pageId,
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
      <Toolbar fillable={rows.some((r) => isFillable(r.field))} hasPages={doc.pages.length > 0} />
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

function AddFieldMenu({ disabled }: { readonly disabled: boolean }) {
  const placing = useCreateStore((s) => s.placing);
  return (
    <Menu.Root>
      <Menu.Trigger
        className={styles.button}
        disabled={disabled}
        aria-pressed={placing !== null}
        data-add-field=""
      >
        <Plus aria-hidden="true" />
        {m.forms_add_field()}
        <ChevronDown aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup}>
            {FIELD_KINDS.map((kind) => {
              const Icon = CREATE_ICONS[kind];
              return (
                <Menu.Item
                  key={kind}
                  className={menuStyles.item}
                  data-add-kind={kind}
                  onClick={() => startPlacing(kind)}
                >
                  <Icon aria-hidden="true" width={14} height={14} />
                  <span className={menuStyles.label}>{kindName(kind)}</span>
                </Menu.Item>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Toolbar({
  fillable,
  hasPages,
}: {
  readonly fillable: boolean;
  readonly hasPages: boolean;
}) {
  const highlight = useFormStore((s) => s.highlight);
  const flatten = useFormStore((s) => s.flattenOnExport);
  const design = useCreateStore((s) => s.design);
  const placing = useCreateStore((s) => s.placing);
  const id = useId();
  return (
    <div className={styles.toolbar} data-annotation-keep="">
      <div className={styles.buttons}>
        <AddFieldMenu disabled={!hasPages} />
        <button
          type="button"
          className={styles.button}
          aria-pressed={design}
          disabled={!hasPages}
          data-edit-fields=""
          onClick={() => setDesign(!design)}
        >
          <SquareDashedMousePointer aria-hidden="true" />
          {m.forms_design()}
        </button>
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
          disabled={!fillable}
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
      {placing !== null ? (
        <p className={styles.hint} role="status">
          {m.forms_create_placing({ kind: kindName(placing) })}
        </p>
      ) : null}
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
  const design = useCreateStore((s) => s.design);
  const selected = useCreateStore((s) => s.selected);
  const open = (row: FieldStop) => {
    if (design && row.fieldId !== undefined) {
      // Edit fields: a created field's row selects it on its page.
      useCreateStore.getState().select({ fieldId: row.fieldId, widget: row.widget });
      useViewStore.getState().scrollToPage(row.pageId);
      return;
    }
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
            {page.rows.map((row, index) => {
              const Icon = ICONS[row.field.kind];
              const value = valueText(row.field);
              const label = fieldLabel(row.field);
              const current =
                row.fieldId !== undefined && design
                  ? selected?.fieldId === row.fieldId
                  : activeName === row.name && activePage === row.pageId;
              const createdOnPage = page.rows.filter((r) => r.fieldId !== undefined);
              const createdIndex = createdOnPage.indexOf(row);
              return (
                <li
                  key={`${row.source ?? row.fieldId}:${row.name}`}
                  className={styles.row}
                  data-created-row={row.fieldId === undefined ? undefined : row.name}
                  data-index={index}
                >
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
                        {row.fieldId !== undefined ? (
                          <span className={styles.tag}>{m.forms_created_tag()}</span>
                        ) : null}
                      </span>
                      <span className={styles.value} data-empty={value.empty || undefined}>
                        {row.fieldId !== undefined && row.field.kind === 'signature'
                          ? m.forms_signature_placeholder()
                          : value.text}
                      </span>
                    </span>
                  </button>
                  {design && row.fieldId !== undefined ? (
                    <span className={styles.order}>
                      <button
                        type="button"
                        className={styles.orderButton}
                        aria-label={m.forms_tab_earlier({ name: label })}
                        title={m.forms_tab_earlier({ name: label })}
                        disabled={createdIndex <= 0}
                        onClick={() => row.fieldId && stepTabOrder(row.fieldId, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.orderButton}
                        aria-label={m.forms_tab_later({ name: label })}
                        title={m.forms_tab_later({ name: label })}
                        disabled={createdIndex < 0 || createdIndex >= createdOnPage.length - 1}
                        onClick={() => row.fieldId && stepTabOrder(row.fieldId, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
