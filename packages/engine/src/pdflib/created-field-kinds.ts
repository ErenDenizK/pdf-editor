/**
 * How a form field created in the app (document-model `CreatedFieldKind`) is listed by the
 * engine when the output is re-opened. Pure data, shared by the assembler and the export
 * plan (which must not pull pdf-lib in).
 */
import type { CreatedFieldKind } from '@pdf-editor/document-model';

import type { FormFieldKind } from '../types';

export const ENGINE_KIND: Readonly<Record<CreatedFieldKind, FormFieldKind>> = {
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radio',
  dropdown: 'combobox',
  listbox: 'listbox',
  signature: 'signature',
  button: 'button',
};
