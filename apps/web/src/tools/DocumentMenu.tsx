/**
 * The tab bar's Document menu (spec: "every tool is an action on the open document,
 * reachable from the command palette and a Document menu"). It lists every registered
 * command of the "Document" group, so tools registered elsewhere join it automatically,
 * and hosts the tool dialogs and the Batch dialog, which load lazily (their code, the
 * compress worker and the wasm stay out of the entry chunk).
 */
import { Menu } from '@base-ui/react/menu';
import { FileCog } from 'lucide-react';
import { lazy, Suspense, useSyncExternalStore } from 'react';

import { BatchDialogHost } from '../batch/BatchDialogHost';
import { commandRegistry } from '../commands/registry';
import { m } from '../i18n';
import menuStyles from '../ui/Menu.module.css';
import iconStyles from '../ui/IconButton.module.css';
import { useToolsStore } from './tools-store';

const CompressDialog = lazy(() => import('./CompressDialog'));
const ImageExportDialog = lazy(() => import('./ImageExportDialog'));
const ConvertDialog = lazy(() => import('../convert/ConvertDialog'));

const subscribe = (listener: () => void) => commandRegistry.subscribe(listener);
const snapshot = () => commandRegistry.list();

export function DocumentMenu({ visible }: { readonly visible: boolean }) {
  const commands = useSyncExternalStore(subscribe, snapshot);
  const group = m.group_document();
  const items = commands.filter((c) => c.group === group);
  return (
    <>
      {visible && items.length > 0 ? (
        <Menu.Root>
          <Menu.Trigger
            className={iconStyles.button}
            aria-label={m.tools_menu_label()}
            title={m.tools_menu_label()}
            data-testid="document-menu"
          >
            <FileCog aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end" collisionPadding={8}>
              <Menu.Popup className={menuStyles.popup} aria-label={m.tools_menu()}>
                {items.map((command) => (
                  <Menu.Item
                    key={command.id}
                    className={menuStyles.item}
                    disabled={!commandRegistry.isEnabled(command)}
                    onClick={() => void commandRegistry.execute(command.id)}
                  >
                    <span className={menuStyles.label}>{command.title}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
      <ToolDialogs />
      <BatchDialogHost />
    </>
  );
}

function ToolDialogs() {
  const dialog = useToolsStore((s) => s.dialog);
  if (dialog === null) return null;
  return (
    <Suspense fallback={null}>
      {dialog.kind === 'compress' ? (
        <CompressDialog key={dialog.documentId} documentId={dialog.documentId} />
      ) : dialog.kind === 'markdown' ? (
        <ConvertDialog key={dialog.documentId} documentId={dialog.documentId} />
      ) : (
        <ImageExportDialog key={dialog.documentId} documentId={dialog.documentId} />
      )}
    </Suspense>
  );
}
