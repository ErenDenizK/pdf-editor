import { describe, expect, it, vi } from 'vitest';

import { CommandRegistry, groupCommands } from './registry';
import { dispatchShortcut, isEditableTarget } from './use-shortcuts';

function keydown(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('CommandRegistry', () => {
  it('registers, lists, and unregisters commands', () => {
    const registry = new CommandRegistry();
    const dispose = registry.register({ id: 'a', title: 'A', group: 'G', run: () => undefined });
    expect(registry.list().map((c) => c.id)).toEqual(['a']);
    expect(registry.get('a')?.shortcuts).toEqual([]);
    dispose();
    expect(registry.list()).toEqual([]);
  });

  it('rejects duplicate ids and invalid shortcuts', () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'a', title: 'A', group: 'G', run: () => undefined });
    expect(() =>
      registry.register({ id: 'a', title: 'A', group: 'G', run: () => undefined }),
    ).toThrow(/already registered/);
    expect(() =>
      registry.register({
        id: 'b',
        title: 'B',
        group: 'G',
        shortcut: 'Mod+',
        run: () => undefined,
      }),
    ).toThrow();
  });

  it('keeps list() stable between mutations and notifies subscribers', () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const first = registry.list();
    expect(registry.list()).toBe(first);
    registry.register({ id: 'a', title: 'A', group: 'G', run: () => undefined });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.list()).not.toBe(first);
  });

  it('does not let a stale disposer remove a re-registered command', () => {
    const registry = new CommandRegistry();
    const disposeOld = registry.register({ id: 'a', title: 'A', group: 'G', run: () => undefined });
    disposeOld();
    registry.register({ id: 'a', title: 'A2', group: 'G', run: () => undefined });
    disposeOld();
    expect(registry.get('a')?.title).toBe('A2');
  });

  it('executes only enabled commands', async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    let enabled = false;
    registry.register({ id: 'a', title: 'A', group: 'G', run, when: () => enabled });
    expect(await registry.execute('a')).toBe(false);
    enabled = true;
    expect(await registry.execute('a')).toBe(true);
    expect(await registry.execute('missing')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing predicate as disabled', () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'a',
      title: 'A',
      group: 'G',
      run: () => undefined,
      when: () => {
        throw new Error('boom');
      },
    });
    const command = registry.get('a');
    expect(command && registry.isEnabled(command)).toBe(false);
  });
});

describe('groupCommands', () => {
  it('groups in order of first appearance', () => {
    const grouped = groupCommands([
      { id: '1', group: 'View' },
      { id: '2', group: 'File' },
      { id: '3', group: 'View' },
    ]);
    expect(grouped.map((g) => [g.group, g.items.map((i) => i.id)])).toEqual([
      ['View', ['1', '3']],
      ['File', ['2']],
    ]);
  });
});

describe('dispatchShortcut', () => {
  function setup() {
    const registry = new CommandRegistry();
    const palette = vi.fn();
    const read = vi.fn();
    registry.register({
      id: 'palette',
      title: 'Palette',
      group: 'G',
      shortcut: 'Mod+K',
      allowInInputs: true,
      run: palette,
    });
    registry.register({ id: 'read', title: 'Read', group: 'G', shortcut: '1', run: read });
    return { registry, palette, read };
  }

  it('runs the matching command and prevents the default action', () => {
    const { registry, palette } = setup();
    const event = keydown({ key: 'k', ctrlKey: true });
    expect(dispatchShortcut(event, registry, 'other')).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(palette).toHaveBeenCalledOnce();
  });

  it('ignores plain keys in text fields unless the command opts in', () => {
    const { registry, palette, read } = setup();
    const input = document.createElement('input');
    expect(dispatchShortcut(keydown({ key: '1' }, input), registry, 'other')).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(dispatchShortcut(keydown({ key: 'k', ctrlKey: true }, input), registry, 'other')).toBe(
      true,
    );
    expect(palette).toHaveBeenCalledOnce();
  });

  it('ignores keys inside modal dialogs unless the command opts in', () => {
    const { registry, read } = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    dialog.append(button);
    expect(dispatchShortcut(keydown({ key: '1' }, button), registry, 'other')).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips events already handled or composing', () => {
    const { registry, read } = setup();
    const handled = keydown({ key: '1' });
    handled.preventDefault();
    expect(dispatchShortcut(handled, registry, 'other')).toBe(false);
    expect(dispatchShortcut(keydown({ key: '1', isComposing: true }), registry, 'other')).toBe(
      false,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('classifies editable targets', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    document.body.append(editable);
    expect(isEditableTarget(text)).toBe(true);
    expect(isEditableTarget(checkbox)).toBe(false);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
    editable.remove();
  });
});
