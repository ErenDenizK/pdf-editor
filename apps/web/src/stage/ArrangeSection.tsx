/**
 * One light-table section: a sticky header (title, page count, source colour tags,
 * honesty badges, collapse toggle, section menu) and a `role="grid"` of the rows the
 * virtualizer currently shows (spec §1, §6, §8).
 *
 * The section element is a drop target for page drags, tab drags and OS files; the table
 * computes the insertion gap from pointer coordinates (dnd/geometry.ts), so targets carry
 * only the section's document id.
 */
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter';
import { dropTargetForExternal } from '@atlaskit/pragmatic-drag-and-drop/adapter/drop-target-for-external';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/utils/combine';
import { containsFiles } from '@atlaskit/pragmatic-drag-and-drop/utils/contains-files';
import {
  type DocumentId,
  effectiveLabel,
  type PageId,
  pageTotalRotation,
  type SourceId,
  type Workspace,
} from '@pdf-editor/document-model';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { useCommands } from '../commands/use-commands';
import { useDropHighlight } from '../dnd/drag-store';
import { type GridMetrics, GRID, gapBar, type SectionLayout } from '../dnd/geometry';
import { isPageDrag, isTabDrag } from '../dnd/page-drag';
import { displaySize, fitInBox } from '../pages/page-geometry';
import { announce } from '../shell/announcer';
import { SOURCE_BADGES } from '../shell/RightPanel';
import { selectAllOf, useSelectionStore } from '../state/selection-store';
import { useUiStore } from '../state/ui-store';
import { documentSources, pagesPhrase, type SourceFileInfo } from '../state/workspace-store';
import menuStyles from '../ui/Menu.module.css';
import { Tooltip } from '../ui/Tooltip';
import { selectParity } from './arrange-actions';
import type { ShownSection } from './arrange-data';
import { outlineTargets } from './arrange-data';
import styles from './ArrangeView.module.css';
import { PageCell } from './PageCell';
import {
  isSectionCommandEnabled,
  runSectionCommand,
  sectionMenuItems,
  subscribeSectionMenu,
} from './section-menu';

/** DOM attribute that tells the shell's window-wide file drop to leave a drop alone. */
export const FILE_DROP_ZONE_ATTRIBUTE = 'data-file-drop-zone';

export function sectionDomId(documentId: DocumentId, part: 'title' | 'grid'): string {
  return `arrange-${part}-${documentId}`;
}

interface ArrangeSectionProps {
  readonly section: ShownSection;
  readonly layout: SectionLayout<DocumentId>;
  readonly metrics: GridMetrics;
  /** Row indices to render (the virtualizer's range). */
  readonly rows: readonly number[];
  readonly ws: Workspace;
  readonly files: Readonly<Record<SourceId, SourceFileInfo>>;
  readonly viewTop: number;
  readonly viewBottom: number;
  /** Roving tabindex: the section's one tabbable cell. */
  readonly tabbableId: PageId | undefined;
}

export function ArrangeSection({
  section,
  layout,
  metrics,
  rows,
  ws,
  files,
  viewTop,
  viewBottom,
  tabbableId,
}: ArrangeSectionProps) {
  const ref = useRef<HTMLElement>(null);
  const { doc } = section;
  const documentId = doc.id;
  const outlined = useDropHighlight((s) => {
    const h = s.highlight;
    if (h === null) return false;
    if (h.kind === 'section') return h.section === documentId;
    return h.kind === 'gap' && h.files && h.section === documentId;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const data = { type: 'section', documentId };
    return combine(
      dropTargetForElements({
        element,
        getData: () => data,
        canDrop: ({ source }) => isPageDrag(source.data) || isTabDrag(source.data),
        getDropEffect: ({ input }) => (input.altKey ? 'copy' : 'move'),
      }),
      dropTargetForExternal({
        element,
        getData: () => data,
        canDrop: containsFiles,
        getDropEffect: () => 'copy',
      }),
    );
  }, [documentId]);

  const pages = doc.pages;
  const outline = outlineTargets(doc);
  const height = layout.bottom - layout.top - GRID.sectionGap;

  return (
    <section
      ref={ref}
      className={styles.section}
      style={{ top: layout.top, height }}
      aria-labelledby={sectionDomId(documentId, 'title')}
      data-section-id={documentId}
      data-drop-outline={outlined || undefined}
      {...{ [FILE_DROP_ZONE_ATTRIBUTE]: '' }}
    >
      <SectionHeader section={section} ws={ws} files={files} />
      {section.collapsed ? null : (
        <div
          id={sectionDomId(documentId, 'grid')}
          role="grid"
          aria-labelledby={sectionDomId(documentId, 'title')}
          aria-multiselectable="true"
          aria-rowcount={Math.max(1, layout.rows)}
          aria-colcount={metrics.columns}
          className={styles.grid}
          style={{ height: layout.gridHeight }}
        >
          {pages.length === 0 ? (
            <div role="row" aria-rowindex={1} className={styles.row} style={{ height: '100%' }}>
              <div role="gridcell" aria-colindex={1} className={styles.emptyRow}>
                No pages. Drop pages or PDF files here.
              </div>
            </div>
          ) : (
            rows.map((row) => {
              const top = layout.gridTop + row * metrics.rowHeight;
              const visible = top + metrics.rowHeight > viewTop && top < viewBottom;
              const start = row * metrics.columns;
              return (
                <div
                  key={row}
                  role="row"
                  aria-rowindex={row + 1}
                  className={styles.row}
                  style={{
                    transform: `translateY(${row * metrics.rowHeight}px)`,
                    gridTemplateColumns: `repeat(${metrics.columns}, ${metrics.cellWidth}px)`,
                    columnGap: metrics.gapX,
                    paddingInline: metrics.padX,
                  }}
                >
                  {pages.slice(start, start + metrics.columns).map((page, offset) => {
                    const index = start + offset;
                    const size = displaySize(ws, page);
                    const fitted = fitInBox(size, metrics.cellWidth, metrics.boxHeight);
                    const ref = page.ref;
                    const file = ref.kind === 'source' ? files[ref.source] : undefined;
                    return (
                      <PageCell
                        key={page.id}
                        pageId={page.id}
                        documentId={documentId}
                        index={index}
                        count={pages.length}
                        column={offset}
                        label={safeLabel(ws, doc, index)}
                        sourceId={ref.kind === 'source' ? ref.source : undefined}
                        sourceIndex={ref.kind === 'source' ? ref.index : 0}
                        sourceName={
                          file?.name ??
                          (ref.kind === 'source' ? ws.sources[ref.source]?.name : undefined)
                        }
                        colorIndex={file?.colorIndex ?? 0}
                        rotation={page.rotation}
                        totalRotation={safeRotation(ws, page)}
                        widthPt={size.width}
                        heightPt={size.height}
                        thumbWidth={fitted.width}
                        thumbHeight={fitted.height}
                        cellWidth={metrics.cellWidth}
                        boxHeight={metrics.boxHeight}
                        outlined={outline.has(page.id)}
                        tabbable={page.id === tabbableId}
                        visible={visible}
                      />
                    );
                  })}
                </div>
              );
            })
          )}
          <InsertionBar documentId={documentId} metrics={metrics} />
        </div>
      )}
    </section>
  );
}

function safeLabel(ws: Workspace, doc: ShownSection['doc'], index: number): string {
  try {
    return effectiveLabel(ws, doc, index);
  } catch {
    return String(index + 1);
  }
}

function safeRotation(ws: Workspace, page: ShownSection['doc']['pages'][number]): number {
  try {
    return pageTotalRotation(ws, page);
  } catch {
    return page.rotation;
  }
}

/** The 2px accent bar in the gutter of the current drop gap (spec §3). */
function InsertionBar({
  documentId,
  metrics,
}: {
  readonly documentId: DocumentId;
  readonly metrics: GridMetrics;
}) {
  const highlight = useDropHighlight((s) =>
    s.highlight?.kind === 'gap' && s.highlight.section === documentId ? s.highlight : null,
  );
  if (highlight === null) return null;
  const bar = gapBar(metrics, highlight.gap);
  return (
    <div
      className={styles.insertionBar}
      data-testid="insertion-bar"
      data-index={highlight.gap.index}
      data-duplicate={highlight.duplicate || undefined}
      aria-hidden="true"
      style={{ height: bar.height, transform: `translate(${bar.x}px, ${bar.y}px)` }}
    />
  );
}

function SectionHeader({
  section,
  ws,
  files,
}: {
  readonly section: ShownSection;
  readonly ws: Workspace;
  readonly files: Readonly<Record<SourceId, SourceFileInfo>>;
}) {
  const { doc, collapsed } = section;
  const setCollapsed = useUiStore((s) => s.setArrangeCollapsed);
  const sources = documentSources(doc);
  const badges = SOURCE_BADGES.filter((badge) =>
    sources.some((id) => ws.sources[id]?.flags[badge.flag] === true),
  );
  const toggle = () => {
    setCollapsed(doc.id, !collapsed);
    announce(`${collapsed ? 'Expanded' : 'Collapsed'} ${doc.title}`);
  };

  return (
    <header className={styles.header} data-section-header="">
      <button
        type="button"
        className={styles.headerButton}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : sectionDomId(doc.id, 'grid')}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${doc.title}`}
        onClick={toggle}
      >
        <ChevronDown aria-hidden="true" />
      </button>
      <h2 id={sectionDomId(doc.id, 'title')} className={styles.sectionTitle} title={doc.title}>
        {doc.title}
      </h2>
      <span className={styles.sectionTags}>
        {sources.map((id) => {
          const file = files[id];
          const name = file?.name ?? ws.sources[id]?.name ?? 'Unknown file';
          return (
            <span
              key={id}
              className={styles.sectionTag}
              data-tag={file?.colorIndex ?? 0}
              title={name}
              role="img"
              aria-label={`Pages from ${name}`}
            />
          );
        })}
      </span>
      <span className={styles.sectionCount}>{pagesPhrase(doc.pages.length)}</span>
      {badges.length > 0 ? (
        <span className={styles.badges}>
          {badges.map((badge) => (
            <Tooltip key={badge.flag} label={badge.explanation}>
              <button type="button" className={styles.badge} aria-label={badge.explanation}>
                {badge.label}
              </button>
            </Tooltip>
          ))}
        </span>
      ) : null}
      <span className={styles.headerSpacer} />
      {section.pinned ? <span className={styles.pinnedMark}>Kept</span> : null}
      <SectionMenu section={section} />
    </header>
  );
}

function SectionMenu({ section }: { readonly section: ShownSection }) {
  const { doc, collapsed, pinned } = section;
  const items = useSyncExternalStore(subscribeSectionMenu, sectionMenuItems);
  // Re-render when commands register, so extension items enable themselves.
  useCommands();
  const ui = useUiStore.getState;
  const apply = useSelectionStore((s) => s.apply);
  const focused = useSelectionStore((s) => s.focused);

  const builtIn: { key: string; label: string; run: () => void; disabled?: boolean }[] = [
    {
      key: 'pin',
      label: pinned ? 'Remove from Arrange' : 'Keep in Arrange',
      run: () => {
        if (pinned) ui().unpinFromArrange(doc.id);
        else ui().pinToArrange([doc.id]);
      },
    },
    {
      key: 'collapse',
      label: collapsed ? 'Expand' : 'Collapse',
      run: () => ui().setArrangeCollapsed(doc.id, !collapsed),
    },
    {
      key: 'select-all',
      label: 'Select all pages',
      disabled: doc.pages.length === 0,
      run: () => {
        apply(
          selectAllOf(
            doc.pages.map((p) => p.id),
            focused,
          ),
        );
        announce(`Selected ${pagesPhrase(doc.pages.length)} in ${doc.title}`);
      },
    },
    {
      key: 'odd',
      label: 'Select odd pages',
      disabled: doc.pages.length === 0,
      run: () => selectParity(doc.id, 'odd'),
    },
    {
      key: 'even',
      label: 'Select even pages',
      disabled: doc.pages.length < 2,
      run: () => selectParity(doc.id, 'even'),
    },
  ];

  return (
    <Menu.Root>
      <Menu.Trigger className={styles.headerButton} aria-label={`${doc.title} actions`}>
        <MoreHorizontal aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={8}>
          <Menu.Popup className={menuStyles.popup}>
            {builtIn.map((item) => (
              <Menu.Item
                key={item.key}
                className={menuStyles.item}
                disabled={item.disabled ?? false}
                onClick={item.run}
              >
                <span className={menuStyles.label}>{item.label}</span>
              </Menu.Item>
            ))}
            {(['pages', 'document'] as const).map((group) => (
              <Menu.Group key={group}>
                <Menu.Separator className={menuStyles.separator} />
                {items
                  .filter((item) => item.group === group)
                  .map((item) => {
                    const enabled = isSectionCommandEnabled(item.command, doc.id);
                    return (
                      <Menu.Item
                        key={item.command}
                        className={menuStyles.item}
                        disabled={!enabled}
                        title={enabled ? undefined : 'Not available yet'}
                        onClick={() => void runSectionCommand(item.command, doc.id)}
                      >
                        <span className={menuStyles.label}>{item.label}</span>
                      </Menu.Item>
                    );
                  })}
              </Menu.Group>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
