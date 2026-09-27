import { useLayoutEffect } from 'react';

import { registerAppCommands } from './commands/app-commands';
import { getEngineService } from './engine/engine-service';
import { ExportDialog } from './export/ExportDialog';
import { useLocale } from './i18n';
import { LocaleBoundary } from './i18n/LocaleBoundary';
import { UpdateToast } from './pwa/UpdateToast';
import { AppShell } from './shell/AppShell';
import { registerArrangeCommands } from './stage/arrange-commands';
import { requestPassword } from './state/password-store';

/**
 * Application root. Registers the shell's commands before first paint (so keycap hints
 * render immediately), connects the engine's password prompt, and mounts the shell.
 * A language switch re-registers the commands (their titles are translated) and remounts
 * the shell through `LocaleBoundary`.
 */
export function App() {
  const locale = useLocale();
  useLayoutEffect(() => registerAppCommands(), [locale]);
  useLayoutEffect(() => registerArrangeCommands(), [locale]);
  useLayoutEffect(() => {
    const engine = getEngineService();
    engine.setPasswordPrompt(requestPassword);
    return () => engine.setPasswordPrompt(undefined);
  }, []);
  return (
    <LocaleBoundary>
      <AppShell />
      <ExportDialog />
      <UpdateToast />
    </LocaleBoundary>
  );
}
