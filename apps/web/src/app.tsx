import { useLayoutEffect } from 'react';

import { registerAppCommands } from './commands/app-commands';
import { AppShell } from './shell/AppShell';

/**
 * Application root. Registers the shell's commands before first paint (so keycap hints
 * render immediately) and mounts the shell.
 */
export function App() {
  useLayoutEffect(() => registerAppCommands(), []);
  return <AppShell />;
}
