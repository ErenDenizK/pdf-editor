/**
 * The tab bar's Document menu (experience-redesign spec §5.3): "Document" with its icon,
 * sections with headings, and no disabled twins: a "Remove …" item appears only when there
 * is something to remove. Combine and split (Merge files…, Split…, Compare with…, Rotate
 * pages) opens the existing dialogs and views. Commands of the "Document" group that no
 * section names join the last section, so tools registered elsewhere still appear; "About
 * this app" (`help.aboutPage`, presentation spec §3) closes that section. Just before it, an
 * "Appearance" submenu holds the app's appearance settings as checkbox items, "Glass
 * panels" and "Reduce transparency" (craft spec §7; also palette commands,
 * shell/appearance-commands.ts), and "Pen draws in Edit" (craft spec §3.5; palette command
 * in viewer/edit-policy.ts); one row, so the menu stays within an 800 px window.
 *
 * It also hosts the tool dialogs, the Batch dialog and the OCR dialog, which load lazily
 * (their code, the compress worker and the wasm stay out of the entry chunk).
 */
import { Menu } from '@base-ui/react/menu';
import { getActiveDocument, type PageId } from '@pdf-editor/document-model';
import { ChevronRight, FileCog } from 'lucide-react';
import { Fragment, lazy, Suspense, useSyncExternalStore } from 'react';

import { BatchDialogHost } from '../batch/BatchDialogHost';
import { openDocuments } from '../commands/app-commands';
import { type Command, commandRegistry } from '../commands/registry';
import { pickFiles } from '../files/open-files';
import { m } from '../i18n';
import { OcrDialogHost } from '../ocr';
import { announce } from '../shell/announcer';
import { setGlassPanels, setReduceTransparency } from '../shell/appearance-commands';
import { useAppearanceStore } from '../state/appearance-store';
import { setPenDrawsInEdit, usePenDrawsInEdit } from '../viewer/edit-policy';
import { useSelectionStore } from '../state/selection-store';
import { useWorkspaceStore } from '../state/workspace-store';
import menuStyles from '../ui/Menu.module.css';
import styles from './DocumentMenu.module.css';
import { useToolsStore } from './tools-store';

const CompressDialog = lazy(() => import('./CompressDialog'));
const ImageExportDialog = lazy(() => import('./ImageExportDialog'));
const ConvertDialog = lazy(() => import('../convert/ConvertDialog'));

const subscribe = (listener: () => void) => commandRegistry.subscribe(listener);
const snapshot = () => commandRegistry.list();

/** One menu entry: a registered command, or one of the menu's own actions. */
export type DocumentMenuEntry =
  | {
      readonly kind: 'command';
      readonly id: string;
      /** The menu's name for it, when shorter than the command's title ("Split…"). */
      readonly label?: () => string;
      /** Hidden, not disabled, while unavailable ("Remove …" when there is nothing). */
      readonly onlyWhenAvailable?: true;
    }
  | { readonly kind: 'merge' }
  | { readonly kind: 'rotate' };

export interface DocumentMenuSection {
  readonly id: 'combine' | 'add' | 'protect' | 'convert' | 'document';
  readonly label: () => string;
  readonly entries: readonly DocumentMenuEntry[];
}

const command = (
  id: string,
  extra: Omit<Extract<DocumentMenuEntry, { kind: 'command' }>, 'kind' | 'id'> = {},
): DocumentMenuEntry => ({ kind: 'command', id, ...extra });

const furniture = (id: string): DocumentMenuEntry[] => [
  command(id),
  command(`${id}.remove`, { onlyWhenAvailable: true }),
];

/** The sections (spec §5.3), in order. */
export const DOCUMENT_MENU_SECTIONS: readonly DocumentMenuSection[] = [
  {
    id: 'combine',
    label: m.menu_section_combine,
    entries: [
      { kind: 'merge' },
      command('section.split', { label: m.menu_split }),
      command('mode.compare', { label: m.menu_compare }),
      { kind: 'rotate' },
    ],
  },
  {
    id: 'add',
    label: m.menu_section_add,
    entries: [
      ...furniture('document.pageNumbers'),
      ...furniture('document.headerFooter'),
      ...furniture('document.bates'),
      ...furniture('document.watermark'),
    ],
  },
  {
    id: 'protect',
    label: m.menu_section_protect,
    entries: [
      command('document.setPassword'),
      command('document.removePassword', { onlyWhenAvailable: true }),
      command('document.sign'),
      command('document.stripMetadata'),
    ],
  },
  {
    id: 'convert',
    label: m.menu_section_convert,
    entries: [
      command('file.export'),
      command('document.exportImages'),
      command('document.exportMarkdown'),
      command('document.ocr'),
      command('document.compress'),
      command('document.batch'),
    ],
  },
  {
    id: 'document',
    label: m.menu_section_document,
    entries: [
      // --- Document info (N1) -------------------------------------------------------------
      // "Document info…" is the navigator package's (N1) command `document.info`; its title
      // and what it opens are N1's. Keep this entry first in the section.
      command('document.info'),
      // --- end Document info ----------------------------------------------------------------
      command('outline.addBookmark'),
      command('outline.removeDeadLinks', { onlyWhenAvailable: true }),
      command('document.saveRepaired', { onlyWhenAvailable: true }),
    ],
  },
];

/** "About this app" (presentation spec §3): one quiet item, always last in "Document",
 *  after any unnamed Document commands. It opens the about page in a new tab. */
const ABOUT_PAGE_ID = 'help.aboutPage';
const ABOUT_PAGE_ENTRY = command(ABOUT_PAGE_ID);

const NAMED = new Set([
  ...DOCUMENT_MENU_SECTIONS.flatMap((s) =>
    s.entries.flatMap((e) => (e.kind === 'command' ? [e.id] : [])),
  ),
  ABOUT_PAGE_ID,
]);

/** What a section shows now: the entries to render, each with its command and state. */
export interface ShownEntry {
  readonly key: string;
  readonly entry: DocumentMenuEntry;
  readonly command?: Command;
  readonly label: string;
  readonly enabled: boolean;
}

const activeDocument = () => getActiveDocument(useWorkspaceStore.getState().workspace);

/** The pages "Rotate pages" turns: the selected pages of the active document, else all. */
export function rotateScope(): { pages: PageId[]; selected: boolean } {
  const doc = activeDocument();
  if (!doc) return { pages: [], selected: false };
  const { selected } = useSelectionStore.getState();
  const chosen = doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id);
  return chosen.length > 0
    ? { pages: chosen, selected: true }
    : { pages: doc.pages.map((p) => p.id), selected: false };
}

/** The menu's sections as shown now (no empty section, no unavailable "Remove …"). */
export function shownDocumentMenu(
  commands: readonly Command[],
): { section: DocumentMenuSection; entries: ShownEntry[] }[] {
  const group = m.group_document();
  const extra = commands.filter((c) => c.group === group && !NAMED.has(c.id));
  const docCount = useWorkspaceStore.getState().workspace.documentOrder.length;
  return DOCUMENT_MENU_SECTIONS.map((section) => {
    const entries: ShownEntry[] = [];
    const all: DocumentMenuEntry[] = [
      ...section.entries,
      ...(section.id === 'document' ? [...extra.map((c) => command(c.id)), ABOUT_PAGE_ENTRY] : []),
    ];
    for (const entry of all) {
      if (entry.kind === 'merge') {
        entries.push({ key: 'merge', entry, label: m.menu_merge(), enabled: docCount > 0 });
        continue;
      }
      if (entry.kind === 'rotate') {
        const enabled = rotateScope().pages.length > 0;
        entries.push({ key: 'rotate', entry, label: m.menu_rotate(), enabled });
        continue;
      }
      const registered = commands.find((c) => c.id === entry.id);
      if (!registered) continue;
      const enabled = commandRegistry.isEnabled(registered);
      if (!enabled && entry.onlyWhenAvailable) continue;
      entries.push({
        key: entry.id,
        entry,
        command: registered,
        label: entry.label?.() ?? registered.title,
        enabled,
      });
    }
    return { section, entries };
  }).filter((s) => s.entries.length > 0);
}

/**
 * Merge files…: with several documents open, the merge dialog for all of them; with one,
 * a file picker first, then the same dialog (spec §13 decision 2: combining always goes
 * through the merge dialog).
 */
export async function mergeFiles(): Promise<void> {
  const count = () => useWorkspaceStore.getState().workspace.documentOrder.length;
  if (count() < 2) {
    const files = await pickFiles('pdf');
    if (files.length === 0) return;
    await openDocuments(files);
  }
  if (count() > 1) await commandRegistry.execute('documents.mergeAll');
}

/** Rotates the scope (selected pages, else all) by `delta` degrees and says so. */
export function rotateDocumentPages(delta: 90 | -90 | 180): void {
  const { pages } = rotateScope();
  if (pages.length === 0) return;
  if (!useWorkspaceStore.getState().rotatePages(pages, delta)) return;
  const count = pages.length;
  announce(
    delta === 180
      ? m.menu_rotated_half({ count })
      : delta > 0
        ? m.announce_rotated_right({ count })
        : m.announce_rotated_left({ count }),
  );
}

export function DocumentMenu({ visible }: { readonly visible: boolean }) {
  const commands = useSyncExternalStore(subscribe, snapshot);
  const group = m.group_document();
  const any = commands.some((c) => c.group === group);
  return (
    <>
      {visible && any ? (
        <Menu.Root>
          <Menu.Trigger className={styles.trigger} data-testid="document-menu">
            <FileCog aria-hidden="true" />
            <span>{m.tools_menu()}</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={4} align="end" collisionPadding={8}>
              <Menu.Popup
                className={`${menuStyles.popup} ${styles.popup}`}
                aria-label={m.tools_menu()}
              >
                <DocumentMenuItems />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
      <ToolDialogs />
      <BatchDialogHost />
      <OcrDialogHost />
    </>
  );
}

/** Rendered when the menu opens, so availability is read then. */
function DocumentMenuItems() {
  const commands = useSyncExternalStore(subscribe, snapshot);
  return (
    <>
      {shownDocumentMenu(commands).map(({ section, entries }, index) => (
        <Fragment key={section.id}>
          {index > 0 ? <Menu.Separator className={menuStyles.separator} /> : null}
          <Menu.Group data-section={section.id}>
            <Menu.GroupLabel className={styles.sectionLabel}>{section.label()}</Menu.GroupLabel>
            {entries.map((shown) =>
              shown.key === ABOUT_PAGE_ID ? (
                <Fragment key={shown.key}>
                  <AppearanceSubmenu />
                  <Menu.Item
                    className={menuStyles.item}
                    disabled={!shown.enabled}
                    onClick={() => {
                      if (shown.command) void commandRegistry.execute(shown.command.id);
                    }}
                  >
                    <span className={menuStyles.label}>{shown.label}</span>
                  </Menu.Item>
                </Fragment>
              ) : shown.entry.kind === 'rotate' ? (
                <RotateSubmenu key={shown.key} label={shown.label} enabled={shown.enabled} />
              ) : (
                <Menu.Item
                  key={shown.key}
                  className={menuStyles.item}
                  disabled={!shown.enabled}
                  onClick={() => {
                    if (shown.entry.kind === 'merge') void mergeFiles();
                    else if (shown.command) void commandRegistry.execute(shown.command.id);
                  }}
                >
                  <span className={menuStyles.label}>{shown.label}</span>
                </Menu.Item>
              ),
            )}
            {section.id === 'document' && !entries.some((e) => e.key === ABOUT_PAGE_ID) ? (
              <AppearanceSubmenu />
            ) : null}
          </Menu.Group>
        </Fragment>
      ))}
    </>
  );
}

/**
 * "Appearance ▸": the appearance settings and "Pen draws in Edit" as checkbox items (role
 * menuitemcheckbox). The pen setting shows its effective value: "auto" is on once a pen has
 * been seen; a click makes an explicit choice.
 */
function AppearanceSubmenu() {
  const glassPanels = useAppearanceStore((s) => s.glassPanels);
  const reduceTransparency = useAppearanceStore((s) => s.reduceTransparency);
  const penDraws = usePenDrawsInEdit();
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={menuStyles.item} data-settings="appearance">
        <span className={menuStyles.label}>{m.appearance_heading()}</span>
        <ChevronRight className={menuStyles.submenuArrow} aria-hidden="true" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="left" align="end" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup} aria-label={m.appearance_heading()}>
            <Menu.CheckboxItem
              className={menuStyles.item}
              checked={glassPanels}
              onCheckedChange={setGlassPanels}
              closeOnClick={false}
            >
              <span className={menuStyles.check} aria-hidden="true" />
              <span className={menuStyles.label}>{m.appearance_glass_panels()}</span>
            </Menu.CheckboxItem>
            <Menu.CheckboxItem
              className={menuStyles.item}
              checked={reduceTransparency}
              onCheckedChange={setReduceTransparency}
              closeOnClick={false}
            >
              <span className={menuStyles.check} aria-hidden="true" />
              <span className={menuStyles.label}>{m.appearance_reduce_transparency()}</span>
            </Menu.CheckboxItem>
            <Menu.CheckboxItem
              className={menuStyles.item}
              checked={penDraws}
              onCheckedChange={setPenDrawsInEdit}
              closeOnClick={false}
            >
              <span className={menuStyles.check} aria-hidden="true" />
              <span className={menuStyles.label}>{m.pen_draws_in_edit()}</span>
            </Menu.CheckboxItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

function RotateSubmenu({ label, enabled }: { readonly label: string; readonly enabled: boolean }) {
  const scope = rotateScope();
  const count = scope.pages.length;
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={menuStyles.item} disabled={!enabled}>
        <span className={menuStyles.label}>{label}</span>
        <ChevronRight className={menuStyles.submenuArrow} aria-hidden="true" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="left" align="start" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup}>
            <Menu.Group>
              <Menu.GroupLabel className={styles.sectionLabel}>
                {scope.selected
                  ? m.menu_rotate_scope_selected({ count })
                  : m.menu_rotate_scope_all({ count })}
              </Menu.GroupLabel>
              <Menu.Item className={menuStyles.item} onClick={() => rotateDocumentPages(90)}>
                <span className={menuStyles.label}>{m.menu_rotate_right()}</span>
              </Menu.Item>
              <Menu.Item className={menuStyles.item} onClick={() => rotateDocumentPages(-90)}>
                <span className={menuStyles.label}>{m.menu_rotate_left()}</span>
              </Menu.Item>
              <Menu.Item className={menuStyles.item} onClick={() => rotateDocumentPages(180)}>
                <span className={menuStyles.label}>{m.menu_rotate_half()}</span>
              </Menu.Item>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
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
