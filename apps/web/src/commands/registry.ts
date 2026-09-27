/**
 * The command registry. Every user-facing action is a command: it appears in the command
 * palette and the shortcut overlay, and may be bound to a shortcut (DESIGN.md §4.1).
 */
import { type ParsedShortcut, parseShortcut } from './shortcuts';

export interface CommandDefinition {
  /** Stable, namespaced id, e.g. `file.open`. */
  readonly id: string;
  readonly title: string;
  /** Palette and overlay group heading, e.g. `File`, `View`. */
  readonly group: string;
  /** One shortcut, or several; the first is the one displayed. */
  readonly shortcut?: string | readonly string[];
  /** Extra search terms for the palette. */
  readonly keywords?: readonly string[];
  /** Short note shown in the shortcut overlay, e.g. browser caveats. */
  readonly note?: string;
  /**
   * Let the shortcut fire while focus is in a text field or inside a modal dialog. Off by
   * default so typing "1" in the palette never switches the view mode.
   */
  readonly allowInInputs?: boolean;
  /** Keep the command in the overlay but out of the palette (e.g. "Toggle palette"). */
  readonly hiddenInPalette?: boolean;
  readonly run: () => void | Promise<void>;
  /** Availability predicate; unavailable commands do not run and are dimmed in lists. */
  readonly when?: () => boolean;
}

export interface Command extends CommandDefinition {
  readonly shortcuts: readonly ParsedShortcut[];
}

type Listener = () => void;

export class CommandRegistry {
  private readonly byId = new Map<string, Command>();
  private readonly listeners = new Set<Listener>();
  private snapshot: readonly Command[] = [];

  register(definition: CommandDefinition): () => void {
    if (this.byId.has(definition.id)) {
      throw new Error(`Command "${definition.id}" is already registered`);
    }
    const raw = definition.shortcut;
    const list: readonly string[] = raw === undefined ? [] : typeof raw === 'string' ? [raw] : raw;
    const command: Command = { ...definition, shortcuts: list.map(parseShortcut) };
    this.byId.set(command.id, command);
    this.emit();
    return () => {
      if (this.byId.get(command.id) === command) {
        this.byId.delete(command.id);
        this.emit();
      }
    };
  }

  get(id: string): Command | undefined {
    return this.byId.get(id);
  }

  /** Commands in registration order. The array identity changes only on mutation. */
  list(): readonly Command[] {
    return this.snapshot;
  }

  isEnabled(command: Command): boolean {
    try {
      return command.when ? command.when() : true;
    } catch {
      return false;
    }
  }

  /** Runs a command if it exists and is enabled. Resolves to whether it ran. */
  async execute(id: string): Promise<boolean> {
    const command = this.byId.get(id);
    if (!command || !this.isEnabled(command)) return false;
    await command.run();
    return true;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.snapshot = [...this.byId.values()];
    for (const listener of this.listeners) listener();
  }
}

/** Groups commands preserving the order in which groups first appear. */
export function groupCommands<T extends { group: string }>(
  commands: readonly T[],
): { group: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const command of commands) {
    const items = groups.get(command.group);
    if (items) items.push(command);
    else groups.set(command.group, [command]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

/** The application-wide registry. */
export const commandRegistry = new CommandRegistry();

export function registerCommand(definition: CommandDefinition): () => void {
  return commandRegistry.register(definition);
}
