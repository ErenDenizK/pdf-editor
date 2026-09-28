import { describe, expect, it } from 'vitest';

import {
  addFormField,
  addRadioButton,
  clampFieldRect,
  deleteFormFields,
  duplicateFormField,
  fieldsOnPage,
  findFormField,
  formFieldId,
  newFormField,
  nextFieldName,
  removeRadioButton,
  reorderFormFields,
  setFormFieldRect,
  setFormFieldValue,
  stepFormFieldOrder,
  updateFormField,
} from '../fields';
import { createHistory, pushHistory, redo, undo } from '../history';
import { checkWorkspaceInvariants } from '../invariants';
import {
  deletePages,
  duplicatePages,
  insertBlankPage,
  interleave,
  mergeDocuments,
  movePages,
  splitDocument,
} from '../pages';
import { getDocument } from '../selectors';
import { deserializeWorkspace, serializeWorkspace } from '../serialize';
import type { CreatedField, DocumentId, FieldId, PageId, Workspace } from '../types';
import { check, expectCode, must, open, pageTuple } from './fixtures';

const rect = { x: 72, y: 600, width: 160, height: 22 };

function fieldsOf(ws: Workspace, doc: DocumentId): readonly CreatedField[] {
  return getDocument(ws, doc).fields ?? [];
}

function namesOf(ws: Workspace, doc: DocumentId): string[] {
  return fieldsOf(ws, doc).map((f) => f.name);
}

const id = (n: number): FieldId => formFieldId(`f${n}`);

describe('created form fields: operations', () => {
  const { ws, docs } = open(['A', 3], ['B', 2]);
  const [a, b] = docs as [DocumentId, DocumentId];
  const [p1, p2] = pageTuple(ws, a, 3);
  const text = newFormField('text', id(1), 'Text1', [{ page: p1, rect }]);
  const box = newFormField('checkbox', id(2), 'CheckBox1', [
    { page: p1, rect: { x: 72, y: 560, width: 14, height: 14 } },
  ]);

  it('adds fields in tab order and keeps other documents', () => {
    const next = check(addFormField(addFormField(ws, a, text), a, box));
    expect(namesOf(next, a)).toEqual(['Text1', 'CheckBox1']);
    expect(getDocument(next, a).clean).toBe(false);
    expect(getDocument(next, b)).toBe(getDocument(ws, b));
    const first = check(
      addFormField(next, a, newFormField('text', id(3), 'Text2', [{ page: p2, rect }]), 0),
    );
    expect(namesOf(first, a)).toEqual(['Text2', 'Text1', 'CheckBox1']);
    expect(fieldsOnPage(first, p1).map((f) => f.field.name)).toEqual(['Text1', 'CheckBox1']);
    expect(findFormField(first, id(3))?.document).toBe(a);
  });

  it('defaults per kind', () => {
    expect(newFormField('checkbox', id(9), 'c', [{ page: p1, rect }]).value).toBe(false);
    expect(newFormField('dropdown', id(9), 'd', [{ page: p1, rect }]).options?.length).toBe(3);
    expect(newFormField('radio', id(9), 'r', [{ page: p1, rect }]).widgets[0]?.exportValue).toBe(
      'Choice1',
    );
    expect(newFormField('button', id(9), 'b', [{ page: p1, rect }]).label).toBe('Button');
  });

  it('refuses duplicate names, periods, pages of another document and rects outside', () => {
    const one = addFormField(ws, a, text);
    expectCode(() => addFormField(one, a, { ...box, name: 'Text1' }), 'invalid-argument');
    expectCode(() => addFormField(one, a, { ...box, id: id(1) }), 'duplicate-id');
    expectCode(() => addFormField(ws, a, { ...text, name: 'a.b' }), 'invalid-argument');
    expectCode(() => addFormField(ws, a, { ...text, name: '  ' }), 'invalid-argument');
    const bPage = pageTuple(ws, b, 2)[0];
    expectCode(
      () => addFormField(ws, a, { ...text, widgets: [{ page: bPage, rect }] }),
      'invalid-argument',
    );
    expectCode(
      () =>
        addFormField(ws, a, { ...text, widgets: [{ page: p1, rect: { ...rect, width: 900 } }] }),
      'invalid-argument',
    );
    // Same name in another document is fine.
    expect(
      namesOf(
        check(
          addFormField(one, b, {
            ...text,
            id: id(5),
            widgets: [{ page: pageTuple(ws, b, 2)[0], rect }],
          }),
        ),
        b,
      ),
    ).toEqual(['Text1']);
  });

  it('choice fields need options; radio groups need buttons with distinct values', () => {
    const drop = newFormField('dropdown', id(4), 'Dropdown1', [{ page: p1, rect }]);
    expectCode(() => addFormField(ws, a, { ...drop, options: [] }), 'invalid-argument');
    expectCode(() => addFormField(ws, a, { ...drop, options: ['x', 'x'] }), 'invalid-argument');
    const radio = newFormField('radio', id(5), 'Radio', [{ page: p1, rect }]);
    expectCode(() => addFormField(ws, a, { ...radio, widgets: [] }), 'invalid-argument');
    expectCode(
      () =>
        addFormField(ws, a, {
          ...radio,
          widgets: [
            { page: p1, rect, exportValue: 'x' },
            { page: p1, rect, exportValue: 'x' },
          ],
        }),
      'invalid-argument',
    );
    expectCode(
      () =>
        addFormField(ws, a, {
          ...text,
          widgets: [
            { page: p1, rect },
            { page: p2, rect },
          ],
        }),
      'invalid-argument',
    );
  });

  it('updates properties, renames, and normalizes values', () => {
    const drop = newFormField('dropdown', id(4), 'Dropdown1', [{ page: p1, rect }], {
      value: 'Option 2',
      defaultValue: 'Option 1',
    });
    let next = check(addFormField(ws, a, drop));
    next = check(updateFormField(next, a, id(4), { name: 'Country', options: ['Option 1', 'X'] }));
    const field = must(fieldsOf(next, a)[0]);
    expect(field.name).toBe('Country');
    expect(field.value).toBeUndefined();
    expect(field.defaultValue).toBe('Option 1');
    expect(updateFormField(next, a, id(4), { name: 'Country' })).toBe(next);
    expectCode(() => updateFormField(next, a, id(4), { name: 'a.b' }), 'invalid-argument');
    expectCode(() => updateFormField(next, a, id(99), { name: 'x' }), 'invalid-argument');

    let t = check(addFormField(ws, a, { ...text, value: 'Hello world' }));
    t = check(updateFormField(t, a, id(1), { maxLength: 5, comb: true }));
    expect(must(fieldsOf(t, a)[0]).value).toBe('Hello');
    t = check(updateFormField(t, a, id(1), { maxLength: undefined, comb: undefined }));
    expect(must(fieldsOf(t, a)[0]).maxLength).toBeUndefined();
    expectCode(() => updateFormField(t, a, id(1), { comb: true }), 'invalid-argument');

    const list = newFormField('listbox', id(6), 'ListBox1', [{ page: p1, rect }], {
      multiSelect: true,
      value: ['Option 1', 'Option 3'],
    });
    let l = check(addFormField(ws, a, list));
    l = check(updateFormField(l, a, id(6), { multiSelect: undefined }));
    expect(must(fieldsOf(l, a)[0]).value).toBe('Option 1');
  });

  it('fills values, validating them per kind', () => {
    let next = check(addFormField(addFormField(ws, a, text), a, box));
    next = check(setFormFieldValue(next, a, id(1), 'Alice'));
    next = check(setFormFieldValue(next, a, id(2), true));
    expect(fieldsOf(next, a).map((f) => f.value)).toEqual(['Alice', true]);
    expectCode(() => setFormFieldValue(next, a, id(2), 'yes'), 'invalid-argument');
    expectCode(() => setFormFieldValue(next, a, id(1), true), 'invalid-argument');
    next = check(setFormFieldValue(next, a, id(1), undefined));
    expect(must(fieldsOf(next, a)[0]).value).toBeUndefined();
    const sig = newFormField('signature', id(7), 'Signature1', [{ page: p1, rect }]);
    expectCode(
      () => setFormFieldValue(addFormField(ws, a, sig), a, id(7), 'x'),
      'invalid-argument',
    );
  });

  it('moves and resizes widgets inside the page', () => {
    const one = addFormField(ws, a, text);
    const moved = check(setFormFieldRect(one, a, id(1), { ...rect, x: 10, width: 50 }));
    expect(must(fieldsOf(moved, a)[0]).widgets[0]?.rect).toEqual({ ...rect, x: 10, width: 50 });
    expect(setFormFieldRect(one, a, id(1), rect)).toBe(one);
    expectCode(() => setFormFieldRect(one, a, id(1), { ...rect, width: -1 }), 'invalid-argument');
    expectCode(() => setFormFieldRect(one, a, id(1), rect, 3), 'invalid-index');
  });

  it('deletes, duplicates with the next copy name, and reorders the tab order', () => {
    let next = check(addFormField(addFormField(ws, a, text), a, box));
    next = check(duplicateFormField(next, a, id(1), id(3), { dx: 0, dy: -30 }));
    expect(namesOf(next, a)).toEqual(['Text1', 'Text1_2', 'CheckBox1']);
    expect(must(fieldsOf(next, a)[1]).widgets[0]?.rect.y).toBe(570);
    next = check(duplicateFormField(next, a, id(3), id(4)));
    expect(namesOf(next, a)).toEqual(['Text1', 'Text1_2', 'Text1_3', 'CheckBox1']);
    next = check(reorderFormFields(next, a, [id(2), id(1), id(3), id(4)]));
    expect(namesOf(next, a)).toEqual(['CheckBox1', 'Text1', 'Text1_2', 'Text1_3']);
    expectCode(() => reorderFormFields(next, a, [id(1)]), 'invalid-argument');
    next = check(stepFormFieldOrder(next, a, id(1), -1));
    expect(namesOf(next, a)).toEqual(['Text1', 'CheckBox1', 'Text1_2', 'Text1_3']);
    expect(stepFormFieldOrder(next, a, id(1), -1)).toBe(next);
    next = check(deleteFormFields(next, a, [id(3), id(4)]));
    expect(namesOf(next, a)).toEqual(['Text1', 'CheckBox1']);
    next = check(deleteFormFields(next, a, [id(1), id(2)]));
    expect(getDocument(next, a).fields).toBeUndefined();
  });

  it('radio groups gain and lose buttons, keeping at least one', () => {
    const radio = newFormField('radio', id(5), 'RadioGroup1', [{ page: p1, rect }]);
    let next = check(addFormField(ws, a, radio));
    next = check(addRadioButton(next, a, id(5), { page: p2, rect }));
    next = check(setFormFieldValue(next, a, id(5), 'Choice2'));
    expect(must(fieldsOf(next, a)[0]).widgets.map((w) => w.exportValue)).toEqual([
      'Choice1',
      'Choice2',
    ]);
    next = check(removeRadioButton(next, a, id(5), 1));
    // The value named the removed button.
    expect(must(fieldsOf(next, a)[0]).value).toBeUndefined();
    expectCode(() => removeRadioButton(next, a, id(5), 0), 'invalid-argument');
    expectCode(
      () => addRadioButton(addFormField(ws, a, text), a, id(1), { page: p1, rect }),
      'invalid-argument',
    );
  });

  it('every operation is undone and redone through history', () => {
    let h = createHistory(ws);
    const steps: [string, (w: Workspace) => Workspace][] = [
      ['add', (w) => addFormField(w, a, text)],
      ['fill', (w) => setFormFieldValue(w, a, id(1), 'x')],
      ['move', (w) => setFormFieldRect(w, a, id(1), { ...rect, x: 0 })],
      ['rename', (w) => updateFormField(w, a, id(1), { name: 'First' })],
      ['duplicate', (w) => duplicateFormField(w, a, id(1), id(2))],
      ['reorder', (w) => reorderFormFields(w, a, [id(2), id(1)])],
      ['delete', (w) => deleteFormFields(w, a, [id(1)])],
    ];
    const states = [ws];
    for (const [label, op] of steps) {
      const next = check(op(h.present.workspace));
      h = pushHistory(h, next, label, { now: states.length * 10_000 });
      states.push(next);
    }
    for (let i = states.length - 2; i >= 0; i--) {
      h = undo(h);
      expect(h.present.workspace).toBe(states[i]);
    }
    for (let i = 1; i < states.length; i++) {
      h = redo(h);
      expect(h.present.workspace).toBe(states[i]);
    }
  });

  it('names automatic fields "Text1", "Text2", … skipping taken names', () => {
    expect(nextFieldName('text', [])).toBe('Text1');
    expect(nextFieldName('text', ['Text1', 'Text3'])).toBe('Text2');
    expect(nextFieldName('checkbox', ['Text1'])).toBe('CheckBox1');
  });

  it('clamps rects into bounds', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    expect(clampFieldRect({ x: 90, y: -5, width: 20, height: 10 }, bounds)).toEqual({
      x: 80,
      y: 0,
      width: 20,
      height: 10,
    });
    expect(clampFieldRect({ x: 0, y: 0, width: 500, height: 1 }, bounds).width).toBe(100);
  });
});

describe('created form fields and page operations', () => {
  function setup() {
    const { ws, docs, ids } = open(['A', 3], ['B', 2]);
    const [a, b] = docs as [DocumentId, DocumentId];
    const pa = pageTuple(ws, a, 3);
    const pb = pageTuple(ws, b, 2);
    let next = addFormField(ws, a, newFormField('text', id(1), 'Name', [{ page: pa[0], rect }]));
    next = addFormField(next, a, newFormField('text', id(2), 'Other', [{ page: pa[1], rect }]));
    next = addFormField(
      next,
      a,
      newFormField('radio', id(3), 'Pick', [
        { page: pa[1], rect },
        { page: pa[2], rect },
      ]),
    );
    next = addFormField(next, b, newFormField('text', id(4), 'Name', [{ page: pb[0], rect }]));
    return { ws: check(next), a, b, pa, pb, ids };
  }

  it('deleting a page removes its fields and radio buttons; undo restores them', () => {
    const { ws, a, pa } = setup();
    const next = check(deletePages(ws, [pa[1]]));
    expect(namesOf(next, a)).toEqual(['Name', 'Pick']);
    expect(must(fieldsOf(next, a)[1]).widgets.map((w) => w.page)).toEqual([pa[2]]);
    let h = pushHistory(createHistory(ws), next, 'Delete', { now: 1 });
    h = undo(h);
    expect(namesOf(h.present.workspace, a)).toEqual(['Name', 'Other', 'Pick']);
    const all = check(deletePages(ws, [...pa]));
    expect(getDocument(all, a).fields).toBeUndefined();
  });

  it('moving pages within a document keeps fields; across documents they follow', () => {
    const { ws, a, b, pa } = setup();
    const within = check(movePages(ws, { pageIds: [pa[0]], target: { document: a, index: 3 } }));
    expect(namesOf(within, a)).toEqual(['Name', 'Other', 'Pick']);
    const across = check(movePages(ws, { pageIds: [pa[0]], target: { document: b, index: 0 } }));
    expect(namesOf(across, a)).toEqual(['Other', 'Pick']);
    // "Name" is taken in b: the arriving field gets the next copy name.
    expect(namesOf(across, b)).toEqual(['Name', 'Name_2']);
    // A radio group split by the move keeps the buttons that stay.
    const split = check(movePages(ws, { pageIds: [pa[2]], target: { document: b, index: 0 } }));
    expect(must(fieldsOf(split, a).find((f) => f.name === 'Pick')).widgets.length).toBe(1);
  });

  it('merge, interleave and split carry fields with their pages', () => {
    const { ws, a, b, ids } = setup();
    const merged = check(mergeDocuments(ws, { documentIds: [a, b], title: 'M' }, ids));
    const m = must(merged.activeDocument);
    expect(namesOf(merged, m)).toEqual(['Name', 'Other', 'Pick', 'Name_2']);
    const mixed = check(interleave(ws, { a, b, mode: 'alternate' }, ids));
    expect(namesOf(mixed, must(mixed.activeDocument))).toEqual(['Name', 'Other', 'Pick', 'Name_2']);
    const parts = check(splitDocument(ws, a, { mode: 'every', n: 1 }, ids));
    const partNames = parts.documentOrder.filter((d) => d !== b).map((d) => namesOf(parts, d));
    // A radio group split across parts stays with its first button's part.
    expect(partNames).toEqual([['Name'], ['Other', 'Pick'], []]);
  });

  it('duplicated pages carry no fields; inserted pages keep fields', () => {
    const { ws, a, pa, ids } = setup();
    const dup = check(duplicatePages(ws, [pa[0]], ids));
    expect(namesOf(dup, a)).toEqual(['Name', 'Other', 'Pick']);
    const blank = check(insertBlankPage(ws, { document: a, index: 0 }, ids));
    expect(namesOf(blank, a)).toEqual(['Name', 'Other', 'Pick']);
  });

  it('fields on blank pages must lie inside the page', () => {
    const { ws, a, ids } = setup();
    const withBlank = insertBlankPage(
      ws,
      { document: a, index: 3, size: { width: 200, height: 200 } },
      ids,
    );
    const blankId = must(getDocument(withBlank, a).pages[3]).id;
    const ok = newFormField('checkbox', id(8), 'Box', [
      { page: blankId, rect: { x: 10, y: 10, width: 14, height: 14 } },
    ]);
    check(addFormField(withBlank, a, ok));
    expectCode(
      () =>
        addFormField(withBlank, a, {
          ...ok,
          widgets: [{ page: blankId, rect: { x: 190, y: 10, width: 14, height: 14 } }],
        }),
      'invalid-argument',
    );
  });
});

describe('created form fields: invariants and serialization', () => {
  const { ws, docs } = open(['A', 2]);
  const a = docs[0] as DocumentId;
  const [p1, p2] = pageTuple(ws, a, 2);
  const every: CreatedField[] = [
    newFormField('text', id(1), 'Text1', [{ page: p1, rect }], {
      multiline: true,
      maxLength: 40,
      value: 'hi',
      defaultValue: '',
      tooltip: 'Your name',
      fontSize: 11,
      align: 'center',
      required: true,
    }),
    newFormField('checkbox', id(2), 'CheckBox1', [{ page: p1, rect }], { value: true }),
    newFormField(
      'radio',
      id(3),
      'RadioGroup1',
      [
        { page: p1, rect },
        { page: p2, rect, exportValue: 'B' },
      ],
      { value: 'B' },
    ),
    newFormField('dropdown', id(4), 'Dropdown1', [{ page: p1, rect }], {
      editable: true,
      value: 'Free',
    }),
    newFormField('listbox', id(5), 'ListBox1', [{ page: p2, rect }], {
      multiSelect: true,
      value: ['Option 2'],
    }),
    newFormField('signature', id(6), 'Signature1', [{ page: p2, rect }], { readOnly: true }),
    newFormField('button', id(7), 'Button1', [{ page: p2, rect }], {
      label: 'Submit',
      border: 'black',
      background: 'light-blue',
    }),
  ];
  const full = every.reduce((w, f) => addFormField(w, a, f), ws);

  it('round-trips every kind through JSON', () => {
    const restored = deserializeWorkspace(JSON.stringify(serializeWorkspace(check(full))));
    expect(getDocument(restored, a).fields).toEqual(getDocument(full, a).fields);
  });

  it('reports broken fields on load', () => {
    const json = serializeWorkspace(full) as unknown as {
      documents: { fields: Record<string, unknown>[] }[];
    };
    const broken = JSON.parse(JSON.stringify(json)) as typeof json;
    const fields = must(broken.documents[0]).fields;
    must(fields[1]).name = 'Text1';
    expectCode(() => deserializeWorkspace(broken), 'invalid-serialized');
    const badKind = JSON.parse(JSON.stringify(json)) as typeof json;
    must(must(badKind.documents[0]).fields[0]).kind = 'slider';
    expectCode(() => deserializeWorkspace(badKind), 'invalid-serialized');
  });

  it('invariants catch duplicate names, dangling pages, empty options and empty radio groups', () => {
    const doc = getDocument(full, a);
    const tamper = (fields: CreatedField[]): string[] =>
      checkWorkspaceInvariants({
        ...full,
        documents: { ...full.documents, [a]: { ...doc, fields } },
      });
    expect(tamper([...every])).toEqual([]);
    expect(tamper([...every, { ...must(every[0]), id: id(9) }]).join()).toMatch(/used twice/);
    expect(
      tamper([{ ...must(every[0]), widgets: [{ page: 'nope' as PageId, rect }] }]).join(),
    ).toMatch(/not in document/);
    expect(tamper([{ ...must(every[3]), options: [] }]).join()).toMatch(/at least one option/);
    expect(tamper([{ ...must(every[2]), widgets: [] }]).join()).toMatch(/no widget/);
  });
});
