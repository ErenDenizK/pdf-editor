/**
 * Form layer (spec document-tools §1): one per page in Read mode, registered as a page
 * overlay after the annotation layer.
 *
 * PDFium draws the fields (value included) into the page bitmap; this layer adds hit
 * targets over the widgets of the page and, for the active field, an in-place editor
 * sized to the widget. Widget rects come from the form store in unrotated user space and
 * go through the viewer's page frame, so rotation and CropBox offsets need no special
 * case. The layer is live with the Select tool only; with a drawing tool it is inert (the
 * annotation layer captures the page). A source with XFA but no AcroForm widgets has no
 * targets at all.
 *
 * Kinds: checkbox and radio toggle on click / Space; text, combo box and list box open an
 * editor; a push button shows that its actions are not run; a signature field shows what
 * the engine read about it, never validated.
 */
import type { FormField } from '@pdf-editor/engine';
import { BadgeAlert } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { m } from '../i18n';
import type { PageOverlayProps } from '../stage/page-overlays';
import { type Box, type PageFrame, userRectToCss } from '../viewer/geometry';
import { pageFrame } from '../viewer/page-frame';
import { useToolStore } from '../viewer/tool-store';
import { Tooltip } from '../ui/Tooltip';
import { fieldLabel, fillField } from './actions';
import { ChoiceEditor, TextEditor } from './FieldEditors';
import { type ActiveField, useFormStore, useSourceFields, widgetsOf } from './form-store';
import styles from './FormLayer.module.css';
import { moveField } from './navigation';

interface PlacedWidget {
  readonly field: FormField;
  readonly widget: number;
  readonly box: Box;
  readonly exportValue: string | undefined;
}

export function FormLayer(props: PageOverlayProps) {
  const { sourceId, sourceIndex, pageId, pageIndex } = props;
  const mode = useToolStore((s) => s.mode);
  const fields = useSourceFields(sourceId);
  const ensureSource = useFormStore((s) => s.ensureSource);
  const highlight = useFormStore((s) => s.highlight);
  const active = useFormStore((s) => (s.active?.pageId === pageId ? s.active : null));

  useEffect(() => {
    if (sourceId !== undefined) ensureSource(sourceId);
  }, [sourceId, ensureSource]);

  if (sourceId === undefined) return null;
  const frame = pageFrame(props);
  const placed: PlacedWidget[] = [];
  for (const field of fields) {
    widgetsOf(field).forEach((w, widget) => {
      if (w.pageIndex !== sourceIndex) return;
      placed.push({ field, widget, box: userRectToCss(frame, w.rect), exportValue: w.exportValue });
    });
  }
  if (placed.length === 0) return null;
  const live = mode === 'select';

  return (
    <div
      className={styles.layer}
      data-form-layer={pageIndex}
      data-live={live || undefined}
      data-highlight={highlight || undefined}
      role="group"
      aria-label={m.forms_layer_label({ page: pageIndex + 1 })}
    >
      {placed.map((p) => {
        const here: ActiveField = {
          source: sourceId,
          name: p.field.name,
          widget: p.widget,
          pageId,
        };
        const isActive =
          live && active !== null && active.name === p.field.name && active.widget === p.widget;
        return (
          <FieldWidget
            key={`${p.field.name}#${p.widget}`}
            placed={p}
            frame={frame}
            here={here}
            active={isActive}
            live={live}
          />
        );
      })}
    </div>
  );
}

FormLayer.displayName = 'FormLayer';

function FieldWidget({
  placed,
  frame,
  here,
  active,
  live,
}: {
  readonly placed: PlacedWidget;
  readonly frame: PageFrame;
  readonly here: ActiveField;
  readonly active: boolean;
  readonly live: boolean;
}) {
  const { field, box } = placed;
  const ref = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState(false);
  const editable = field.kind === 'text' || field.kind === 'combobox' || field.kind === 'listbox';

  // Keyboard navigation lands here for toggles: take focus.
  useEffect(() => {
    if (active && !editable) ref.current?.focus({ preventScroll: false });
  }, [active, editable]);

  if (active && editable && !field.readOnly) {
    return field.kind === 'text' || (field.kind === 'combobox' && field.editable) ? (
      <TextEditor field={field} here={here} box={box} frame={frame} />
    ) : (
      <ChoiceEditor field={field} here={here} box={box} frame={frame} />
    );
  }

  const label = fieldLabel(field);
  const position = { left: box.left, top: box.top, width: box.width, height: box.height };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      moveField(here, event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setNotice(false);
      useFormStore.getState().setActive(null);
      ref.current?.blur();
    }
  };
  const common = {
    ref,
    type: 'button' as const,
    className: styles.target,
    style: position,
    tabIndex: live ? 0 : -1,
    'data-field-name': field.name,
    'data-field-kind': field.kind,
    'data-annotation-keep': '',
    'data-active': active || undefined,
    onKeyDown,
    onFocus: () => {
      if (!active) useFormStore.getState().setActive(here);
    },
  };

  switch (field.kind) {
    case 'checkbox': {
      const on = field.value === true;
      return (
        <button
          {...common}
          role="checkbox"
          aria-checked={on}
          aria-label={label}
          aria-readonly={field.readOnly || undefined}
          aria-required={field.required || undefined}
          onClick={() => {
            if (!field.readOnly) void fillField(here.source, field.name, !on);
          }}
        />
      );
    }
    case 'radio': {
      const on = placed.exportValue !== undefined && field.value === placed.exportValue;
      return (
        <button
          {...common}
          role="radio"
          aria-checked={on}
          aria-label={m.forms_radio_option({ name: label, option: placed.exportValue ?? '' })}
          aria-disabled={field.readOnly || undefined}
          onClick={() => {
            if (!field.readOnly && !on && placed.exportValue !== undefined) {
              void fillField(here.source, field.name, placed.exportValue);
            }
          }}
        />
      );
    }
    case 'button':
      return (
        <Tooltip label={m.forms_button_not_run()}>
          <button
            {...common}
            aria-label={`${label}: ${m.forms_button_not_run()}`}
            aria-disabled="true"
            data-inert=""
          />
        </Tooltip>
      );
    case 'signature':
      return (
        <>
          <button
            {...common}
            aria-label={m.forms_signature_field({ name: label })}
            aria-expanded={notice}
            onClick={() => setNotice((v) => !v)}
          />
          {notice ? <SignatureNotice field={field} box={box} /> : null}
        </>
      );
    default:
      return (
        <button
          {...common}
          aria-label={field.readOnly ? m.forms_read_only({ name: label }) : label}
          aria-disabled={field.readOnly || field.kind === 'unknown' || undefined}
          onClick={() => {
            if (!field.readOnly && editable) useFormStore.getState().setActive(here);
          }}
        />
      );
  }
}

function SignatureNotice({ field, box }: { readonly field: FormField; readonly box: Box }) {
  const signature = field.signature;
  return (
    <div
      role="note"
      className={styles.notice}
      data-annotation-keep=""
      style={{ left: box.left, top: box.top + box.height + 6 }}
    >
      <div className={styles.noticeTitle}>{m.forms_signature_title()}</div>
      {signature ? (
        <>
          {signature.signer ? <div>{signature.signer}</div> : null}
          {signature.date ? (
            <div className={styles.noticeMeta}>{formatPdfDate(signature.date)}</div>
          ) : null}
          <span className={styles.badge}>
            <BadgeAlert aria-hidden="true" />
            {m.forms_signature_not_validated()}
          </span>
        </>
      ) : (
        <div className={styles.noticeMeta}>{m.forms_signature_unsigned()}</div>
      )}
    </div>
  );
}

/** A PDF date (`D:YYYYMMDDHHmmSS`) or ISO string, for display. */
export function formatPdfDate(value: string): string {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return value;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00'] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
