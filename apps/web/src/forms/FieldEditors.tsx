/**
 * In-place field editors (spec document-tools §1), sized to the widget on screen:
 *
 * - `TextEditor`: single-line input, multi-line textarea, password, max length and comb
 *   spacing (monospaced cells when the field has /Ff Comb and /MaxLen); also free-text
 *   combo boxes (input with the options as suggestions).
 * - `ChoiceEditor`: native select for combo boxes and list boxes (multi-select included).
 *
 * Keys: Enter commits (Mod+Enter in a textarea), Esc reverts and closes, Tab / Shift+Tab
 * commit and move to the next / previous field in document order. Leaving the editor
 * commits. A commit is one history entry ("Fill Name") when the value changed.
 */
import type { FormField } from '@pdf-editor/engine';
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import { m } from '../i18n';
import type { Box, PageFrame } from '../viewer/geometry';
import { commitFieldValue, type FieldValue, fieldLabel } from './actions';
import { type ActiveField, useFormStore } from './form-store';
import styles from './FormLayer.module.css';
import { moveField } from './navigation';

interface EditorProps {
  readonly field: FormField;
  readonly here: ActiveField;
  readonly box: Box;
  readonly frame: PageFrame;
}

/** Placement of an editor over the widget; rotated pages turn the control with the page. */
function placement(
  box: Box,
  frame: PageFrame,
): { style: CSSProperties; width: number; height: number } {
  const quarter = frame.rotation === 90 || frame.rotation === 270;
  const width = quarter ? box.height : box.width;
  const height = quarter ? box.width : box.height;
  return {
    width,
    height,
    style: {
      left: box.left + box.width / 2 - width / 2,
      top: box.top + box.height / 2 - height / 2,
      width,
      height,
      ...(frame.rotation === 0 ? {} : { transform: `rotate(${frame.rotation}deg)` }),
    },
  };
}

/** Font size (CSS px) that fits a single line in the widget, as viewers auto-size. */
function fitFontSize(heightPx: number, scale: number, multiline: boolean): number {
  const heightPt = heightPx / scale;
  const pt = multiline
    ? Math.min(12, Math.max(8, heightPt * 0.5))
    : Math.min(14, Math.max(7, heightPt * 0.62));
  return pt * scale;
}

/** Shared keys: returns true when handled. */
function useEditorKeys(
  here: ActiveField,
  commit: () => void,
  revert: () => void,
): (event: KeyboardEvent<HTMLElement>, allowEnter: boolean) => void {
  return (event, allowEnter) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      revert();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      commit();
      if (!moveField(here, event.shiftKey ? -1 : 1)) useFormStore.getState().setActive(null);
    } else if (event.key === 'Enter' && (!allowEnter || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      commit();
      useFormStore.getState().setActive(null);
    } else {
      // Typing must not reach the app's single-key shortcuts.
      event.stopPropagation();
    }
  };
}

/** Commit-once bookkeeping shared by the editors. */
function useCommit(here: ActiveField, original: FieldValue, current: () => FieldValue) {
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    const value = current();
    if (JSON.stringify(value ?? null) !== JSON.stringify(original ?? null)) {
      void commitFieldValue(here, value);
    }
  };
  const revert = () => {
    done.current = true;
    const store = useFormStore.getState();
    if (
      store.active?.name === here.name &&
      store.active.fieldId === here.fieldId &&
      store.active.pageId === here.pageId
    ) {
      store.setActive(null);
    }
  };
  const blur = () => {
    commit();
    const store = useFormStore.getState();
    if (
      store.active?.name === here.name &&
      store.active.fieldId === here.fieldId &&
      store.active.pageId === here.pageId &&
      store.active.widget === here.widget
    ) {
      store.setActive(null);
    }
  };
  return { commit, revert, blur };
}

export function TextEditor({ field, here, box, frame }: EditorProps) {
  const original = typeof field.value === 'string' ? field.value : '';
  const [text, setText] = useState(original);
  const textRef = useRef(text);
  const change = (value: string) => {
    textRef.current = value;
    setText(value);
  };
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const listId = useId();
  const { commit, revert, blur } = useCommit(here, original, () => textRef.current);
  const onKey = useEditorKeys(here, commit, revert);
  const { style, width, height } = placement(box, frame);
  const multiline = field.multiline === true;
  const fontSize = fitFontSize(height, frame.scale, multiline);
  const comb = field.comb === true && field.maxLength !== undefined && field.maxLength > 0;
  const combStyle: CSSProperties = {};
  if (comb && field.maxLength) {
    const cell = width / field.maxLength;
    const glyph = fontSize * 0.6;
    combStyle.fontFamily = 'var(--font-mono)';
    combStyle.letterSpacing = `${Math.max(0, cell - glyph)}px`;
    combStyle.paddingLeft = `${Math.max(0, (cell - glyph) / 2)}px`;
    combStyle.paddingRight = 0;
  }

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    if (useFormStore.getState().active?.selectAll) el.select();
    else el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const shared = {
    ref: inputRef,
    className: styles.editor,
    'data-form-editor': field.name,
    'data-annotation-keep': '',
    'aria-label': fieldLabel(field),
    'aria-required': field.required || undefined,
    value: text,
    maxLength: field.maxLength,
    spellCheck: !field.password,
    style: { ...style, fontSize, ...combStyle },
    onBlur: blur,
    onPointerDown: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };

  if (multiline) {
    return (
      <textarea
        {...shared}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => onKey(e, true)}
      />
    );
  }
  const options = field.kind === 'combobox' ? (field.options ?? []) : [];
  return (
    <>
      <input
        {...shared}
        type={field.password ? 'password' : 'text'}
        autoComplete="off"
        list={options.length > 0 ? listId : undefined}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => onKey(e, false)}
      />
      {options.length > 0 ? (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

export function ChoiceEditor({ field, here, box, frame }: EditorProps) {
  const options = field.options ?? [];
  const multiple = field.kind === 'listbox' && field.multiSelect === true;
  const original: FieldValue = field.value;
  const initial: string[] =
    typeof original === 'object'
      ? [...original]
      : typeof original === 'string' && original !== ''
        ? [original]
        : [];
  const [selected, setSelected] = useState<string[]>(initial);
  const selectedRef = useRef(selected);
  const current = (): FieldValue =>
    multiple ? selectedRef.current : (selectedRef.current[0] ?? '');
  const { commit, revert, blur } = useCommit(
    here,
    multiple ? initial : (initial[0] ?? ''),
    current,
  );
  const onKey = useEditorKeys(here, commit, revert);
  const ref = useRef<HTMLSelectElement>(null);
  /** The pending change comes from the keyboard (arrows, letters): commit on Enter / leave. */
  const viaKeys = useRef(false);
  const { style, height } = placement(box, frame);
  const fontSize = fitFontSize(
    field.kind === 'listbox' ? Math.min(height, 22 * frame.scale) : height,
    frame.scale,
    false,
  );

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // A value that is not an option (e.g. set by another tool) stays visible and selected.
  const shown = [...options, ...selected.filter((s) => !options.includes(s))];
  return (
    <select
      ref={ref}
      className={styles.editor}
      data-form-editor={field.name}
      data-annotation-keep=""
      aria-label={fieldLabel(field)}
      aria-required={field.required || undefined}
      multiple={multiple}
      size={field.kind === 'listbox' ? Math.max(2, Math.min(options.length, 6)) : undefined}
      value={multiple ? selected : (selected[0] ?? '')}
      style={{ ...style, fontSize }}
      onChange={(e) => {
        const values = Array.from(e.target.selectedOptions, (o) => o.value);
        setSelected(values);
        selectedRef.current = values;
        // A single choice picked with the pointer is complete (like a checkbox); keyboard
        // browsing and multi-select lists commit on Enter, Tab or leaving.
        if (!multiple && !viaKeys.current) {
          commit();
          useFormStore.getState().setActive(null);
        }
        viaKeys.current = false;
      }}
      onKeyDown={(e) => {
        viaKeys.current = !['Enter', 'Tab', 'Escape'].includes(e.key);
        onKey(e, false);
      }}
      onBlur={blur}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {!multiple && (selected[0] ?? '') === '' ? (
        <option value="" disabled>
          {m.forms_choose()}
        </option>
      ) : null}
      {shown.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
