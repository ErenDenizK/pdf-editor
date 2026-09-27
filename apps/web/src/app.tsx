import { useLayoutEffect } from 'react';

import { registerAppCommands } from './commands/app-commands';
import { getEngineService } from './engine/engine-service';
import { AppShell } from './shell/AppShell';
import { requestPassword } from './state/password-store';

/**
 * Application root. Registers the shell's commands before first paint (so keycap hints
 * render immediately), connects the engine's password prompt, and mounts the shell.
 */
export function App() {
  useLayoutEffect(() => registerAppCommands(), []);
  useLayoutEffect(() => {
    const engine = getEngineService();
    engine.setPasswordPrompt(requestPassword);
    return () => engine.setPasswordPrompt(undefined);
  }, []);
  return <AppShell />;
}
