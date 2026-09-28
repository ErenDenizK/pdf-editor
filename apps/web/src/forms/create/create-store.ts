/**
 * UI state of field creation (spec redaction-and-text-editing §3): the kind being placed
 * ("Add field" in the Forms panel, then a click or drag on a page), "Edit fields" (design
 * mode: created fields select, move and resize instead of filling), the selected created
 * widget and its properties popover.
 */
import type { CreatedFieldKind, FieldId } from '@pdf-editor/document-model';
import { create } from 'zustand';

export interface SelectedField {
  readonly fieldId: FieldId;
  /** Index into the field's widgets (radio buttons). */
  readonly widget: number;
}

interface CreateState {
  readonly placing: CreatedFieldKind | null;
  readonly design: boolean;
  readonly selected: SelectedField | null;
  readonly propertiesOpen: boolean;
  setPlacing: (kind: CreatedFieldKind | null) => void;
  setDesign: (on: boolean) => void;
  select: (selected: SelectedField | null) => void;
  setPropertiesOpen: (open: boolean) => void;
}

export const useCreateStore = create<CreateState>()((set) => ({
  placing: null,
  design: false,
  selected: null,
  propertiesOpen: false,
  setPlacing: (placing) => set({ placing }),
  setDesign: (design) =>
    set(design ? { design } : { design, selected: null, propertiesOpen: false }),
  select: (selected) => set(selected === null ? { selected, propertiesOpen: false } : { selected }),
  setPropertiesOpen: (propertiesOpen) => set({ propertiesOpen }),
}));

/** Tests: back to the initial state. */
export function resetCreateStore(): void {
  useCreateStore.setState({ placing: null, design: false, selected: null, propertiesOpen: false });
}
