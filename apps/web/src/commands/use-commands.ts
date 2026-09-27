import { useSyncExternalStore } from 'react';

import { type Command, type CommandRegistry, commandRegistry } from './registry';

/** Subscribes a component to the list of registered commands. */
export function useCommands(registry: CommandRegistry = commandRegistry): readonly Command[] {
  return useSyncExternalStore(registry.subscribe, () => registry.list());
}

/** A single command by id, or undefined while it is not registered. */
export function useCommand(
  id: string,
  registry: CommandRegistry = commandRegistry,
): Command | undefined {
  const commands = useCommands(registry);
  return commands.find((command) => command.id === id);
}
