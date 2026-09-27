/**
 * Read-mode page layout: continuous, single page, two-up. Icon segmented control in the
 * stage header (APG radio group: arrows move and select), next to the mode switch.
 */
import { Columns2, File, GalleryVertical } from 'lucide-react';
import { type KeyboardEvent, useRef } from 'react';

import { m } from '../i18n';
import { READ_LAYOUTS, type ReadLayout, useViewStore } from '../state/view-store';
import { Tooltip } from '../ui/Tooltip';
import styles from './LayoutSwitch.module.css';
import { layoutTitle, setReadLayout } from './viewer-commands';

const ICONS: Record<ReadLayout, typeof File> = {
  continuous: GalleryVertical,
  single: File,
  'two-up': Columns2,
};

export function LayoutSwitch() {
  const layout = useViewStore((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !backward) return;
    event.preventDefault();
    const index = READ_LAYOUTS.indexOf(layout);
    const count = READ_LAYOUTS.length;
    const next = READ_LAYOUTS[(index + (forward ? 1 : -1) + count) % count] ?? 'continuous';
    setReadLayout(next);
    ref.current?.querySelector<HTMLElement>(`[data-layout="${next}"]`)?.focus();
  };

  return (
    <div ref={ref} role="radiogroup" aria-label={m.layout_label()} className={styles.segmented}>
      {READ_LAYOUTS.map((id) => {
        const Icon = ICONS[id];
        const checked = layout === id;
        const title = layoutTitle(id);
        return (
          <Tooltip key={id} label={title}>
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={title}
              tabIndex={checked ? 0 : -1}
              data-layout={id}
              className={styles.segment}
              onKeyDown={onKeyDown}
              onClick={() => setReadLayout(id)}
            >
              <Icon aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
