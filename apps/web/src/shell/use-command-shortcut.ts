import { useCommand } from '../commands/use-commands';
import type { ParsedShortcut } from '../commands/shortcuts';

/** The primary shortcut of a registered command, for tooltips and hints. */
export function useCommandShortcut(id: string): ParsedShortcut | undefined {
  return useCommand(id)?.shortcuts[0];
}
