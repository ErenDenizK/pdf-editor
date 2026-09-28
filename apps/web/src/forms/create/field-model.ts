/**
 * Created form fields (document-model fields.ts) as the forms UI sees them: the engine's
 * `FormField` shape, so the Forms panel, Tab navigation and the in-place editors treat
 * created and source fields alike.
 */
import type { CreatedField, CreatedFieldKind, CreatedFieldValue } from '@pdf-editor/document-model';
import type { FormField, FormFieldKind } from '@pdf-editor/engine';

/** The engine kind a created field shows as (and is listed as after export). */
export const UI_KIND: Readonly<Record<CreatedFieldKind, FormFieldKind>> = {
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radio',
  dropdown: 'combobox',
  listbox: 'listbox',
  signature: 'signature',
  button: 'button',
};

/**
 * A created field as a `FormField`. `pageIndex` is the document position of its first
 * widget's page (created fields have no source page); widgets carry the same.
 */
export function asFormField(field: CreatedField, position: number): FormField {
  const first = field.widgets[0];
  const rect = first?.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const radio = field.kind === 'radio';
  const exportValues = radio ? field.widgets.map((w) => w.exportValue ?? '') : undefined;
  return {
    name: field.name,
    kind: UI_KIND[field.kind],
    pageIndex: position,
    rect,
    ...(field.value === undefined ? {} : { value: field.value }),
    ...(radio && exportValues ? { options: exportValues, exportValues } : {}),
    ...(field.options ? { options: field.options, exportValues: field.options } : {}),
    ...(field.kind === 'checkbox' ? { exportValues: ['Yes'] } : {}),
    readOnly: field.readOnly,
    required: field.required,
    ...(field.tooltip ? { tooltip: field.tooltip } : {}),
    ...(field.multiline ? { multiline: true } : {}),
    ...(field.comb ? { comb: true } : {}),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    ...(field.multiSelect ? { multiSelect: true } : {}),
    ...(field.editable ? { editable: true } : {}),
    widgets: field.widgets.map((w) => ({
      pageIndex: position,
      rect: w.rect,
      ...(w.exportValue === undefined ? {} : { exportValue: w.exportValue }),
    })),
  };
}

/** An editor value (engine `FormField['value']`) as the created field's model value. */
export function toCreatedValue(
  field: CreatedField,
  value: FormField['value'],
): CreatedFieldValue | undefined {
  if (value === undefined) return undefined;
  switch (field.kind) {
    case 'checkbox':
      return value === true || value === 'Yes';
    case 'listbox':
      if (field.multiSelect)
        return typeof value === 'object' ? value : value === '' ? [] : [String(value)];
      return typeof value === 'object' ? (value[0] ?? '') : String(value);
    case 'text':
    case 'dropdown':
      return typeof value === 'object' ? value.join('') : String(value);
    case 'radio':
      return typeof value === 'string' && value !== '' ? value : undefined;
    default:
      return undefined;
  }
}
